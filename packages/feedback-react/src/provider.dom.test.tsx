// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FeedbackWorkspace } from "./components.js";
import { FeedbackProvider } from "./provider.js";
import { FeedbackTransportError } from "./types.js";
import type {
  FeedbackTicketDetail,
  FeedbackTicketPage,
  HandsFeedbackTransport,
} from "./types.js";

beforeAll(() => {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
});

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
  comments: [
    { id: "comment-1", authorType: "staff", body: "Thanks", createdAt: 3 },
  ],
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
  it("supports host copy and date localization overrides through one provider contract", async () => {
    const adapter = transport();
    adapter.getTicket = vi.fn(async () => ({
      ...detail,
      attachments: [
        {
          id: "attachment-1",
          filename: "proof.png",
          contentType: "image/png",
          sizeBytes: 2048,
          createdAt: 4,
        },
      ],
    }));
    render(
      <FeedbackProvider
        transport={adapter}
        messages={{
          newFeedback: "Create report",
          statusFilter: "Ticket state",
          unreadCount: "{count} new items",
          attachmentSummary: "FILE {name} SIZE {size}",
          openAttachment: "OPEN {name}",
        }}
        formatDate={(value, { locale }) => `DATE:${locale}:${value.getTime()}`}
        formatFileSize={(bytes, { locale }) => `SIZE:${locale}:${bytes}`}
      >
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    expect(await screen.findByText(ticket.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create report" })).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Ticket state" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("2 new items")).toBeTruthy();
    expect(screen.getByText("DATE:en:2", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByText(ticket.message));
    expect(
      await screen.findByText("FILE proof.png SIZE SIZE:en:2048"),
    ).toBeTruthy();
    expect(screen.getByLabelText("OPEN proof.png")).toBeTruthy();
  });

  it("localizes closed errors and parameterized attachment validation through message overrides", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => {
      throw new Error("hidden");
    });
    const list = render(
      <FeedbackProvider
        transport={adapter}
        messages={{ errorUnavailable: "Localized safe failure" }}
      >
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Localized safe failure",
    );
    list.unmount();

    render(
      <FeedbackProvider
        transport={transport()}
        messages={{ attachmentUnsupported: "Unsupported: {name}" }}
      >
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    const file = new File(["text"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: { files: [file] },
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unsupported: notes.txt",
    );
  });

  it("lands on the Hands-backed list and reports authoritative unread changes", async () => {
    const adapter = transport();
    const onUnreadChanged = vi.fn();
    const { container } = render(
      <FeedbackProvider
        transport={adapter}
        theme="brutal"
        onUnreadChanged={onUnreadChanged}
      >
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    expect(
      container.querySelector("[data-hands-feedback-theme='brutal']"),
    ).not.toBeNull();
    expect(await screen.findByText(ticket.message)).toBeTruthy();
    expect(adapter.listTickets).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
    expect(adapter.listTickets).not.toHaveBeenCalledWith(
      expect.objectContaining({ reporterId: expect.anything() }),
    );
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);
    expect(onUnreadChanged).toHaveBeenLastCalledWith({
      total: 2,
      source: "list",
    });

    fireEvent.click(screen.getByText(ticket.message));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    expect(adapter.getTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: ticket.id,
        commentLimit: 100,
      }),
    );
    await waitFor(() =>
      expect(onUnreadChanged).toHaveBeenLastCalledWith({
        total: 0,
        source: "detail",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText(ticket.message)).toBeTruthy();
  });

  it("maps every reporter ticket status to the Raft task palette", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => ({
      tickets: (["open", "in_progress", "resolved", "closed"] as const).map(
        (status, index) => ({
          ...ticket,
          id: `ticket-${status}`,
          message: `Ticket ${status}`,
          status,
          unread: false,
          unreadCount: 0,
          updatedAt: index + 10,
        }),
      ),
      nextCursor: null,
      unreadTotal: 0,
    }));
    const { container } = render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText("Ticket open");
    expect(screen.getByRole("radio", { name: "Active" })).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-feedback-status]"),
      ).map((badge) => badge.dataset.feedbackStatus),
    ).toEqual(["open", "in_progress", "resolved", "closed"]);
  });

  it("uses the shared segmented control with radio and keyboard semantics", async () => {
    render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText(ticket.message);
    const group = screen.getByRole("radiogroup", { name: "Status filter" });
    const all = screen.getByRole("radio", { name: "All" });
    const active = screen.getByRole("radio", { name: "Active" });
    expect(group.getAttribute("data-slot")).toBe("segmented-control");
    expect(all.getAttribute("data-slot")).toBe("segmented-control-item");
    expect(all.getAttribute("aria-checked")).toBe("true");

    all.focus();
    fireEvent.keyDown(all, { key: "ArrowRight" });
    await waitFor(() => {
      expect(active.getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(active);
    });
  });

  it("does not re-notify when list and detail return the same authoritative total", async () => {
    const adapter = transport();
    adapter.getTicket = vi.fn(async () => ({
      ...detail,
      unreadTotal: page.unreadTotal,
    }));
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

  it("preserves list filter, scroll position, and originating row focus after Back", async () => {
    const adapter = transport();
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    const row = await screen.findByRole("button", {
      name: /A reporter-visible ticket/,
    });
    fireEvent.click(screen.getByRole("radio", { name: "Active" }));
    const listScroll = document.querySelector<HTMLElement>(
      "[data-feedback-list-scroll]",
    )!;
    listScroll.scrollTop = 91;
    fireEvent.click(row);
    expect(await screen.findByText("Thanks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(listScroll.scrollTop).toBe(91);
    expect(
      screen
        .getByRole("radio", { name: "Active" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(row.getAttribute("data-unread")).toBeNull();
  });

  it("never advances authoritative unread or clears the row when detail read fails", async () => {
    const adapter = transport();
    adapter.getTicket = vi.fn(async () => {
      throw new FeedbackTransportError("unavailable");
    });
    const onUnreadChanged = vi.fn();
    render(
      <FeedbackProvider transport={adapter} onUnreadChanged={onUnreadChanged}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    const row = await screen.findByRole("button", {
      name: /A reporter-visible ticket/,
    });
    expect(row.getAttribute("data-unread")).toBe("true");
    fireEvent.click(row);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);
    expect(onUnreadChanged).toHaveBeenCalledWith({ total: 2, source: "list" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      (
        await screen.findByRole("button", { name: /A reporter-visible ticket/ })
      ).getAttribute("data-unread"),
    ).toBe("true");
  });

  it("keeps per-ticket drafts and honors IME-safe Enter semantics", async () => {
    const second = {
      ...ticket,
      id: "ticket-2",
      message: "Second ticket",
      unread: false,
      unreadCount: 0,
    };
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => ({
      ...page,
      tickets: [ticket, second],
    }));
    adapter.getTicket = vi.fn(async ({ ticketId }) => ({
      ...detail,
      ticket: { ...detail.ticket, id: ticketId },
    }));
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByText(ticket.message));
    const firstDraft = await screen.findByLabelText("Reply");
    expect(firstDraft.closest(".hands-feedback-composer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send reply" })).toBeTruthy();
    fireEvent.change(firstDraft, { target: { value: "draft one" } });
    fireEvent.keyDown(firstDraft, { key: "Enter", isComposing: true });
    fireEvent.keyDown(firstDraft, { key: "Enter", shiftKey: true });
    expect(adapter.addComment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByText("Second ticket"));
    fireEvent.change(await screen.findByLabelText("Reply"), {
      target: { value: "draft two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByText(ticket.message));
    const restored = (await screen.findByLabelText(
      "Reply",
    )) as HTMLTextAreaElement;
    expect(restored.value).toBe("draft one");
    fireEvent.keyDown(restored, { key: "Enter" });
    await waitFor(() => expect(adapter.addComment).toHaveBeenCalledTimes(1));
    expect(vi.mocked(adapter.addComment).mock.calls[0]![0].body).toBe(
      "draft one",
    );
    expect(
      vi.mocked(adapter.addComment).mock.calls[0]![0].attachments,
    ).toEqual([]);
  });

  it("keeps reply attachments inside the composer and forwards upload progress", async () => {
    const adapter = transport();
    adapter.addComment = vi.fn(async (input) => {
      input.onAttachmentProgress?.({ index: 0, progress: 0.5 });
      return detail;
    });
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );

    const attachment = new File([new Uint8Array(128)], "reply.png", {
      type: "image/png",
    });
    fireEvent.change(
      await screen.findByTestId("hands-feedback-reply-image-input"),
      { target: { files: [attachment] } },
    );
    expect(await screen.findByText("reply.png")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Reply with a screenshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(adapter.addComment).toHaveBeenCalledTimes(1));
    const input = vi.mocked(adapter.addComment).mock.calls[0]![0];
    expect(input.attachments).toEqual([attachment]);
    expect(screen.queryByText("reply.png")).toBeNull();
  });

  it("aborts and resets an in-flight reply when the reporter transport changes", async () => {
    const first = transport();
    const second = transport();
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((value: FeedbackTicketDetail) => void) | undefined;
    first.addComment = vi.fn(
      ({ signal }) =>
        new Promise<FeedbackTicketDetail>((resolve) => {
          firstSignal = signal;
          resolveFirst = resolve;
        }),
    );
    const view = render(
      <FeedbackProvider transport={first}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    const editor = (await screen.findByLabelText("Reply")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Preserve this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(first.addComment).toHaveBeenCalledTimes(1);

    view.rerender(
      <FeedbackProvider transport={second}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(editor.value).toBe("Preserve this draft");
    expect(
      (screen.getByRole("button", {
        name: "Send reply",
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
    resolveFirst?.(detail);
    await Promise.resolve();
    expect(second.addComment).not.toHaveBeenCalled();
  });

  it("keeps create text and attachments across failure, reports progress, and reuses the retry ID", async () => {
    const adapter = transport();
    let attempt = 0;
    adapter.createTicket = vi.fn(async (input) => {
      input.onAttachmentProgress?.({ index: 0, progress: 0.5 });
      attempt += 1;
      if (attempt === 1) throw new FeedbackTransportError("unavailable");
      return detail;
    });
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    const editor = screen.getByLabelText(
      "What would you like us to know?",
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Keep this text" } });
    const file = new File(["image"], "proof.png", {
      type: "image/png",
      lastModified: 7,
    });
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByText("Upload failed")).toBeTruthy();
    expect(editor.value).toBe("Keep this text");
    expect(screen.getByText("proof.png")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry upload"));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    const calls = vi.mocked(adapter.createTicket).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].submissionId).toBe(calls[1]![0].submissionId);
    expect(calls[0]![0].attachments[0]).toBe(file);
  });

  it("shows a created ticket in the mounted inbox without a refresh or list refetch", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => ({
      tickets: [],
      nextCursor: null,
      unreadTotal: 0,
    }));
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    expect(await screen.findByText("No feedback yet")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "New feedback" })[0]!,
    );
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), {
      target: { value: "A newly-created ticket" },
    });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByText(ticket.message)).toBeTruthy();
    expect(adapter.listTickets).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate create submission and lets the reporter cancel an in-flight upload", async () => {
    const adapter = transport();
    let uploadSignal: AbortSignal | undefined;
    adapter.createTicket = vi.fn(
      ({ signal }) =>
        new Promise<FeedbackTicketDetail>((_resolve, reject) => {
          uploadSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    const editor = screen.getByLabelText(
      "What would you like us to know?",
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Only once" } });
    const submit = screen.getByText("Submit feedback");
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(adapter.createTicket).toHaveBeenCalledTimes(1);
    const cancelButtons = await screen.findAllByRole("button", {
      name: "Cancel",
    });
    fireEvent.click(cancelButtons.at(-1)!);
    expect(uploadSignal?.aborted).toBe(true);
    expect(editor.value).toBe("Only once");
    expect(screen.getByText("Submit feedback")).toBeTruthy();
  });

  it("aborts and resets an in-flight create when the reporter transport changes", async () => {
    const first = transport();
    const second = transport();
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((value: FeedbackTicketDetail) => void) | undefined;
    first.createTicket = vi.fn(
      ({ signal }) =>
        new Promise<FeedbackTicketDetail>((resolve) => {
          firstSignal = signal;
          resolveFirst = resolve;
        }),
    );
    const view = render(
      <FeedbackProvider transport={first}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    const editor = screen.getByLabelText(
      "What would you like us to know?",
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Preserve across session" } });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByText("Submitting…")).toBeTruthy();

    view.rerender(
      <FeedbackProvider transport={second}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(editor.value).toBe("Preserve across session");
    expect(screen.getByText("Submit feedback")).toBeTruthy();
    resolveFirst?.(detail);
    await Promise.resolve();
    expect(
      screen.getByRole("heading", { name: "New feedback" }),
    ).toBeTruthy();
    expect(second.createTicket).not.toHaveBeenCalled();
  });

  it("restores row focus after a delayed controlled host commits the inbox route", async () => {
    const adapter = transport();
    function DelayedHost() {
      const [route, setRoute] = useState<{
        view: "inbox" | "new" | "ticket";
        ticketId?: string;
      }>({ view: "inbox" });
      return (
        <FeedbackProvider transport={adapter}>
          <FeedbackWorkspace
            route={route}
            onRouteChange={(next) => setTimeout(() => setRoute(next), 40)}
          />
        </FeedbackProvider>
      );
    }
    render(<DelayedHost />);
    const row = await screen.findByRole("button", {
      name: /A reporter-visible ticket/,
    });
    fireEvent.click(row);
    expect(await screen.findByText("Thanks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(document.activeElement).toBe(row), {
      timeout: 1000,
    });
  });

  it("loads, deduplicates, and orders conversations beyond the first 100 comments", async () => {
    const adapter = transport();
    const firstComments = Array.from({ length: 100 }, (_, index) => ({
      id: `comment-${String(index + 1).padStart(3, "0")}`,
      authorType: "staff" as const,
      body: `Reply ${index + 1}`,
      createdAt: index + 1,
    }));
    adapter.getTicket = vi.fn(async ({ commentCursor }) =>
      commentCursor
        ? {
            ...detail,
            comments: [
              firstComments[99]!,
              {
                id: "comment-101",
                authorType: "reporter",
                body: "Reply 101",
                createdAt: 101,
              },
            ],
            nextCommentCursor: null,
          }
        : { ...detail, comments: firstComments, nextCommentCursor: "page-2" },
    );
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );

    expect(await screen.findByText("Reply 100")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more replies"));
    expect(await screen.findByText("Reply 101")).toBeTruthy();
    expect(screen.getAllByText("Reply 100")).toHaveLength(1);
    expect(adapter.getTicket).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentCursor: "page-2" }),
    );
    expect(screen.queryByText("Load more replies")).toBeNull();
  });

  it("preserves historical reading position and exposes a new-reply affordance away from bottom", async () => {
    const adapter = transport();
    let reads = 0;
    adapter.getTicket = vi.fn(async () => {
      reads += 1;
      return reads === 1
        ? detail
        : {
            ...detail,
            comments: [
              ...detail.comments,
              {
                id: "comment-2",
                authorType: "staff" as const,
                body: "Fresh reply",
                createdAt: 4,
              },
            ],
          };
    });
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    expect(await screen.findByText("Thanks")).toBeTruthy();
    const conversation = screen.getByLabelText("Conversation");
    Object.defineProperties(conversation, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Fresh reply")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New replies" })).toBeTruthy();
    expect(conversation.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "New replies" }));
    expect(conversation.scrollTop).toBe(500);
  });

  it("aborts an in-flight comment page when detail unmounts", async () => {
    const adapter = transport();
    let pageSignal: AbortSignal | undefined;
    let resolvePage: ((value: FeedbackTicketDetail) => void) | undefined;
    adapter.getTicket = vi.fn(({ commentCursor, signal }) =>
      commentCursor
        ? new Promise<FeedbackTicketDetail>((resolve) => {
            pageSignal = signal;
            resolvePage = resolve;
          })
        : Promise.resolve({ ...detail, nextCommentCursor: "page-2" }),
    );
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByText("Load more replies"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(pageSignal?.aborted).toBe(true);
    resolvePage?.({
      ...detail,
      comments: [
        { id: "late", authorType: "staff", body: "Late reply", createdAt: 100 },
      ],
      nextCommentCursor: null,
    });
    await waitFor(() => expect(screen.queryByText("Late reply")).toBeNull());
  });

  it("never renders arbitrary transport errors on list, detail, create, or comment", async () => {
    const secretText = "internal database host and sk_agent_FAKE_SECRET";

    const listAdapter = transport();
    listAdapter.listTickets = vi.fn(async () => {
      throw new Error(secretText);
    });
    const listView = render(
      <FeedbackProvider transport={listAdapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Feedback is temporarily unavailable.",
    );
    expect(screen.queryByText(secretText)).toBeNull();
    listView.unmount();

    const detailAdapter = transport();
    detailAdapter.getTicket = vi.fn(async () => {
      throw new Error(secretText);
    });
    const detailView = render(
      <FeedbackProvider transport={detailAdapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Feedback is temporarily unavailable.",
    );
    expect(
      screen.getByRole("heading", { name: "Feedback ticket" }),
    ).toBeTruthy();
    expect(screen.queryByText(secretText)).toBeNull();
    detailView.unmount();

    const createAdapter = transport();
    createAdapter.createTicket = vi.fn(async () => {
      throw new Error(secretText);
    });
    const createView = render(
      <FeedbackProvider transport={createAdapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Feedback is temporarily unavailable.",
    );
    expect(screen.queryByText(secretText)).toBeNull();
    createView.unmount();

    const commentAdapter = transport();
    commentAdapter.addComment = vi.fn(async () => {
      throw new Error(secretText);
    });
    render(
      <FeedbackProvider transport={commentAdapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Reply"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByText("Send reply"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Feedback is temporarily unavailable.",
    );
    expect(screen.queryByText(secretText)).toBeNull();
  });

  it("maps only closed transport error codes to fixed user-safe copy", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => {
      throw new FeedbackTransportError("rate_limited", {
        cause: new Error("hidden internal detail"),
      });
    });
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Too many feedback requests. Try again later.",
    );
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
      <FeedbackProvider transport={createAdapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByText("New feedback"));
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), {
      target: { value: "Retry me" },
    });
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Submit feedback"));
    expect(await screen.findByText("Thanks")).toBeTruthy();
    const createCalls = vi.mocked(createAdapter.createTicket).mock.calls;
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]![0].submissionId).toBe(
      createCalls[1]![0].submissionId,
    );
    createView.unmount();

    const commentAdapter = transport();
    let commentAttempt = 0;
    commentAdapter.addComment = vi.fn(async () => {
      commentAttempt += 1;
      if (commentAttempt === 1) throw new FeedbackTransportError("unavailable");
      return detail;
    });
    render(
      <FeedbackProvider transport={commentAdapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    fireEvent.change(await screen.findByLabelText("Reply"), {
      target: { value: "Same reply" },
    });
    fireEvent.click(screen.getByText("Send reply"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Send reply"));
    await waitFor(() =>
      expect(vi.mocked(commentAdapter.addComment).mock.calls).toHaveLength(2),
    );
    const commentCalls = vi.mocked(commentAdapter.addComment).mock.calls;
    expect(commentCalls[0]![0].submissionId).toBe(
      commentCalls[1]![0].submissionId,
    );
  });

  it("exposes stable headings and programmatic feedback-kind selection", async () => {
    const adapter = transport();
    let resolveDetail: ((value: FeedbackTicketDetail) => void) | undefined;
    adapter.getTicket = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const loading = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );
    expect(
      screen.getByRole("heading", { name: "Feedback ticket" }),
    ).toBeTruthy();
    expect(
      loading.container.querySelector(".hands-feedback-skeleton-detail"),
    ).not.toBeNull();
    loading.unmount();
    resolveDetail?.(detail);

    render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
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
