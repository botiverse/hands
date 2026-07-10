/**
 * Toast notification system.
 *
 * This is a thin ADAPTER over raft-ui's elegant Toast component. The public
 * API (ToastProvider / useToast / Toast / ToastKind) is preserved so no call
 * site needs to change, but the actual rendering is delegated to raft-ui's
 * `ToastProvider` + `useToastManager` (backed by base-ui's toast primitives).
 *
 * Usage:
 *   - Wrap the app root in <ToastProvider>
 *   - Anywhere: const { show } = useToast(); show({ kind: "loading", title: "..." })
 *
 * Toasts stack in the bottom-right corner. `show()` returns an opaque id
 * (a string, produced by raft-ui) so callers can update (loading -> success)
 * or dismiss the toast.
 */

import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import { ToastProvider as RaftToastProvider, useToastManager } from "raft-ui";

export type ToastKind = "loading" | "success" | "error" | "info";

/** Opaque toast id. raft-ui/base-ui identifies toasts by string. */
export type ToastId = string;

export interface Toast {
  id: ToastId;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Auto-dismiss after this many ms. Set to 0 to disable. Default 4500. */
  ttlMs?: number;
  /** Optional sticky footer content (e.g. progress bar). */
  progress?: number; // 0..1
}

interface ToastApi {
  show: (t: Omit<Toast, "id">) => ToastId;
  update: (id: ToastId, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: ToastId) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

/** Auto-dismiss defaults, matching the previous bespoke implementation. */
function defaultTtl(kind: ToastKind): number {
  return kind === "loading" ? 10000 : kind === "error" ? 8000 : 4500;
}

/**
 * Build the base-ui `description` ReactNode. base-ui renders the description
 * inside a `<p>`, so the optional progress bar is composed from phrasing-level
 * `<span>`s (styled as blocks) rather than `<div>`s to keep the markup valid.
 */
function buildDescription(
  description?: string,
  progress?: number,
): React.ReactNode {
  const hasProgress = typeof progress === "number";
  if (!description && !hasProgress) return undefined;
  return (
    <>
      {description ? (
        <span className="wrap-break-word">{description}</span>
      ) : null}
      {hasProgress ? (
        <span className="mt-2 block h-1.5 bg-slate-100 rounded-sm overflow-hidden">
          <span
            className="block h-full bg-blue-500 transition-all"
            style={{ width: `${Math.round((progress as number) * 100)}%` }}
          />
        </span>
      ) : null}
    </>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  // raft-ui's ToastProvider renders its elegant DefaultToastLayer (viewport +
  // toasts) automatically. Bottom-right placement matches the old stacking.
  return (
    <RaftToastProvider viewportPlacement="bottom-right">
      <ToastAdapter>{children}</ToastAdapter>
    </RaftToastProvider>
  );
}

/**
 * Bridges the legacy {show, update, dismiss} API onto raft-ui's toast manager.
 * Must live inside <RaftToastProvider> so `useToastManager()` sees its context.
 */
function ToastAdapter({ children }: { children: React.ReactNode }) {
  const manager = useToastManager();
  // We keep our own logical copy of each live toast so that a partial
  // `update()` (e.g. only `progress`) can rebuild the description ReactNode
  // from the merged state, exactly like the old in-memory implementation.
  const stateRef = useRef<Map<ToastId, Omit<Toast, "id">>>(new Map());

  const show = useCallback<ToastApi["show"]>(
    (t) => {
      const timeout = t.ttlMs !== undefined ? t.ttlMs : defaultTtl(t.kind);
      const id = manager.add({
        title: t.title,
        description: buildDescription(t.description, t.progress),
        type: t.kind,
        timeout,
        priority: t.kind === "error" ? "high" : "low",
      });
      stateRef.current.set(id, { ...t, ttlMs: timeout });
      return id;
    },
    [manager],
  );

  const update = useCallback<ToastApi["update"]>(
    (id, patch) => {
      const existing = stateRef.current.get(id);
      if (!existing) return;
      const merged = { ...existing, ...patch };
      stateRef.current.set(id, merged);
      // Always pass a fresh timeout so loading -> success/error transitions
      // reschedule the auto-dismiss timer (base-ui resets the timer whenever
      // `timeout` is present in the update options).
      const timeout =
        patch.ttlMs !== undefined ? patch.ttlMs : defaultTtl(merged.kind);
      manager.update(id, {
        title: merged.title,
        description: buildDescription(merged.description, merged.progress),
        type: merged.kind,
        timeout,
        priority: merged.kind === "error" ? "high" : "low",
      });
    },
    [manager],
  );

  const dismiss = useCallback<ToastApi["dismiss"]>(
    (id) => {
      manager.close(id);
      stateRef.current.delete(id);
    },
    [manager],
  );

  const api = useMemo<ToastApi>(
    () => ({ show, update, dismiss }),
    [show, update, dismiss],
  );

  return <ToastCtx.Provider value={api}>{children}</ToastCtx.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast() must be used within <ToastProvider>");
  return ctx;
}
