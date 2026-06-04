// Helpers to extract status, headers, and body from NextResponse
function getStatus(res: any): number {
  return res.status ?? res._getStatus?.() ?? res._status ?? 200;
}

function getHeader(res: any, key: string): string | null {
  if (res.headers?.get) return res.headers.get(key);
  if (res.headers && typeof res.headers === "object") {
    return res.headers[key.toLowerCase()] || res.headers[key] || null;
  }
  return null;
}

async function getBody(res: any): Promise<any> {
  if (typeof res.text === "function") {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (res.body && typeof res.body === "string") {
    try {
      return JSON.parse(res.body);
    } catch {
      return res.body;
    }
  }
  if (res._getData) return res._getData();
  return undefined;
}
import { nextProxyHandler, InMemoryRateLimitStore } from "../src/proxy";
import type {
  NextProxyOptions,
  ProxyRequestPayload,
  ProxyResponsePayload,
  RateLimitStore,
  RateLimitHit,
} from "../src/proxy";
// Definición local mínima de NextRequest para pruebas, igual que en proxy.ts
type NextRequest = {
  method: string;
  headers: Headers;
  json(): Promise<any>;
  url: string;
};

// Mock NextRequest for testing
function createMockRequest({
  method = "POST",
  headers = {},
  body = {},
  origin = "https://test.com",
}: {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  origin?: string;
} = {}): NextRequest {
  const realHeaders = new Headers(headers);
  // Only set origin if not already present
  if (origin && !realHeaders.has("origin")) realHeaders.set("origin", origin);
  return {
    method,
    headers: realHeaders,
    json: async () => body,
    url: "https://localhost/api/proxy",
  } as unknown as NextRequest;
}

describe("nextProxyHandler", () => {
  // Mock the network so the happy-path suite never hits a real host
  // (previously these tests depended on jsonplaceholder.typicode.com).
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 1, ok: true }),
      text: async () => '{"id":1,"ok":true}',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("should block unauthorized requests with auth", async () => {
    const handler = await nextProxyHandler({
      auth: () => false,
    });
    const req = createMockRequest();
    const res = await handler(req);
    expect(getStatus(res)).toBe(401);
    const body = await getBody(res);
    expect(body.error).toMatch(/auth/i);
  });

  it("should allow authorized requests with auth", async () => {
    const handler = await nextProxyHandler({
      auth: () => true,
      baseUrl: "https://jsonplaceholder.typicode.com",
    });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/todos/1" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBeGreaterThanOrEqual(200);
  });

  it("should block requests with failed csrf", async () => {
    const handler = await nextProxyHandler({
      csrf: () => false,
    });
    const req = createMockRequest();
    const res = await handler(req);
    expect(getStatus(res)).toBe(403);
    const body = await getBody(res);
    expect(body.error).toMatch(/csrf/i);
  });

  it("should allow requests with passed csrf", async () => {
    const handler = await nextProxyHandler({
      csrf: () => true,
      baseUrl: "https://jsonplaceholder.typicode.com",
    });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/todos/1" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBeGreaterThanOrEqual(200);
  });

  it("should sanitize data before sending", async () => {
    let sanitized = false;
    const handler = await nextProxyHandler({
      baseUrl: "https://jsonplaceholder.typicode.com",
      sanitize: (data) => {
        sanitized = true;
        return Object.assign(
          {},
          typeof data === "object" && data !== null ? data : {},
          { safe: true }
        );
      },
    });
    const req = createMockRequest({
      body: { method: "POST", endpoint: "/posts", data: { foo: "bar" } },
    });
    await handler(req);
    expect(sanitized).toBe(true);
  });

  it("should call monitor on response", async () => {
    let called = false;
    const handler = await nextProxyHandler({
      baseUrl: "https://jsonplaceholder.typicode.com",
      monitor: (req, res) => {
        called = true;
        expect(req).toBeDefined();
        expect(res).toBeDefined();
      },
    });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/todos/1" },
    });
    await handler(req);
    expect(called).toBe(true);
  });
  it("should allow all origins with wildcard", async () => {
    const handler = await nextProxyHandler({ allowOrigins: "*" });
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { origin: "https://anything.com" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(204);
    expect(getHeader(res, "Access-Control-Allow-Origin")).toBe(
      "https://anything.com"
    );
  });

  it("should allow origin by function", async () => {
    const handler = await nextProxyHandler({
      allowOrigins: (origin) => origin.endsWith(".trusted.com"),
    });
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { origin: "https://api.trusted.com" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(204);
    expect(getHeader(res, "Access-Control-Allow-Origin")).toBe(
      "https://api.trusted.com"
    );
    // Should deny untrusted
    const req2 = createMockRequest({
      method: "OPTIONS",
      headers: { origin: "https://evil.com" },
    });
    const res2 = await handler(req2);
    expect(getStatus(res2)).toBe(403);
  });

  it("should set custom CORS methods and headers", async () => {
    const handler = await nextProxyHandler({
      allowOrigins: ["https://test.com"],
      corsMethods: ["GET", "POST"],
      corsHeaders: ["X-Custom", "Authorization"],
    });
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { origin: "https://test.com" },
    });
    const res = await handler(req);
    expect(getHeader(res, "Access-Control-Allow-Methods")).toBe("GET,POST");
    expect(getHeader(res, "Access-Control-Allow-Headers")).toBe(
      "X-Custom, Authorization"
    );
  });
  it("should handle CORS preflight", async () => {
    const handler = await nextProxyHandler({
      allowOrigins: ["https://test.com"],
    });
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { origin: "https://test.com" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(204);
    expect(getHeader(res, "Access-Control-Allow-Origin")).toBe(
      "https://test.com"
    );
  });

  it("should deny CORS if origin not allowed", async () => {
    const handler = await nextProxyHandler({
      allowOrigins: ["https://test.com"],
    });
    const req = createMockRequest({
      method: "OPTIONS",
      headers: { origin: "https://evil.com" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(403);
    // A denied preflight must NOT grant CORS to the denied origin.
    expect(getHeader(res, "Access-Control-Allow-Origin")).toBeNull();
  });

  it("should apply in-memory rate limiting", async () => {
    const handler = await nextProxyHandler({
      inMemoryRate: { windowMs: 1000, max: 1, key: () => "test" },
    });
    const req = createMockRequest();
    await handler(req); // first request
    const res = await handler(req); // second request (should be rate limited)
    expect(getStatus(res)).toBe(429);
  });

  it("should call validate and block if false", async () => {
    const handler = await nextProxyHandler({
      validate: () => false,
    });
    const req = createMockRequest();
    const res = await handler(req);
    expect(getStatus(res)).toBe(401);
  });

  it("should call log on request and response", async () => {
    const logs: any[] = [];
    const handler = await nextProxyHandler({
      log: (info) => logs.push(info),
      baseUrl: "https://jsonplaceholder.typicode.com",
    });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/todos/1" },
    });
    await handler(req);
    // Validar campos clave en los logs
    const requestLog = logs.find((l) => l.type === "request");
    const responseLog = logs.find((l) => l.type === "response");
    expect(requestLog).toBeDefined();
    expect(responseLog).toBeDefined();
    expect(typeof requestLog.timestamp).toBe("string");
    expect(requestLog.level).toBe("info");
    expect(typeof requestLog.ip).toBe("string");
    expect(requestLog.method).toBe("POST");
    expect(requestLog.origin).toBe("https://test.com");
    expect(typeof responseLog.timestamp).toBe("string");
    expect(responseLog.level).toBe("info");
    expect(typeof responseLog.ip).toBe("string");
    expect(responseLog.status).toBeGreaterThanOrEqual(200);
    expect(responseLog.endpoint).toBe(
      "https://jsonplaceholder.typicode.com/todos/1"
    );
    expect(responseLog.payload).toBeDefined();
  });

  it("should transform request and response", async () => {
    const handler = await nextProxyHandler({
      baseUrl: "https://jsonplaceholder.typicode.com",
      transformRequest: ({ method, endpoint, data }: ProxyRequestPayload) => ({
        method,
        endpoint,
        data,
      }),
      transformResponse: (res: ProxyResponsePayload) => ({ id: res.id }),
    });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/todos/1" },
    });
    const res = await handler(req);
    const json = await getBody(res);
    expect(json).toHaveProperty("id");
  });

  it("should mask sensitive data", async () => {
    const handler = await nextProxyHandler({
      baseUrl: "https://jsonplaceholder.typicode.com",
      maskSensitiveData: (data) =>
        Object.assign(
          {},
          typeof data === "object" && data !== null ? data : {},
          { secret: "***" }
        ),
    });
    const req = createMockRequest({
      body: { method: "POST", endpoint: "/posts", data: { secret: "1234" } },
    });
    // We only test that it does not throw and returns a response
    const res = await handler(req);
    expect(getStatus(res)).toBeGreaterThanOrEqual(200);
  });

  it("should handle missing method or endpoint", async () => {
    const handler = await nextProxyHandler();
    const req = createMockRequest({ body: {} });
    const res = await handler(req);
    expect(getStatus(res)).toBe(400);
  });

  it("should handle relative endpoint without baseUrl", async () => {
    const handler = await nextProxyHandler();
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/foo" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(400);
  });

  it("prefers x-real-ip over x-forwarded-for for the client IP", async () => {
    const realFetch = global.fetch;
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    const logs: any[] = [];
    try {
      const handler = await nextProxyHandler({
        allowedHosts: ["api.example.com"],
        log: (info) => logs.push(info),
      });
      const req = createMockRequest({
        headers: {
          "x-real-ip": "203.0.113.7",
          "x-forwarded-for": "10.0.0.1, 203.0.113.7",
        },
        body: { method: "GET", endpoint: "https://api.example.com/data" },
      });
      await handler(req);
      const requestLog = logs.find((l) => l.type === "request");
      expect(requestLog.ip).toBe("203.0.113.7");
    } finally {
      global.fetch = realFetch;
    }
  });

  it("returns 504 when the upstream fetch exceeds timeoutMs", async () => {
    const realFetch = global.fetch;
    // A fetch that never resolves until its abort signal fires.
    global.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      })) as unknown as typeof fetch;
    try {
      const handler = await nextProxyHandler({
        allowedHosts: ["api.example.com"],
        timeoutMs: 20,
      });
      const req = createMockRequest({
        body: { method: "GET", endpoint: "https://api.example.com/slow" },
      });
      const res = await handler(req);
      expect(getStatus(res)).toBe(504);
      const body = await getBody(res);
      expect(body.error).toMatch(/timed out/i);
    } finally {
      global.fetch = realFetch;
    }
  });

  it("does not leak internal error details to the client on 500", async () => {
    const realFetch = global.fetch;
    global.fetch = (() => {
      throw new Error("super secret upstream stack trace");
    }) as unknown as typeof fetch;
    const logs: any[] = [];
    try {
      const handler = await nextProxyHandler({
        allowedHosts: ["api.example.com"],
        log: (info) => logs.push(info),
      });
      const req = createMockRequest({
        body: { method: "GET", endpoint: "https://api.example.com/data" },
      });
      const res = await handler(req);
      expect(getStatus(res)).toBe(500);
      const body = await getBody(res);
      // Client gets a generic message, never the raw error text.
      expect(body.error).toBe("Internal proxy error");
      expect(JSON.stringify(body)).not.toMatch(/secret/i);
      // The full error is still available server-side via the log callback.
      const errorLog = logs.find((l) => l.type === "error" && l.status === 500);
      expect(errorLog).toBeDefined();
      expect(String(errorLog.error)).toMatch(/secret/i);
    } finally {
      global.fetch = realFetch;
    }
  });

  it("returns 400 when method/endpoint are missing even if transformRequest is set", async () => {
    const realFetch = global.fetch;
    const spy = jest.fn() as unknown as typeof fetch;
    global.fetch = spy;
    try {
      const handler = await nextProxyHandler({
        // A transform that does not supply method/endpoint must not cause the
        // missing values to be coerced to the truthy string "undefined".
        transformRequest: ({ data }) => ({ data }),
      });
      const req = createMockRequest({ body: {} });
      const res = await handler(req);
      expect(getStatus(res)).toBe(400);
      expect(spy as unknown as jest.Mock).not.toHaveBeenCalled();
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe("nextProxyHandler — SSRF protection (allowedHosts)", () => {
  const realFetch = global.fetch;

  // Mock fetch so "allowed" cases never hit the network and we can assert calls.
  function mockFetch() {
    const fn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    global.fetch = fn;
    return fn as unknown as jest.Mock;
  }

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("blocks absolute endpoint to cloud metadata (169.254.169.254)", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: ["api.example.com"] });
    const req = createMockRequest({
      body: {
        method: "GET",
        endpoint: "http://169.254.169.254/latest/meta-data/",
      },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks loopback hosts (localhost and 127.0.0.1)", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: "*" });
    for (const endpoint of [
      "http://localhost:6379",
      "http://127.0.0.1:8080/admin",
    ]) {
      const req = createMockRequest({ body: { method: "GET", endpoint } });
      const res = await handler(req);
      expect(getStatus(res)).toBe(403);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks private LAN ranges (10.x, 192.168.x, 172.16.x)", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: "*" });
    for (const endpoint of [
      "http://10.0.0.5/internal",
      "http://192.168.1.1/router",
      "http://172.16.0.10/service",
    ]) {
      const req = createMockRequest({ body: { method: "GET", endpoint } });
      const res = await handler(req);
      expect(getStatus(res)).toBe(403);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks absolute endpoint whose host is not in allowedHosts", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: ["api.example.com"] });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "https://evil.com/steal" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects absolute endpoints when no allowedHosts is configured", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler();
    const req = createMockRequest({
      body: { method: "GET", endpoint: "https://api.example.com/data" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows absolute endpoint whose host is in allowedHosts", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: ["api.example.com"] });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "https://api.example.com/data" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
    const calledUrl = spy.mock.calls[0][0];
    expect(String(calledUrl)).toBe("https://api.example.com/data");
  });

  it("supports wildcard subdomains and denies non-matching hosts", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: "*.trusted.com" });
    const allowed = createMockRequest({
      body: { method: "GET", endpoint: "https://api.trusted.com/v1" },
    });
    expect(getStatus(await handler(allowed))).toBeLessThan(400);

    const denied = createMockRequest({
      body: { method: "GET", endpoint: "https://trusted.com.evil.io/x" },
    });
    expect(getStatus(await handler(denied))).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("blocks private host even if explicitly allowlisted (no allowPrivateHosts)", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ allowedHosts: ["169.254.169.254"] });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "http://169.254.169.254/latest/" },
    });
    expect(getStatus(await handler(req))).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows internal host only when allowPrivateHosts is explicitly enabled", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({
      allowedHosts: ["127.0.0.1"],
      allowPrivateHosts: true,
    });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "http://127.0.0.1:4000/health" },
    });
    expect(getStatus(await handler(req))).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("implicitly trusts the baseUrl host for relative endpoints", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ baseUrl: "https://api.service.com" });
    const req = createMockRequest({
      body: { method: "GET", endpoint: "/v1/health" },
    });
    expect(getStatus(await handler(req))).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      "https://api.service.com/v1/health"
    );
  });
});

describe("nextProxyHandler — pluggable rate-limit store", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("routes rate-limit accounting through a custom store", async () => {
    const calls: Array<{ key: string; windowMs: number }> = [];
    const store: RateLimitStore = {
      increment(key, windowMs) {
        calls.push({ key, windowMs });
        // Allow the first hit, deny from the second on.
        return { count: calls.length, resetAt: Date.now() + windowMs };
      },
    };
    const handler = nextProxyHandler({
      inMemoryRate: { windowMs: 1000, max: 1, key: () => "k", store },
    });
    const req = createMockRequest();
    expect(getStatus(await handler(req))).not.toBe(429); // count 1 <= max 1
    expect(getStatus(await handler(req))).toBe(429); // count 2 > max 1
    expect(calls).toEqual([
      { key: "k", windowMs: 1000 },
      { key: "k", windowMs: 1000 },
    ]);
  });

  it("awaits an async (Promise-returning) store", async () => {
    const store: RateLimitStore = {
      async increment(_key, windowMs): Promise<RateLimitHit> {
        return { count: 99, resetAt: Date.now() + windowMs };
      },
    };
    const handler = nextProxyHandler({
      inMemoryRate: { windowMs: 1000, max: 5, key: () => "async", store },
    });
    expect(getStatus(await handler(createMockRequest()))).toBe(429);
  });

  it("InMemoryRateLimitStore instances keep isolated counters", () => {
    const a = new InMemoryRateLimitStore();
    const b = new InMemoryRateLimitStore();
    expect(a.increment("x", 1000).count).toBe(1);
    expect(a.increment("x", 1000).count).toBe(2);
    // A separate instance does not see the other's counter.
    expect(b.increment("x", 1000).count).toBe(1);
  });
});

describe("nextProxyHandler — named routes", () => {
  const realFetch = global.fetch;
  function mockFetch() {
    const fn = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    global.fetch = fn;
    return fn as unknown as jest.Mock;
  }
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("resolves a named route server-side and ignores a client endpoint", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({
      routes: { users: "https://api.internal.com/v1/users" },
    });
    const req = createMockRequest({
      // The client tries to smuggle its own endpoint; it must be ignored.
      body: {
        method: "GET",
        route: "users",
        endpoint: "https://evil.com/steal",
      },
    });
    expect(getStatus(await handler(req))).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      "https://api.internal.com/v1/users"
    );
  });

  it("returns 400 for an unknown route without disclosing route names", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ routes: { users: "https://a.com/u" } });
    const req = createMockRequest({
      body: { method: "GET", route: "secrets" },
    });
    const res = await handler(req);
    expect(getStatus(res)).toBe(400);
    const body = await getBody(res);
    expect(body.error).toBe("Unknown route");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 400 when a route is sent but routes are not configured", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler();
    const req = createMockRequest({ body: { method: "GET", route: "users" } });
    expect(getStatus(await handler(req))).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not resolve inherited object keys as routes", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({ routes: { users: "https://a.com/u" } });
    const req = createMockRequest({
      body: { method: "GET", route: "constructor" },
    });
    expect(getStatus(await handler(req))).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("bypasses allowedHosts for trusted named routes", async () => {
    const spy = mockFetch();
    // The route host is NOT in allowedHosts, yet a server-defined route is
    // trusted and must be allowed.
    const handler = nextProxyHandler({
      allowedHosts: ["only-this.com"],
      routes: { pay: "https://payments.partner.com/charge" },
    });
    const req = createMockRequest({
      body: { method: "POST", route: "pay", data: { amount: 10 } },
    });
    expect(getStatus(await handler(req))).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      "https://payments.partner.com/charge"
    );
  });

  it("still blocks a named route that resolves to an internal host", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({
      routes: { meta: "http://169.254.169.254/latest/meta-data/" },
    });
    const req = createMockRequest({ body: { method: "GET", route: "meta" } });
    expect(getStatus(await handler(req))).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows a named route to an internal host when allowPrivateHosts is set", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({
      allowPrivateHosts: true,
      routes: { local: "http://127.0.0.1:4000/health" },
    });
    const req = createMockRequest({ body: { method: "GET", route: "local" } });
    expect(getStatus(await handler(req))).toBeLessThan(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative named route via baseUrl", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({
      baseUrl: "https://api.service.com",
      routes: { health: "/v1/health" },
    });
    const req = createMockRequest({ body: { method: "GET", route: "health" } });
    expect(getStatus(await handler(req))).toBeLessThan(400);
    expect(String(spy.mock.calls[0][0])).toBe(
      "https://api.service.com/v1/health"
    );
  });

  it("supports the function form of routes", async () => {
    const spy = mockFetch();
    const handler = nextProxyHandler({
      routes: (name) =>
        name === "ok" ? "https://api.fn.com/ok" : undefined,
    });
    expect(
      getStatus(
        await handler(
          createMockRequest({ body: { method: "GET", route: "ok" } })
        )
      )
    ).toBeLessThan(400);
    expect(
      getStatus(
        await handler(
          createMockRequest({ body: { method: "GET", route: "nope" } })
        )
      )
    ).toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
