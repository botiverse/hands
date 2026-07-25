import type {
  FeedbackLocale,
  FeedbackStatus,
  FeedbackTransportErrorCode,
} from "./types.js";

export type FeedbackMessageKey =
  | "attachments"
  | "back"
  | "cancel"
  | "conversation"
  | "emptyBody"
  | "emptyTitle"
  | "feedback"
  | "feedbackType"
  | "inboxDescription"
  | "loadMore"
  | "loadMoreReplies"
  | "loading"
  | "loadingMore"
  | "newDescription"
  | "newFeedback"
  | "newReplies"
  | "noReplies"
  | "openAttachment"
  | "problem"
  | "question"
  | "refresh"
  | "remove"
  | "reply"
  | "retry"
  | "retryUpload"
  | "screenshots"
  | "sendReply"
  | "sending"
  | "submit"
  | "submitting"
  | "statusFilter"
  | "team"
  | "feedbackCreated"
  | "replySent"
  | "ticketUpdated"
  | "ticketHeading"
  | "unread"
  | "update"
  | "uploadCanceled"
  | "uploadFailed"
  | "uploadProgress"
  | "you";

const messages: Record<FeedbackLocale, Record<FeedbackMessageKey, string>> = {
  en: {
    attachments: "Attachments",
    back: "Back",
    cancel: "Cancel",
    conversation: "Conversation",
    emptyBody: "Send your first idea or report a problem.",
    emptyTitle: "No feedback yet",
    feedback: "Feedback",
    feedbackType: "Feedback type",
    inboxDescription: "Your feedback and replies from the team.",
    loadMore: "Load more",
    loadMoreReplies: "Load more replies",
    loading: "Loading feedback",
    loadingMore: "Loading…",
    newDescription: "Share an idea or report a problem.",
    newFeedback: "New feedback",
    newReplies: "New replies",
    noReplies: "No replies yet",
    openAttachment: "Open attachment",
    problem: "Problem",
    question: "What would you like us to know?",
    refresh: "Refresh",
    remove: "Remove",
    reply: "Reply",
    retry: "Try again",
    retryUpload: "Retry upload",
    screenshots: "Screenshots (up to 3)",
    sendReply: "Send reply",
    sending: "Sending…",
    submit: "Submit feedback",
    submitting: "Submitting…",
    statusFilter: "Status filter",
    team: "Team",
    feedbackCreated: "Feedback created",
    replySent: "Reply sent",
    ticketUpdated: "Ticket updated",
    ticketHeading: "Feedback ticket",
    unread: "unread",
    update: "Update",
    uploadCanceled: "Upload canceled",
    uploadFailed: "Upload failed",
    uploadProgress: "upload progress",
    you: "You",
  },
  "zh-CN": {
    attachments: "附件",
    back: "返回",
    cancel: "取消",
    conversation: "对话",
    emptyBody: "提交第一个想法或问题。",
    emptyTitle: "暂无反馈",
    feedback: "反馈",
    feedbackType: "反馈类型",
    inboxDescription: "你的反馈和团队回复。",
    loadMore: "加载更多",
    loadMoreReplies: "加载更多回复",
    loading: "正在加载反馈",
    loadingMore: "加载中…",
    newDescription: "分享想法或报告问题。",
    newFeedback: "新建反馈",
    newReplies: "有新回复",
    noReplies: "暂无回复",
    openAttachment: "打开附件",
    problem: "问题",
    question: "你想告诉我们什么？",
    refresh: "刷新",
    remove: "移除",
    reply: "回复",
    retry: "重试",
    retryUpload: "重试上传",
    screenshots: "截图（最多 3 张）",
    sendReply: "发送回复",
    sending: "发送中…",
    submit: "提交反馈",
    submitting: "提交中…",
    statusFilter: "状态筛选",
    team: "团队",
    feedbackCreated: "反馈已创建",
    replySent: "回复已发送",
    ticketUpdated: "工单已更新",
    ticketHeading: "反馈工单",
    unread: "条未读",
    update: "更新",
    uploadCanceled: "上传已取消",
    uploadFailed: "上传失败",
    uploadProgress: "上传进度",
    you: "你",
  },
};

export function resolveFeedbackLocale(
  explicit?: FeedbackLocale,
): FeedbackLocale {
  if (explicit) return explicit;
  if (typeof navigator !== "undefined") {
    const requested = [
      ...(navigator.languages ?? []),
      navigator.language,
    ].filter(Boolean);
    if (requested.some((value) => value.toLowerCase().startsWith("zh")))
      return "zh-CN";
  }
  return "en";
}

export function feedbackMessage(
  locale: FeedbackLocale,
  key: FeedbackMessageKey,
): string {
  return messages[locale][key];
}

export function feedbackStatusLabel(
  locale: FeedbackLocale,
  status: FeedbackStatus,
): string {
  const labels: Record<FeedbackLocale, Record<FeedbackStatus, string>> = {
    en: {
      open: "Open",
      in_progress: "In progress",
      resolved: "Resolved",
      closed: "Closed",
    },
    "zh-CN": {
      open: "待处理",
      in_progress: "处理中",
      resolved: "已解决",
      closed: "已关闭",
    },
  };
  return labels[locale][status];
}

export function feedbackErrorMessage(
  locale: FeedbackLocale,
  code?: FeedbackTransportErrorCode,
): string {
  const fallback =
    locale === "zh-CN"
      ? "反馈服务暂时不可用。"
      : "Feedback is temporarily unavailable.";
  if (!code) return fallback;
  const copy: Record<
    FeedbackLocale,
    Record<FeedbackTransportErrorCode, string>
  > = {
    en: {
      conflict: "This retry no longer matches the original request.",
      invalid: "Check the feedback details and try again.",
      not_found: "This feedback ticket is no longer available.",
      rate_limited: "Too many feedback requests. Try again later.",
      unauthorized:
        "Your feedback session expired. Reopen feedback and try again.",
      unavailable: fallback,
    },
    "zh-CN": {
      conflict: "本次重试与原请求不一致。",
      invalid: "请检查反馈内容后重试。",
      not_found: "该反馈工单已不可用。",
      rate_limited: "请求过于频繁，请稍后重试。",
      unauthorized: "反馈会话已过期，请重新打开后重试。",
      unavailable: fallback,
    },
  };
  return copy[locale][code];
}
