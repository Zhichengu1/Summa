"use client";
// Small toast queue: push a message (optionally with an action like "Undo"), it
// auto-dismisses after `ttlMs`. At most three are shown at once — older ones drop.

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastItem = {
  id: number;
  text: string;
  tone?: "info" | "success" | "warn";
  action?: { label: string; onClick: () => void };
};

export function useToasts(ttlMs = 5000) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setItems((p) => p.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((text: string, opts?: Omit<ToastItem, "id" | "text">) => {
    const id = ++seq.current;
    setItems((p) => [...p.slice(-2), { id, text, ...opts }]);
    timers.current.set(id, setTimeout(() => dismiss(id), ttlMs));
    return id;
  }, [dismiss, ttlMs]);

  // Clear any pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => { for (const t of map.values()) clearTimeout(t); map.clear(); };
  }, []);

  return { items, push, dismiss };
}
