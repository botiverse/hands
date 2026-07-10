/**
 * Toast notification system.
 *
 * Usage:
 *   - Wrap the app root in <ToastProvider>
 *   - Anywhere: const { show } = useToast(); show({ kind: "loading", title: "..." })
 *
 * Toasts stack in the bottom-right corner. The component returns a numeric
 * id so callers can update (loading -> success) or dismiss the toast.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "raft-ui";

export type ToastKind = "loading" | "success" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Auto-dismiss after this many ms. Set to 0 to disable. Default 4500. */
  ttlMs?: number;
  /** Optional sticky footer content (e.g. progress bar). */
  progress?: number; // 0..1
}

interface ToastApi {
  show: (t: Omit<Toast, "id">) => number;
  update: (id: number, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (t) => {
      const id = nextId.current++;
      const effectiveTtl =
        t.ttlMs !== undefined ? t.ttlMs : t.kind === "loading" ? 10000 : 4500;
      setToasts((cur) => [...cur, { id, ttlMs: effectiveTtl, ...t }]);
      // Loading toasts get a safety TTL so they don't live forever even if
      // the caller never `update()`s them. Successful/error/info toasts
      // dismiss on their own after ttlMs.
      if (effectiveTtl > 0) {
        const handle = setTimeout(() => dismiss(id), effectiveTtl);
        timers.current.set(id, handle);
      }
      return id;
    },
    [dismiss],
  );

  const update = useCallback<ToastApi["update"]>(
    (id, patch) => {
      setToasts((cur) => {
        const existing = cur.find((t) => t.id === id);
        if (!existing) return cur;
        const merged = { ...existing, ...patch };
        // When converting a loading toast to a terminal kind, schedule
        // the terminal TTL fresh.
        return cur.map((t) => (t.id === id ? merged : t));
      });
      const mergedKind = patch.kind;
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      // Always reschedule on update so transitions get fresh timers.
      const nextTtl =
        patch.ttlMs !== undefined
          ? patch.ttlMs
          : mergedKind === "loading"
            ? 10000
            : mergedKind === "error"
              ? 8000
              : 4500;
      if (nextTtl > 0) {
        const handle = setTimeout(() => dismiss(id), nextTtl);
        timers.current.set(id, handle);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    return () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    };
  }, []);

  return (
    <ToastCtx.Provider value={{ show, update, dismiss }}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast() must be used within <ToastProvider>");
  return ctx;
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const isLoading = toast.kind === "loading";
  const isError = toast.kind === "error";
  const isSuccess = toast.kind === "success";

  const borderClass = isError
    ? "border-red-300"
    : isSuccess
      ? "border-green-300"
      : isLoading
        ? "border-blue-300"
        : "border-slate-200";

  const iconBg = isError
    ? "bg-red-100 text-red-600"
    : isSuccess
      ? "bg-green-100 text-green-600"
      : isLoading
        ? "bg-blue-100 text-blue-600"
        : "bg-slate-100 text-slate-600";

  return (
    <div
      role="status"
      aria-live={isError ? "assertive" : "polite"}
      className={`card p-3! flex items-start gap-3 border ${borderClass} animate-in slide-in-from-right-5`}
    >
      <div
        className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center ${iconBg}`}
      >
        {isLoading && (
          <svg
            className="w-4 h-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
          </svg>
        )}
        {isSuccess && (
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
          >
            <path
              fillRule="evenodd"
              d="M16.704 5.296a1 1 0 010 1.414l-7.997 7.997a1 1 0 01-1.414 0l-3.997-3.997a1 1 0 011.414-1.414L9 11.586l6.29-6.29a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        )}
        {isError && (
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        )}
        {toast.kind === "info" && (
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-.5a.5.5 0 00-.5-.5H9z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{toast.title}</div>
        {toast.description && (
          <div className="text-xs text-slate-500 mt-0.5 wrap-break-word">
            {toast.description}
          </div>
        )}
        {typeof toast.progress === "number" && (
          <div className="mt-2 h-1.5 bg-slate-100 rounded-sm overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all"
              style={{ width: `${Math.round(toast.progress * 100)}%` }}
            />
          </div>
        )}
      </div>
      {!isLoading && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-slate-400 hover:text-slate-700 -mr-1 -mt-1"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </Button>
      )}
    </div>
  );
}