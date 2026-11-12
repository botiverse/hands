import { createRoot } from "react-dom/client";
import { Banner, BannerDescription } from "@botiverse/raft-ui";
import { FeedbackProvider, FeedbackWorkspace } from "../src/index.js";
import type { FeedbackTicketSummary, HandsFeedbackTransport } from "../src/index.js";

const params = new URLSearchParams(location.search);
document.documentElement.dir = params.get("rtl") === "1" ? "rtl" : "ltr";
const count = params.get("many") === "1" ? 30 : params.get("empty") === "1" ? 0 : 1;
const tickets: FeedbackTicketSummary[] = Array.from({ length: count }, (_, index) => ({
  id: `ticket-${index}`,
  kind: "feedback",
  status: "open",
  closureReason: null,
  duplicateOfTicketId: null,
  message: params.get("long") === "1"
    ? `Unbroken-${"x".repeat(250)}-${index}`
    : `Alignment test ticket ${index}`,
  createdAt: 1720000000000,
  updatedAt: 1720000000000,
  unread: index === 1,
  unreadCount: index === 1 ? 2 : 0,
  attachmentCount: 0,
  commentCount: 0,
}));
const detail = { ticket: tickets[0] ?? {
  id: "created", kind: "feedback" as const, status: "open" as const, closureReason: null,
  duplicateOfTicketId: null, message: "Created", createdAt: 1720000000000, updatedAt: 1720000000000,
  unread: false, unreadCount: 0, attachmentCount: 0, commentCount: 0,
}, comments: [], attachments: [], nextCommentCursor: null, unreadTotal: 0 };
const listCalls = { count: 0 };
Object.assign(window, { feedbackFixture: listCalls });
const transport: HandsFeedbackTransport = {
  listTickets: async () => {
    listCalls.count++;
    return { tickets, nextCursor: null, unreadTotal: 0 };
  },
  getTicket: async () => detail,
  createTicket: async () => detail,
  addComment: async () => detail,
};
createRoot(document.getElementById("root")!).render(
  <FeedbackProvider transport={transport} locale="en">
    <FeedbackWorkspace
      enablePullToRefresh
      inboxNotice={<Banner status="info"><BannerDescription>Did you know?</BannerDescription></Banner>}
    />
  </FeedbackProvider>,
);
