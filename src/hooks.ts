/**
 * React hook for type-safe proxyFetch integration.
 *
 * Provides {@link useProxyFetch}, a React hook that wraps the {@link proxyFetch}
 * function with state management, polling, and context-aware URL resolution.
 *
 * @module hooks
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { proxyFetch } from "./client";
import { useProxyFetchContext } from "./context";
import type { ProxyFetchOptions, ErrorInfo } from "./client";

/**
 * Options for the {@link useProxyFetch} hook.
 * Extends {@link ProxyFetchOptions} with lifecycle and callback options.
 */
export interface UseProxyFetchOptions extends ProxyFetchOptions {
  /** Auto-fetch on mount. Defaults to `true`. */
  enabled?: boolean;
  /**
   * Polling interval in milliseconds.
   * Polling starts AFTER the first response completes.
   * Set to `undefined` (default) to disable polling.
   */
  refetchInterval?: number;
  /** Called with the parsed response data after a successful fetch. */
  onSuccess?: (data: unknown) => void;
  /** Called with a normalized ErrorInfo after a failed fetch. */
  onError?: (error: ErrorInfo) => void;
}

/**
 * Hook return value.
 * Contains the current fetch state and a manual refetch trigger.
 */
export interface UseProxyFetchState<T = unknown> {
  /** Parsed response data (only present after a successful fetch). */
  data?: T;
  /** Normalized error information (only present after a failed fetch). */
  error?: ErrorInfo;
  /** `true` while a fetch is in progress. */
  loading: boolean;
  /** Manually re-run the request. Debounced (no-op) while already loading. */
  refetch: () => Promise<void>;
}

/**
 * React hook that wraps {@link proxyFetch} with state management, polling,
 * and context-aware URL resolution.
 *
 * @template T - Expected response data type.
 * @param options - Configuration for the request and hook behavior.
 * @returns Current fetch state and a manual refetch function.
 *
 * @example
 * function UserProfile({ userId }: { userId: number }) {
 *   const { data, error, loading, refetch } = useProxyFetch<User>({
 *     route: "user",
 *     data: { id: userId },
 *   });
 *
 *   if (loading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *   return <div>{data?.name}</div>;
 * }
 *
 * @example
 * // With polling
 * const { data } = useProxyFetch({
 *   route: "notifications",
 *   refetchInterval: 5000,
 * });
 */
export function useProxyFetch<T = unknown>(
  options: UseProxyFetchOptions,
): UseProxyFetchState<T> {
  const [state, setState] = useState<
    Omit<UseProxyFetchState<T>, "refetch">
  >({
    loading: false,
    data: undefined,
    error: undefined,
  });

  // Ref to track loading state for debouncing (bypasses stale closures).
  const isLoadingRef = useRef(false);
  // Ref to track the polling interval ID for cleanup and restart.
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Resolve the proxy endpoint URL.
  const ctx = useProxyFetchContext();
  const resolvedUrl = options.url || ctx.url;

  // Keep a stable ref to the latest options so the callback never goes stale.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // -----------------------------------------------------------------------
  // Core fetch logic
  // -----------------------------------------------------------------------

  /**
   * Execute the proxied request and update state.
   * Debounced: if a fetch is already in progress, this is a no-op.
   */
  const fetchData = useCallback(async (): Promise<void> => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    setState((prev: Omit<UseProxyFetchState<T>, "refetch">) => ({
      ...prev,
      loading: true,
    }));

    try {
      const response = await proxyFetch<T>({
        route: optionsRef.current.route,
        data: optionsRef.current.data,
        method: optionsRef.current.method,
        headers: optionsRef.current.headers,
        url: resolvedUrl,
      });

      if (response.ok) {
        setState({
          data: response.data,
          error: undefined,
          loading: false,
        });
        optionsRef.current.onSuccess?.(response.data);
      } else {
        // proxyFetch already normalises server errors into ErrorInfo.
        const errInfo =
          (response.error as ErrorInfo) ?? {
            type: "server" as const,
            message: `HTTP ${response.status}`,
            status: response.status,
          };
        setState({
          data: undefined,
          error: errInfo,
          loading: false,
        });
        optionsRef.current.onError?.(errInfo);
      }
    } catch (err) {
      // Network errors propagate from proxyFetch as thrown exceptions.
      const errorInfo: ErrorInfo = {
        type: "network",
        message: err instanceof Error ? err.message : "Unknown error",
      };
      setState({
        data: undefined,
        error: errorInfo,
        loading: false,
      });
      optionsRef.current.onError?.(errorInfo);
    } finally {
      isLoadingRef.current = false;
    }
  }, [resolvedUrl]);

  // -----------------------------------------------------------------------
  // Mount effect: initial fetch + polling setup
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (optionsRef.current.enabled === false) return;

    let mounted = true;

    // Start the initial fetch. Polling starts ONLY after the first response
    // completes (design decision: no immediate poll on mount).
    fetchData().finally(() => {
      if (
        mounted &&
        optionsRef.current.refetchInterval &&
        optionsRef.current.refetchInterval > 0
      ) {
        intervalRef.current = setInterval(
          fetchData,
          optionsRef.current.refetchInterval,
        );
      }
    });

    return () => {
      mounted = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = undefined;
      }
    };
  }, [fetchData]);

  // -----------------------------------------------------------------------
  // Public refetch function
  // -----------------------------------------------------------------------

  /**
   * Manually re-run the request.
   *
   * If a fetch is already in progress, this is debounced (no-op).
   * If polling is active, the current interval is cleared and restarted
   * after the new fetch completes.
   */
  const refetch = useCallback(async (): Promise<void> => {
    // If already loading, debounce (ignore).
    if (isLoadingRef.current) return;

    // Clear any active polling interval — it will be restarted after the
    // fetch completes if refetchInterval is still set.
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    }

    await fetchData();

    // Restart polling if still configured.
    if (
      optionsRef.current.refetchInterval &&
      optionsRef.current.refetchInterval > 0
    ) {
      intervalRef.current = setInterval(
        fetchData,
        optionsRef.current.refetchInterval,
      );
    }
  }, [fetchData]);

  // -----------------------------------------------------------------------
  // Return
  // -----------------------------------------------------------------------

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    refetch,
  };
}
