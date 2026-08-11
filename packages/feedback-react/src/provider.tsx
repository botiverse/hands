import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { ThemeProvider } from "raft-ui";
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
  type FeedbackMessages,
  type FeedbackMessageValues,
} from "./locale.js";

type FeedbackContextValue = {
  transport: HandsFeedbackTransport;
  theme: FeedbackTheme;
  locale: FeedbackLocale;
  message(key: FeedbackMessageKey, values?: FeedbackMessageValues): string;
  formatDate(value: number): string;
  formatFileSize(value: number): string;
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
  /** Partial copy override; missing keys fall back to the selected SDK locale. */
  messages?: Partial<FeedbackMessages>;
  /** Override date/time presentation while retaining the resolved SDK locale. */
  formatDate?: (value: Date, context: { locale: FeedbackLocale }) => string;
  /** Override attachment size presentation for the selected locale. */
  formatFileSize?: (
    bytes: number,
    context: { locale: FeedbackLocale },
  ) => string;
  onUnreadChanged?: (change: FeedbackUnreadChange) => void;
  children: ReactNode;
};

export function FeedbackProvider({
  transport,
  theme = "elegant",
  locale: localeOverride,
  messages,
  formatDate: formatDateOverride,
  formatFileSize: formatFileSizeOverride,
  onUnreadChanged,
  children,
}: FeedbackProviderProps) {
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const locale = resolveFeedbackLocale(localeOverride);
  const message = useCallback(
    (key: FeedbackMessageKey, values?: FeedbackMessageValues) =>
      feedbackMessage(locale, key, messages, values),
    [locale, messages],
  );
  const formatDate = useCallback(
    (value: number) =>
      formatDateOverride?.(new Date(value), { locale }) ??
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    [formatDateOverride, locale],
  );
  const formatFileSize = useCallback(
    (bytes: number) =>
      formatFileSizeOverride?.(bytes, { locale }) ??
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "kilobyte",
        unitDisplay: "short",
        maximumFractionDigits: 0,
      }).format(Math.ceil(bytes / 1024)),
    [formatFileSizeOverride, locale],
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
      formatDate,
      formatFileSize,
      unreadTotal,
      reportUnread,
    }),
    [
      transport,
      theme,
      locale,
      message,
      formatDate,
      formatFileSize,
      unreadTotal,
      reportUnread,
    ],
  );
  return (
    <ThemeProvider theme={theme} syncDom={false}>
      <FeedbackContext.Provider value={value}>
        {children}
      </FeedbackContext.Provider>
    </ThemeProvider>
  );
}

export function useHandsFeedback(): FeedbackContextValue {
  const value = useContext(FeedbackContext);
  if (!value)
    throw new Error("Hands feedback components require FeedbackProvider");
  return value;
}
