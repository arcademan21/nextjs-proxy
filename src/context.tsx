/**
 * React Context and Provider for proxyFetch URL configuration.
 *
 * Allows the proxy endpoint URL to be configured at a high level (via
 * {@link ProxyFetchProvider}) and inherited by all child components.
 *
 * @module context
 */

import React, { createContext, useContext } from "react";

/**
 * Shape of the proxy fetch context value.
 * Contains the base URL for all proxyFetch requests in a subtree.
 */
export interface ProxyFetchContextType {
  /** Base URL for the proxy endpoint. */
  url: string;
}

/**
 * React Context for the proxy endpoint URL.
 *
 * Default value: `{ url: "/api/proxy" }` — safe to use outside a Provider.
 */
const ProxyFetchContext = createContext<ProxyFetchContextType>({
  url: "/api/proxy",
});

/**
 * Provides a proxy endpoint URL to all descendant components.
 *
 * Wraps your app (or a subtree) with a configured proxy URL that
 * `useProxyFetchContext()` and `useProxyFetch()` will read automatically.
 *
 * @param props.url    Proxy endpoint URL. Defaults to `"/api/proxy"`.
 * @param props.children React children.
 *
 * @example
 * <ProxyFetchProvider url="/api/v2/proxy">
 *   <App />
 * </ProxyFetchProvider>
 */
export function ProxyFetchProvider({
  url = "/api/proxy",
  children,
}: {
  url?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ProxyFetchContext.Provider value={{ url }}>
      {children}
    </ProxyFetchContext.Provider>
  );
}

/**
 * Read the configured proxy URL from context.
 *
 * Safe to call outside a `<ProxyFetchProvider>` — returns `{ url: "/api/proxy" }`
 * when no provider exists in the component tree.
 *
 * @returns The current proxy endpoint URL configuration.
 *
 * @example
 * const { url } = useProxyFetchContext();
 * // url is either the provider's value or "/api/proxy"
 */
export function useProxyFetchContext(): ProxyFetchContextType {
  return useContext(ProxyFetchContext);
}
