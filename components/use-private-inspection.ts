"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Private results belong to one visible lookup, even if fetch ignores abort.
export function usePrivateInspection<T>() {
  const [view, setView] = useState<T | { state: "idle" | "loading" }>({ state: "idle" });
  const pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    setView({ state: "idle" });
  }, []);
  useEffect(() => {
    const onHide = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", clear);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", clear);
      pending.current?.abort();
    };
  }, [clear]);
  async function inspect(load: (signal: AbortSignal) => Promise<T>) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setView({ state: "loading" });
    const next = await load(controller.signal);
    if (!controller.signal.aborted) setView(next);
  }
  return { view, clear, inspect };
}
