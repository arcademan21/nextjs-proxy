/**
 * @jest-environment jsdom
 *
 * Integration tests for the full proxyFetch → useProxyFetch cycle.
 *
 * Unlike hooks.test.tsx, these tests do NOT mock the proxyFetch module.
 * They mock only the lowest layer (global.fetch), exercising the real
 * integration between useProxyFetch, proxyFetch, and response parsing.
 */

import React from "react";
import {
  renderHook,
  waitFor,
  act,
} from "@testing-library/react";
import { useProxyFetch } from "../src/hooks";
import { ProxyFetchProvider } from "../src/context";
import type { UseProxyFetchState } from "../src/hooks";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mockFetchResponse(
  overrides: Partial<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    headers: Record<string, string>;
  }> = {},
): Response {
  const headers = new Headers(overrides.headers ?? {});
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    json: overrides.json ?? (async () => ({ data: "default" })),
    text: overrides.text ?? (async () => JSON.stringify({ data: "default" })),
    headers,
    redirected: false,
    statusText: overrides.ok === false ? "Error" : "OK",
    type: "basic" as ResponseType,
    url: "",
    clone: function () {
      return mockFetchResponse(overrides);
    },
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
  } as Response;
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("proxyFetch + useProxyFetch integration", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  // ---- 4.1 Integration: full request/response cycle ----

  it("full request/response cycle works end-to-end", async () => {
    const responseData = { id: 1, name: "Alice", email: "alice@test.com" };
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => responseData,
      }),
    );

    const { result } = renderHook(() =>
      useProxyFetch<typeof responseData>({
        route: "user",
        data: { id: 1 },
      }),
    );

    // Should fetch and populate data through the real proxyFetch → fetch path
    await waitFor(() => {
      expect(result.current.data).toEqual(responseData);
    });

    // Verify the full wire format: proxyFetch constructs { method, route, data, headers }
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/proxy",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );

    const callBody = JSON.parse(
      ((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(callBody).toEqual({
      method: "GET",
      route: "user",
      data: { id: 1 },
      headers: {},
    });

    // Verify hook state is correct
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it("hook populates data through proxyFetch JSON parsing pipeline", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => ({ items: ["a", "b", "c"], total: 42 }),
      }),
    );

    const { result } = renderHook(() =>
      useProxyFetch<{ items: string[]; total: number }>({
        route: "items",
        method: "GET",
      }),
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ items: ["a", "b", "c"], total: 42 });
    });
    expect(result.current.loading).toBe(false);
  });

  it("server error in proxyFetch surfaces in hook error state", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: false,
        status: 500,
        json: async () => ({ message: "Internal server error" }),
      }),
    );

    const { result } = renderHook(() =>
      useProxyFetch({ route: "user" }),
    );

    await waitFor(() => {
      expect(result.current.error).toBeDefined();
    });

    // Error should be classified as 'server' with the HTTP status
    expect(result.current.error?.type).toBe("server");
    expect(result.current.error?.status).toBe(500);
    expect(result.current.error?.message).toContain("Internal server error");
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("4xx error surfaces in hook error state through proxyFetch", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: false,
        status: 404,
        json: async () => ({ message: "User not found" }),
      }),
    );

    const { result } = renderHook(() =>
      useProxyFetch({ route: "user" }),
    );

    await waitFor(() => {
      expect(result.current.error?.status).toBe(404);
    });

    expect(result.current.error?.type).toBe("server");
    expect(result.current.error?.message).toContain("User not found");
    expect(result.current.loading).toBe(false);
  });

  it("network error propagates from proxyFetch to hook error state", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    const { result } = renderHook(() =>
      useProxyFetch({ route: "user" }),
    );

    await waitFor(() => {
      expect(result.current.error).toBeDefined();
    });

    expect(result.current.error?.type).toBe("network");
    expect(result.current.error?.message).toContain("Failed to fetch");
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  // ---- Integration with Context ----

  it("uses context URL in the proxyFetch fetch call", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    );

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      (<ProxyFetchProvider url="/api/v2/proxy">{children}</ProxyFetchProvider>);

    renderHook(() => useProxyFetch({ route: "test" }), { wrapper });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // The fetch URL should come from context
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v2/proxy",
      expect.any(Object),
    );
  });

  it("per-call url overrides context URL at the fetch level", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    );

    const wrapper = ({ children }: { children: React.ReactNode }) =>
      (<ProxyFetchProvider url="/api/context">{children}</ProxyFetchProvider>);

    renderHook(
      () => useProxyFetch({ route: "test", url: "/api/override" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    // The per-call URL should win
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/override",
      expect.any(Object),
    );
  });

  it("refetch() re-runs the full proxyFetch → fetch cycle", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          status: 200,
          json: async () => ({ count: 1 }),
        }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          status: 200,
          json: async () => ({ count: 2 }),
        }),
      );

    const { result } = renderHook(() =>
      useProxyFetch<{ count: number }>({ route: "counter" }),
    );

    await waitFor(() => {
      expect(result.current.data?.count).toBe(1);
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data?.count).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("handles non-JSON text response through the real parseResponseBody path", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      mockFetchResponse({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Not JSON");
        },
        text: async () => "plain text content",
      }),
    );

    const { result } = renderHook(() =>
      useProxyFetch({ route: "text" }),
    );

    await waitFor(() => {
      expect(result.current.data).toBe("plain text content");
    });
  });
});
