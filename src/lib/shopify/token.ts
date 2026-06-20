/**
 * Shopify token resolver — multi-store aware.
 *
 * Every store has its OWN OAuth app (clientId + clientSecret). We exchange them
 * via the client_credentials grant for a short-lived Admin API access_token
 * (~24h) and cache it per store domain, auto-refreshing before expiry.
 */

import { activeStore } from "./store-context";
import type { ShopifyStore } from "./stores";

// access_token cache keyed by store domain.
const _cache = new Map<string, { token: string; expiresAt: number }>();

async function fetchOAuthToken(store: ShopifyStore): Promise<string> {
  const cached = _cache.get(store.storeDomain);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  if (!store.clientId || !store.clientSecret) {
    throw new Error(`Store "${store.id}" is missing clientId/clientSecret`);
  }

  const url = `https://${store.storeDomain}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: store.clientId,
      client_secret: store.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token request failed for ${store.storeDomain} (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  const expiresIn = data.expires_in ?? 86400;
  _cache.set(store.storeDomain, { token: data.access_token, expiresAt: Date.now() + (expiresIn - 3600) * 1000 });
  console.log(`[shopify-token] fetched token for ${store.storeDomain} (expires in ${expiresIn}s)`);
  return data.access_token;
}

/** Resolve the Admin API token for the currently-active store. */
export async function getShopifyToken(): Promise<string> {
  return fetchOAuthToken(activeStore());
}
