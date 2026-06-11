/**
 * Client-side proxyFetch helper for nextjs-proxy.
 *
 * Provides a type-safe, convenient wrapper around the proxy endpoint with
 * automatic error classification and response parsing.
 *
 * @module client
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HTTP methods supported by proxyFetch. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Normalized error information across all error types. */
export interface ErrorInfo {
  /** Error category. */
  type: "network" | "timeout" | "server" | "unknown";
  /** Human-readable error message. */
  message: string;
  /** HTTP status code (present only for server errors). */
  status?: number;
  /** The original Error object for debugging. */
  originalError?: Error;
}

/** Options for {@link proxyFetch}. */
export interface ProxyFetchOptions {
  /**
   * Named route (e.g. "user", "posts").
   * Resolved server-side by the proxy handler.
   */
  route: string;
  /** Request payload data. Defaults to `{}`. */
  data?: Record<string, unknown>;
  /** HTTP method sent in the proxy payload. Defaults to `"GET"`. */
  method?: HttpMethod;
  /** Custom headers included in the proxy payload. */
  headers?: Record<string, string>;
  /**
   * Proxy endpoint URL. Defaults to `"/api/proxy"`.
   * Can be overridden per-call; the default is also configurable via
   * `ProxyFetchProvider` (React Context, see context.tsx).
   */
  url?: string;
}

/** Response from a proxyFetch call. */
export interface ProxyFetchResponse<T = unknown> {
  /** `true` when the HTTP status is 2xx. */
  ok: boolean;
  /** HTTP status code (200, 404, 500, etc.). */
  status: number;
  /** Parsed response body — populated when `ok === true`. */
  data?: T;
  /**
   * Error information — populated when `ok === false`.
   * Contains an {@link ErrorInfo} with `type: "server"` for HTTP errors,
   * or the raw server error body otherwise.
   */
  error?: unknown;
  /** Response headers from the proxy endpoint. */
  headers?: Headers;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_URL = "/api/proxy";
const DEFAULT_METHOD: HttpMethod = "GET";

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

/**
 * Normalize a caught error into a structured {@link ErrorInfo}.
 *
 * @param err         The value caught in a `catch` block.
 * @param isTimeout   Explicitly mark the error as a timeout (e.g. from an
 *                    AbortController timeout). When `true`, the error is
 *                    classified as `"timeout"` regardless of its type/name.
 * @returns A normalized ErrorInfo object.
 *
 * @example
 * try {
 *   await proxyFetch({ route: "user" });
 * } catch (err) {
 *   const info = classifyError(err);
 *   console.log(info.type); // "network" | "timeout" | "unknown"
 * }
 */
export function classifyError(err: unknown, isTimeout?: boolean): ErrorInfo {
  // Explicit timeout flag takes precedence.
  if (isTimeout) {
    return {
      type: "timeout",
      message: err instanceof Error ? err.message : "Request timeout",
      originalError: err instanceof Error ? err : undefined,
    };
  }

  // TypeError is the standard fetch network error.
  if (err instanceof TypeError) {
    return {
      type: "network",
      message: err.message || "Network error",
      originalError: err,
    };
  }

  // AbortError indicates an aborted request (timeout or manual abort).
  if (err instanceof Error && err.name === "AbortError") {
    return {
      type: "timeout",
      message: err.message || "The request was aborted",
      originalError: err,
    };
  }

  // Everything else is unknown.
  return {
    type: "unknown",
    message: err instanceof Error ? err.message : "An unknown error occurred",
    originalError: err instanceof Error ? err : undefined,
  };
}

// ---------------------------------------------------------------------------
// parseResponseBody
// ---------------------------------------------------------------------------

/**
 * Try to parse the response body as JSON. Falls back to text, then to a
 * binary-length descriptor object.
 *
 * @param res - A standard `Response` object from `fetch()`.
 * @returns The parsed body (object, string, or binary descriptor).
 *
 * @example
 * const body = await parseResponseBody(response);
 * // body is either JSON-parsed, plain text, or { message, length }
 */
export async function parseResponseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    // JSON parsing failed — try as text.
    try {
      return await res.text();
    } catch {
      // Text also failed — binary body.
      const buffer = await res.arrayBuffer();
      return {
        message: "Unparseable response (binary)",
        length: buffer.byteLength,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// proxyFetch
// ---------------------------------------------------------------------------

/**
 * Make a type-safe request through the nextjs-proxy endpoint.
 *
 * Sends a POST request to the proxy endpoint with a JSON payload containing
 * the method, route, data, and headers. The server-side proxy handler
 * resolves the route and forwards the request to the actual destination.
 *
 * @template T - The expected response data type. Pass a type parameter to
 *               get typed `data` in the response (e.g. `proxyFetch<User>()`).
 * @param options - Request configuration.
 * @returns A promise that resolves to a {@link ProxyFetchResponse}.
 *
 * @throws {TypeError} When a network error occurs (DNS failure, CORS error,
 *                     network down). HTTP errors (4xx, 5xx) are returned in
 *                     the response — they do NOT throw.
 * @throws {Error} With `name: "AbortError"` when the request is aborted
 *                 (timeout or manual cancellation).
 *
 * @example
 * // Basic GET request (typed)
 * const res = await proxyFetch<User>({ route: "user", data: { id: 42 } });
 * if (res.ok) {
 *   console.log(res.data.name); // typed as T
 * } else {
 *   console.error(res.status, res.error);
 * }
 *
 * @example
 * // POST request with custom headers
 * const res = await proxyFetch({
 *   route: "users",
 *   method: "POST",
 *   data: { name: "Alice" },
 *   headers: { Authorization: "Bearer ..." },
 * });
 */
export async function proxyFetch<T = unknown>(
  options: ProxyFetchOptions,
): Promise<ProxyFetchResponse<T>> {
  const {
    route,
    data = {},
    method = DEFAULT_METHOD,
    headers = {},
    url = DEFAULT_URL,
  } = options;

  // Build the payload in the format expected by the server proxy handler.
  const payload = { method, route, data, headers };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err: unknown) {
    // Network errors propagate as exceptions (FR-1.9).
    // HTTP errors are handled below — they arrive as responses, not exceptions.
    throw err;
  }

  // Try to parse the body (JSON → text → binary descriptor).
  const body = await parseResponseBody(response);

  if (!response.ok) {
    // Server error: return ErrorInfo in the error field (FR-2.4).
    const errorInfo: ErrorInfo = {
      type: "server",
      message:
        body && typeof body === "object" && "message" in (body as Record<string, unknown>)
          ? String((body as Record<string, unknown>).message)
          : `HTTP ${response.status}`,
      status: response.status,
    };

    return {
      ok: false,
      status: response.status,
      error: errorInfo,
      headers: response.headers,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: body as T,
    headers: response.headers,
  };
}
