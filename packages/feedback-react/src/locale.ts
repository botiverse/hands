import type {
  FeedbackLocale,
  FeedbackStatus,
  FeedbackTransportErrorCode,
} from "./types.js";

export type FeedbackMessageKey =
  | "active"
  | "all"
  | "attachmentTooLarge"
  | "attachmentTooMany"
  | "attachmentUnsupported"
  | "attachmentSummary"
  | "attachmentHint"
  | "attachments"
  | "attachFile"
  | "attachImage"
  | "back"
  | "cancel"
  | "closeTicket"
  | "closeTicketConfirm"
  | "closeTicketDescription"
  | "closingTicket"
  | "closedDescription"
  | "conversation"
  | "describePlaceholder"
  | "emptyActiveBody"
  | "emptyActiveTitle"
  | "emptyAllBody"
  | "emptyAllTitle"
  | "emptyEndedBody"
  | "emptyEndedTitle"
  | "ended"
  | "errorConflict"
  | "errorInvalid"
  | "errorNotFound"
  | "errorRateLimited"
  | "errorUnauthorized"
  | "errorUnavailable"
  | "feedback"
  | "feedbackType"
  | "idea"
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
  | "refreshing"
  | "reopenTicket"
  | "reopeningTicket"
  | "remove"
  | "reply"
  | "replyPlaceholder"
  | "retry"
  | "retryUpload"
  | "screenshots"
  | "sendReply"
  | "sending"
  | "submit"
  | "submitting"
  | "statusFilter"
  | "statusClosed"
  | "statusInProgress"
  | "statusOpen"
  | "statusResolved"
  | "team"
  | "type"
  | "feedbackCreated"
  | "replySent"
  | "ticketClosed"
  | "ticketReopened"
  | "ticketUpdated"
  | "ticketHeading"
  | "unreadCount"
  | "update"
  | "uploadCanceled"
  | "uploadFailed"
  | "uploadProgress"
  | "workspaceTitle"
  | "you";

export type FeedbackMessages = Record<FeedbackMessageKey, string>;
export type FeedbackMessageValues = Record<string, string | number>;

const messages: Record<FeedbackLocale, FeedbackMessages> = {
  en: {
    active: "Active",
    all: "All",
    ended: "Ended",
    attachmentTooLarge: "{name} is larger than 10 MB.",
    attachmentTooMany: "Choose no more than {count} screenshots.",
    attachmentUnsupported: "{name} is not a supported image.",
    attachmentSummary: "{name} · {size}",
    attachmentHint: "Up to {count} images.",
    attachments: "Attachments",
    attachFile: "Attach file",
    attachImage: "Attach image",
    back: "Back",
    cancel: "Cancel",
    closeTicket: "Close ticket",
    closeTicketConfirm: "Close this ticket?",
    closeTicketDescription:
      "You won’t be able to add more replies after closing it. You can reopen it if more information is needed.",
    closingTicket: "Closing…",
    closedDescription: "This ticket is closed. You can reopen it if more information is needed.",
    conversation: "Conversation",
    describePlaceholder: "Describe your idea or the problem you ran into…",
    emptyActiveBody: "Resolved or closed feedback lives under “Ended”.",
    emptyActiveTitle: "Nothing in progress",
    emptyAllBody:
      "Share an idea or report a problem — team replies will show up here.",
    emptyAllTitle: "No feedback yet",
    emptyEndedBody:
      "Feedback appears here once it’s resolved or closed.",
    emptyEndedTitle: "Nothing ended yet",
    errorConflict: "This retry no longer matches the original request.",
    errorInvalid: "Check the feedback details and try again.",
    errorNotFound: "This feedback ticket is no longer available.",
    errorRateLimited: "Too many feedback requests. Try again later.",
    errorUnauthorized:
      "Your feedback session expired. Reopen feedback and try again.",
    errorUnavailable: "Couldn't load feedback. Try again.",
    feedback: "Feedback",
    feedbackType: "Feedback type",
    idea: "Idea",
    inboxDescription: "Your feedback and replies from the team.",
    loadMore: "Load more",
    loadMoreReplies: "Load more replies",
    loading: "Loading feedback",
    loadingMore: "Loading…",
    newDescription: "Share an idea or report a problem.",
    newFeedback: "New feedback",
    newReplies: "New replies",
    noReplies: "No replies yet",
    openAttachment: "Open attachment {name}",
    problem: "Problem",
    question: "What would you like us to know?",
    refresh: "Refresh",
    refreshing: "Refreshing…",
    reopenTicket: "Reopen ticket",
    reopeningTicket: "Reopening…",
    remove: "Remove",
    reply: "Reply",
    replyPlaceholder: "Write a reply…",
    retry: "Try again",
    retryUpload: "Retry upload",
    screenshots: "Screenshots (up to {count})",
    sendReply: "Send reply",
    sending: "Sending…",
    submit: "Submit",
    submitting: "Submitting…",
    statusFilter: "Status filter",
    statusClosed: "Closed",
    statusInProgress: "In progress",
    statusOpen: "Open",
    statusResolved: "Resolved",
    team: "Team",
    type: "Type",
    feedbackCreated: "Feedback created",
    replySent: "Reply sent",
    ticketClosed: "Ticket closed",
    ticketReopened: "Ticket reopened",
    ticketUpdated: "Ticket updated",
    ticketHeading: "Feedback ticket",
    unreadCount: "{count} unread",
    update: "Update",
    uploadCanceled: "Upload canceled",
    uploadFailed: "Upload failed",
    uploadProgress: "Upload progress for {name}",
    workspaceTitle: "My Feedback",
    you: "You",
  },
  "zh-CN": {
    active: "活跃",
    all: "全部",
    ended: "已结束",
    attachmentTooLarge: "{name} 超过 10 MB。",
    attachmentTooMany: "最多选择 {count} 张截图。",
    attachmentUnsupported: "{name} 不是支持的图片格式。",
    attachmentSummary: "{name} · {size}",
    attachmentHint: "最多添加 {count} 张图片。",
    attachments: "附件",
    attachFile: "添加文件",
    attachImage: "添加图片",
    back: "返回",
    cancel: "取消",
    closeTicket: "关闭工单",
    closeTicketConfirm: "确定关闭这个工单吗？",
    closeTicketDescription: "关闭后你将不能继续回复。如需补充信息，你可以重新打开。",
    closingTicket: "正在关闭…",
    closedDescription: "该工单已关闭。如需更多信息，你可以重新打开。",
    conversation: "对话",
    describePlaceholder: "描述你的想法或遇到的问题…",
    emptyActiveBody: "已解决或已关闭的反馈在「已结束」里。",
    emptyActiveTitle: "没有进行中的反馈",
    emptyAllBody: "分享想法或报告问题，团队回复会显示在这里。",
    emptyAllTitle: "还没有反馈",
    emptyEndedBody: "反馈被解决或关闭后，会出现在这里。",
    emptyEndedTitle: "还没有已结束的反馈",
    errorConflict: "本次重试与原请求不一致。",
    errorInvalid: "请检查反馈内容后重试。",
    errorNotFound: "该反馈工单已不可用。",
    errorRateLimited: "请求过于频繁，请稍后重试。",
    errorUnauthorized: "反馈会话已过期，请重新打开后重试。",
    errorUnavailable: "反馈加载失败，请重试。",
    feedback: "反馈",
    feedbackType: "反馈类型",
    idea: "想法",
    inboxDescription: "你的反馈和团队回复。",
    loadMore: "加载更多",
    loadMoreReplies: "加载更多回复",
    loading: "正在加载反馈",
    loadingMore: "加载中…",
    newDescription: "分享想法或报告问题。",
    newFeedback: "新建反馈",
    newReplies: "有新回复",
    noReplies: "暂无回复",
    openAttachment: "打开附件 {name}",
    problem: "问题",
    question: "你想告诉我们什么？",
    refresh: "刷新",
    refreshing: "正在刷新…",
    reopenTicket: "重新打开",
    reopeningTicket: "正在重新打开…",
    remove: "移除",
    reply: "回复",
    replyPlaceholder: "写下回复…",
    retry: "重试",
    retryUpload: "重试上传",
    screenshots: "截图（最多 {count} 张）",
    sendReply: "发送回复",
    sending: "发送中…",
    submit: "提交",
    submitting: "提交中…",
    statusFilter: "状态筛选",
    statusClosed: "已关闭",
    statusInProgress: "处理中",
    statusOpen: "待处理",
    statusResolved: "已解决",
    team: "团队",
    type: "类型",
    feedbackCreated: "反馈已创建",
    replySent: "回复已发送",
    ticketClosed: "工单已关闭",
    ticketReopened: "工单已重新打开",
    ticketUpdated: "工单已更新",
    ticketHeading: "反馈工单",
    unreadCount: "{count} 条未读",
    update: "更新",
    uploadCanceled: "上传已取消",
    uploadFailed: "上传失败",
    uploadProgress: "{name} 的上传进度",
    workspaceTitle: "我的反馈",
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
    return resolveFeedbackLocaleFromPreferences(requested);
  }
  return "en";
}

export function resolveFeedbackLocaleFromPreferences(
  preferences: readonly string[],
): FeedbackLocale {
  for (const value of preferences) {
    const normalized = value.toLowerCase();
    if (normalized.startsWith("en")) return "en";
    if (normalized.startsWith("zh")) return "zh-CN";
  }
  return "en";
}

export function feedbackMessage(
  locale: FeedbackLocale,
  key: FeedbackMessageKey,
  overrides?: Partial<FeedbackMessages>,
  values?: FeedbackMessageValues,
): string {
  const template = overrides?.[key] ?? messages[locale][key];
  if (!values) return template;
  return template.replace(/\{([^}]+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
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
  const keys: Record<FeedbackTransportErrorCode, FeedbackMessageKey> = {
    conflict: "errorConflict",
    invalid: "errorInvalid",
    not_found: "errorNotFound",
    rate_limited: "errorRateLimited",
    unauthorized: "errorUnauthorized",
    unavailable: "errorUnavailable",
  };
  return feedbackMessage(locale, code ? keys[code] : "errorUnavailable");
}
