import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FeedbackTheme,
  FeedbackUnreadChange,
  HandsFeedbackTransport,
} from "./types.js";

type FeedbackContextValue = {
  transport: HandsFeedbackTransport;
  theme: FeedbackTheme;
  unreadTotal: number | null;
  reportUnread(change: FeedbackUnreadChange): void;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function nextUnreadReport(
  previous: number | null,
  change: FeedbackUnreadChange,
): { next: number; notify: boolean } {
  if (!Number.isSafeInteger(change.total) || change.total < 0) {
    throw new Error("Hands unread total must be a non-negative safe integer");
  }
  return { next: change.total, notify: previous !== change.total };
}

export type FeedbackProviderProps = {
  transport: HandsFeedbackTransport;
  theme?: FeedbackTheme;
  onUnreadChanged?: (change: FeedbackUnreadChange) => void;
  children: ReactNode;
};

export function FeedbackProvider({
  transport,
  theme = "elegant",
  onUnreadChanged,
  children,
}: FeedbackProviderProps) {
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const lastReported = useRef<number | null>(null);
  const reportUnread = useCallback((change: FeedbackUnreadChange) => {
    const report = nextUnreadReport(lastReported.current, change);
    setUnreadTotal(report.next);
    if (report.notify) {
      lastReported.current = report.next;
      onUnreadChanged?.(change);
    }
  }, [onUnreadChanged]);
  const value = useMemo(() => ({
    transport,
    theme,
    unreadTotal,
    reportUnread,
  }), [transport, theme, unreadTotal, reportUnread]);
  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

export function useHandsFeedback(): FeedbackContextValue {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error("Hands feedback components require FeedbackProvider");
  return value;
}
