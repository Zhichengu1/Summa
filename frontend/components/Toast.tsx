"use client";
// Toasts — transient bottom-right notices ("AAPL added to your watchlist", with an
// optional action such as Undo). Pure presentational: the queue lives in
// lib/hooks/useToasts.ts and the root Page renders this once.
import { Icon } from "./Icon";
import type { ToastItem } from "../lib/hooks/useToasts";

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="toast-stack" role="region" aria-label="Notifications">
      {items.map((t) => (
        <div key={t.id} className={`toast${t.tone ? ` toast-${t.tone}` : ""}`} role="status" aria-live="polite">
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => { t.action?.onClick(); onDismiss(t.id); }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={13} /></button>
        </div>
      ))}
    </div>
  );
}
