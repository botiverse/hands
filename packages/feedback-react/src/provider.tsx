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
  FeedbackLocale,
  FeedbackTheme,
  FeedbackUnreadChange,
  HandsFeedbackTransport,
} from "./types.js";
import {
  feedbackMessage,
  resolveFeedbackLocale,
  type FeedbackMessageKey,
} from "./locale.js";

type FeedbackContextValue = {
  transport: HandsFeedbackTransport;
  theme: FeedbackTheme;
  locale: FeedbackLocale;
  message(key: FeedbackMessageKey): string;
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
  /** Defaults to browser language (`zh*` -> `zh-CN`, otherwise `en`). */
  locale?: FeedbackLocale;
  onUnreadChanged?: (change: FeedbackUnreadChange) => void;
  children: ReactNode;
};

export function FeedbackProvider({
  transport,
  theme = "elegant",
  locale: localeOverride,
  onUnreadChanged,
  children,
}: FeedbackProviderProps) {
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const locale = resolveFeedbackLocale(localeOverride);
  const message = useCallback(
    (key: FeedbackMessageKey) => feedbackMessage(locale, key),
    [locale],
  );
  const lastReported = useRef<{
    transport: HandsFeedbackTransport;
    total: number;
  } | null>(null);
  const reportUnread = useCallback(
    (change: FeedbackUnreadChange) => {
      const report = nextUnreadReport(
        lastReported.current?.transport === transport
          ? lastReported.current.total
          : null,
        change,
      );
      setUnreadTotal(report.next);
      if (report.notify) {
        lastReported.current = { transport, total: report.next };
        onUnreadChanged?.(change);
      }
    },
    [onUnreadChanged, transport],
  );
  const value = useMemo(
    () => ({
      transport,
      theme,
      locale,
      message,
      unreadTotal,
      reportUnread,
    }),
    [transport, theme, locale, message, unreadTotal, reportUnread],
  );
  return (
    <FeedbackContext.Provider value={value}>
      {children}
    </FeedbackContext.Provider>
  );
}

export function useHandsFeedback(): FeedbackContextValue {
  const value = useContext(FeedbackContext);
  if (!value)
    throw new Error("Hands feedback components require FeedbackProvider");
  return value;
}
