// Normalizes Supabase storage URLs to use the public-facing HTTPS proxy.
// Stored URLs may contain the internal IP-based URL (http://5.223.48.44:8000);
// this rewrites them to https://supa-api.top so they load correctly in browsers.
const INTERNAL_BASE = "http://5.223.48.44:8000";
const PUBLIC_BASE = "https://supa-api.top";

export function resolveStorageUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  if (url.startsWith(INTERNAL_BASE)) {
    return PUBLIC_BASE + url.slice(INTERNAL_BASE.length);
  }
  return url;
}
