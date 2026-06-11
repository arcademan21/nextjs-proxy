/**
 * @jest-environment jsdom
 */

import React from "react";
import {
  render,
  renderHook,
  waitFor,
  act,
} from "@testing-library/react";
import { ProxyFetchProvider, useProxyFetchContext } from "../src/context";
import { useProxyFetch } from "../src/hooks";
import type { ErrorInfo, ProxyFetchResponse } from "../src/client";
import type { UseProxyFetchState } from "../src/hooks";

// ---------------------------------------------------------------------------
// Mock proxyFetch from client — we test hook logic, not the fetch implementation
// ---------------------------------------------------------------------------

jest.mock("../src/client", () => {
  const actual = jest.requireActual("../src/client");
  return {
    ...actual,
    proxyFetch: jest.fn(),
  };
});

import { proxyFetch } from "../src/client";
const mockProxyFetch = proxyFetch as jest.MockedFunction<typeof proxyFetch>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function successResponse<T = unknown>(
  data: T = { id: 1, name: "Test" } as T,
): ProxyFetchResponse<T> {
  return {
    ok: true,
    status: 200,
    data,
    headers: new Headers(),
  };
}

function errorResponse(
  status = 500,
  message = "Internal server error",
): ProxyFetchResponse {
  return {
    ok: false,
    status,
    error: { type: "server", message, status } as ErrorInfo,
    headers: new Headers(),
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — Context (RED 2.1)
// ---------------------------------------------------------------------------

describe("ProxyFetchProvider / useProxyFetchContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns default URL when used outside a Provider", () => {
    const { result } = renderHook(() => useProxyFetchContext());
    expect(result.current.url).toBe("/api/proxy");
  });

  it("provides custom URL to descendant components", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      (<ProxyFetchProvider url="/api/v2/proxy">{children}</ProxyFetchProvider>);

    const { result } = renderHook(() => useProxyFetchContext(), { wrapper });
    expect(result.current.url).toBe("/api/v2/proxy");
  });

  it("uses default url when no url prop given to Provider", () => {
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      (<ProxyFetchProvider>{children}</ProxyFetchProvider>);

    const { result } = renderHook(() => useProxyFetchContext(), { wrapper });
    expect(result.current.url).toBe("/api/proxy");
  });

  it("supports nested provider overrides", () => {
    const { result } = renderHook(() => useProxyFetchContext(), {
      wrapper: ({ children }) =>
        (<ProxyFetchProvider url="/outer">
          <ProxyFetchProvider url="/inner">
            {children}
          </ProxyFetchProvider>
        </ProxyFetchProvider>),
    });
    // Innermost provider wins (React Context shadowing)
    expect(result.current.url).toBe("/inner");
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — useProxyFetch
// ---------------------------------------------------------------------------

describe("useProxyFetch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProxyFetch.mockResolvedValue(successResponse());
  });

  // ---- Task 3.1 RED: Initial state, fetch on mount, loading/data/error ----

  describe("initial state and lifecycle", () => {
    it("starts with loading=false, data=undefined, error=undefined", () => {
      // Use enabled=false so the effect does not fire and we see pure initial state.
      const { result } = renderHook(() =>
        useProxyFetch({ route: "test", enabled: false }),
      );

      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeUndefined();
      expect(result.current.error).toBeUndefined();
      expect(typeof result.current.refetch).toBe("function");
    });

    it("fetches on mount when enabled is true (default)", async () => {
      renderHook(() => useProxyFetch({ route: "test" }));

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });
      expect(mockProxyFetch).toHaveBeenCalledWith(
        expect.objectContaining({ route: "test" }),
      );
    });

    it("does NOT fetch on mount when enabled is false", () => {
      renderHook(() =>
        useProxyFetch({ route: "test", enabled: false }),
      );

      expect(mockProxyFetch).not.toHaveBeenCalled();
    });

    it("sets loading=true during fetch and loading=false after response", async () => {
      let resolveFetch!: (value: ProxyFetchResponse<unknown>) => void;
      mockProxyFetch.mockReturnValue(
        new Promise<ProxyFetchResponse<unknown>>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const { result } = renderHook(() => useProxyFetch({ route: "test" }));

      // After effect fires but before fetch resolves, loading should be true
      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      resolveFetch(successResponse({ id: 42 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it("populates data on successful response", async () => {
      mockProxyFetch.mockResolvedValue(
        successResponse({ id: 1, name: "Alice" }),
      );

      const { result } = renderHook(() => useProxyFetch({ route: "test" }));

      await waitFor(() => {
        expect(result.current.data).toEqual({ id: 1, name: "Alice" });
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeUndefined();
    });

    it("populates error on failed response", async () => {
      mockProxyFetch.mockResolvedValue(
        errorResponse(500, "Internal server error"),
      );

      const { result } = renderHook(() => useProxyFetch({ route: "test" }));

      await waitFor(() => {
        expect(result.current.error).toBeDefined();
        expect(result.current.error?.type).toBe("server");
        expect(result.current.error?.status).toBe(500);
        expect(result.current.error?.message).toContain("Internal server error");
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it("clears data on error (switching from success to error)", async () => {
      // First render with success
      mockProxyFetch.mockResolvedValueOnce(successResponse({ id: 1 }));
      const { result, rerender } = renderHook(
        ({ route }) => useProxyFetch({ route, enabled: true }),
        { initialProps: { route: "test" } },
      );

      await waitFor(() => {
        expect(result.current.data).toEqual({ id: 1 });
      });

      // Second render — mock returns error
      // The mock will be called again because we're triggering refetch or re-fetch
      // Actually, the hook doesn't automatically re-fetch on rerender.
      // Let me use refetch instead.
      mockProxyFetch.mockResolvedValueOnce(errorResponse(500, "Server error"));

      await act(async () => {
        await result.current.refetch();
      });

      expect(result.current.data).toBeUndefined();
      expect(result.current.error?.type).toBe("server");
    });

    it("clears error on success (switching from error to success)", async () => {
      // First render with error
      mockProxyFetch.mockResolvedValueOnce(errorResponse(500, "Error"));

      const { result } = renderHook(() => useProxyFetch({ route: "test" }));

      await waitFor(() => {
        expect(result.current.error).toBeDefined();
      });

      // Refetch with success
      mockProxyFetch.mockResolvedValueOnce(successResponse({ id: 1 }));

      await act(async () => {
        await result.current.refetch();
      });

      expect(result.current.error).toBeUndefined();
      expect(result.current.data).toEqual({ id: 1 });
    });

    it("preserves previous data during refetch loading", async () => {
      let resolveRefetch!: (value: ProxyFetchResponse<unknown>) => void;
      mockProxyFetch
        .mockResolvedValueOnce(successResponse({ id: 1 }))
        .mockReturnValue(new Promise<ProxyFetchResponse<unknown>>((resolve) => { resolveRefetch = resolve; }));

      const { result } = renderHook(() => useProxyFetch({ route: "test" }));

      await waitFor(() => {
        expect(result.current.data).toEqual({ id: 1 });
      });

      // Refetch — the `setState((prev) => ({ ...prev, loading: true }))` call
      // preserves previous data and error while only toggling loading.
      act(() => { result.current.refetch(); });

      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      // Previous data is preserved during loading
      expect(result.current.data).toEqual({ id: 1 });
      expect(result.current.error).toBeUndefined();

      // Resolve the refetch
      resolveRefetch(successResponse({ id: 2 }));

      await waitFor(() => {
        expect(result.current.data).toEqual({ id: 2 });
      });
    });
  });

  // ---- Task 3.2 RED: refetch() behavior, debounce while loading ----

  describe("refetch()", () => {
    it("re-runs the request with the same options", async () => {
      const { result } = renderHook(() =>
        useProxyFetch({ route: "test", enabled: true }),
      );

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });

      // NOTE: we cannot simply call refetch, because it's inside a
      // wrapper that uses the proxyFetch mock. The first fetch consumed
      // the default mockResolvedValue, but the mock is still set.
      // We need a second mock value for this test.
      mockProxyFetch.mockResolvedValueOnce(successResponse({ id: 2 }));

      await act(async () => {
        await result.current.refetch();
      });

      expect(mockProxyFetch).toHaveBeenCalledTimes(2);
      expect(result.current.data).toEqual({ id: 2 });
    });

    it("is debounced (no-op) while already loading", async () => {
      let resolveFetch!: (value: ProxyFetchResponse<unknown>) => void;
      mockProxyFetch.mockReset();
      mockProxyFetch.mockReturnValue(
        new Promise<ProxyFetchResponse<unknown>>((resolve) => {
          resolveFetch = resolve;
        }),
      );

      const { result } = renderHook(() =>
        useProxyFetch({ route: "test", enabled: true }),
      );

      // Wait for loading to start
      await waitFor(() => {
        expect(result.current.loading).toBe(true);
      });

      // Refetch while loading — should be debounced (no second fetch call)
      mockProxyFetch.mockClear();
      await act(async () => {
        await result.current.refetch();
      });

      // Loading is true, so refetch should be no-op (no additional fetch call)
      // However, refetch returns a promise that resolves immediately (doesn't
      // trigger a new fetch). So mockProxyFetch remains with 0 calls
      expect(mockProxyFetch).not.toHaveBeenCalled();

      // Now resolve the original fetch
      resolveFetch(successResponse({ id: 1 }));

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it("returns a Promise that resolves when the fetch completes", async () => {
      // Normal refetch (not debounced)
      const { result } = renderHook(() =>
        useProxyFetch({ route: "test", enabled: false }),
      );

      mockProxyFetch.mockResolvedValue(successResponse({ id: 42 }));

      let refetchResolved = false;
      await act(async () => {
        await result.current.refetch();
        refetchResolved = true;
      });

      expect(refetchResolved).toBe(true);
      expect(result.current.data).toEqual({ id: 42 });
    });
  });

  // ---- Task 3.3 RED: Polling ----

  describe("polling", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("does NOT poll if refetchInterval is not set", async () => {
      mockProxyFetch.mockResolvedValue(successResponse({ count: 1 }));

      renderHook(() => useProxyFetch({ route: "test" }));

      // initial fetch
      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalledTimes(1);
      });

      jest.advanceTimersByTime(10000);

      // Should still only have been called once
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    });

    it("polls at the specified interval", async () => {
      mockProxyFetch.mockResolvedValue(successResponse({ count: 1 }));

      renderHook(() =>
        useProxyFetch({ route: "test", refetchInterval: 1000 }),
      );

      // Flush microtasks so the initial fetch resolves and .finally() sets
      // up the polling interval.
      await act(async () => {});
      expect(mockProxyFetch).toHaveBeenCalled();
      const callCountAfterInitial = mockProxyFetch.mock.calls.length;

      // Advance time to trigger first poll. Wrap in act to flush the
      // async fetchData microtasks (the mockResolvedValue promise) so
      // the isLoadingRef flag is cleared before the next tick.
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockProxyFetch.mock.calls.length).toBe(callCountAfterInitial + 1);

      // Advance again for second poll
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockProxyFetch.mock.calls.length).toBe(callCountAfterInitial + 2);
    });

    it("starts polling after the first response completes", async () => {
      mockProxyFetch.mockResolvedValue(successResponse({ count: 1 }));

      renderHook(() =>
        useProxyFetch({ route: "test", refetchInterval: 1000 }),
      );

      // Flush microtasks so the initial fetch resolves and .finally() sets up
      // the polling interval.
      await act(async () => {});

      // The interval should now be active. Advance time to trigger poll.
      jest.advanceTimersByTime(1000);
      expect(mockProxyFetch).toHaveBeenCalledTimes(2);
    });

    it("cleans up the interval on unmount", async () => {
      mockProxyFetch.mockResolvedValue(successResponse({ count: 1 }));

      const { unmount } = renderHook(() =>
        useProxyFetch({ route: "test", refetchInterval: 1000 }),
      );

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalled();
      });

      const callCount = mockProxyFetch.mock.calls.length;

      unmount();

      // Advance time — polling should have been cleaned up
      jest.advanceTimersByTime(5000);

      // The initial fetch + any that fired before unmount
      // Since unmount also clears the interval, no new calls
      expect(mockProxyFetch.mock.calls.length).toBe(callCount);
    });

    it("refetch() during polling clears interval and restarts it after response", async () => {
      mockProxyFetch.mockResolvedValue(successResponse({ count: 1 }));

      const { result } = renderHook(() =>
        useProxyFetch({ route: "test", refetchInterval: 10000 }),
      );

      // Wait for initial fetch to complete and polling to start
      await act(async () => {});

      // Advance a little — no poll yet
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockProxyFetch).toHaveBeenCalledTimes(1);

      // Refetch manually during polling
      mockProxyFetch.mockResolvedValueOnce(successResponse({ count: 2 }));
      await act(async () => {
        await result.current.refetch();
      });
      expect(mockProxyFetch).toHaveBeenCalledTimes(2);
      expect(result.current.data).toEqual({ count: 2 });

      // The interval should have been restarted. Advance past the new interval.
      await act(async () => {
        jest.advanceTimersByTime(10000);
      });
      expect(mockProxyFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("continues polling on error (does not stop on error)", async () => {
      // Resolve first call with success
      mockProxyFetch.mockResolvedValueOnce(successResponse({ count: 1 }));
      // Subsequent calls: error
      mockProxyFetch.mockResolvedValue(errorResponse(500, "Poll error"));

      const { result } = renderHook(() =>
        useProxyFetch({ route: "test", refetchInterval: 1000 }),
      );

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalled();
      });

      // After first successful fetch, error should be undefined (success)
      await waitFor(() => {
        expect(result.current.data).toEqual({ count: 1 });
      });

      // Advance time to trigger poll — should get error
      jest.advanceTimersByTime(1000);

      await waitFor(() => {
        expect(result.current.error?.type).toBe("server");
      });

      // Advance again — polling should still be active
      jest.advanceTimersByTime(1000);

      const totalCalls = mockProxyFetch.mock.calls.length;
      expect(totalCalls).toBeGreaterThanOrEqual(3);
    });
  });

  // ---- Task 3.4 RED: Context URL resolution ----

  describe("URL resolution", () => {
    it("uses context URL when available and no per-call url given", async () => {
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        (<ProxyFetchProvider url="/api/custom">{children}</ProxyFetchProvider>);

      renderHook(() => useProxyFetch({ route: "test" }), { wrapper });

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalled();
      });

      expect(mockProxyFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: "/api/custom" }),
      );
    });

    it("per-call url overrides context URL", async () => {
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        (<ProxyFetchProvider url="/api/custom">{children}</ProxyFetchProvider>);

      renderHook(
        () => useProxyFetch({ route: "test", url: "/api/override" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalled();
      });

      expect(mockProxyFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: "/api/override" }),
      );
    });

    it("defaults to /api/proxy without context or per-call url", async () => {
      renderHook(() => useProxyFetch({ route: "test" }));

      await waitFor(() => {
        expect(mockProxyFetch).toHaveBeenCalled();
      });

      expect(mockProxyFetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: "/api/proxy" }),
      );
    });
  });

  // ---- Task 3.5 RED: Callbacks ----

  describe("callbacks", () => {
    it("calls onSuccess with data on successful response", async () => {
      const onSuccess = jest.fn();
      const testData = { id: 1, name: "Alice" };
      mockProxyFetch.mockResolvedValue(successResponse(testData));

      renderHook(() =>
        useProxyFetch({ route: "test", onSuccess }),
      );

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledWith(testData);
      });
    });

    it("calls onError with ErrorInfo on failed response", async () => {
      const onError = jest.fn();
      mockProxyFetch.mockResolvedValue(errorResponse(500, "Server err"));

      renderHook(() =>
        useProxyFetch({ route: "test", onError }),
      );

      await waitFor(() => {
        expect(onError).toHaveBeenCalled();
      });

      const errArg = onError.mock.calls[0][0] as ErrorInfo;
      expect(errArg.type).toBe("server");
      expect(errArg.status).toBe(500);
    });

    it("calls onError with network error when proxyFetch throws", async () => {
      const onError = jest.fn();
      mockProxyFetch.mockRejectedValue(new TypeError("Failed to fetch"));

      renderHook(() =>
        useProxyFetch({ route: "test", onError }),
      );

      await waitFor(() => {
        expect(onError).toHaveBeenCalled();
      });

      const errArg = onError.mock.calls[0][0] as ErrorInfo;
      expect(errArg.type).toBe("network");
      expect(errArg.message).toContain("Failed to fetch");
    });
  });
});
