/**
 * Renders items in parallel up to `concurrency` at a time.
 * Calls `onDone(index, url)` after each item finishes so callers
 * can update UI progressively rather than waiting for all.
 * Disposes memory between renders — the render fn must not hold
 * references to WebGL resources after the Promise resolves.
 */
export async function renderPool<T>(
  items: T[],
  render: (item: T) => Promise<Blob>,
  onDone: (index: number, url: string) => void,
  concurrency = 3
): Promise<void> {
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      try {
        const blob = await render(item);
        const url  = URL.createObjectURL(blob);
        onDone(idx, url);
      } catch {
        // Silently ignore failed renders — item keeps SVG fallback
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
}
