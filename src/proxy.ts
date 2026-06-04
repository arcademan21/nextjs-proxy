// Interfaz para logging detallado
export type LogLevel = "info" | "debug" | "error";
export interface LogInfo {
  type: "request" | "response" | "error";
  level: LogLevel;
  timestamp: string;
  ip?: string;
  method?: string;
  origin?: string;
  endpoint?: string;
  status?: number;
  durationMs?: number;
  payload?: unknown;
  error?: unknown;
}
// Tipos para transformación segura de request y response
export interface ProxyRequestPayload {
  method: string;
  endpoint: string;
  data?: Record<string, unknown>;
  /**
   * Name of a server-defined route (see `NextProxyOptions.routes`). When the
   * client sends `{ route }`, the proxy resolves it to `endpoint` server-side,
   * so the client never controls the destination URL.
   */
  route?: string;
}

export interface ProxyResponsePayload {
  [key: string]: unknown;
}
/**
 * Next Proxy - Universal API Proxy for Next.js
 * Security, CORS, centralization, logging, request/response transformation, and access control.
 * @author Haroldy Arturo Pérez Rodríguez - ArcadeMan <haroldyarturo@gmail.com>
 * @license MIT
 */

// Next.js types
import { NextRequest, NextResponse } from "next/server";

// HTTP methods that do not have a body
const WITHOUT_BODY = ["GET", "HEAD"];

// Options for the proxy handler
export interface NextProxyOptions {
  /** Validación de autenticación */
  auth?: (req: NextRequest) => boolean | Promise<boolean>;
  /** Sanitización de datos antes de enviar */
  sanitize?: (data: unknown) => unknown;
  /** Protección contra CSRF/XSS */
  csrf?: (req: NextRequest) => boolean | Promise<boolean>;
  /** Monitoreo de actividad sospechosa */
  monitor?: (req: NextRequest, res?: unknown) => void;
  /** Logging callback for request/response/error events */
  log?: (info: LogInfo) => void;
  /** Pre-validation (auth, permissions, etc.) */
  validate?: (req: NextRequest) => Promise<boolean> | boolean;
  /** Transform input data (method, endpoint, data) before proxying */
  transformRequest?: (
    payload: ProxyRequestPayload
  ) => Partial<ProxyRequestPayload> | void;
  /** Transform the response before returning to the client */
  transformResponse?: (res: ProxyResponsePayload) => ProxyResponsePayload;
  /** External rate limiting (true = allowed) */
  rateLimit?: (req: NextRequest) => Promise<boolean> | boolean;
  /** Allowed origins for CORS. Puede ser:
   * - string: '*' para todos, o un origen específico
   * - string[]: lista de orígenes permitidos
   * - función: (origin, req) => boolean para lógica personalizada
   */
  allowOrigins?:
    | string
    | string[]
    | ((origin: string, req: NextRequest) => boolean);
  /** Métodos permitidos para CORS (por defecto POST,OPTIONS) */
  corsMethods?: string[];
  /** Encabezados permitidos para CORS (por defecto Content-Type, Authorization) */
  corsHeaders?: string[];
  /** Mask sensitive data before sending */
  maskSensitiveData?: (data: unknown) => unknown;
  /** Base URL for relative endpoints */
  baseUrl?: string;
  /**
   * Abort the upstream fetch after this many milliseconds. Prevents a hung
   * upstream from holding the (serverless) function open and burning time.
   * Defaults to 30000 (30s). Set to `0` to disable the timeout.
   */
  timeoutMs?: number;
  /**
   * Allowlist of upstream destination hosts for ABSOLUTE endpoints (SSRF protection).
   * - `string` / `string[]`: exact host, wildcard subdomain (`"*.example.com"`), or `"*"` for any public host
   * - function: `(url, req) => boolean` for custom logic
   * The host of `baseUrl` is always implicitly allowed.
   * If omitted, absolute endpoints are rejected and only relative endpoints resolved via `baseUrl` are permitted.
   */
  allowedHosts?: string | string[] | ((url: URL, req: NextRequest) => boolean);
  /**
   * Allow requests to internal/private/loopback/link-local hosts
   * (e.g. `127.0.0.1`, `169.254.169.254`, `10.x`, `192.168.x`, `*.localhost`).
   * Disabled by default to prevent SSRF against cloud metadata and internal services.
   */
  allowPrivateHosts?: boolean;
  /**
   * Named server-side routes. The SAFEST way to use this proxy: the client
   * sends `{ route: "name" }` instead of a raw URL and the server resolves the
   * destination here, so the client never controls where the request goes
   * (eliminates client-driven SSRF for this mode).
   *
   * - Record form: a `{ name: url }` map. `url` may be absolute or a relative
   *   path resolved via `baseUrl`.
   * - Function form: `(name, req) => url | undefined`. Return `undefined` to
   *   reject an unknown route.
   *
   * Resolved named-route destinations are server-defined and therefore trusted:
   * they bypass `allowedHosts`, but still respect `allowPrivateHosts` and the
   * `http`/`https` protocol check as defense in depth.
   */
  routes?:
    | Record<string, string>
    | ((name: string, req: NextRequest) => string | undefined);
  /** Custom response when origin is not allowed */
  onCorsDenied?: (origin: string) => unknown;
  /**
   * In-memory rate limiter implementation.
   *
   * NOTE: this counter lives in a single process instance. On serverless /
   * multi-instance deployments the limit is per-instance and best-effort, not
   * a global guarantee. For strict, shared limits use the `rateLimit` hook
   * backed by an external store (e.g. Redis).
   */
  inMemoryRate?: {
    windowMs: number; // window in ms
    max: number; // max requests per window
    key?: (req: NextRequest) => string; // how to identify the client
    /**
     * Backend that records hits. Defaults to a shared in-process
     * `InMemoryRateLimitStore`. Provide a shared `RateLimitStore` (e.g. Redis)
     * to enforce the limit globally across instances. The `windowMs`/`max`/`key`
     * values above still drive the windowing and the allow/deny decision.
     */
    store?: RateLimitStore;
  };
}

// Internal state for in-memory rate limiting
interface InternalRateState {
  count: number;
  expires: number;
}

/** Result of incrementing a rate-limit counter for a key. */
export interface RateLimitHit {
  /** Number of requests recorded in the current window, including this hit. */
  count: number;
  /** Epoch milliseconds at which the current window resets. */
  resetAt: number;
}

/**
 * Pluggable rate-limit backend. Implement this to back rate limiting with a
 * shared store (Redis, Memcached, a database) so the limit holds across
 * serverless / multi-instance deployments. `increment` must record one hit for
 * `key` within a `windowMs` window and return the running count and reset time.
 *
 * Example (Redis): `INCR key`; if the result is 1, `PEXPIRE key windowMs`;
 * return `{ count, resetAt: now + pttl }`.
 */
export interface RateLimitStore {
  increment(
    key: string,
    windowMs: number
  ): Promise<RateLimitHit> | RateLimitHit;
}

/**
 * Default in-process rate-limit store backed by a Map. Counters live in a
 * single instance, so on serverless / multi-instance deployments the limit is
 * per-instance and best-effort. For strict global limits, pass a shared
 * `RateLimitStore` (e.g. Redis) via `inMemoryRate.store`.
 *
 * Instantiate your own to get an isolated counter namespace; the proxy uses a
 * shared module-level instance by default.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private store: Map<string, InternalRateState> = new Map();
  // Last time we purged expired entries, to bound the store's memory growth.
  private lastSweep = 0;

  /**
   * Remove expired entries so the store does not grow unbounded on a long-lived
   * instance. Runs at most once per `windowMs` to keep it cheap.
   */
  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    for (const [key, state] of this.store) {
      if (state.expires < now) this.store.delete(key);
    }
  }

  increment(key: string, windowMs: number): RateLimitHit {
    const now = Date.now();
    this.sweep(now, windowMs);
    const current = this.store.get(key);
    if (!current || current.expires < now) {
      const resetAt = now + windowMs;
      this.store.set(key, { count: 1, expires: resetAt });
      return { count: 1, resetAt };
    }
    current.count += 1;
    return { count: current.count, resetAt: current.expires };
  }
}

// Shared default store used when `inMemoryRate.store` is not provided.
const defaultRateStore = new InMemoryRateLimitStore();

/**
 * Apply in-memory rate limiting via the configured (or default) store.
 * @returns True if the request is allowed, false if rate limited.
 */
async function applyInMemoryRate(
  req: NextRequest,
  cfg: NonNullable<NextProxyOptions["inMemoryRate"]>
): Promise<boolean> {
  const key = cfg.key ? cfg.key(req) : getClientIp(req);
  const store = cfg.store ?? defaultRateStore;
  const { count } = await store.increment(key, cfg.windowMs);
  return count <= cfg.max;
}

/** Get a best-effort client IP from request headers or connection info.
 *
 * WARNING: `x-real-ip` and `x-forwarded-for` are client-supplied headers. They
 * are only trustworthy when set by a proxy/platform you control that overwrites
 * (not appends to) them. Behind an untrusted network these can be spoofed, so
 * do NOT treat this value as a security boundary. For rate limiting that must
 * resist spoofing, supply `inMemoryRate.key` (or the external `rateLimit` hook)
 * with an identifier derived from a source you trust.
 * @param req The NextRequest object
 * @returns The client IP as a string
 */
function getClientIp(req: NextRequest): string {
  // Prefer x-real-ip (single value typically set by the edge/platform) over
  // x-forwarded-for (a client-controllable, comma-separated chain).
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  // @ts-ignore acceso interno no tipado en modo Node runtime
  const nodeReq = (
    req as unknown as { _req?: { socket?: { remoteAddress?: string } } }
  )?._req; // best effort
  return nodeReq?.socket?.remoteAddress || "anon";
}

/**
 * Detect internal/private/loopback/link-local hosts. These are blocked by default
 * to prevent SSRF against cloud metadata (169.254.169.254), localhost and LAN ranges.
 * @param hostname The URL hostname (may include IPv6 brackets)
 */
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal") return true;
  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10)
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]*:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]*:/.test(h)) return true;
  // IPv4 (also IPv4-mapped IPv6 like ::ffff:127.0.0.1)
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const ip = mapped ? mapped[1] : h;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const oct = m.slice(1).map((n) => Number(n));
    if (oct.some((n) => n > 255)) return false;
    const [a, b] = oct;
    if (a === 0 || a === 127) return true; // this-host / loopback
    if (a === 10) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  }
  return false;
}

/** Extract the hostname from a URL string, or undefined if it cannot be parsed. */
function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/** Match a host against a pattern: exact, `"*"` (any), or `"*.suffix"` wildcard subdomain. */
function matchHostPattern(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase().trim();
  const h = hostname.toLowerCase();
  if (p === "*") return true;
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  return false;
}

/**
 * Resolve a named route to a destination URL using `options.routes`.
 * Returns undefined when routes are not configured or the name is unknown.
 */
function resolveNamedRoute(
  name: string,
  req: NextRequest,
  options: NextProxyOptions
): string | undefined {
  const routes = options.routes;
  if (!routes) return undefined;
  if (typeof routes === "function") return routes(name, req) || undefined;
  // Own-property check avoids resolving inherited keys like "constructor".
  return Object.prototype.hasOwnProperty.call(routes, name)
    ? routes[name]
    : undefined;
}

/**
 * SSRF guard. Decide whether the resolved upstream URL may be fetched.
 * Secure by default: internal hosts are blocked (unless `allowPrivateHosts`),
 * and absolute hosts must match `baseUrl`'s host, `allowedHosts`, or be approved
 * by the `allowedHosts` function. Returns a reason for logging when denied.
 *
 * `trusted` marks a server-defined destination (a resolved named route); it
 * bypasses the `allowedHosts` allowlist but still enforces the protocol and
 * internal-host checks.
 */
function isUpstreamAllowed(
  rawUrl: string,
  req: NextRequest,
  options: NextProxyOptions,
  trusted = false
): { ok: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid endpoint URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Unsupported protocol" };
  }
  const host = url.hostname;

  if (!options.allowPrivateHosts && isInternalHost(host)) {
    return { ok: false, reason: "Blocked internal/private host" };
  }

  // Server-defined named routes are trusted destinations; skip the allowlist.
  if (trusted) {
    return { ok: true };
  }

  // The host of baseUrl is implicitly trusted (relative endpoints resolve here).
  const baseHost = options.baseUrl ? hostOf(options.baseUrl) : undefined;
  if (baseHost && host.toLowerCase() === baseHost.toLowerCase()) {
    return { ok: true };
  }

  const allow = options.allowedHosts;
  if (allow === undefined || allow === null) {
    return {
      ok: false,
      reason: baseHost
        ? "Absolute endpoint host not allowed (only baseUrl host is permitted)"
        : "No allowedHosts configured for absolute endpoints",
    };
  }
  if (typeof allow === "function") {
    return allow(url, req)
      ? { ok: true }
      : { ok: false, reason: "Host denied by allowedHosts function" };
  }
  const list = Array.isArray(allow) ? allow : [allow];
  return list.some((p) => matchHostPattern(p, host))
    ? { ok: true }
    : { ok: false, reason: "Host not in allowedHosts" };
}

/**
 * Universal handler for proxying API requests in Next.js
 * @param options Advanced options for logging, validation, transformation, etc.
 */
export function nextProxyHandler(options: NextProxyOptions = {}) {
  // Helper para validar origen
  function isOriginAllowed(origin: string, req: NextRequest): boolean {
    if (!options.allowOrigins) return true;
    if (typeof options.allowOrigins === "string") {
      if (options.allowOrigins === "*") return true;
      return origin === options.allowOrigins;
    }
    if (Array.isArray(options.allowOrigins)) {
      if (options.allowOrigins.includes("*")) return true;
      return options.allowOrigins.includes(origin);
    }
    if (typeof options.allowOrigins === "function") {
      return options.allowOrigins(origin, req);
    }
    return false;
  }
  return async function handler(req: NextRequest) {
    const origin = req.headers.get("origin") || "";

    // Validación de autenticación
    if (options.auth && !(await options.auth(req))) {
      if (options.log)
        options.log({
          type: "error",
          level: "error",
          timestamp: new Date().toISOString(),
          ip: getClientIp(req),
          method: req.method,
          origin,
          endpoint: undefined,
          status: 401,
          durationMs: undefined,
          payload: undefined,
          error: "Unauthorized (auth)",
        });
      return NextResponse.json(
        { error: "Unauthorized (auth)" },
        { status: 401 }
      );
    }

    // Protección CSRF/XSS
    if (options.csrf && !(await options.csrf(req))) {
      if (options.log)
        options.log({
          type: "error",
          level: "error",
          timestamp: new Date().toISOString(),
          ip: getClientIp(req),
          method: req.method,
          origin,
          endpoint: undefined,
          status: 403,
          durationMs: undefined,
          payload: undefined,
          error: "Forbidden (csrf/xss)",
        });
      return NextResponse.json(
        { error: "Forbidden (csrf/xss)" },
        { status: 403 }
      );
    }

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      if (!isOriginAllowed(origin, req)) {
        const denied = options.onCorsDenied?.(origin) || {
          error: "Origin not allowed",
        };
        // Do NOT echo Access-Control-Allow-* headers on a denied preflight:
        // reflecting the denied origin would tell the browser it is allowed,
        // defeating the CORS check. Return a clean 403 with no CORS grant.
        return new NextResponse(JSON.stringify(denied), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": (
            options.corsHeaders ?? ["Content-Type", "Authorization"]
          ).join(", "),
          "Access-Control-Allow-Methods": (
            options.corsMethods ?? ["POST", "OPTIONS"]
          ).join(","),
        },
      });
    }

    if (!isOriginAllowed(origin, req)) {
      const denied = options.onCorsDenied?.(origin) || {
        error: "Origin not allowed",
      };
      return NextResponse.json(denied, { status: 403 });
    }

    // In-memory rate limiting if configured
    if (
      options.inMemoryRate &&
      !(await applyInMemoryRate(req, options.inMemoryRate))
    ) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }

    // External/custom rate limiting
    if (options.rateLimit && !(await options.rateLimit(req))) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }

    // Custom validation (auth, permissions, etc.)
    if (options.validate && !(await options.validate(req))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Log request event
    if (options.log)
      options.log({
        type: "request",
        level: "info",
        timestamp: new Date().toISOString(),
        ip: getClientIp(req),
        method: req.method,
        origin,
        payload: undefined,
      });

    try {
      const token = req.headers.get("Authorization");
      let payload: Record<string, unknown> = {};
      try {
        payload = await req.json();
      } catch {
        /* ignore empty body */
      }
      let { method, endpoint, data, route } = payload as {
        method?: unknown;
        endpoint?: unknown;
        data?: unknown;
        route?: unknown;
      };

      // Named route resolution. When the client sends `{ route }`, resolve the
      // destination server-side so the client never controls the URL. A
      // resolved route is a trusted, server-defined destination.
      let routeTrusted = false;
      if (route != null && route !== "") {
        if (!options.routes) {
          return NextResponse.json(
            { error: "Named routes are not configured" },
            { status: 400 }
          );
        }
        const resolved = resolveNamedRoute(String(route), req, options);
        if (!resolved) {
          // Generic message: do not disclose which route names exist.
          return NextResponse.json(
            { error: "Unknown route" },
            { status: 400 }
          );
        }
        endpoint = resolved;
        routeTrusted = true;
      }

      if (options.transformRequest) {
        // Do NOT coerce missing values to the string "undefined" here: that
        // would be truthy and slip past the validation guard below, causing a
        // proxy attempt to a bogus endpoint. Pass empty strings for absent
        // values and only overwrite when the transform returns a real value.
        const transformed =
          options.transformRequest({
            method: method == null ? "" : String(method),
            endpoint: endpoint == null ? "" : String(endpoint),
            data:
              typeof data === "object" && data !== null
                ? (data as Record<string, unknown>)
                : {},
            route: route == null ? undefined : String(route),
          }) || {};
        if (transformed.method !== undefined) method = transformed.method;
        if (transformed.endpoint !== undefined) endpoint = transformed.endpoint;
        if (transformed.data !== undefined) data = transformed.data;
      }

      if (!method || !endpoint) {
        return NextResponse.json(
          { error: "Missing method or endpoint" },
          { status: 400 }
        );
      }

      // Resolve relative endpoints using baseUrl
      if (!/^https?:\/\//i.test(String(endpoint))) {
        if (!options.baseUrl) {
          return NextResponse.json(
            { error: "Relative endpoint without baseUrl" },
            { status: 400 }
          );
        }
        endpoint =
          options.baseUrl.replace(/\/$/, "") +
          "/" +
          String(endpoint).replace(/^\//, "");
      }

      // SSRF guard: validate the final upstream host before issuing the fetch.
      const upstreamCheck = isUpstreamAllowed(
        String(endpoint),
        req,
        options,
        routeTrusted
      );
      if (!upstreamCheck.ok) {
        if (options.log)
          options.log({
            type: "error",
            level: "error",
            timestamp: new Date().toISOString(),
            ip: getClientIp(req),
            method: String(method),
            origin,
            endpoint: String(endpoint),
            status: 403,
            durationMs: undefined,
            payload: undefined,
            error: `Endpoint not allowed: ${upstreamCheck.reason}`,
          });
        return NextResponse.json(
          { error: "Endpoint not allowed" },
          { status: 403 }
        );
      }

      // Sanitización de datos si está configurado
      if (options.sanitize) {
        data = options.sanitize(data);
      }
      // Mask sensitive data if configurado
      if (options.maskSensitiveData) {
        data = options.maskSensitiveData(data);
      }

      const upperMethod = String(method).toUpperCase();
      const fetchOptions: RequestInit = { method: upperMethod };
      const headers: Record<string, string> = {};
      if (token)
        headers["Authorization"] = token.startsWith("Bearer")
          ? token
          : `Bearer ${token}`;
      if (!WITHOUT_BODY.includes(upperMethod)) {
        headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify(data ?? {});
      }
      if (Object.keys(headers).length) fetchOptions.headers = headers;

      // Proxy the request to the external endpoint, guarded by a timeout so a
      // hung upstream cannot hold the function open indefinitely.
      const timeoutMs = options.timeoutMs ?? 30000;
      const controller = timeoutMs > 0 ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
      if (controller) fetchOptions.signal = controller.signal;
      const started = Date.now();
      let upstream: Response;
      try {
        upstream = await fetch(endpoint as RequestInfo, fetchOptions);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const durationMs = Date.now() - started;

      // Parse the response as JSON, text, or fallback to binary
      let response: unknown;
      try {
        response = await upstream.json();
      } catch {
        try {
          response = await upstream.text();
        } catch {
          const buffer = await upstream.arrayBuffer();
          response = {
            message: "Unprocessable response (binary)",
            length: buffer.byteLength,
          };
        }
      }

      // Transform the response si está configurado y es objeto
      if (
        options.transformResponse &&
        typeof response === "object" &&
        response !== null
      )
        response = options.transformResponse(response as ProxyResponsePayload);

      // Log response event
      if (options.log)
        options.log({
          type: "response",
          level: "info",
          timestamp: new Date().toISOString(),
          ip: getClientIp(req),
          method: String(method),
          origin,
          endpoint: String(endpoint),
          status: upstream.status,
          durationMs,
          payload: response,
        });
      // Monitoreo de actividad sospechosa
      if (options.monitor) {
        options.monitor(req, response);
      }

      if (!upstream.ok)
        return NextResponse.json(response, { status: upstream.status });
      return NextResponse.json(response, {
        headers: options.allowOrigins
          ? {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Headers": (
                options.corsHeaders ?? ["Content-Type", "Authorization"]
              ).join(", "),
              "Access-Control-Allow-Methods": (
                options.corsMethods ?? ["POST", "OPTIONS"]
              ).join(","),
            }
          : undefined,
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      // Log error event
      if (options.log)
        options.log({
          type: "error",
          level: "error",
          timestamp: new Date().toISOString(),
          ip: getClientIp(req),
          method: req.method,
          origin,
          endpoint: undefined,
          status: isTimeout ? 504 : 500,
          durationMs: undefined,
          payload: undefined,
          error: error,
        });
      if (isTimeout) {
        return NextResponse.json(
          { error: "Upstream request timed out" },
          { status: 504 }
        );
      }
      // Do not leak internal error details (messages, stack, upstream
      // internals) to the client. The full error is still delivered to the
      // `log` callback above for server-side observability.
      return NextResponse.json(
        { error: "Internal proxy error" },
        { status: 500 }
      );
    }
  };
}

// Default export for convenience
export default nextProxyHandler;
