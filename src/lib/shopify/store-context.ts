import { AsyncLocalStorage } from "node:async_hooks";
import { getDefaultStore, getStore, type ShopifyStore } from "./stores";

/**
 * Per-request active Shopify store. Route handlers wrap their Shopify work in
 * `withStore(storeId, fn)` so the low-level client (client.ts / token.ts) can
 * resolve the right shop + token without threading a store argument through
 * every function. Outside a withStore() scope, the default store is used.
 */
const storage = new AsyncLocalStorage<ShopifyStore>();

export function withStore<T>(storeId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const store = getStore(storeId);
  if (!store) throw new Error("No Shopify store configured");
  return storage.run(store, fn);
}

/** The store active for the current request, or the default if none was set. */
export function activeStore(): ShopifyStore {
  const store = storage.getStore() ?? getDefaultStore();
  if (!store) throw new Error("No Shopify store configured");
  return store;
}
