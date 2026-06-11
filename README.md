# nextjs-proxy

> One secure entry point for every external API call in your Next.js app — with SSRF protection, CORS, rate limiting, logging, and request/response transformation built in.

[![npm version](https://img.shields.io/npm/v/nextjs-proxy.svg)](https://www.npmjs.com/package/nextjs-proxy)
[![npm downloads](https://img.shields.io/npm/dm/nextjs-proxy.svg)](https://www.npmjs.com/package/nextjs-proxy)
[![license](https://img.shields.io/npm/l/nextjs-proxy.svg)](https://github.com/arcademan21/nextjs-proxy/blob/main/LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/nextjs-proxy.svg)](https://bundlephobia.com/package/nextjs-proxy)

## The problem

When your frontend talks to external APIs, you end up scattering the same concerns across every route handler: hiding credentials, configuring CORS, rate limiting, logging, masking sensitive data, and validating where requests are allowed to go. Miss one — say, an unguarded upstream URL — and you ship an **SSRF** vulnerability.

`nextjs-proxy` gives you a **single, governed entry point** for outbound traffic. You declare your destinations and policies once; every call flows through them.

### Before

```ts
// app/api/users/route.ts — and repeated in every other route...
export async function POST(req: Request) {
  // CORS by hand, logging by hand, rate limit by hand,
  // auth by hand, and an unguarded fetch (SSRF risk) by hand.
  const { id } = await req.json();
  const res = await fetch(`https://api.internal.com/v1/users/${id}`);
  return Response.json(await res.json());
}
```

### After

```ts
// app/api/proxy/route.ts — one handler, declared policies
import { nextProxyHandler } from "nextjs-proxy";

export const POST = nextProxyHandler({
  baseUrl: "https://api.internal.com",
  routes: {
    user: "/v1/users", // the client never sees or controls this URL
  },
  allowOrigins: ["https://app.com"],
  inMemoryRate: { windowMs: 60_000, max: 100 },
  log: (e) => console.log("[proxy]", e),
});
```

```ts
// Client — sends a route NAME, not a URL
await fetch("/api/proxy", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ method: "GET", route: "user", data: { id: 42 } }),
});
```

## Installation

```sh
pnpm add nextjs-proxy
# or: npm install nextjs-proxy
```

Requires Next.js `>= 13` (App Router). Works on the Node.js and Edge runtimes.

---

## Named routes — the recommended way (and your SSRF shield)

The root cause of proxy SSRF is letting the **client** choose the destination URL. Named routes remove that entirely: you define the destinations on the server, and the client only sends a **name**.

```ts
export const POST = nextProxyHandler({
  baseUrl: "https://api.my-service.com",
  routes: {
    profile: "/v1/users/me", // relative → resolved via baseUrl
    charge: "https://payments.partner.com/charge", // absolute → trusted
  },
});
```

| Behavior | Guarantee |
| --- | --- |
| Client controls the destination | **No.** It only picks an allowed name. Any `endpoint` sent alongside a valid `route` is ignored. |
| Unknown route name | Returns `400 { error: "Unknown route" }` — without disclosing which names exist. |
| Inherited keys (`constructor`, `__proto__`) | Never resolvable. |
| Resolved route still checked? | Yes — protocol (`http`/`https`) and internal-host checks always run (see SSRF below). It only bypasses the `allowedHosts` allowlist, because the destination is server-defined. |
| Dynamic resolution | Use the function form: `routes: (name, req) => url \| undefined`. |

> If you also set a `transformRequest` that **rewrites** the endpoint, the route's trust is dropped and the new URL is re-checked against `allowedHosts` — a transform-derived destination is treated like any client endpoint, not a trusted route.

## Advanced mode — client-supplied endpoint + allowlist

If you need the client to pass a URL directly (e.g. a generic gateway), use `endpoint` with an `allowedHosts` allowlist. This is more flexible but puts the SSRF burden on your allowlist — prefer named routes when you can.

```ts
export const POST = nextProxyHandler({
  allowedHosts: ["api.partner.com", "*.internal-cdn.com"],
});
```

```ts
// Client sends the URL (must match allowedHosts)
body: JSON.stringify({ method: "GET", endpoint: "https://api.partner.com/data" });
```

---

## Security

### SSRF protection

`nextjs-proxy` is **secure by default**:

- **Internal hosts are always blocked** — loopback (`127.0.0.1`, `localhost`), link-local `169.254.0.0/16` (incl. cloud metadata `169.254.169.254`), and private ranges `10/8`, `172.16/12`, `192.168/16`, plus their IPv6 equivalents. Override only with `allowPrivateHosts: true`.
- **Absolute endpoints must be allowlisted.** With no `allowedHosts`, only relative endpoints resolved through `baseUrl` are allowed (the `baseUrl` host is implicitly trusted).
- Denied requests return `403 { error: "Endpoint not allowed" }`; the detailed reason goes to your `log` callback, never to the client.

`allowedHosts` accepts a `string`, `string[]` (exact host, `*.wildcard.com`, or `*`), or a function `(url: URL, req: NextRequest) => boolean`.

> ⚠️ **Breaking change in v2.0.0:** absolute endpoints are rejected unless their host is in `allowedHosts` (or matches `baseUrl`). If you forwarded arbitrary absolute URLs before, add their hosts to `allowedHosts`.

### CORS and credentials

The handler answers `OPTIONS` preflight automatically based on `allowOrigins`. A denied preflight returns a clean `403` with no `Access-Control-Allow-*` headers.

Set `corsCredentials: true` to send cookies / `Authorization` cross-origin. The proxy always reflects the **specific** request origin (never `*`), so it stays spec-compliant — and it **requires an explicit `allowOrigins` allowlist**:

```ts
nextProxyHandler({ allowOrigins: ["https://app.com"], corsCredentials: true });
// throws if allowOrigins is "*" or unset — that would grant credentialed CORS to any origin.
```

### Rate limiting

In-memory (per-instance, best-effort):

```ts
inMemoryRate: { windowMs: 15_000, max: 20 } // grouped by client IP, or key: (req) => "user:" + id
```

> ⚠️ The default counter lives in a single process. On serverless / multi-instance it is **per-instance**, not global.

For a **shared, strict limit**, pass a `RateLimitStore` (e.g. Redis):

```ts
import type { RateLimitStore } from "nextjs-proxy";

const redisStore: RateLimitStore = {
  async increment(key, windowMs) {
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, windowMs);
    return { count, resetAt: Date.now() + (await redis.pttl(key)) };
  },
};

nextProxyHandler({ inMemoryRate: { windowMs: 60_000, max: 100, store: redisStore } });
```

The exported `InMemoryRateLimitStore` class is the default backend; instantiate your own for an isolated counter namespace.

---

## Streaming (SSE / LLM token streaming)

By default the proxy buffers the upstream response and returns it as JSON. For Server-Sent Events, NDJSON, or LLM token streams you want the bytes to flow to the client as they arrive. Set `stream` to pipe the upstream body straight through, unbuffered.

```ts
// Always stream this route's responses (e.g. an LLM completion endpoint)
export const POST = nextProxyHandler({
  routes: { chat: "https://api.openai.com/v1/chat/completions" },
  stream: true,
});
```

> The upstream `Authorization` is taken from the incoming request's `Authorization` header (forwarded as a Bearer token). Keep provider secrets server-side with a `validate`/`transformRequest` hook or a fixed `route` as appropriate.

`stream` accepts:

- `true` — always pipe the body through.
- `"auto"` — stream only when the upstream `Content-Type` is stream-like (`text/event-stream`, `application/x-ndjson`, `application/stream+json`, `application/octet-stream`); otherwise buffer normally.
- `(req) => boolean | "auto"` — decide per request (e.g. based on a header).

```ts
// Stream only when the client asks for it
nextProxyHandler({
  allowedHosts: ["api.partner.com"],
  stream: (req) => req.headers.get("accept") === "text/event-stream",
});
```

**How streaming behaves:**

- All guards (auth, CSRF, CORS, rate limit, `validate`, SSRF) run **before** the fetch, so streaming never bypasses your security checks.
- Only `content-type` and `cache-control` are forwarded from the upstream. Every other upstream header (including `Set-Cookie`) is dropped. `X-Content-Type-Options: nosniff` is added, and `text/event-stream` also gets `X-Accel-Buffering: no` (so SSE survives buffering reverse proxies like nginx).
- `transformResponse` is **not** applied to a streamed body (it would require buffering the whole thing). `monitor` is called without the response argument. `log` still fires a `response` event with `payload: "[stream]"`.
- `timeoutMs` only guards **time-to-headers**. Once the stream starts there is no idle or total timeout — a slow upstream keeps the connection open up to your platform's function limit. Client disconnects rely on the runtime cancelling the upstream body.

---

## Full options

| Option | Type | Description |
| --- | --- | --- |
| `routes` | `Record<string,string> \| (name,req)=>string\|undefined` | **Named routes.** Client sends `{ route }`; server resolves the URL. Strongest SSRF protection. |
| `baseUrl` | `string` | Prefix for relative endpoints/routes. Its host is implicitly trusted. |
| `allowedHosts` | `string \| string[] \| (url,req)=>boolean` | SSRF allowlist for absolute client endpoints. |
| `allowPrivateHosts` | `boolean` | Allow internal/loopback/private hosts (default `false`). |
| `allowOrigins` | `string \| string[] \| (origin,req)=>boolean` | CORS allowlist. |
| `corsCredentials` | `boolean` | Emit `Access-Control-Allow-Credentials: true` (default `false`). Requires an explicit `allowOrigins`. |
| `corsMethods` / `corsHeaders` | `string[]` | Override the allowed CORS methods / headers. |
| `onCorsDenied` | `(origin) => any` | Custom response body for a denied origin. |
| `inMemoryRate` | `{ windowMs, max, key?, store? }` | Rate limiting. Pass `store` for a shared backend (Redis, etc.). |
| `rateLimit` | `(req) => boolean \| Promise` | Custom external rate-limit hook. |
| `timeoutMs` | `number` | Abort the upstream fetch after N ms (default `30000`; `0` disables). Times out with `504`. |
| `stream` | `boolean \| "auto" \| (req)=>boolean\|"auto"` | Pipe the upstream body straight to the client without buffering — for SSE / LLM token streaming. See [Streaming](#streaming-sse--llm-token-streaming). |
| `auth` / `csrf` / `validate` | `(req) => boolean \| Promise` | Pre-checks. Return `false` to reject (`401` / `403` / `401`). |
| `transformRequest` | `({method,endpoint,data,route}) => {...}` | Modify the payload before fetching. |
| `transformResponse` | `(res) => any` | Modify the response before returning (objects only). |
| `sanitize` / `maskSensitiveData` | `(data) => any` | Clean / redact data before sending upstream. |
| `log` | `(info) => void` | Receives `request` / `response` / `error` events for auditing. |
| `monitor` | `(req, res?) => void` | Hook for suspicious-activity monitoring. |

---

## Client-Side Usage — `proxyFetch` helper & React Hook

The package includes a type-safe client helper and React hook that abstract the POST-to-proxy pattern into a clean, typed API.

### Installation

Already installed — `proxyFetch`, `useProxyFetch`, and `ProxyFetchProvider` are re-exported from the same `nextjs-proxy` package:

```ts
import { proxyFetch, useProxyFetch, ProxyFetchProvider } from "nextjs-proxy";
```

### 1. Basic GET

```ts
import { proxyFetch } from "nextjs-proxy";

interface User {
  id: number;
  name: string;
}

const response = await proxyFetch<User>({
  route: "user",
  data: { id: 42 },
  // method defaults to "GET"
  // url defaults to "/api/proxy"
});

if (response.ok) {
  console.log(response.data.name); // ✅ typed as string
} else {
  console.log(response.status);    // e.g., 404
  console.log(response.error);     // server error details
}
```

### 2. POST with Data (Form Submission)

```ts
const response = await proxyFetch({
  route: "users",
  method: "POST",
  data: { name: "Alice", email: "alice@example.com" },
  headers: { "X-Request-ID": "abc-123" },
});

if (response.ok) {
  // Created — handle success
} else if (response.status === 400) {
  console.log(response.error); // Validation error
}
```

### 3. `useProxyFetch` Hook (Loading / Error / Data)

```tsx
import { useProxyFetch } from "nextjs-proxy";

function UserProfile({ userId }: { userId: number }) {
  const { data, error, loading, refetch } = useProxyFetch<User>({
    route: "user",
    data: { id: userId },
    enabled: true, // fetch on mount (default)
  });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  if (!data) return <div>No data</div>;

  return (
    <div>
      <p>{data.name}</p>
      <button onClick={() => refetch()}>Refresh</button>
    </div>
  );
}
```

### 4. Polling (Auto-Update)

```tsx
import { useProxyFetch } from "nextjs-proxy";

function LiveNotifications() {
  const { data: notifications, loading } = useProxyFetch({
    route: "notifications",
    enabled: true,
    refetchInterval: 5000, // Check every 5 seconds
  });

  return (
    <div>
      {loading && <span>Syncing...</span>}
      <ul>
        {notifications?.map((n: { id: string; message: string }) => (
          <li key={n.id}>{n.message}</li>
        ))}
      </ul>
    </div>
  );
}
```

Polling starts **after** the first response completes (not immediately on mount). It continues on error and is cleaned up on unmount.

### 5. Error Handling (Network vs Server)

```ts
import { proxyFetch } from "nextjs-proxy";

// HTTP errors (4xx/5xx) — returned in the response, never thrown
const response = await proxyFetch<User>({ route: "user" });

if (!response.ok) {
  // Server error — inspect response.status and response.error
  console.log(response.status);    // e.g., 500
  console.log(response.error);     // ErrorInfo { type: "server", status, message }
}

// Network errors (DNS fail, CORS, network down) — thrown as exceptions
try {
  const data = await proxyFetch({ route: "user" });
} catch (err) {
  // err is a TypeError (network) or AbortError (timeout)
  console.error("Network error:", (err as Error).message);
}
```

| Scenario | Behavior |
|----------|----------|
| HTTP 2xx | `response.ok === true`, `response.data` populated, `error` is `undefined` |
| HTTP 4xx/5xx | `response.ok === false`, `response.error` is `ErrorInfo { type: "server", status, message }` |
| Network down / DNS / CORS | `proxyFetch()` throws `TypeError` — catch with `try/catch` |
| Timeout (AbortController) | `proxyFetch()` throws `AbortError(name: "AbortError")` — catch with `try/catch` |

### 6. Context Setup (Global URL)

Wrap your app (or a subtree) with `ProxyFetchProvider` to set a global proxy URL:

```tsx
import { ProxyFetchProvider, proxyFetch } from "nextjs-proxy";

// In your app root:
<ProxyFetchProvider url="/api/v2/proxy">
  <App />
</ProxyFetchProvider>

// Any component inside the provider:
const response = await proxyFetch({ route: "user" }); // uses "/api/v2/proxy"

// Per-call URL always overrides context:
const response2 = await proxyFetch({
  route: "user",
  url: "/custom", // forces this URL for this call only
});
```

If no provider is present, `proxyFetch()` defaults to `"/api/proxy"`.

---

## Next.js setup

### 1. Route handler (the package API)

```ts
// app/api/proxy/route.ts
import { nextProxyHandler } from "nextjs-proxy";

export const POST = nextProxyHandler({
  /* options */
});
```

Need async setup? Build the options first — `nextProxyHandler` already returns the async handler:

```ts
export const POST = nextProxyHandler(await loadProxyOptions());
```

### 2. Optional global gate (middleware / proxy file)

For app-wide logic (auth, logging) you can pair it with the special Next.js file. This is independent of the package — `nextProxyHandler` is a route-handler factory and does **not** depend on it.

> **Next.js 16 rename:** the special `middleware` file became `proxy`.
>
> | Next.js | File | Export |
> | --- | --- | --- |
> | 16+ | `proxy.ts` | `export function proxy(...)` |
> | 13–15 | `middleware.ts` | `export function middleware(...)` |
>
> On Next.js 16 the `proxy` file runs on the **Node.js runtime** — `edge` is not supported there. Config flags were renamed too (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`).

### 3. Pages Router note

`nextProxyHandler` is built on the **Web Fetch API** (`NextRequest` / `NextResponse`). Classic Pages Router API routes (`pages/api/*`) use Node-style `(req, res)` handlers and are **not compatible**. If you use the Pages Router, add an **App Router route handler** for the proxy (both can coexist) and call `/api/proxy` from your frontend as usual.

---

## When to use what

| Solution | Best for | Limitation |
| --- | --- | --- |
| **Rewrites** (`next.config.js`) | Simple path forwarding, dev | No headers, auth, or logging |
| **http-proxy / middleware** | Custom control per route | Boilerplate, not App-Router native |
| **nextjs-proxy** | Centralized, secure, governed outbound traffic | A focused gateway, not a general server |

Use rewrites for simple dev forwarding. Use `nextjs-proxy` when you need **security, governance, and audit** over outbound traffic from one place.

## Common errors

| Message | Cause | Fix |
| --- | --- | --- |
| `Relative endpoint without baseUrl` | Relative endpoint, no `baseUrl` | Set `baseUrl` |
| `Endpoint not allowed` | Host blocked by SSRF guard | Add it to `allowedHosts` or use a `route` |
| `Unknown route` | `route` name not in `routes` | Check the route name |
| `Origin not allowed` | CORS blocked | Add the origin to `allowOrigins` |
| `Rate limit exceeded` | Limit reached | Raise `max` / window, or use a shared `store` |

## License

[MIT](https://github.com/arcademan21/nextjs-proxy/blob/main/LICENSE) © Haroldy Arturo Pérez Rodríguez — ArcadeMan
