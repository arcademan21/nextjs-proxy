// Real runtime integration tests — NO mocks.
//
// The suite in proxy.test.ts double-mocks the boundary: it fakes the incoming
// request object and stubs `global.fetch`, so it only proves the handler's
// internal branching, never that the package actually works against a live
// Next.js runtime and a real socket. These tests close that gap end to end:
//   - a REAL `NextRequest` built with `new NextRequest(...)` (next is a devDep),
//   - a REAL upstream over `http.createServer` reached by the REAL global fetch,
//   - a REAL `NextResponse` whose status/headers/body we read via the web API.
// Nothing here is stubbed; the only relaxation is `allowPrivateHosts: true`,
// required because the loopback upstream is an internal host the SSRF guard
// blocks by default (we assert that default below).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { nextProxyHandler } from "../src/proxy";

const ORIGIN = "https://app.example.com";

let server: http.Server;
let baseUrl: string;

// Minimal upstream: a JSON echo, an SSE stream, and a 404 fallback. Each is
// exercised over a real TCP connection by the proxy's fetch.
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString() || "{}";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ youSent: JSON.parse(raw), ok: true }));
      });
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: one\n\n");
      res.write("data: two\n\n");
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // Drop idle keep-alive sockets first so close() resolves promptly instead of
  // waiting out undici's idle timeout under jest's hook deadline on slow CI.
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// Build a genuine NextRequest carrying the proxy envelope as its JSON body.
// The HTTP method is always POST (the browser posts to /api/proxy); the upstream
// verb travels inside the envelope's `method` field.
function realRequest(body: unknown): NextRequest {
  return new NextRequest("https://localhost/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

describe("nextProxyHandler — real runtime integration", () => {
  it("buffers a real upstream JSON response and reflects the CORS origin", async () => {
    const handler = nextProxyHandler({
      baseUrl,
      allowPrivateHosts: true,
      allowOrigins: "*",
    });

    const data = { hello: "world", n: 42 };
    const res = await handler(
      realRequest({ method: "POST", endpoint: "/echo", data })
    );

    expect(res.status).toBe(200);
    // With allowOrigins "*", the proxy still reflects the specific request
    // origin in the ACAO header — it never echoes a literal "*".
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = await res.json();
    expect(body).toEqual({ youSent: data, ok: true });
  });

  it("streams a real text/event-stream upstream through untouched (stream: 'auto')", async () => {
    const handler = nextProxyHandler({
      baseUrl,
      allowPrivateHosts: true,
      allowOrigins: "*",
      stream: "auto",
    });

    const res = await handler(
      realRequest({ method: "GET", endpoint: "/stream" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // Streaming forwards the upstream Content-Type verbatim, so MIME sniffing
    // must be disabled and reverse-proxy buffering switched off for SSE.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const text = await res.text();
    expect(text).toContain("data: one");
    expect(text).toContain("data: two");
  });

  it("passes a real upstream error status through to the client", async () => {
    const handler = nextProxyHandler({
      baseUrl,
      allowPrivateHosts: true,
      allowOrigins: "*",
    });

    const res = await handler(
      realRequest({ method: "GET", endpoint: "/missing" })
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("blocks the loopback upstream with 403 when allowPrivateHosts is off", async () => {
    // Same live upstream, but without the private-host opt-in. The SSRF guard
    // must refuse before any fetch leaves the process.
    const handler = nextProxyHandler({ baseUrl, allowOrigins: "*" });

    const res = await handler(
      realRequest({ method: "POST", endpoint: "/echo", data: {} })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Endpoint not allowed" });
  });
});
