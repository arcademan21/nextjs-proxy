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
  /** Custom response when origin is not allowed */
  onCorsDenied?: (origin: string) => unknown;
  /** In-memory rate limiter implementation */
  inMemoryRate?: {
    windowMs: number; // window in ms
    max: number; // max requests per window
    key?: (req: NextRequest) => string; // how to identify the client
  };
}

// Internal state for in-memory rate limiting
interface InternalRateState {
  count: number;
  expires: number;
}

// Simple in-memory store for rate limiting
const rateStore: Map<string, InternalRateState> = new Map();

/**
 * Apply in-memory rate limiting
 * @param req The NextRequest object
 * @param cfg The rate limiting configuration
 * @returns True if the request is allowed, false if rate limited
 */
function applyInMemoryRate(
  req: NextRequest,
  cfg: NonNullable<NextProxyOptions["inMemoryRate"]>
): boolean {
  const key = cfg.key ? cfg.key(req) : getClientIp(req);
  const now = Date.now();
  const current = rateStore.get(key);
  if (!current || current.expires < now) {
    rateStore.set(key, { count: 1, expires: now + cfg.windowMs });
    return true;
  }
  if (current.count >= cfg.max) return false;
  current.count += 1;
  return true;
}

/** Get client IP from request headers or connection info
 * @param req The NextRequest object
 * @returns The client IP as a string
 */
function getClientIp(req: NextRequest): string {
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
 * SSRF guard. Decide whether the resolved upstream URL may be fetched.
 * Secure by default: internal hosts are blocked (unless `allowPrivateHosts`),
 * and absolute hosts must match `baseUrl`'s host, `allowedHosts`, or be approved
 * by the `allowedHosts` function. Returns a reason for logging when denied.
 */
function isUpstreamAllowed(
  rawUrl: string,
  req: NextRequest,
  options: NextProxyOptions
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
        return new NextResponse(JSON.stringify(denied), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
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
    if (options.inMemoryRate && !applyInMemoryRate(req, options.inMemoryRate)) {
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
      let { method, endpoint, data } = payload as {
        method?: unknown;
        endpoint?: unknown;
        data?: unknown;
      };

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
      const upstreamCheck = isUpstreamAllowed(String(endpoint), req, options);
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

      // Proxy the request to the external endpoint
      const started = Date.now();
      const upstream = await fetch(endpoint as RequestInfo, fetchOptions);
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
          status: 500,
          durationMs: undefined,
          payload: undefined,
          error: error,
        });
      return NextResponse.json(
        { error: error || String(error) },
        { status: 500 }
      );
    }
  };
}

// Versión asíncrona: útil si necesitas inicialización async
export async function nextProxyHandlerAsync(options: NextProxyOptions = {}) {
  // Puedes agregar lógica async aquí si lo necesitas
  return nextProxyHandler(options);
}

// Default export for convenience
export default nextProxyHandler;
