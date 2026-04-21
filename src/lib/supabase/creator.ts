// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = { from: (...args: any[]) => any };

/**
 * Batch-resolve display names for a list of user IDs.
 * Returns a map of userId → "nickname" or "email" (fallback "Unknown").
 * Used to attach creator info to globally-visible resources.
 */
export async function resolveCreatorNames(
  supabase: AnySupabaseClient,
  userIds: string[]
): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return {};

  const { data: profiles } = await supabase
    .from("user_profiles")
    .select("user_id, nickname, email")
    .in("user_id", unique);

  const map: Record<string, string> = {};
  for (const p of profiles ?? []) {
    map[p.user_id] = p.nickname?.trim() || p.email || "Unknown";
  }
  return map;
}
