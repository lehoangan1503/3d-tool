/**
 * Minimal structural types for the Supabase calls the render pipeline makes.
 *
 * Why not `SupabaseClient` directly: this project runs on a non-public Postgres
 * schema (`shopify_customizer`), so createClient() and createAdminServiceClient()
 * return SupabaseClient instances whose schema generic is a plain `string`
 * rather than the `"public"` the default type expects. Passing those to a
 * function typed as `SupabaseClient` fails to compile, and the existing helper
 * (lib/supabase/creator.ts) works around it with `any` — which this codebase
 * bans. These interfaces describe exactly the surface used here instead, so the
 * calls stay type-checked.
 */

/** What every PostgREST read/write resolves to. */
export interface QueryResult<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

/** Terminal shapes — awaiting a builder runs the query. */
export interface SelectBuilder<T> extends PromiseLike<QueryResult<T[]>> {
  eq(column: string, value: string | number | boolean | null): SelectBuilder<T>;
  in(column: string, values: readonly (string | number)[]): SelectBuilder<T>;
  ilike(column: string, pattern: string): SelectBuilder<T>;
  /** `lt` on a timestamptz column is how the purge finds jobs that are due. */
  lt(column: string, value: string | number): SelectBuilder<T>;
  /** `.is(col, null)` — PostgREST needs IS NULL, not `eq(col, null)`. */
  is(column: string, value: null | boolean): SelectBuilder<T>;
  order(column: string, options?: { ascending?: boolean }): SelectBuilder<T>;
  limit(count: number): SelectBuilder<T>;
  range(from: number, to: number): SelectBuilder<T>;
  maybeSingle(): PromiseLike<QueryResult<T>>;
  single(): PromiseLike<QueryResult<T>>;
}

export interface MutationBuilder<T> extends PromiseLike<QueryResult<T[]>> {
  eq(column: string, value: string | number | boolean | null): MutationBuilder<T>;
  in(column: string, values: readonly (string | number)[]): MutationBuilder<T>;
  lt(column: string, value: string | number): MutationBuilder<T>;
  is(column: string, value: null | boolean): MutationBuilder<T>;
  /** The returning clause picks its own row type: an update may read back
   *  different columns than the values it wrote. */
  select<R = T>(columns?: string): SelectBuilder<R>;
}

export interface TableHandle {
  select<T>(columns?: string, options?: { count?: "exact" }): SelectBuilder<T>;
  insert<T = never>(
    values: Record<string, unknown> | Record<string, unknown>[]
  ): MutationBuilder<T>;
  update<T = never>(values: Record<string, unknown>): MutationBuilder<T>;
  delete<T = never>(): MutationBuilder<T>;
}

/** The client surface the render pipeline needs — reads, writes, and RPC. */
export interface RenderDbClient {
  from(table: string): TableHandle;
  rpc<T>(fn: string, params: Record<string, unknown>): PromiseLike<QueryResult<T>>;
}

/** Storage surface used by the worker upload route. */
export interface StorageBucketHandle {
  upload(
    path: string,
    body: Uint8Array,
    options?: { contentType?: string; upsert?: boolean }
  ): PromiseLike<QueryResult<{ path: string }>>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
  /**
   * Batch delete. Supabase caps one call at 1000 paths, and it does NOT fail
   * on a path that is already gone — which is what makes the purge safe to
   * re-run after a partial failure.
   */
  remove(paths: string[]): PromiseLike<QueryResult<{ name: string }[]>>;
}

export interface RenderStorageClient extends RenderDbClient {
  storage: { from(bucket: string): StorageBucketHandle };
}

/**
 * Narrows a real SupabaseClient to the surface above.
 *
 * Assigning the client directly makes TypeScript compare its full generic
 * signature against these interfaces and give up with "type instantiation is
 * excessively deep" — the client's builder types are recursive and huge. This
 * goes through `unknown` on purpose: the runtime shape is identical (the
 * interfaces are a strict subset of PostgREST's builder API), only the
 * structural check is skipped.
 */
export function asRenderDbClient(client: { from: unknown; rpc: unknown }): RenderDbClient {
  return client as unknown as RenderDbClient;
}

export function asRenderStorageClient(client: {
  from: unknown;
  rpc: unknown;
  storage: unknown;
}): RenderStorageClient {
  return client as unknown as RenderStorageClient;
}
