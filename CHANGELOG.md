# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.3.1] - 2026-06-11

### Maintenance

- Added `homepage` field to `package.json` pointing to the project landing page
  for npmjs.com metadata display.

## [2.3.0] - 2026-06-11

### Added

- **`proxyFetch()` client helper** (`src/client.ts`): type-safe, convenient
  wrapper around the proxy endpoint with automatic error classification and
  response parsing. Accepts `{ route, data?, method?, headers?, url? }` and
  returns `ProxyFetchResponse<T>` with `{ ok, status, data?, error?, headers? }`.
  HTTP errors (4xx/5xx) are returned in the response — only network errors throw.
  Generics: `proxyFetch<User>({ route: "user" })` types the `data` field.
  Response parsing falls back gracefully: JSON → text → binary descriptor.

- **`useProxyFetch()` React hook** (`src/hooks.ts`): wraps `proxyFetch()` with
  state management (`loading`, `data`, `error`), manual `refetch()`, optional
  polling via `refetchInterval`, and `onSuccess`/`onError` callbacks. Polling
  starts after the first response (not immediately), cleans up on unmount, and
  restarts on manual refetch. Refetch is debounced while a request is in flight.

- **`ProxyFetchProvider` React Context** (`src/context.tsx`): optional context
  provider that injects a proxy URL into all child `proxyFetch()` and
  `useProxyFetch()` calls. Defaults to `"/api/proxy"` when no provider is
  present. Per-call `url` option overrides the context value.

- **New exports** (`src/index.ts`): re-exports `client.ts`, `context.tsx`, and
  `hooks.ts` modules from the package entry point.

- **README** section with 6 usage examples: basic GET, POST with data,
  `useProxyFetch` hook (loading/error/data), polling, error handling (network
  vs server), and Context setup.

### Changed

- `jest.config.js`: added `.tsx` extension support for React hook tests.
- `tsconfig.json`: enabled `"jsx": "react-jsx"` for `.tsx` compilation.

### Dev

- 158 total tests (66 new: 29 unit + 28 hook + 9 integration).
- `client.ts`: 100% coverage (statements, branches, functions, lines).
- `hooks.ts`: 98.03% statement coverage.
- Overall: 96.83% statements, 91.78% branches, 100% functions, 98.7% lines.

## [2.2.3] - 2026-06-06

### Added

- Targeted unit tests raising branch coverage from ~83% to ~91% and statement
  coverage from ~89% to ~96% (92 tests). New cases cover the in-memory store
  sweep of expired entries, `x-forwarded-for` IP fallback, the internal-host
  classifier (IPv6 unique-local/link-local, private LAN), the `allowedHosts`
  function allow/deny paths, guard-failure log events (`auth`/`csrf`), the
  `onCorsDenied` hook, `Authorization` Bearer normalization, the binary-response
  fallback, the upstream timeout (504), and `monitor` on the streaming path.
- `typecheck` script (`tsc --noEmit`) wired as a `pretest` step so local `test`
  runs the same type gate as CI.

### Changed

- `tsconfig.json`: enabled `isolatedModules` to satisfy `ts-jest` under the
  NodeNext module resolution and remove its hybrid-module-kind warning.
- Migrated the project history from `CHANGE.log` to this `CHANGELOG.md` following
  the Keep a Changelog convention for better discoverability on npm and GitHub.

### Removed

- Deleted the empty `src/types/` directory (dead structure; the package ships no
  hand-written type shims).

### Security

- Documented a runtime limitation of the internal-host classifier: `new URL()`
  normalizes an IPv4-mapped IPv6 literal (e.g. `[::ffff:127.0.0.1]`) to its
  compressed hex form (`[::ffff:7f00:1]`), so the decimal IPv4-mapped branch in
  `isInternalHost` is not reached through the request path. Loopback via that
  literal is not classified as internal; in practice the upstream `fetch` fails
  closed (500) rather than connecting. Prefer named `routes` or an explicit
  `allowedHosts` allowlist for SSRF-sensitive deployments.

## [2.2.2] - 2026-06-05

### Changed

- Formatting only (no runtime change): reformatted `src/proxy.ts` to satisfy the
  project formatter (trailing commas on multi-line arguments, consistent blank
  lines). No control flow, status codes, strings, or security logic changed; the
  full suite, type-check, lint, build, and the Next 13/14/15 compat matrix stay
  green.

## [2.2.1] - 2026-06-04

### Changed

- Maintenance only (no runtime change): metadata, dev type-tooling, and tests.
- Normalized `repository.url` to
  `git+https://github.com/arcademan21/nextjs-proxy.git` so npm and tooling
  resolve the repository cleanly (removes the npm publish warning).
- Removed two redundant hand-written `next/server` type shims; the test mocks now
  typecheck against the real Next types (`next` devDependency), keeping the
  package's own type surface honest instead of shadowing it.

### Added

- Real runtime integration test (`test/integration.test.ts`): a genuine
  `NextRequest` driving a live `http` upstream over real `fetch` into a real
  `NextResponse` — covering buffered JSON + CORS origin reflection, SSE streaming
  passthrough headers, upstream-status passthrough, and the loopback SSRF block
  (403).

## [2.2.0] - 2026-06-04

### Added

- Streaming passthrough via the new `stream` option: pipe the upstream body
  straight to the client without buffering — for Server-Sent Events, NDJSON, and
  LLM token streaming. Additive and fully backward compatible (unset/`false`
  keeps the existing buffered JSON behavior).
  - `stream: true` always pipes; `stream: "auto"` pipes only when the upstream
    `Content-Type` essence is stream-like (`text/event-stream`,
    `application/x-ndjson`, `application/stream+json`,
    `application/octet-stream`); `stream: (req) => boolean | "auto"` decides per
    request.
  - 13 streaming tests including guard-before-stream, SSRF-block, header
    stripping, and non-ok passthrough.

### Security

- All guards (auth, CSRF, CORS, rate limit, `validate`, SSRF) run before the
  fetch, so streaming never bypasses them. Only `content-type` and
  `cache-control` are forwarded; every other upstream header (including
  `Set-Cookie`) is dropped. Adds `X-Content-Type-Options: nosniff`, and
  `X-Accel-Buffering: no` for `text/event-stream`.
- `"auto"` matches the parsed MIME essence exactly (not a loose substring), so a
  stream-like charset on a non-stream type cannot trip the heuristic.

### Changed

- `transformResponse` is skipped for streamed bodies; `monitor` is called without
  the response; `log` fires a `response` event with `payload: "[stream]"`.
- `timeoutMs` only guards time-to-headers; an in-progress stream has no idle or
  total timeout (documented).

## [2.1.1] - 2026-06-04

### Changed

- Docs only (no runtime change): documentation and language-consistency pass.
- Rewrote the README with a product-adoption focus: leads with the problem,
  presents named routes as the recommended happy path with a before/after
  comparison, and documents security, CORS credentials, the rate-limit store, and
  timeouts against the actual handler API.
- Translated the remaining Spanish JSDoc/inline comments in `src/proxy.ts` and the
  full changelog to English.

### Removed

- Removed the "No Turbopack Compatibility" warning. Verified empirically:
  installing the published tarball into a Next.js 15.5 app and running
  `next build --turbopack` compiles the proxy route cleanly. The old warning only
  reflected Turbopack's local symlink/workspace resolution during package
  development.

## [2.1.0] - 2026-06-04

### Added

- Named routes (stronger SSRF protection): new `routes` option
  (`Record<string,string> | (name, req) => string | undefined`). The client sends
  `{ route: "name" }` instead of a URL and the server resolves the destination, so
  the client no longer controls where the request goes (eliminates client-driven
  SSRF in this mode — the recommended way to use the proxy).
- Pluggable rate-limit store: new `RateLimitStore` interface
  (`increment(key, windowMs) => { count, resetAt }`) and `inMemoryRate.store`
  option to back the limit with a shared backend (e.g. Redis) so it holds globally
  across instances/serverless. The default in-memory store is exported as the
  `InMemoryRateLimitStore` class.
- CORS with credentials (opt-in): new `corsCredentials` option that emits
  `Access-Control-Allow-Credentials: true` on the preflight and the response. The
  proxy always reflects the specific origin (never `*`), so credentialed CORS
  stays spec-compliant.

### Security

- Resolved routes are server-defined trusted destinations: they bypass
  `allowedHosts` but still respect the `http`/`https` protocol check and the
  internal-host check (`allowPrivateHosts`) as defense in depth. An unknown
  `route` returns `400 { error: "Unknown route" }` without disclosing which names
  exist; inherited keys (e.g. `constructor`) are not resolved.
- `nextProxyHandler` throws at construction if `corsCredentials` is combined with
  a wildcard (`"*"`) or unset `allowOrigins`, since reflecting the origin with
  credentials would grant it to any origin (credentialed-response leak). An
  explicit allowlist is required.
- If a `transformRequest` rewrites the `endpoint`, the named route's trust is
  dropped and the resulting URL is re-validated against `allowedHosts` (route
  trust is not inherited).

### Changed

- All changes are additive; no existing signature is broken.

## [2.0.0] - 2026-06-04

### Added

- SSRF protection. New `allowedHosts` option
  (`string | string[] | (url, req) => boolean`): allowlist of destination hosts
  for absolute endpoints. Supports exact host, subdomain wildcard
  (`*.example.com`), and `*`.
- New `allowPrivateHosts` option (default `false`): blocks internal/loopback/
  private hosts (`127.0.0.1`, `localhost`, `169.254.169.254`/cloud metadata,
  `10/8`, `172.16/12`, `192.168/16`, and their IPv6 equivalents). The host of
  `baseUrl` is implicitly trusted for relative endpoints.
- New `timeoutMs` option (default `30000`, `0` disables): aborts the upstream
  fetch with `AbortController`; timeouts return `504`.

### Changed

- **BREAKING:** absolute endpoints are now rejected (`403`) unless their host is
  in `allowedHosts` or matches `baseUrl`. Denials return
  `403 { error: "Endpoint not allowed" }`; the detailed reason goes only to the
  `log` callback, never to the client.
- **BREAKING:** removed `nextProxyHandlerAsync` (a YAGNI wrapper that just
  returned `nextProxyHandler(options)` in a promise). Use `nextProxyHandler`
  directly; if you need async initialization, build the options with `await` and
  pass them to the handler.
- IP resolution prefers `x-real-ip` over `x-forwarded-for` and documents that both
  are spoofable (not a security boundary).

### Fixed

- `transformRequest`: fixed a bug where a missing `method`/`endpoint` became the
  string `"undefined"` (truthy) and slipped past validation, attempting to proxy
  to an invalid endpoint. It now returns `400`.
- Information leak: the `500` no longer serializes the internal error to the
  client (`{ error: "Internal proxy error" }`); the full detail goes only to the
  `log` callback.
- In-memory rate limit: expired entries are purged (prevents unbounded memory
  growth) and it is documented as per-instance best-effort on serverless.
- CORS: a denied `OPTIONS` preflight no longer reflects
  `Access-Control-Allow-Origin` for the denied origin; it now returns a clean
  `403` with no `Access-Control-Allow-*` headers.
- Fixed the `license` field in `package.json` (`"Public"` → `"MIT"`), now
  consistent with the LICENSE file and the code headers.
- Removed `@types/next` from `devDependencies` (a deprecated stub that
  transitively pulled a vulnerable `next`); pinned `next@^15.5.19` +
  `react`/`react-dom` for local typecheck/tests.

## [2025-09-16]

### Added

- Two versions of `nextProxyHandler`: synchronous
  (`export const POST = nextProxyHandler(...)`) and asynchronous
  (`nextProxyHandlerAsync`) for advanced initialization.

[Unreleased]: https://github.com/arcademan21/nextjs-proxy/compare/v2.3.1...HEAD
[2.3.1]: https://github.com/arcademan21/nextjs-proxy/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/arcademan21/nextjs-proxy/compare/v2.2.3...v2.3.0
[2.2.3]: https://github.com/arcademan21/nextjs-proxy/compare/v2.2.2...v2.2.3
[2.2.2]: https://github.com/arcademan21/nextjs-proxy/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/arcademan21/nextjs-proxy/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/arcademan21/nextjs-proxy/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/arcademan21/nextjs-proxy/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/arcademan21/nextjs-proxy/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/arcademan21/nextjs-proxy/releases/tag/v2.0.0
