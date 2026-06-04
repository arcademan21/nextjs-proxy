# NextJs Proxy

Universal, secure proxy for Next.js. Centralize, audit, and control all external API calls from a single entry point, with support for:

- Security (hides credentials and backend logic)
- Configurable CORS (with opt-in credentials)
- Centralized outbound traffic
- Structured auditing and logging
- Request/response transformation
- Access control and validation
- Rate limiting (custom, in-memory, and pluggable shared stores)
- SSRF protection with `allowedHosts` and server-side **named routes**
- Support for relative endpoints via `baseUrl`

Ideal for projects with multiple external integrations or governance requirements over outbound traffic.

NextJs Proxy is designed to work seamlessly with the modern, native architecture of Next.js. For optimal performance, security, and maintainability, we recommend combining:

- **Rewrites** in `next.config.js` for declarative route mapping
- **Middleware** for global, centralized logic (auth, rate limiting, logging)
- **nextjs-proxy handler** for advanced, per-endpoint proxy logic

### 1. Route Rewrites (next.config.js)

```js
// next.config.js
module.exports = {
  async rewrites() {
    return [
      {
        source: "/api/proxy/:path*",
        destination: "/api/proxy", // All requests go to your handler
      },
    ];
  },
};
```

### 2. Global Middleware / Proxy file

> **Next.js 16+ naming change:**
> Next.js 16 renamed the special `middleware` file to `proxy`. Use the name
> that matches your Next.js version:
>
> | Next.js version | File              | Exported function |
> | --------------- | ----------------- | ----------------- |
> | **16 and newer**| `proxy.ts`        | `export function proxy(...)` |
> | **13 – 15**     | `middleware.ts`   | `export function middleware(...)` |
>
> On Next.js 16 the `proxy` file always runs on the **Node.js runtime** — the
> `edge` runtime is **not** supported there. If you need the edge runtime, keep
> using a `middleware.ts` file on a Next.js version that still supports it.
> Config flags were also renamed (e.g. `skipMiddlewareUrlNormalize` →
> `skipProxyUrlNormalize`).

> **Important (Pages Router):**
> If your project uses the Pages Router (a `pages/` folder), the file must live
> at `src/proxy.ts` (Next 16+) or `src/middleware.ts` (Next 13–15) for Next.js
> to detect it. App Router projects can place it at the project root or in `src/`.

```ts
// Next.js 16+  ->  proxy.ts
import { NextResponse, NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // Example: global authentication
  const token = request.headers.get("authorization");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Add logging, rate limiting, etc. here
  return NextResponse.next();
}

// Apply only to proxy routes
export const config = {
  matcher: ["/api/proxy/:path*"],
};
```

```ts
// Next.js 13–15  ->  middleware.ts
import { NextResponse, NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const token = request.headers.get("authorization");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/proxy/:path*"],
};
```

> Note: `nextjs-proxy`'s handler (`nextProxyHandler`, section 3) is a route
> handler factory and does **not** depend on the special middleware/proxy file.
> This section only documents the optional global-gate pattern; the rename above
> applies to that pattern, not to the package API.

### 3. Centralized Advanced Logic (Handler)

```ts
// app/api/proxy/route.ts
import { nextProxyHandler } from "nextjs-proxy";

export const POST = nextProxyHandler({
  // ...all your advanced options (logging, transform, masking, etc.)
});
```

> Need async initialization before handling requests? Build the options
> yourself and pass them in — `nextProxyHandler` already returns the async
> route handler:
>
> ```ts
> const options = await loadProxyOptions();
> export const POST = nextProxyHandler(options);
> ```

---

**With this approach you get:**

- Native performance and compatibility (serverless/edge)
- Centralized governance and security
- Advanced proxy logic with minimal code duplication
- Easy maintenance and extensibility

This pattern is fully aligned with the best practices recommended by the Next.js team and the evolution of the framework.

> ⚠️ **Warning: (No Turbopack Compatibility)**
> NextJs Proxy is fully compatible with Next.js using Webpack. However, Turbopack (the new experimental bundler for Next.js) currently has limitations with local packages, workspaces, and some advanced module resolution patterns. If you experience issues using this package with Turbopack, consider the following options:

- **Recommended:** Force the use of Webpack by adding to your `next.config.js`:
  ```js
  experimental: {
    turbo: false;
  }
  ```
- **If you want to use Turbopack:**
  - Publish the package to npm (even as private) and install it from the registry, not as a local or symlinked package.
  - Avoid cross-dependencies or indirect imports between workspaces.
- **Alternative:** Bundle your module as a single JS file and consume it as a direct dependency.

Turbopack is under active development and will improve over time. For the latest status, see [Vercel Turbopack GitHub](https://github.com/vercel/turbopack).

## Installation

```sh
pnpm add nextjs-proxy
# or
npm install nextjs-proxy
```

## Quick Usage (App Router)

```ts
// app/api/proxy/route.ts
import { nextProxyHandler } from "nextjs-proxy";

export const POST = nextProxyHandler({
  baseUrl: process.env.EXTERNAL_API_BASE,
  allowOrigins: ["http://localhost:3000"],
});
```

---

## Pages Router (not supported in `pages/api` routes)

`nextProxyHandler` is built on the **Web Fetch API** (`NextRequest` /
`NextResponse` from `next/server`): it receives a `Request` and returns a
`Response`. Classic **Pages Router API routes** (`pages/api/*`) use Node-style
`(req: NextApiRequest, res: NextApiResponse)` handlers instead, which are **not
compatible** with this signature. There is no drop-in adapter.

If your project still uses the Pages Router, add an **App Router route handler**
for the proxy — App Router and Pages Router can coexist in the same project:

```ts
// app/api/proxy/route.ts  (works even in a Pages Router project)
import { nextProxyHandler } from "nextjs-proxy";

export const POST = nextProxyHandler({
  baseUrl: process.env.EXTERNAL_API_BASE,
});
```

Your Pages Router frontend can then call `/api/proxy` normally (see the combined
example below).

## Combined usage: App Router API + Pages Router frontend

You can use `nextjs-proxy` in an App Router API route and call it from a Pages Router frontend. This is a common and fully supported scenario in Next.js projects.

**API route (App Router):**

```ts
// src/app/api/proxy/route.ts
import { nextProxyHandler } from "nextjs-proxy";

export const POST = nextProxyHandler({
  baseUrl: "https://your-external-backend.com", // your external backend base URL
  allowOrigins: ["http://localhost:3000"], // adjust as needed
  // You can add more options: log, validate, rateLimit, etc.
});
```

**Advanced Example**

```ts
export const POST = nextProxyHandler({
  baseUrl: "https://api.my-service.com",
  allowOrigins: ["http://localhost:3000", "https://app.my-domain.com"],
  inMemoryRate: { windowMs: 60_000, max: 100 },
  log: (e) => console.log("[proxy]", e),
  validate: (req) => {
    const auth = req.headers.get("authorization");
    return !!(auth && auth.includes("Bearer "));
  },
  transformRequest: ({ method, endpoint, data }) => ({
    method: method ?? "GET",
    endpoint: endpoint.startsWith("/internal")
      ? endpoint.replace("/internal", "/v2")
      : endpoint,
    data,
  }),
  transformResponse: (res) => ({ ...res, proxiedAt: new Date().toISOString() }),
  maskSensitiveData: (data) => {
    if (!data) return data;
    if (typeof data === "object" && data !== null && "password" in data) {
      return { ...data, password: "***" };
    }
    return data;
  },
});
```

In a React component (e.g. `src/pages/index.tsx`), you should use a hook like `useEffect` to make the request after the component mounts:

```tsx
import { useEffect } from "react";

export default function Home() {
  useEffect(() => {
    const fetchData = async () => {
      const req = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          endpoint: "/v1/health", // relative endpoint, will be resolved with baseUrl
        }),
      });
      const res = await req.json();
    };
    fetchData();
  }, []);

  return (
    <div>
      <h1>Home page</h1>
    </div>
  );
}
```

This pattern allows you to keep your API logic in the App Router (recommended for new Next.js projects) while using the classic Pages Router for your frontend. Both approaches work together seamlessly.

## Full Options

| Option              | Type                                | Description                                    |
| ------------------- | ----------------------------------- | ---------------------------------------------- |
| `log`               | `(info) => void`                    | Receives events: request, response, error.     |
| `validate`          | `(req) => boolean \| Promise`       | Allows to block flow (auth, permissions).      |
| `transformRequest`  | `({method,endpoint,data}) => {...}` | Modifies payload before fetch.                 |
| `transformResponse` | `(res) => any`                      | Adjusts the response before sending to client. |
| `rateLimit`         | `(req) => boolean \| Promise`       | Custom external rate limiting.                 |
| `inMemoryRate`      | `{ windowMs, max, key?, store? }`   | In-memory rate limiting; pass `store` for a shared backend (e.g. Redis). |
| `allowOrigins`      | `string[]`                          | CORS whitelist.                                |
| `corsCredentials`   | `boolean`                           | Emit `Access-Control-Allow-Credentials: true` (default `false`). Reflects the specific origin, never `*`. |
| `onCorsDenied`      | `(origin) => any`                   | Custom response for denied CORS.               |
| `maskSensitiveData` | `(data) => any`                     | Sanitizes data before sending.                 |
| `baseUrl`           | `string`                            | Prefix for relative endpoints.                 |
| `routes`            | `Record<string,string> \| (name,req)=>string\|undefined` | **Named routes**: client sends `{ route }`, server resolves the URL. Removes client control over the destination. |
| `allowedHosts`      | `string \| string[] \| (url,req)=>boolean` | **SSRF allowlist** of upstream destination hosts for absolute endpoints. |
| `allowPrivateHosts` | `boolean`                           | Allow internal/loopback/private hosts (default `false`). |
| `timeoutMs`         | `number`                            | Abort the upstream fetch after N ms (default `30000`; `0` disables). Times out with `504`. |

## Security: SSRF protection (`allowedHosts`)

Because clients send the target `endpoint` in the request body, an unrestricted proxy is a **Server-Side Request Forgery (SSRF)** vector: a client could ask the server to fetch internal services or the cloud metadata endpoint (`http://169.254.169.254/...`). `nextjs-proxy` is **secure by default**:

- **Internal hosts are always blocked** (loopback `127.0.0.1`/`localhost`, link-local `169.254.0.0/16` incl. cloud metadata, and private ranges `10/8`, `172.16/12`, `192.168/16`, plus their IPv6 equivalents). Override only with `allowPrivateHosts: true`.
- **Absolute endpoints must be allowlisted.** If `allowedHosts` is omitted, only relative endpoints resolved through `baseUrl` are permitted (the `baseUrl` host is implicitly trusted).

```ts
export const POST = nextProxyHandler({
  baseUrl: "https://api.my-service.com", // its host is implicitly allowed
  allowedHosts: [
    "api.partner.com", // exact host
    "*.internal-cdn.com", // wildcard subdomain
  ],
  // allowPrivateHosts: true, // ONLY for trusted internal proxies — disabled by default
});
```

`allowedHosts` accepts a `string`, `string[]`, or a function `(url: URL, req: NextRequest) => boolean` for custom logic. Denied requests return `403 { error: "Endpoint not allowed" }`; the detailed reason is sent to your `log` callback, never to the client.

> ⚠️ **Breaking change in v2.0.0:** absolute endpoints are now rejected unless their host is in `allowedHosts` (or matches `baseUrl`). If you previously relied on forwarding arbitrary absolute URLs, add the destination hosts to `allowedHosts`.

## Named routes (recommended, strongest SSRF protection)

The root cause of proxy SSRF is letting the **client** choose the destination
URL. `allowedHosts` constrains that; **named routes remove it entirely**. You
define the destinations server-side and the client only sends a `route` name:

```ts
export const POST = nextProxyHandler({
  baseUrl: "https://api.my-service.com",
  routes: {
    profile: "/v1/users/me", // relative, resolved via baseUrl
    charge: "https://payments.partner.com/charge", // absolute, trusted
  },
});
```

```ts
// Client — sends a route name, never a URL:
await fetch("/api/proxy", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ method: "POST", route: "charge", data: { amount: 10 } }),
});
```

- The client **cannot** control the destination, so client-driven SSRF is gone
  for routed calls. Any `endpoint` sent alongside a valid `route` is ignored.
- Resolved routes are **trusted server-defined destinations**: they bypass
  `allowedHosts`, but still enforce the `http`/`https` and internal-host checks
  (`allowPrivateHosts`) as defense in depth.
- Unknown route names return a generic `400 { error: "Unknown route" }` without
  disclosing which routes exist. Inherited object keys (e.g. `constructor`) are
  never resolvable.
- Use the function form `routes: (name, req) => url | undefined` for dynamic or
  per-request resolution.

`routes` and `endpoint`/`allowedHosts` can coexist: requests with a `route` use
named resolution; requests with a raw `endpoint` fall back to the allowlist.

## CORS and Preflight

Automatically responds to `OPTIONS` with headers configured according to `allowOrigins`.

Set `corsCredentials: true` to emit `Access-Control-Allow-Credentials: true` so
browsers send cookies and `Authorization` on cross-origin requests. The proxy
always reflects the **specific** request origin (never `*`), keeping credentialed
CORS spec-compliant — pair it with a real `allowOrigins` allowlist, never a
blanket `"*"`.

## Rate limiting

Minimal in-memory configuration (per-instance, best-effort):

```ts
inMemoryRate: { windowMs: 15_000, max: 20 }
```

Grouping is by client IP, or define `key: (req) => "user:" + id`.

> ⚠️ The default in-memory counter lives in a single process. On serverless or
> multi-instance deployments it is **per-instance**, not a global guarantee.

### Pluggable shared store (Redis, etc.)

For a strict limit shared across instances, pass a `RateLimitStore` via
`inMemoryRate.store`. Implement `increment(key, windowMs)` returning the running
`count` and `resetAt`:

```ts
import type { RateLimitStore } from "nextjs-proxy";

const redisStore: RateLimitStore = {
  async increment(key, windowMs) {
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, windowMs);
    const pttl = await redis.pttl(key);
    return { count, resetAt: Date.now() + pttl };
  },
};

export const POST = nextProxyHandler({
  inMemoryRate: { windowMs: 60_000, max: 100, store: redisStore },
});
```

The exported `InMemoryRateLimitStore` class is the default backend; instantiate
your own for an isolated counter namespace.

## Common Errors

| Message                             | Cause                                    | Solution                     |
| ----------------------------------- | ---------------------------------------- | ---------------------------- |
| `Relative endpoint without baseUrl` | Used relative endpoint without `baseUrl` | Define `baseUrl` in options  |
| `Origin not allowed`                | CORS blocked                             | Add origin to `allowOrigins` |
| `Rate limit exceeded`               | Limit reached                            | Increase `max` or window     |

# Comparison: nextjs-proxy vs other Next.js proxy solutions

Next.js offers several ways to proxy API requests. Here’s when to use each approach:

| Solution                        | Use Case                                                  | Limitations                                |
| ------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| **Rewrites (next.config.js)**   | Simple path forwarding, development, no logic needed      | Cannot modify headers, no auth, no logging |
| **http-proxy / middleware**     | Custom API routes, can modify requests, more control      | More boilerplate, not native to App Router |
| **next-http-proxy-middleware**  | Simplifies http-proxy usage in API routes                 | Still requires custom route, less flexible |
| **@navikt/next-api-proxy**      | Advanced token exchange, enterprise security              | Complex setup, focused on auth scenarios   |
| **nextjs-proxy (this package)** | Centralized, configurable, minimal, works with App Router | Not for legacy custom servers              |

## Why use nextjs-proxy?

- Native integration with App Router and Pages Router
- Centralized logic: CORS, logging, rate limiting, request/response transformation, access control
- Minimal dependencies, clean API, easy to maintain
- Ideal for projects needing governance, security, and audit over outbound traffic

If you only need simple path forwarding for development, rewrites are enough. For production, security, and advanced logic, use nextjs-proxy.

## License

<a href="https://github.com/arcademan21/nextjs-proxy/blob/main/LICENSE">MIT</a>
