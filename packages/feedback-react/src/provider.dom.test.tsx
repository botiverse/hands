// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackWorkspace } from "./components.js";
import { FeedbackProvider } from "./provider.js";
import { FeedbackTransportError } from "./types.js";
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

  it("loads, deduplicates, and orders conversations beyond the first 100 comments", async () => {
    const adapter = transport();
    const firstComments = Array.from({ length: 100 }, (_, index) => ({
      id: `comment-${String(index + 1).padStart(3, "0")}`,
      authorType: "staff" as const,
      body: `Reply ${index + 1}`,
      createdAt: index + 1,
    }));
    adapter.getTicket = vi.fn(async ({ commentCursor }) => commentCursor
      ? {
          ...detail,
          comments: [firstComments[99]!, {
            id: "comment-101",
            authorType: "reporter",
            body: "Reply 101",
            createdAt: 101,
          }],
          nextCommentCursor: null,
        }
      : { ...detail, comments: firstComments, nextCommentCursor: "page-2" });
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );

    expect(await screen.findByText("Reply 100")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more replies"));
    expect(await screen.findByText("Reply 101")).toBeTruthy();
    expect(screen.getAllByText("Reply 100")).toHaveLength(1);
    expect(adapter.getTicket).toHaveBeenLastCalledWith(expect.objectContaining({ commentCursor: "page-2" }));
    expect(screen.queryByText("Load more replies")).toBeNull();
  });

  it("aborts an in-flight comment page when detail unmounts", async () => {
    const adapter = transport();
    let pageSignal: AbortSignal | undefined;
    let resolvePage: ((value: FeedbackTicketDetail) => void) | undefined;
    adapter.getTicket = vi.fn(({ commentCursor, signal }) => commentCursor
      ? new Promise<FeedbackTicketDetail>((resolve) => {
          pageSignal = signal;
          resolvePage = resolve;
        })
      : Promise.resolve({ ...detail, nextCommentCursor: "page-2" }));
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByText("Load more replies"));
    fireEvent.click(screen.getByText("Back"));
    expect(pageSignal?.aborted).toBe(true);
    resolvePage?.({
      ...detail,
      comments: [{ id: "late", authorType: "staff", body: "Late reply", createdAt: 100 }],
      nextCommentCursor: null,
    });
    await waitFor(() => expect(screen.queryByText("Late reply")).toBeNull());
  });

  it("never renders arbitrary transport errors on list, detail, create, or comment", async () => {
    const secretText = "internal database host and sk_agent_FAKE_SECRET";

    const listAdapter = transport();
    listAdapter.listTickets = vi.fn(async () => { throw new Error(secretText); });
    const listView = render(
      <FeedbackProvider transport={listAdapter}><FeedbackWorkspace /></FeedbackProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Feedback is temporarily unavailable.");
    expect(screen.queryByText(secretText)).toBeNull();
    listView.unmount();

    const detailAdapter = transport();
    detailAdapter.getTicket = vi.fn(async () => { throw new Error(secretText); });
    const detailView = render(
      <FeedbackProvider transport={detailAdapter}><FeedbackWorkspace initialTicketId={ticket.id} /></FeedbackProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Feedback is temporarily unavailable.");
    expect(screen.getByRole("heading", { name: "Feedback ticket" })).toBeTruthy();
    expect(screen.queryByText(secretText)).toBeNull();
    detailView.unmount();

    const createAdapter = transport();
    createAdapter.createTicket = vi.fn(async () => { throw new Error(secretText); });
    const createView = render(
      <FeedbackProvider transport={createAdapter}><FeedbackWorkspace /></FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), { target: { value: "Idea" } });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect((await screen.findByRole("alert")).textContent).toContain("Feedback is temporarily unavailable.");
    expect(screen.queryByText(secretText)).toBeNull();
    createView.unmount();

    const commentAdapter = transport();
    commentAdapter.addComment = vi.fn(async () => { throw new Error(secretText); });
    render(
      <FeedbackProvider transport={commentAdapter}><FeedbackWorkspace initialTicketId={ticket.id} /></FeedbackProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Reply"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByText("Send reply"));
    expect((await screen.findByRole("alert")).textContent).toContain("Feedback is temporarily unavailable.");
    expect(screen.queryByText(secretText)).toBeNull();
  });

  it("maps only closed transport error codes to fixed user-safe copy", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => {
      throw new FeedbackTransportError("rate_limited", { cause: new Error("hidden internal detail") });
    });
    render(<FeedbackProvider transport={adapter}><FeedbackWorkspace /></FeedbackProvider>);
    expect((await screen.findByRole("alert")).textContent).toContain("Too many feedback requests. Try again later.");
    expect(screen.queryByText("hidden internal detail")).toBeNull();
  });

  it("reuses idempotency IDs for unchanged create and comment retries", async () => {
    const createAdapter = transport();
    let createAttempt = 0;
    createAdapter.createTicket = vi.fn(async () => {
      createAttempt += 1;
      if (createAttempt === 1) throw new FeedbackTransportError("unavailable");
      return detail;
    });
    const createView = render(
      <FeedbackProvider transport={createAdapter}><FeedbackWorkspace /></FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), { target: { value: "Retry me" } });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    const createCalls = vi.mocked(createAdapter.createTicket).mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]![0].submissionId).toBe(createCalls[1]![0].submissionId);
    createView.unmount();

    const commentAdapter = transport();
    let commentAttempt = 0;
    commentAdapter.addComment = vi.fn(async () => {
      commentAttempt += 1;
      if (commentAttempt === 1) throw new FeedbackTransportError("unavailable");
      return detail;
    });
    render(
      <FeedbackProvider transport={commentAdapter}><FeedbackWorkspace initialTicketId={ticket.id} /></FeedbackProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Reply"), { target: { value: "Same reply" } });
    fireEvent.click(screen.getByText("Send reply"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Send reply"));
    await waitFor(() => expect(vi.mocked(commentAdapter.addComment).mock.calls).toHaveLength(2));
    const commentCalls = vi.mocked(commentAdapter.addComment).mock.calls;
    expect(commentCalls[0]![0].submissionId).toBe(commentCalls[1]![0].submissionId);
  });

  it("exposes stable headings and programmatic feedback-kind selection", async () => {
    const adapter = transport();
    let resolveDetail: ((value: FeedbackTicketDetail) => void) | undefined;
    adapter.getTicket = vi.fn(() => new Promise((resolve) => { resolveDetail = resolve; }));
    const loading = render(
      <FeedbackProvider transport={adapter}><FeedbackWorkspace initialTicketId={ticket.id} /></FeedbackProvider>,
    );
    expect(screen.getByRole("heading", { name: "Feedback ticket" })).toBeTruthy();
    expect(loading.container.querySelector(".hands-feedback-skeleton-detail")).not.toBeNull();
    loading.unmount();
    resolveDetail?.(detail);

    render(<FeedbackProvider transport={transport()}><FeedbackWorkspace /></FeedbackProvider>);
    fireEvent.click(await screen.findByText("New feedback"));
    const feedback = screen.getByRole("button", { name: "Feedback" });
    const problem = screen.getByRole("button", { name: "Problem" });
    expect(feedback.getAttribute("aria-pressed")).toBe("true");
    expect(problem.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(problem);
    expect(feedback.getAttribute("aria-pressed")).toBe("false");
    expect(problem.getAttribute("aria-pressed")).toBe("true");
  });
});
