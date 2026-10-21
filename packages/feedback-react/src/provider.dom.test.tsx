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

// The row's open button is named by the ticket's first line, then its unread
// count when there is one ("…, 2 unread").
const ticketRowName = /^A reporter-visible ticket(, .+)?$/;

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

  it("shows each ticket's latest comment under its title and merges a sender's run in the conversation", async () => {
    const adapter = transport();
    adapter.listTickets = vi.fn(async () => ({
      ...page,
      tickets: [
        {
          ...ticket,
          latestComment: {
            authorType: "staff" as const,
            bodyPreview: "Fixed in **1.21.30** — see [notes](https://example.test)",
            createdAt: 5,
          },
        },
        {
          ...ticket,
          id: "ticket-quiet",
          message: "Nobody replied yet",
          unread: false,
          unreadCount: 0,
          commentCount: 0,
          latestComment: null,
        },
      ],
    }));
    adapter.getTicket = vi.fn(async () => ({
      ...detail,
      comments: [
        { id: "c1", authorType: "staff" as const, body: "First", createdAt: 3 },
        { id: "c2", authorType: "staff" as const, body: "Second", createdAt: 4 },
        { id: "c3", authorType: "reporter" as const, body: "Mine", createdAt: 5 },
      ],
    }));
    const { container } = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    await screen.findByText(ticket.message);
    const previews = container.querySelectorAll<HTMLElement>(".hands-feedback-ticket-preview");
    // One preview line, as plain text with its sender; none for a ticket
    // nobody has replied to.
    expect(previews).toHaveLength(1);
    expect(previews[0]!.textContent).toBe("Team: Fixed in 1.21.30 — see notes");

    fireEvent.click(screen.getByRole("button", { name: ticketRowName }));
    await screen.findByText("Second");
    const items = Array.from(
      container.querySelectorAll<HTMLElement>("[data-slot='message-item']"),
    );
    // Ticket message (you), First (team), Second (team, merged), Mine (you).
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.querySelector("[data-slot='message-item-sender']")?.textContent ?? null))
      .toEqual(["You", "Team", null, "You"]);
  });

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
      <FeedbackProvider transport={adapter} locale="zh-CN">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: ticketRowName }),
    );
    // Close is the ticket page's own action: an icon button at the end of
    // its header, beside the status on the title's line.
    const header = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        ".hands-feedback-detail [data-slot='panel-header']",
      );
      expect(element).toBeTruthy();
      return element!;
    });
    const closeButton = within(header).getByRole("button", { name: "关闭工单" });
    expect(header.querySelector("[data-slot='panel-status'] [data-feedback-status='open']")).toBeTruthy();
    expect(
      container.querySelector("[data-slot='message-item'] [data-feedback-status]"),
    ).toBeNull();
    fireEvent.click(closeButton);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "关闭工单" })).toBeTruthy();
    expect(
      within(dialog).getByText("关闭后不能再回复。如果问题再次出现，请发新的反馈。"),
    ).toBeTruthy();
    // An open ticket defaults to "no longer needed": nothing has been fixed.
    expect(
      within(dialog).getByRole("radio", { name: /不再需要/ }).getAttribute("aria-checked"),
    ).toBe("true");
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
    // Closed: the reply box gives way to a line saying so, and the header
    // loses its close action.
    expect(screen.queryByLabelText("回复")).toBeNull();
    expect(container.querySelector(".hands-feedback-closed-note")?.textContent).toContain(
      "该工单已关闭",
    );
    expect(within(header).queryByRole("button", { name: "关闭工单" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await waitFor(() => expect(screen.getByText("已关闭")).toBeTruthy());
  });

  it("asks a resolved ticket's reporter to close it, defaulting to fixed", async () => {
    const adapter = transport();
    const resolved = { ...detail.ticket, status: "resolved" as const };
    adapter.listTickets = vi.fn(async () => ({
      ...page,
      tickets: [{ ...ticket, status: "resolved" as const }],
    }));
    adapter.getTicket = vi.fn(async () => ({ ...detail, ticket: resolved }));
    adapter.closeTicket = vi.fn(async () => ({
      ...detail,
      ticket: { ...resolved, status: "closed" as const, closureReason: "completed" as const },
    }));
    const { container } = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: ticketRowName }));
    const notice = await waitFor(() => {
      const element = container.querySelector<HTMLElement>("[data-slot='panel-notice']");
      expect(element).toBeTruthy();
      return element!;
    });
    expect(notice.textContent).toContain("The team marked this resolved");
    // The notice carries the one close action; the header doesn't repeat it.
    expect(
      container.querySelector("[data-slot='panel-header'] [aria-label='Close Ticket']"),
    ).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Close Ticket" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("radio", { name: /It works now/ }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Ticket" }));
    await waitFor(() =>
      expect(adapter.closeTicket).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: ticket.id, reason: "completed" }),
      ),
    );
  });

  it("opens a ticket from its row, which has no close action of its own", async () => {
    const adapter = transport();
    adapter.closeTicket = vi.fn(async () => detail);
    const { container } = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    const openTicket = await screen.findByRole("button", {
      name: ticketRowName,
    });
    const row = openTicket.closest<HTMLElement>("[data-slot='inbox-item']")!;
    expect(row).toBeTruthy();
    // A list where every row carries a button reads as a wall of buttons;
    // the row itself is the target (raft-design InboxItem).
    expect(within(row).getAllByRole("button")).toEqual([openTicket]);
    fireEvent.click(openTicket);
    await waitFor(() => expect(adapter.getTicket).toHaveBeenCalledTimes(1));
    expect(adapter.closeTicket).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(container.querySelector(".hands-feedback-detail")).toBeTruthy(),
    );
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
    expect(container.querySelector("[data-slot='inbox-item']")).toBeTruthy();
    // The unread count is in the row's name (host copy), and shown as a
    // count beside the status.
    expect(
      screen.getByRole("button", { name: `${ticket.message}, 2 new items` }),
    ).toBeTruthy();
    const unreadCount = container.querySelector<HTMLElement>(
      ".hands-feedback-unread-count",
    )!;
    expect(unreadCount.textContent).toBe("2 new");
    expect(unreadCount.getAttribute("data-feedback-unread-count")).toBe("2");
    // The row's time is the latest activity; the host's date format is its
    // full-date tooltip.
    const listTime = container.querySelector<HTMLElement>(
      "[data-slot='inbox-item-timestamp'] time",
    )!;
    expect(listTime.getAttribute("title")).toBe("DATE:en:1");
    expect(listTime.closest(".hands-feedback-ticket-meta")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `${ticket.message}, 2 new items` }));
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

  it("shows each unread count as a pink count and in the row name", async () => {
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
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText("Unread 1");
    const badges = Array.from(
      container.querySelectorAll<HTMLElement>(
        ".hands-feedback-unread-count",
      ),
    );
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "1 new",
      "2 new",
      "99+ new",
    ]);
    // A count that wait for the person is raft-ui's pink badge.
    expect(badges.every((badge) => badge.dataset.slot === "badge")).toBe(true);
    // The exact count is in each row's accessible name.
    expect(
      screen.getAllByRole("button", { name: /^Unread \d+, \d+ unread$/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Unread 1, 1 unread", "Unread 2, 2 unread", "Unread 120, 120 unread"]);
    expect(container.querySelector(".hands-feedback-unread-dot")).toBeNull();
  });

  it("pull-refreshes list and conversation only from scroll-top", async () => {
    const adapter = transport();
    render(
      <FeedbackProvider transport={adapter}>
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

    fireEvent.click(screen.getByRole("button", { name: ticketRowName }));
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
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace onRouteChange={onRouteChange} />
      </FeedbackProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "New Feedback" }));
    fireEvent.change(
      screen.getByRole("textbox", {
        name: /What would you like us to know/,
      }),
      { target: { value: "Route this ticket" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send Feedback" }));

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
    fireEvent.click(await screen.findByText("New Feedback"));
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
        onUnreadChanged={onUnreadChanged}
      >
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    // raft-ui 0.6 has a single look; the workspace must not stamp a theme attribute.
    expect(container.querySelector("[data-hands-feedback-theme]")).toBeNull();
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

    fireEvent.click(screen.getByRole("button", { name: ticketRowName }));
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
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText("Ticket open");
    // Each ticket is an InboxItem row, the same row Raft's Activity uses.
    const rows = container.querySelectorAll<HTMLElement>("[data-slot='inbox-item']");
    expect(rows).toHaveLength(4);
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
      { backgroundColor: "", slot: "badge" },
      { backgroundColor: "", slot: "badge" },
      { backgroundColor: "", slot: "badge" },
      { backgroundColor: "", slot: "badge" },
    ]);
    // Each status chip leads with the design system's status pixel, not an icon.
    for (const badge of container.querySelectorAll<HTMLElement>("[data-feedback-status]")) {
      expect(badge.querySelector("[data-slot='status']")).toBeTruthy();
      expect(badge.querySelector("svg")).toBeNull();
    }
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-feedback-status]"),
      ).every((badge) => badge.closest(".hands-feedback-ticket-meta")),
    ).toBe(true);
    // The kind is the title's icon, named for screen readers; colour stays
    // with status.
    const titles = container.querySelectorAll<HTMLElement>(
      ".hands-feedback-ticket-title[data-feedback-kind]",
    );
    expect(Array.from(titles).map((title) => title.dataset.feedbackKind)).toEqual([
      "feedback",
      "feedback",
      "bug",
      "feedback",
    ]);
    expect(titles[2]?.querySelector("svg")?.getAttribute("aria-label")).toBe("Bug");
    expect(titles[0]?.querySelector("svg")?.getAttribute("aria-label")).toBe("Idea");
    // No row carries a close action: closing lives on the ticket's page.
    expect(screen.queryByRole("button", { name: "Close Ticket" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen ticket" })).toBeNull();
  });

  it("presents a completed closed ticket as resolved without reopening it", async () => {
    const adapter = transport();
    adapter.closeTicket = vi.fn(async () => detail);
    adapter.getTicket = vi.fn(async () => ({
      ...detail,
      ticket: {
        ...detail.ticket,
        id: "ticket-completed",
        message: "Completed closed ticket",
        status: "closed",
        closureReason: "completed",
      },
    }));
    adapter.listTickets = vi.fn(async () => ({
      tickets: [
        {
          ...ticket,
          id: "ticket-completed",
          message: "Completed closed ticket",
          status: "closed",
          closureReason: "completed",
          unread: false,
          unreadCount: 0,
        },
        {
          ...ticket,
          id: "ticket-no-longer-needed",
          message: "No longer needed ticket",
          status: "closed",
          closureReason: "no_longer_needed",
          unread: false,
          unreadCount: 0,
        },
      ],
      nextCursor: null,
      unreadTotal: 0,
    }));
    const { container } = render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    await screen.findByText("Completed closed ticket");
    const completedCard = screen
      .getByRole("button", { name: "Completed closed ticket" })
      .closest<HTMLElement>("[data-slot='inbox-item']")!;
    const completedStatus = completedCard.querySelector<HTMLElement>(
      "[data-feedback-status='closed']",
    )!;
    expect(completedStatus.dataset.feedbackDisplayStatus).toBe("resolved");
    expect(completedStatus.style.backgroundColor).toBe("");
    expect(completedStatus.textContent).toContain("Resolved");
    expect(completedStatus.querySelector("[data-slot='status']")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Completed closed ticket" }),
    );
    await waitFor(() =>
      expect(
        container.querySelector(
          ".hands-feedback-detail [data-feedback-display-status='resolved']",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText("Closed as Completed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    const noLongerNeededCard = screen
      .getByRole("button", { name: "No longer needed ticket" })
      .closest<HTMLElement>("[data-slot='inbox-item']")!;
    const noLongerNeededStatus = noLongerNeededCard.querySelector<HTMLElement>(
      "[data-feedback-status='closed']",
    )!;
    expect(noLongerNeededStatus.dataset.feedbackDisplayStatus).toBe("closed");
    expect(noLongerNeededStatus.style.backgroundColor).toBe("");
    expect(noLongerNeededStatus.textContent).toContain("Closed");
    expect(noLongerNeededStatus.querySelector("[data-slot='status']")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Close Ticket" })).toBeNull();
    expect(container.querySelectorAll("[data-feedback-status='closed']")).toHaveLength(2);
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
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "My Feedback" }),
    ).toBeTruthy();
    const createButton = screen.getByRole("button", { name: "New Feedback" });
    expect(createButton.closest(".hands-feedback-toolbar")).toBeTruthy();
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
      <FeedbackProvider transport={emptyAdapter}>
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
      screen.getAllByRole("button", { name: "New Feedback" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("tablist", { name: "Status filter" })).toBeNull();
    expect(empty.container.querySelector(".hands-feedback-empty")).not.toBeNull();
    expect(
      empty.container.querySelector("[data-feedback-empty-kind='all']"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New Feedback" }));
    expect(
      screen.getByRole("heading", { name: "New Feedback" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    const kind = screen.getByRole("radiogroup", { name: "Type" });
    expect(kind).toBeTruthy();
    expect(kind.getAttribute("data-slot")).toBe("segmented-control");
    expect(screen.getByRole("radio", { name: "Idea" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Bug" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Idea" }).className).toContain(
      "hands-feedback-kind-item",
    );
    // A page form (raft-design Forms): the message is a field of its own,
    // screenshots are optional, and Cancel and the one pink button end it.
    expect(screen.getByRole("textbox", { name: /What would you like us to know/ }).dataset.slot).toBe("textarea");
    expect(screen.getByRole("button", { name: "Attach Image" })).toBeTruthy();
    expect(screen.getByText("Screenshots (optional)")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.closest(".hands-feedback-form-actions")).not.toBeNull();
    expect(cancel.closest(".hands-feedback-header")).toBeNull();
    const submit = screen.getByRole("button", { name: "Send Feedback" });
    expect(submit.closest(".hands-feedback-form-actions")).toBe(
      cancel.closest(".hands-feedback-form-actions"),
    );
    expect(submit.getAttribute("type")).toBe("submit");
  });

  it("keeps filtered empty states next to the tabs with accurate semantics", async () => {
    const endedAdapter = transport();
    endedAdapter.listTickets = vi.fn(async () => ({
      tickets: [{ ...ticket, status: "resolved" }],
      nextCursor: null,
      unreadTotal: 0,
    }));
    const endedView = render(
      <FeedbackProvider transport={endedAdapter}>
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
      <FeedbackProvider transport={activeAdapter}>
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
      <FeedbackProvider transport={adapter}>
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
      await screen.findByRole("button", { name: ticketRowName }),
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
      await screen.findByRole("button", { name: ticketRowName }),
    );
    const firstDraft = await screen.findByLabelText("Reply");
    expect(firstDraft.closest(".hands-feedback-composer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach Image" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach File" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send Reply" })).toBeTruthy();
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
      await screen.findByRole("button", { name: ticketRowName }),
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

    fireEvent.click(await screen.findByText("New Feedback"));
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
    fireEvent.click(screen.getByRole("button", { name: "Send Reply" }));

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

    fireEvent.click(await screen.findByText("New Feedback"));
    fireEvent.change(screen.getByLabelText(/What would you like us to know/), {
      target: { value: "Show upload progress" },
    });
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: {
        files: [new File(["image"], "progress.png", { type: "image/png" })],
      },
    });
    const submit = screen.getByRole("button", { name: "Send Feedback" });
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
    fireEvent.click(screen.getByRole("button", { name: "Send Reply" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Send Reply" }));
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
        name: "Send Reply",
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
    fireEvent.click(await screen.findByText("New Feedback"));
    const editor = screen.getByLabelText(
      /What would you like us to know/,
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Keep this text" } });
    const file = new File(["image"], "proof.png", {
      type: "image/png",
      lastModified: 7,
    });
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByText("Send Feedback"));
    expect(await screen.findByText("Upload failed")).toBeTruthy();
    expect(editor.value).toBe("Keep this text");
    expect(screen.getByTitle("proof.png · image/png")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry Upload"));
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
    fireEvent.click(screen.getByRole("button", { name: "New Feedback" }));
    fireEvent.change(screen.getByLabelText(/What would you like us to know/), {
      target: { value: "A newly-created ticket" },
    });
    fireEvent.click(screen.getByText("Send Feedback"));
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
    fireEvent.click(await screen.findByText("New Feedback"));
    const editor = screen.getByLabelText(
      /What would you like us to know/,
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Only once" } });
    const submit = screen.getByText("Send Feedback");
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(adapter.createTicket).toHaveBeenCalledTimes(1);
    const cancelButtons = await screen.findAllByRole("button", {
      name: "Cancel",
    });
    fireEvent.click(cancelButtons.at(-1)!);
    expect(uploadSignal?.aborted).toBe(true);
    expect(editor.value).toBe("Only once");
    expect(screen.getByText("Send Feedback")).toBeTruthy();
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
    fireEvent.click(await screen.findByText("New Feedback"));
    const editor = screen.getByLabelText(
      /What would you like us to know/,
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "Preserve across session" } });
    fireEvent.click(screen.getByText("Send Feedback"));
    expect(await screen.findByText("Submitting…")).toBeTruthy();

    view.rerender(
      <FeedbackProvider transport={second}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    expect(editor.value).toBe("Preserve across session");
    expect(screen.getByText("Send Feedback")).toBeTruthy();
    resolveFirst?.(detail);
    await Promise.resolve();
    expect(
      screen.getByRole("heading", { name: "New Feedback" }),
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
    fireEvent.click(screen.getByText("Load More Replies"));
    expect(await screen.findByText("Reply 101")).toBeTruthy();
    expect(screen.getAllByText("Reply 100")).toHaveLength(1);
    expect(adapter.getTicket).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentCursor: "page-2" }),
    );
    expect(screen.queryByText("Load More Replies")).toBeNull();
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

    fireEvent.click(await screen.findByText("Load More Replies"));
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
    fireEvent.click(await screen.findByText("New Feedback"));
    fireEvent.change(screen.getByLabelText(/What would you like us to know/), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByText("Send Feedback"));
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
    fireEvent.click(screen.getByText("Send Reply"));
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
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
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
    fireEvent.click(await screen.findByText("New Feedback"));
    fireEvent.change(screen.getByLabelText(/What would you like us to know/), {
      target: { value: "Retry me" },
    });
    fireEvent.click(screen.getByText("Send Feedback"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Send Feedback"));
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
    fireEvent.click(screen.getByText("Send Reply"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Send Reply"));
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
    fireEvent.click(await screen.findByText("New Feedback"));
    const feedback = screen.getByRole("radio", { name: "Idea" });
    const problem = screen.getByRole("radio", { name: "Bug" });
    expect(feedback.getAttribute("aria-checked")).toBe("true");
    expect(problem.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(problem);
    expect(feedback.getAttribute("aria-checked")).toBe("false");
    expect(problem.getAttribute("aria-checked")).toBe("true");
  });
});
