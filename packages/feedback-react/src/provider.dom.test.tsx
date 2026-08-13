// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:hands-feedback-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(cleanup);

const ticket = {
  id: "ticket-1",
  kind: "feedback" as const,
  status: "open" as const,
  closureReason: null,
  duplicateOfTicketId: null,
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
  const pullDown = (element: HTMLElement, distance = 180) => {
    fireEvent.touchStart(element, {
      touches: [{ clientY: 0 }],
    });
    fireEvent.touchMove(element, {
      cancelable: true,
      touches: [{ clientY: distance }],
    });
    fireEvent.touchEnd(element, { changedTouches: [{ clientY: distance }] });
  };

  it("confirms and closes only through an available host capability", async () => {
    const adapter = transport();
    const closedDetail: FeedbackTicketDetail = {
      ...detail,
      ticket: {
        ...detail.ticket,
        status: "closed",
        closureReason: "no_longer_needed",
        updatedAt: 4,
      },
    };
    adapter.closeTicket = vi.fn(async () => closedDetail);
    const { container } = render(
      <FeedbackProvider transport={adapter} locale="zh-CN" theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: ticket.message }),
    );
    const closeButton = await screen.findByRole("button", { name: "关闭工单" });
    const messageFooter = closeButton.closest("[data-slot='message-item-footer']");
    expect(messageFooter).toBeTruthy();
    const kindChip = messageFooter?.querySelector<HTMLElement>(
      "[data-feedback-kind='feedback']",
    );
    expect(kindChip).toBeTruthy();
    expect(kindChip?.className).toContain("hands-feedback-reference-chip");
    expect(
      Array.from(kindChip?.children ?? []).some(
        (child) => child.tagName.toLowerCase() === "svg",
      ),
    ).toBe(false);
    expect(messageFooter?.querySelector("[data-feedback-status='open']")).toBeTruthy();
    expect(closeButton.className).toContain("hands-feedback-close-main");
    expect(
      closeButton.closest("[data-slot='message-item']")
        ?.querySelector("[data-slot='message-item-header'] [data-feedback-status]"),
    ).toBeNull();
    fireEvent.click(closeButton);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("不再需要处理，关闭工单？")).toBeTruthy();
    expect(
      within(dialog).getByText(
        "即使问题尚未解决，也会直接关闭工单。如果仍需帮助，可以重新提交反馈。",
      ),
    ).toBeTruthy();
    expect(dialog.querySelector(".hands-feedback-close-reason-summary")).toBeNull();
    expect(adapter.closeTicket).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭工单" }));

    await waitFor(() => expect(adapter.closeTicket).toHaveBeenCalledTimes(1));
    expect(adapter.closeTicket).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: ticket.id,
      reason: "no_longer_needed",
      signal: expect.any(AbortSignal),
    }));
    await waitFor(() =>
      expect(
        container.querySelector(
          ".hands-feedback-detail [data-feedback-status='closed']",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByLabelText("回复")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.getByText("已关闭")).toBeTruthy());
  });

  it("keeps list-item open and close actions independent", async () => {
    const adapter = transport();
    adapter.closeTicket = vi.fn(async () => ({
      ...detail,
      ticket: {
        ...detail.ticket,
        status: "closed",
        closureReason: "no_longer_needed",
        updatedAt: 4,
      },
    }));
    const { container } = render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    const openTicket = await screen.findByRole("button", {
      name: ticket.message,
    });
    const card = openTicket.closest<HTMLElement>("[data-slot='task-card']")!;
    const closeTicket = within(card).getByRole("button", {
      name: "Close ticket",
    });

    fireEvent.click(closeTicket);
    expect(adapter.getTicket).not.toHaveBeenCalled();
    expect(adapter.closeTicket).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close ticket" }),
    );

    await waitFor(() => expect(adapter.closeTicket).toHaveBeenCalledTimes(1));
    expect(adapter.closeTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: ticket.id,
        reason: "no_longer_needed",
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() =>
      expect(
        card.querySelector("[data-feedback-status='closed']"),
      ).toBeTruthy(),
    );
    expect(within(card).queryByRole("button", { name: "Close ticket" })).toBeNull();
    expect(container.querySelector(".hands-feedback-detail")).toBeNull();
  });

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
    adapter.getAttachment = vi.fn(async () => new Blob(["preview"], {
      type: "image/png",
    }));
    const onOpenAttachment = vi.fn();
    const view = render(
      <FeedbackProvider
        transport={adapter}
        messages={{
          newFeedback: "Create report",
          statusFilter: "Ticket state",
          unreadCount: "{count} new items",
          openAttachment: "OPEN {name}",
        }}
        formatDate={(value, { locale }) => `DATE:${locale}:${value.getTime()}`}
        formatFileSize={(bytes, { locale }) => `SIZE:${locale}:${bytes}`}
      >
        <FeedbackWorkspace onOpenAttachment={onOpenAttachment} />
      </FeedbackProvider>,
    );
    const { container } = view;
    const listTitle = await screen.findByText(ticket.message);
    expect(listTitle.getAttribute("title")).toBe(ticket.message);
    expect(listTitle.className).toContain("hands-feedback-ticket-title");
    expect(screen.getByRole("button", { name: "Create report" })).toBeTruthy();
    expect(
      screen.getByRole("tablist", { name: "Ticket state" }),
    ).toBeTruthy();
    expect(container.querySelector("[data-slot='task-card']")).toBeTruthy();
    const unreadCount = screen.getByLabelText("2 new items");
    expect(unreadCount.textContent).toBe("2");
    expect(unreadCount.getAttribute("data-feedback-unread-count")).toBe("2");
    const listDate = screen.getByText("DATE:en:2", { exact: false });
    expect(listDate.closest(".hands-feedback-ticket-date")).toBeTruthy();
    expect(listDate.closest(".hands-feedback-ticket-meta")).toBeNull();
    fireEvent.click(listTitle);
    expect(await screen.findByText("proof.png")).toBeTruthy();
    expect(screen.getByText("SIZE:en:2048")).toBeTruthy();
    expect(screen.getByLabelText("OPEN proof.png")).toBeTruthy();
    const image = await screen.findByRole("img", { name: "proof.png" });
    expect(image.getAttribute("src")).toBe("blob:hands-feedback-preview");
    fireEvent.click(image);
    expect(onOpenAttachment).toHaveBeenCalledWith({
      ticketId: ticket.id,
      attachmentId: "attachment-1",
    });
    expect(adapter.getAttachment).toHaveBeenCalledWith({
      ticketId: ticket.id,
      attachmentId: "attachment-1",
      signal: expect.any(AbortSignal),
    });
    expect(container.querySelector("[data-slot='message-image-gallery']")).toBeTruthy();
    expect(container.querySelector("[data-slot='message-list']")).toBeTruthy();
    expect(container.querySelector("[data-slot='message-item']")).toBeTruthy();
    expect(container.querySelector("[data-slot='composer-root']")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:hands-feedback-preview",
    );
  });

  it("renders every unread value as a rounded rectangular numeric badge", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => ({
      tickets: [1, 2, 120].map((unreadCount) => ({
        ...ticket,
        id: `ticket-unread-${unreadCount}`,
        message: `Unread ${unreadCount}`,
        unread: true,
        unreadCount,
      })),
      nextCursor: null,
      unreadTotal: 3,
    }));
    const { container } = render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText("Unread 1");
    const badges = Array.from(
      container.querySelectorAll<HTMLElement>(
        ".hands-feedback-unread-count",
      ),
    );
    expect(badges.map((badge) => badge.textContent)).toEqual(["1", "2", "99+"]);
    expect(badges.map((badge) => badge.getAttribute("aria-label"))).toEqual([
      "1 unread",
      "2 unread",
      "120 unread",
    ]);
    expect(container.querySelector(".hands-feedback-unread-dot")).toBeNull();
  });

  it("pull-refreshes list and conversation only from scroll-top", async () => {
    const adapter = transport();
    render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace enablePullToRefresh />
      </FeedbackProvider>,
    );

    await screen.findByText(ticket.message);
    const listViewport = document.querySelector<HTMLElement>(
      "[data-feedback-list-scroll]",
    )!;
    expect(listViewport).toBeTruthy();
    pullDown(listViewport);
    await waitFor(() => expect(adapter.listTickets).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: ticket.message }));
    await screen.findByText("Thanks");
    const conversation = screen.getByLabelText("Conversation");
    Object.defineProperty(conversation, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    pullDown(conversation);
    await waitFor(() => expect(adapter.getTicket).toHaveBeenCalledTimes(2));

    conversation.scrollTop = 12;
    pullDown(conversation);
    await Promise.resolve();
    expect(adapter.getTicket).toHaveBeenCalledTimes(2);
  });

  it("marks create-to-ticket route replacement for controlled mobile hosts", async () => {
    const adapter = transport();
    const onRouteChange = vi.fn();
    render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace onRouteChange={onRouteChange} />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New feedback" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: "What would you like us to know?",
      }),
      { target: { value: "Route this ticket" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(adapter.createTicket).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onRouteChange).toHaveBeenLastCalledWith(
        { view: "ticket", ticketId: ticket.id },
        { replace: true },
      ),
    );
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
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Localized safe failure");
    expect(alert.getAttribute("data-slot")).toBe("banner");
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

    fireEvent.click(screen.getByRole("button", { name: ticket.message }));
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
    expect(screen.queryByLabelText("2 unread")).toBeNull();
  });

  it("maps every reporter ticket status to the Raft task palette", async () => {
    const adapter = transport();
    adapter.closeTicket = vi.fn(async () => detail);
    adapter.listTickets = vi.fn(async () => ({
      tickets: (["open", "in_progress", "resolved", "closed"] as const).map(
        (status, index) => ({
          ...ticket,
          id: `ticket-${status}`,
          kind: index === 2 ? ("bug" as const) : ticket.kind,
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
    const taskCard = container.querySelector<HTMLElement>(
      "[data-slot='task-card']",
    );
    expect(taskCard?.className).toContain("border-2");
    expect(taskCard?.className).toContain("shadow-raft-sm");
    expect(screen.getByRole("tab", { name: "Active" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Ended" })).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-feedback-status]"),
      ).map((badge) => badge.dataset.feedbackStatus),
    ).toEqual(["open", "in_progress", "resolved", "closed"]);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-feedback-status]"),
      ).map((badge) => ({
        backgroundColor: badge.style.backgroundColor,
        slot: badge.dataset.slot,
      })),
    ).toEqual([
      { backgroundColor: "var(--color-brutal-orange)", slot: "badge" },
      { backgroundColor: "var(--color-brutal-cyan)", slot: "badge" },
      { backgroundColor: "var(--color-brutal-lime)", slot: "badge" },
      { backgroundColor: "var(--color-brutal-stone)", slot: "badge" },
    ]);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-feedback-status]"),
      ).map((badge) => badge.querySelector("svg")?.getAttribute("class")),
    ).toEqual([
      "lucide lucide-circle",
      "lucide lucide-play",
      "lucide lucide-circle-check-big",
      "lucide lucide-ban",
    ]);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-feedback-status]"),
      ).every((badge) => badge.closest(".hands-feedback-ticket-meta")),
    ).toBe(true);
    expect(
      container.querySelectorAll(".hands-feedback-ticket-meta [data-feedback-kind]"),
    ).toHaveLength(4);
    const problemChip = container.querySelector<HTMLElement>(
      "[data-feedback-kind='bug']",
    );
    expect(problemChip?.textContent).toContain("Bug");
    expect(problemChip?.className).toContain("hands-feedback-problem-chip");
    expect(problemChip?.className).toContain("bg-brutal-stone/25");
    expect(problemChip?.className).not.toContain("bg-brutal-pink/30");
    const closeActions = screen.getAllByRole("button", {
      name: "Close ticket",
    });
    expect(closeActions).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Reopen ticket" })).toBeNull();
    const reasonMenus = screen.getAllByRole("button", {
      name: "Choose a close reason",
    });
    expect(reasonMenus).toHaveLength(3);
    expect(closeActions.every((button) =>
      button.className.includes("hands-feedback-reference-chip")
    )).toBe(true);
    expect(reasonMenus.every((button) =>
      button.className.includes("hands-feedback-reference-chip")
    )).toBe(true);
    expect(closeActions.every((button) =>
      button.className.includes("hands-feedback-close-main")
    )).toBe(true);
    expect(reasonMenus.every((button) =>
      button.className.includes("hands-feedback-close-caret")
    )).toBe(true);
    expect(reasonMenus.every((button) =>
      button.querySelector(":scope > .hands-feedback-close-caret-content > svg") &&
      !button.matches(":has(> svg)")
    )).toBe(true);
    expect(
      closeActions.every((action) =>
        action.closest(".hands-feedback-ticket-meta"),
      ),
    ).toBe(true);
    fireEvent.click(closeActions[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("No longer need help — close this ticket?"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "This will close the ticket even if the issue isn’t resolved. If you still need help, submit new feedback.",
      ),
    ).toBeTruthy();
    expect(dialog.querySelector(".hands-feedback-close-reason-summary")).toBeNull();
    expect(adapter.closeTicket).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(reasonMenus[0]!);
    const reasonMenu = await screen.findByRole("menu");
    const closeSplit = reasonMenus[0]!.closest(".hands-feedback-close-split");
    expect(closeSplit?.getAttribute("data-menu-open")).toBe("");
    expect(reasonMenus[0]?.getAttribute("data-popup-open")).toBe("");
    expect(within(reasonMenu).getByText("Completed")).toBeTruthy();
    expect(
      within(reasonMenu).getByText(
        "Confirm the issue is fixed, then close the ticket.",
      ),
    ).toBeTruthy();
    expect(within(reasonMenu).getByText("No longer needed")).toBeTruthy();
    expect(
      within(reasonMenu).getByText(
        "Close the ticket even though the issue is not resolved.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(reasonMenu).getByText("Completed"));
    const alternateDialog = await screen.findByRole("alertdialog");
    expect(
      within(alternateDialog).getByText(
        "Issue resolved — close this ticket?",
      ),
    ).toBeTruthy();
    expect(
      within(alternateDialog).getByText(
        "You won’t be able to reply after closing. If the issue comes back, submit new feedback.",
      ),
    ).toBeTruthy();
    expect(within(alternateDialog).queryByText("Completed")).toBeNull();
    fireEvent.click(
      within(alternateDialog).getByRole("button", { name: "Cancel" }),
    );

    fireEvent.click(closeActions[2]!);
    const resolvedDialog = await screen.findByRole("alertdialog");
    expect(
      within(resolvedDialog).getByText("Issue resolved — close this ticket?"),
    ).toBeTruthy();
    expect(
      within(resolvedDialog).getByRole("button", { name: "Close ticket" }),
    ).toBeTruthy();
  });

  it("uses the shared tabs with native roles, roving focus, and activation", async () => {
    render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText(ticket.message);
    const group = screen.getByRole("tablist", { name: "Status filter" });
    const all = screen.getByRole("tab", { name: "All" });
    const active = screen.getByRole("tab", { name: "Active" });
    expect(group.getAttribute("data-slot")).toBe("tabs-list");
    expect(all.getAttribute("data-slot")).toBe("tabs-tab");
    expect(all.getAttribute("aria-selected")).toBe("true");

    all.focus();
    fireEvent.keyDown(all, { key: "ArrowRight" });
    await waitFor(() => {
      expect(document.activeElement).toBe(active);
    });
    expect(active.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(active);
    await waitFor(() => {
      expect(active.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("keeps one page title and one create entry across list, empty, and compose states", async () => {
    const adapter = transport();
    const view = render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "My Feedback" }),
    ).toBeTruthy();
    const createButton = screen.getByRole("button", { name: "New feedback" });
    expect(createButton.className).toContain("h-6");
    expect(
      screen.getByRole("tablist", { name: "Status filter" }),
    ).toBeTruthy();

    view.unmount();
    const emptyAdapter = transport();
    emptyAdapter.listTickets = vi.fn(async () => ({
      tickets: [],
      nextCursor: null,
      unreadTotal: 0,
    }));
    const empty = render(
      <FeedbackProvider transport={emptyAdapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    expect(await screen.findByText("No feedback yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Share an idea or report a bug — team replies will show up here.",
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "New feedback" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("tablist", { name: "Status filter" })).toBeNull();
    expect(empty.container.querySelector(".hands-feedback-empty")).not.toBeNull();
    expect(
      empty.container.querySelector("[data-feedback-empty-kind='all']"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New feedback" }));
    expect(
      screen.getByRole("heading", { name: "New feedback" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    const kind = screen.getByRole("radiogroup", { name: "Feedback type" });
    expect(kind).toBeTruthy();
    expect(kind.getAttribute("data-slot")).toBe("segmented-control");
    expect(screen.getByRole("radio", { name: "Idea" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Bug" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Idea" }).className).toContain(
      "hands-feedback-kind-item",
    );
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
    expect(screen.getByText("0/10000")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.closest(".hands-feedback-composer-toolbar")).not.toBeNull();
    expect(cancel.closest(".hands-feedback-header")).toBeNull();
    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeTruthy();
    expect(cancel.className).toContain("h-7");
    expect(submit.className).toContain("h-7");
  });

  it("keeps filtered empty states next to the tabs with accurate semantics", async () => {
    const endedAdapter = transport();
    endedAdapter.listTickets = vi.fn(async () => ({
      tickets: [{ ...ticket, status: "resolved" }],
      nextCursor: null,
      unreadTotal: 0,
    }));
    const endedView = render(
      <FeedbackProvider transport={endedAdapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText(ticket.message);
    fireEvent.click(screen.getByRole("tab", { name: "Active" }));
    expect(await screen.findByText("Nothing in progress")).toBeTruthy();
    expect(
      screen.getByText("Resolved or closed feedback lives under “Ended”."),
    ).toBeTruthy();
    expect(
      endedView.container.querySelector("[data-feedback-empty-kind='open']"),
    ).not.toBeNull();
    expect(
      screen.getByRole("tablist", { name: "Status filter" }),
    ).toBeTruthy();

    endedView.unmount();
    const activeAdapter = transport();
    const activeView = render(
      <FeedbackProvider transport={activeAdapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    await screen.findByText(ticket.message);
    fireEvent.click(screen.getByRole("tab", { name: "Ended" }));
    expect(await screen.findByText("Nothing ended yet")).toBeTruthy();
    expect(
      screen.getByText("Feedback appears here once it’s resolved or closed."),
    ).toBeTruthy();
    expect(
      activeView.container.querySelector(
        "[data-feedback-empty-kind='resolved']",
      ),
    ).not.toBeNull();
  });

  it("keeps the selected ticket visible while authoritative detail loads", async () => {
    const adapter = transport();
    let resolveDetail: ((value: FeedbackTicketDetail) => void) | undefined;
    adapter.getTicket = vi.fn(
      () =>
        new Promise<FeedbackTicketDetail>((resolve) => {
          resolveDetail = resolve;
        }),
    );
    const { container } = render(
      <FeedbackProvider transport={adapter} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: /A reporter-visible ticket/,
      }),
    );
    const activeDetail = container.querySelector(".hands-feedback-detail");
    expect(activeDetail?.textContent).toContain(ticket.message);
    expect(
      activeDetail?.querySelector("[data-slot='message-item']"),
    ).not.toBeNull();
    expect(
      activeDetail?.querySelector(".hands-feedback-skeleton-detail"),
    ).toBeNull();

    resolveDetail?.(detail);
    expect(await screen.findByText("Thanks")).toBeTruthy();
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

    fireEvent.click(
      await screen.findByRole("button", { name: ticket.message }),
    );
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
    fireEvent.click(screen.getByRole("tab", { name: "Active" }));
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
        .getByRole("tab", { name: "Active" })
        .getAttribute("aria-selected"),
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

    fireEvent.click(
      await screen.findByRole("button", { name: ticket.message }),
    );
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Second ticket" }),
    );
    fireEvent.change(await screen.findByLabelText("Reply"), {
      target: { value: "draft two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(
      await screen.findByRole("button", { name: ticket.message }),
    );
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

  it("renders pending image thumbnails, opens them through the host, and revokes previews on remove", async () => {
    vi.mocked(URL.createObjectURL).mockClear();
    vi.mocked(URL.revokeObjectURL).mockClear();
    const adapter = transport();
    const onOpenPendingAttachment = vi.fn();
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace
          onOpenPendingAttachment={onOpenPendingAttachment}
        />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByText("New feedback"));
    const attachment = new File([new Uint8Array(128)], "proof.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: { files: [attachment] },
    });

    const thumbnail = await screen.findByRole("button", {
      name: "Open attachment proof.png",
    });
    expect(thumbnail.getAttribute("data-slot")).toBe(
      "composer-attachment-image",
    );
    expect(thumbnail.querySelector("img")?.getAttribute("src")).toBe(
      "blob:hands-feedback-preview",
    );
    expect(thumbnail.getAttribute("title")).toBe("proof.png · image/png");
    expect(thumbnail.parentElement?.querySelector("[data-slot='composer-attachment-file']"))
      .toBeNull();
    fireEvent.click(thumbnail);
    expect(onOpenPendingAttachment).toHaveBeenCalledWith({ file: attachment });

    fireEvent.click(screen.getByRole("button", { name: "Remove proof.png" }));
    await waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(
        "blob:hands-feedback-preview",
      ),
    );
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
    expect(
      await screen.findByTitle("reply.png · image/png"),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Reply with a screenshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(adapter.addComment).toHaveBeenCalledTimes(1));
    const input = vi.mocked(adapter.addComment).mock.calls[0]![0];
    expect(input.attachments).toEqual([attachment]);
    expect(screen.queryByTitle("reply.png · image/png")).toBeNull();
  });

  it("shows aggregate and per-image progress while preventing duplicate submit", async () => {
    const adapter = transport();
    let resolveCreate: ((value: FeedbackTicketDetail) => void) | undefined;
    adapter.createTicket = vi.fn(
      (input) =>
        new Promise<FeedbackTicketDetail>((resolve) => {
          input.onAttachmentProgress?.({ index: 0, progress: 0.42 });
          resolveCreate = resolve;
        }),
    );
    const { container } = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByText("New feedback"));
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), {
      target: { value: "Show upload progress" },
    });
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: {
        files: [new File(["image"], "progress.png", { type: "image/png" })],
      },
    });
    const submit = screen.getByRole("button", { name: "Submit" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(adapter.createTicket).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("status", { name: "" })).toBeTruthy();
    expect(screen.getByText("Uploading 42%")).toBeTruthy();
    expect(
      container.querySelector<HTMLElement>(
        "[data-slot='composer-attachment-upload-progress-bar-indicator']",
      )?.style.width,
    ).toBe("42%");
    expect(
      (screen.getByRole("button", { name: "Submitting…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    resolveCreate?.(detail);
    expect(await screen.findByText("Thanks")).toBeTruthy();
  });

  it("renders an accepted reporter reply into the conversation immediately", async () => {
    const adapter = transport();
    adapter.addComment = vi.fn(async (input) => ({
      ...detail,
      ticket: {
        ...detail.ticket,
        commentCount: detail.ticket.commentCount + 1,
        updatedAt: 5,
      },
      comments: [
        ...detail.comments,
        {
          id: "comment-reporter-reply",
          authorType: "reporter",
          body: input.body,
          createdAt: 5,
        },
      ],
    }));
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace initialTicketId={ticket.id} />
      </FeedbackProvider>,
    );

    const editor = await screen.findByLabelText("Reply");
    fireEvent.change(editor, { target: { value: "A persisted preview reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByText("A persisted preview reply")).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("");
    expect(adapter.addComment).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: ticket.id,
        body: "A persisted preview reply",
      }),
    );
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
    fireEvent.click(screen.getByText("Submit"));
    expect(await screen.findByText("Upload failed")).toBeTruthy();
    expect(editor.value).toBe("Keep this text");
    expect(screen.getByTitle("proof.png · image/png")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "New feedback" }));
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), {
      target: { value: "A newly-created ticket" },
    });
    fireEvent.click(screen.getByText("Submit"));
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
    const submit = screen.getByText("Submit");
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(adapter.createTicket).toHaveBeenCalledTimes(1);
    const cancelButtons = await screen.findAllByRole("button", {
      name: "Cancel",
    });
    fireEvent.click(cancelButtons.at(-1)!);
    expect(uploadSignal?.aborted).toBe(true);
    expect(editor.value).toBe("Only once");
    expect(screen.getByText("Submit")).toBeTruthy();
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
    fireEvent.click(screen.getByText("Submit"));
    expect(await screen.findByText("Submitting…")).toBeTruthy();

    view.rerender(
      <FeedbackProvider transport={second}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(editor.value).toBe("Preserve across session");
    expect(screen.getByText("Submit")).toBeTruthy();
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
    fireEvent(window, new Event("focus"));
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
      "Couldn't load feedback. Try again.",
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
      "Couldn't load feedback. Try again.",
    );
    expect(
      screen.getByRole("heading", { name: "My Feedback" }),
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
    fireEvent.click(screen.getByText("Submit"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn't load feedback. Try again.",
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
      "Couldn't load feedback. Try again.",
    );
    expect(screen.queryByText(secretText)).toBeNull();
  });

  it("keeps the current list error in place while retrying", async () => {
    const adapter = transport();
    let attempt = 0;
    let resolveRetry:
      | ((value: FeedbackTicketPage) => void)
      | undefined;
    adapter.listTickets = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new FeedbackTransportError("unavailable");
      return new Promise<FeedbackTicketPage>((resolve) => {
        resolveRetry = resolve;
      });
    });
    const { container } = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load feedback. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(container.querySelector(".hands-feedback-skeleton-row")).toBeNull();
    expect(
      (screen.getByRole("button", {
        name: /Loading feedback/,
      }) as HTMLButtonElement).disabled,
    ).toBe(true);

    resolveRetry?.({
      tickets: [ticket],
      nextCursor: null,
      unreadTotal: 1,
    });
    expect(await screen.findByText(ticket.message)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
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
    fireEvent.click(screen.getByText("Submit"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Submit"));
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
      screen.getByRole("heading", { name: "My Feedback" }),
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
    const feedback = screen.getByRole("radio", { name: "Idea" });
    const problem = screen.getByRole("radio", { name: "Bug" });
    expect(feedback.getAttribute("aria-checked")).toBe("true");
    expect(problem.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(problem);
    expect(feedback.getAttribute("aria-checked")).toBe("false");
    expect(problem.getAttribute("aria-checked")).toBe("true");
  });
});
