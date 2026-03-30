import { useState, useCallback, useRef } from "react";

interface UndoableState<T> {
  past: T[];
  present: T;
  future: T[];
}

/**
 * Undo/redo state manager.
 *
 * Two ways to write state:
 *   set()     – discrete operation (add frame, delete, align…). Immediately pushes the
 *               PREVIOUS present to the past stack.
 *   setLive() – continuous operation (drag, slider). Updates present without touching history.
 *               Call commit() once the interaction ends to push a single history entry.
 *
 * reset() loads a completely new state and clears all history (used when loading a reference).
 */
export function useUndoable<T>(initial: T) {
  const [history, setHistory] = useState<UndoableState<T>>({
    past: [],
    present: initial,
    future: [],
  });

  // Snapshot captured at the start of a live interaction (before first setLive call)
  const pendingRef = useRef<T | null>(null);

  /** Discrete write — creates a new undo entry immediately. */
  const set = useCallback((next: T | ((prev: T) => T)) => {
    pendingRef.current = null;
    setHistory((h) => {
      const n = typeof next === "function" ? (next as (p: T) => T)(h.present) : next;
      return {
        past: [...h.past.slice(-49), h.present],
        present: n,
        future: [],
      };
    });
  }, []);

  /** Live write — updates present without touching history (use during drag / slider). */
  const setLive = useCallback((next: T | ((prev: T) => T)) => {
    setHistory((h) => {
      if (pendingRef.current === null) {
        pendingRef.current = h.present; // snapshot before this interaction started
      }
      const n = typeof next === "function" ? (next as (p: T) => T)(h.present) : next;
      return { ...h, present: n };
    });
  }, []);

  /**
   * Commit the pending live interaction to history.
   * Call this on mouseup / slider release / input blur.
   * Safe to call even if nothing changed — it's a no-op when present === snapshot.
   */
  const commit = useCallback(() => {
    const snap = pendingRef.current;
    if (snap === null) return;
    pendingRef.current = null;
    setHistory((h) => {
      if (h.present === snap) return h; // nothing changed
      return {
        past: [...h.past.slice(-49), snap],
        present: h.present,
        future: [],
      };
    });
  }, []);

  /** Reset to a new value and clear all history (loading a reference / new layout). */
  const reset = useCallback((value: T) => {
    pendingRef.current = null;
    setHistory({ past: [], present: value, future: [] });
  }, []);

  const undo = useCallback(() => {
    pendingRef.current = null;
    setHistory((h) => {
      if (h.past.length === 0) return h;
      return {
        past: h.past.slice(0, -1),
        present: h.past[h.past.length - 1],
        future: [h.present, ...h.future.slice(0, 49)],
      };
    });
  }, []);

  const redo = useCallback(() => {
    pendingRef.current = null;
    setHistory((h) => {
      if (h.future.length === 0) return h;
      return {
        past: [...h.past, h.present],
        present: h.future[0],
        future: h.future.slice(1),
      };
    });
  }, []);

  return {
    value: history.present,
    set,
    setLive,
    commit,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  } as const;
}
