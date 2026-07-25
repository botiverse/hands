// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackWorkspace } from "./components.js";
import { FeedbackProvider } from "./provider.js";
import type {
  FeedbackTicketDetail,
  FeedbackTicketPage,
  HandsFeedbackTransport,
} from "./types.js";

afterEach(cleanup);

const ticket = {
  id: "ticket-1",
  kind: "feedback" as const,
  status: "open" as const,
  message: "A reporter-visible ticket",
  createdAt: 1,
  updatedAt: 2,
  unread: true,
  unreadCount: 2,
  attachmentCount: 0,
  commentCount: 1,
};

const page: FeedbackTicketPage = {
  tickets: [ticket],
  nextCursor: null,
  unreadTotal: 2,
};

const detail: FeedbackTicketDetail = {
  ticket: { ...ticket, unread: false, unreadCount: 0 },
  comments: [{ id: "comment-1", authorType: "staff", body: "Thanks", createdAt: 3 }],
  attachments: [],
  nextCommentCursor: null,
  unreadTotal: 0,
};

function transport(): HandsFeedbackTransport {
  return {
    listTickets: vi.fn(async () => page),
    getTicket: vi.fn(async () => detail),
    createTicket: vi.fn(async () => detail),
    addComment: vi.fn(async () => detail),
  };
}

describe("FeedbackWorkspace browser behavior", () => {
  it("lands on the Hands-backed list and reports authoritative unread changes", async () => {
    const adapter = transport();
    const onUnreadChanged = vi.fn();
    const { container } = render(
      <FeedbackProvider transport={adapter} theme="brutal" onUnreadChanged={onUnreadChanged}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    expect(container.querySelector("[data-hands-feedback-theme='brutal']")).not.toBeNull();
    expect(await screen.findByText(ticket.message)).toBeTruthy();
    expect(adapter.listTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    expect(adapter.listTickets).not.toHaveBeenCalledWith(expect.objectContaining({ reporterId: expect.anything() }));
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);
    expect(onUnreadChanged).toHaveBeenLastCalledWith({ total: 2, source: "list" });

    fireEvent.click(screen.getByText(ticket.message));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    expect(adapter.getTicket).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: ticket.id,
      commentLimit: 100,
    }));
    await waitFor(() => expect(onUnreadChanged).toHaveBeenLastCalledWith({ total: 0, source: "detail" }));

    fireEvent.click(screen.getByText("Back"));
    expect(await screen.findByText(ticket.message)).toBeTruthy();
  });

  it("does not re-notify when list and detail return the same authoritative total", async () => {
    const adapter = transport();
    adapter.getTicket = vi.fn(async () => ({ ...detail, unreadTotal: page.unreadTotal }));
    const onUnreadChanged = vi.fn();
    render(
      <FeedbackProvider transport={adapter} onUnreadChanged={onUnreadChanged}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByText(ticket.message));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);
    expect(onUnreadChanged).toHaveBeenCalledWith({ total: 2, source: "list" });
  });
});
