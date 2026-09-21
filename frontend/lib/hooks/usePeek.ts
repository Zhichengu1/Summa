"use client";
// usePeek — hover/focus intent for the company peek card (components/CompanyPeek).
// Any surface that shows companies (the watchlist dock, heatmap tiles, movers,
// table rows) gets the same behaviour: the card opens after a short hover (at once
// on keyboard focus), stays while the pointer is over the trigger or the card,
// closes on leave / scroll / resize, and never appears on touch or narrow layouts.
// Positions are viewport coordinates for a fixed-position card beside the trigger.

import { useCallback, useEffect, useRef, useState } from "react";

export type PeekState = { cik: string; top: number; left: number };
export type PeekPoint = { x: number; y: number };

const canPeek = () =>
  typeof window !== "undefined" && window.matchMedia("(min-width: 961px) and (hover: hover)").matches;

export function usePeek({
  side = "right", delay = 220, width = 284, height = 410,
}: { side?: "left" | "right"; delay?: number; width?: number; height?: number } = {}) {
  const CARD_W = width;
  const CARD_H = height;   // generous estimate so the card never runs off the bottom
  const [peek, setPeek] = useState<PeekState | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  // Beside the trigger element, or — for wide rows — beside the pointer.
  const place = useCallback((cik: string, el: HTMLElement, at?: PeekPoint) => {
    const r = el.getBoundingClientRect();
    const anchorTop = at ? at.y - 24 : r.top;
    const top = Math.max(8, Math.min(anchorTop, window.innerHeight - CARD_H - 8));
    let left: number;
    if (at) {
      left = at.x + 18;
      if (left + CARD_W > window.innerWidth - 8) left = at.x - CARD_W - 18;   // flip to the left of the pointer
    } else {
      left = side === "right" ? r.right + 8 : r.left - CARD_W - 8;
      if (left + CARD_W > window.innerWidth - 8) left = r.left - CARD_W - 8;   // flip when it wouldn't fit
    }
    if (left < 8) left = Math.min(r.right + 8, window.innerWidth - CARD_W - 8);
    setPeek({ cik, top, left });
  }, [side, CARD_W, CARD_H]);

  /** Pointer entered / keyboard focused a trigger. `at` anchors the card to the pointer. */
  const enter = useCallback((cik: string, el: HTMLElement, immediate = false, at?: PeekPoint) => {
    if (!canPeek()) return;
    clearTimers();
    if (immediate) place(cik, el, at);
    else openTimer.current = setTimeout(() => place(cik, el, at), delay);
  }, [clearTimers, place, delay]);

  /** Pointer left the trigger (or the card) — close after a grace period. */
  const leave = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => setPeek(null), 160);
  }, [clearTimers]);

  /** Pointer moved onto the card — keep it open. */
  const hold = useCallback(() => clearTimers(), [clearTimers]);

  const close = useCallback(() => { clearTimers(); setPeek(null); }, [clearTimers]);

  // Scrolling or resizing anywhere invalidates the position — just close.
  useEffect(() => {
    const onMove = () => { clearTimers(); setPeek(null); };
    document.addEventListener("scroll", onMove, { capture: true, passive: true });
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("scroll", onMove, { capture: true });
      window.removeEventListener("resize", onMove);
      clearTimers();
    };
  }, [clearTimers]);

  return { peek, enter, leave, hold, close };
}
