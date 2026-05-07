"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ExtractorReference } from "@/types/extractor";

const PAGE_SIZE = 40;
const SEARCH_DEBOUNCE_MS = 300;

// Session-level cache — cleared on page reload, persists across popover open/close.
// Keyed by `${search}:${offset}` so each page of each search is cached separately.
const pageCache = new Map<string, { items: ExtractorReference[]; total: number }>();

/** Call after any mutation (save / rename / delete) to ensure the next popover open shows fresh data. */
export function invalidateReferenceListCache() {
  pageCache.clear();
}

export interface UseReferenceListOptions {
  enabled: boolean;
  pageSize?: number;
}

export interface UseReferenceListResult {
  references: ExtractorReference[];
  total: number;
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  search: string;
  setSearch: (v: string) => void;
  loadMore: () => void;
  reload: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
}

export function useReferenceList({
  enabled,
  pageSize = PAGE_SIZE,
}: UseReferenceListOptions): UseReferenceListResult {
  const [references, setReferences] = useState<ExtractorReference[]>([]);
  const [total, setTotal]           = useState(0);
  const [isLoading, setIsLoading]   = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [search, setSearchRaw]      = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const offsetRef = useRef(0);
  const observer  = useRef<IntersectionObserver | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number, currentSearch: string, append: boolean) => {
      const cacheKey = `${currentSearch}:${offset}:${pageSize}`;
      const cached = pageCache.get(cacheKey);

      if (cached) {
        setReferences((prev) => (append ? [...prev, ...cached.items] : cached.items));
        setTotal(cached.total);
        offsetRef.current = offset + cached.items.length;
        return;
      }

      if (offset === 0) setIsLoading(true);
      else setIsFetchingMore(true);

      try {
        const params = new URLSearchParams({
          limit:  String(pageSize),
          offset: String(offset),
        });
        if (currentSearch) params.set("search", currentSearch);

        const res = await fetch(`/api/extractor-references?${params}`);
        if (!res.ok) throw new Error("Failed to fetch");

        const { items, total: t }: { items: ExtractorReference[]; total: number } =
          await res.json();

        pageCache.set(cacheKey, { items, total: t });
        setReferences((prev) => (append ? [...prev, ...items] : items));
        setTotal(t);
        offsetRef.current = offset + items.length;
      } catch (err) {
        console.error("useReferenceList fetch error:", err);
      } finally {
        setIsLoading(false);
        setIsFetchingMore(false);
      }
    },
    [pageSize]
  );

  // Initial load + search reset — uses cache so reopening popover is instant.
  useEffect(() => {
    if (!enabled) return;
    offsetRef.current = 0;
    setReferences([]);
    fetchPage(0, debouncedSearch, false);
  }, [enabled, debouncedSearch, fetchPage]);

  const loadMore = useCallback(() => {
    if (isLoading || isFetchingMore) return;
    fetchPage(offsetRef.current, debouncedSearch, true);
  }, [isLoading, isFetchingMore, fetchPage, debouncedSearch]);

  const reload = useCallback(() => {
    pageCache.clear();
    offsetRef.current = 0;
    setReferences([]);
    fetchPage(0, debouncedSearch, false);
  }, [fetchPage, debouncedSearch]);

  // IntersectionObserver — auto-loadMore when sentinel enters viewport
  const sentinelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (observer.current) observer.current.disconnect();
      if (!el) return;
      observer.current = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) loadMore(); },
        { threshold: 0.1 }
      );
      observer.current.observe(el);
    },
    [loadMore]
  );

  const hasMore = references.length < total;

  const setSearch = useCallback((v: string) => {
    setSearchRaw(v);
  }, []);

  return {
    references, total, isLoading, isFetchingMore, hasMore,
    search, setSearch,
    loadMore, reload, sentinelRef,
  };
}
