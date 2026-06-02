/**
 * Shopify REST API client.
 * Always fetches token via client_credentials OAuth (2026+).
 * Token is cached in token.ts and auto-refreshed when expired.
 */

import { getShopifyToken, isOAuthConfigured } from "./token";

const SHOPIFY_STORE = process.env.SHOPIFY_STORE ?? "";
const SHOPIFY_STATIC_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2025-10";

console.log(`[shopify-client] store: ${SHOPIFY_STORE} | oauth: ${isOAuthConfigured()}`);

function shopifyUrl(path: string): string {
  return `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

async function getToken(): Promise<string> {
  if (isOAuthConfigured()) return getShopifyToken();
  return SHOPIFY_STATIC_TOKEN;
}

async function shopifyRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  retries = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const token = await getToken();
      const res = await fetch(shopifyUrl(path), {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: body != null ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") ?? "2", 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Shopify API ${res.status}: ${text}`);
      }

      return res.json() as Promise<T>;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError ?? new Error("Shopify request failed");
}

export interface ShopifyCreatedProduct {
  id: number;
  title: string;
  handle: string;
  admin_graphql_api_id: string;
}

export async function createShopifyProduct(
  payload: unknown
): Promise<ShopifyCreatedProduct> {
  const data = await shopifyRequest<{ product: ShopifyCreatedProduct }>(
    "POST",
    "/products.json",
    payload
  );
  return data.product;
}

export async function updateShopifyProduct(
  shopifyProductId: number,
  payload: unknown
): Promise<ShopifyCreatedProduct> {
  const data = await shopifyRequest<{ product: ShopifyCreatedProduct }>(
    "PUT",
    `/products/${shopifyProductId}.json`,
    payload
  );
  return data.product;
}

export async function deleteShopifyProduct(shopifyProductId: number): Promise<void> {
  await shopifyRequest<unknown>("DELETE", `/products/${shopifyProductId}.json`);
}

export function shopifyProductAdminUrl(productId: number): string {
  return `https://${SHOPIFY_STORE}/admin/products/${productId}`;
}

export function shopifyProductStorefrontUrl(handle: string): string {
  return `https://${SHOPIFY_STORE}/products/${handle}`;
}

export function isShopifyConfigured(): boolean {
  return Boolean(SHOPIFY_STORE && (isOAuthConfigured() || SHOPIFY_STATIC_TOKEN));
}
