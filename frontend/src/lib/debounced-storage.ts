import type { PersistStorage, StorageValue } from "zustand/middleware";

export type DebouncedStorage<S> = PersistStorage<S> & {
  /** Write any pending value immediately. */
  flush: () => void;
};

/**
 * A zustand `persist` storage that serialises and writes at most once per `delayMs`.
 * `persist` calls `setItem` on every state change — e.g. every frame of a node drag — so writing
 * synchronously would JSON-encode the whole flow ~60×/s. Pending writes are flushed when the page
 * is hidden or unloaded so nothing is lost. Storage access errors (quota, private mode, corrupt
 * JSON) are swallowed: a draft is a convenience, never worth crashing the editor over.
 */
export function createDebouncedJSONStorage<S>(
  getStorage: () => Storage,
  delayMs = 400,
): DebouncedStorage<S> {
  let pending: { name: string; value: StorageValue<S> } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const { name, value } = pending;
    pending = null;
    try {
      getStorage().setItem(name, JSON.stringify(value));
    } catch (error) {
      console.warn("Could not save the flow draft", error);
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  return {
    getItem: (name) => {
      if (pending?.name === name) return pending.value;
      try {
        const raw = getStorage().getItem(name);
        return raw ? (JSON.parse(raw) as StorageValue<S>) : null;
      } catch {
        return null; // unreadable or corrupt → behave as if there is no draft
      }
    },
    setItem: (name, value) => {
      pending = { name, value };
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null;
      try {
        getStorage().removeItem(name);
      } catch {
        // ignore
      }
    },
    flush,
  };
}
