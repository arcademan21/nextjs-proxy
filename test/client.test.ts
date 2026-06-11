import { proxyFetch, classifyError, parseResponseBody } from "../src/client";
import type { ErrorInfo, ProxyFetchResponse, ProxyFetchOptions } from "../src/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(overrides: Partial<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
}> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: "test" }),
    text: async () => JSON.stringify({ data: "test" }),
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 1.1 — Basic GET/POST, custom URL, custom headers
// ---------------------------------------------------------------------------

describe("proxyFetch", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  // ---- Default behavior (GET, default URL, basic route) ----

  it("sends a POST request to /api/proxy by default", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user" });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("includes method, route, data, headers in the JSON payload", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user" });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      method: "GET",
      route: "user",
      data: {},
      headers: {},
    });
  });

  it("sends Content-Type: application/json", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user" });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
  });

  // ---- Custom URL ----

  it("accepts a custom url parameter", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user", url: "/custom/proxy" });

    expect(global.fetch).toHaveBeenCalledWith("/custom/proxy", expect.any(Object));
  });

  // ---- Custom headers ----

  it("includes custom headers in the payload", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user", headers: { Authorization: "Bearer tok" } });

    const body = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.headers).toEqual({ Authorization: "Bearer tok" });
  });

  // ---- Custom method ----

  it("accepts a custom method parameter", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user", method: "POST" });

    const body = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.method).toBe("POST");
  });

  it('defaults method to "GET" when not provided', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse());

    await proxyFetch({ route: "user" });

    const body = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.method).toBe("GET");
  });

  // ---- Return value shape ----

  it("returns ProxyFetchResponse with ok, status, data on 2xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockResponse({ ok: true, status: 200, json: async () => ({ id: 1 }) }),
    );

    const res = await proxyFetch({ route: "user" });
    expect(res).toMatchObject({
      ok: true,
      status: 200,
      data: { id: 1 },
    });
  });

  it("includes response headers in the return value", async () => {
    const headers = new Headers({ "x-custom": "yes" });
    (global.fetch as jest.Mock).mockResolvedValue(mockResponse({ headers }));

    const res = await proxyFetch({ route: "user" });
    expect(res.headers?.get("x-custom")).toBe("yes");
  });

  // ---- HTTP errors do NOT throw ----

  it("returns 4xx response without throwing", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockResponse({ ok: false, status: 404, json: async () => ({ error: "Not found" }) }),
    );

    const res = await proxyFetch({ route: "user" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("returns 5xx response without throwing", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockResponse({ ok: false, status: 500, json: async () => ({ error: "Server error" }) }),
    );

    const res = await proxyFetch({ route: "user" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });

  // ---- Network errors DO throw ----

  it("throws a TypeError on network failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(proxyFetch({ route: "user" })).rejects.toThrow(TypeError);
  });

  it("preserves the original error message on network failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(
      new TypeError("NetworkError when attempting to fetch resource."),
    );

    await expect(proxyFetch({ route: "user" })).rejects.toThrow(
      "NetworkError when attempting to fetch resource.",
    );
  });

  it("throws an AbortError when the request times out", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    (global.fetch as jest.Mock).mockRejectedValue(abortError);

    await expect(proxyFetch({ route: "user" })).rejects.toThrow("The operation was aborted");
  });
});

// ---------------------------------------------------------------------------
// Task 1.2 — Error classification
// ---------------------------------------------------------------------------

describe("classifyError", () => {
  it("classifies a TypeError as network error", () => {
    const err = new TypeError("Failed to fetch");
    const info = classifyError(err);
    expect(info.type).toBe("network");
    expect(info.message).toBe("Failed to fetch");
    expect(info.originalError).toBe(err);
    expect(info.status).toBeUndefined();
  });

  it("classifies an AbortError as timeout", () => {
    const err = new Error("Request timed out");
    err.name = "AbortError";
    const info = classifyError(err);
    expect(info.type).toBe("timeout");
    expect(info.message).toBe("Request timed out");
    expect(info.originalError).toBe(err);
  });

  it("classifies an error with isTimeout flag as timeout (priority over name)", () => {
    const err = new Error("custom timeout");
    const info = classifyError(err, true);
    expect(info.type).toBe("timeout");
    expect(info.message).toBe("custom timeout");
  });

  it("classifies a generic Error as unknown", () => {
    const err = new Error("Something went wrong");
    const info = classifyError(err);
    expect(info.type).toBe("unknown");
    expect(info.message).toBe("Something went wrong");
    expect(info.originalError).toBe(err);
  });

  it("classifies a non-Error thrown value as unknown with default message", () => {
    const info = classifyError("string error");
    expect(info.type).toBe("unknown");
    expect(info.message).toBe("An unknown error occurred");
  });

  it("classifies null thrown value as unknown", () => {
    const info = classifyError(null);
    expect(info.type).toBe("unknown");
    expect(info.message).toBe("An unknown error occurred");
  });

  // ---- Edge cases for uncovered branches ----

  it("uses default message when isTimeout with non-Error value", () => {
    const info = classifyError(null, true);
    expect(info.type).toBe("timeout");
    expect(info.message).toBe("Request timeout");
  });

  it("uses default message when TypeError has empty message", () => {
    const err = new TypeError("");
    const info = classifyError(err);
    expect(info.type).toBe("network");
    expect(info.message).toBe("Network error");
  });

  it("uses default message when AbortError has empty message", () => {
    const err = new Error("");
    err.name = "AbortError";
    const info = classifyError(err);
    expect(info.type).toBe("timeout");
    expect(info.message).toBe("The request was aborted");
  });
});

// ---------------------------------------------------------------------------
// Task 1.2 — Server error classification (via proxyFetch)
// ---------------------------------------------------------------------------

describe("proxyFetch — server error classification", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = jest.fn(); });
  afterEach(() => { global.fetch = realFetch; });

  it("populates error with ErrorInfo type='server' on HTTP 5xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockResponse({ ok: false, status: 500, json: async () => ({ message: "Internal error" }) }),
    );

    const res = await proxyFetch({ route: "user" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    const errInfo = res.error as ErrorInfo;
    expect(errInfo.type).toBe("server");
    expect(errInfo.status).toBe(500);
    expect(errInfo.message).toContain("Internal error");
  });

  it("populates error with ErrorInfo type='server' on HTTP 4xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockResponse({ ok: false, status: 400, json: async () => ({ message: "Bad request" }) }),
    );

    const res = await proxyFetch({ route: "user" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    const errInfo = res.error as ErrorInfo;
    expect(errInfo.type).toBe("server");
    expect(errInfo.status).toBe(400);
    expect(errInfo.message).toBe("Bad request");
  });

  it("uses default message when server error body has no message field", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockResponse({ ok: false, status: 502, json: async () => ({ error_code: "BAD_GATEWAY" }) }),
    );

    const res = await proxyFetch({ route: "user" });
    const errInfo = res.error as ErrorInfo;
    expect(errInfo.type).toBe("server");
    expect(errInfo.status).toBe(502);
    expect(errInfo.message).toBe("HTTP 502");
  });
});

// ---------------------------------------------------------------------------
// Task 1.3 — Response parsing
// ---------------------------------------------------------------------------

describe("parseResponseBody", () => {
  it("parses a JSON response", async () => {
    const res = {
      json: async () => ({ id: 1, name: "Alice" }),
    } as unknown as Response;

    const result = await parseResponseBody(res);
    expect(result).toEqual({ id: 1, name: "Alice" });
  });

  it("falls back to text when JSON parsing fails", async () => {
    const res = {
      json: async () => { throw new Error("Not JSON"); },
      text: async () => "plain text content",
    } as unknown as Response;

    const result = await parseResponseBody(res);
    expect(result).toBe("plain text content");
  });

  it("returns a binary descriptor when both JSON and text fail", async () => {
    const res = {
      json: async () => { throw new Error("Not JSON"); },
      text: async () => { throw new Error("Not text"); },
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response;

    const result = await parseResponseBody(res);
    expect(result).toEqual({
      message: "Unparseable response (binary)",
      length: 8,
    });
  });
});
