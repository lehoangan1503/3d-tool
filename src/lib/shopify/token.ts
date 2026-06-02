/**
 * Shopify OAuth token manager — TypeScript port of shopify_refresh_token.py
 * Uses client_credentials grant to get a fresh access_token (~24h TTL).
 * Caches in memory; auto-refreshes 1 hour before expiry.
 */

const SHOPIFY_STORE    = process.env.SHOPIFY_STORE ?? "";
const CLIENT_ID        = process.env.SHOPIFY_CLIENT_ID ?? "";
const CLIENT_SECRET    = process.env.SHOPIFY_CLIENT_SECRET ?? "";

const BUFFER_MS = 60 * 60 * 1000; // refresh 1h before expiry

let _cache: { token: string; expiresAt: number } | null = null;

export async function getShopifyToken(): Promise<string> {
  if (_cache && Date.now() < _cache.expiresAt) return _cache.token;

  const shopName = SHOPIFY_STORE.replace(/\.myshopify\.com$/, "");
  const url = `https://${shopName}.myshopify.com/admin/oauth/access_token`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token request failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in?: number; scope?: string };
  if (data.scope) console.log(`[shopify-token] scopes: ${data.scope}`);

  const expiresIn = data.expires_in ?? 86400;
  _cache = { token: data.access_token, expiresAt: Date.now() + (expiresIn - 3600) * 1000 };
  console.log(`[shopify-token] fetched new token (expires in ${expiresIn}s)`);
  return _cache.token;
}

export function isOAuthConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}


