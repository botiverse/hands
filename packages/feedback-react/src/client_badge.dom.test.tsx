// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FeedbackWorkspace } from "./components.js";
import { FeedbackProvider } from "./provider.js";
import type {
  FeedbackClient,
  FeedbackLocale,
  FeedbackTicketDetail,
  FeedbackTicketSummary,
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
});

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;

const ticket: FeedbackTicketSummary = {
  id: "ticket-1",
  kind: "bug",
  status: "open",
  closureReason: null,
  duplicateOfTicketId: null,
  message: "Crash when opening a thread",
  createdAt: Date.UTC(2026, 10, 10, 9),
  updatedAt: Date.UTC(2026, 10, 12, 9),
  unread: false,
  unreadCount: 0,
  attachmentCount: 0,
  commentCount: 2,
  client: "android",
};

function transport(summary: FeedbackTicketSummary): HandsFeedbackTransport {
  const detail: FeedbackTicketDetail = {
    ticket: summary,
    comments: [
      {
        id: "c1",
        authorType: "staff",
        body: "Which version?",
        createdAt: summary.createdAt + 60_000,
      },
      // A later day, so the reporter's reply has its own header.
      {
        id: "c2",
        authorType: "reporter",
        body: "The latest one",
        createdAt: summary.createdAt + 2 * DAY,
      },
    ],
    attachments: [],
    nextCommentCursor: null,
    unreadTotal: 0,
  };
  return {
    listTickets: vi.fn(async () => ({
      tickets: [summary],
      nextCursor: null,
      unreadTotal: 0,
    })),
    getTicket: vi.fn(async () => detail),
    createTicket: vi.fn(async () => detail),
    addComment: vi.fn(async () => detail),
  };
}

async function openTicket(options: {
  currentClient?: FeedbackClient;
  summary?: FeedbackTicketSummary;
  locale?: FeedbackLocale;
}) {
  const summary = options.summary ?? ticket;
  const { container } = render(
    <FeedbackProvider
      transport={transport(summary)}
      locale={options.locale ?? "en"}
      {...(options.currentClient ? { currentClient: options.currentClient } : {})}
    >
      <FeedbackWorkspace />
    </FeedbackProvider>,
  );
  const row = await screen.findByRole("button", {
    name: new RegExp(`^${summary.message}`),
  });
  const list = container.querySelector<HTMLElement>(".hands-feedback-ticket-list")!;
  const rowLabel = row.getAttribute("aria-label") ?? "";
  const rowBadges = Array.from(
    list.querySelectorAll<HTMLElement>("[data-feedback-client]"),
  );
  fireEvent.click(row);
  await screen.findByText("The latest one");
  const messages = Array.from(
    container.querySelectorAll<HTMLElement>(
      ".hands-feedback-detail [data-slot='message-item']",
    ),
  );
  return { container, messages, rowLabel, rowBadges };
}

describe("ticket filed on another client", () => {
  it("names the other client on its list row", async () => {
    const { rowLabel, rowBadges } = await openTicket({ currentClient: "web" });

    // One badge, last in the row's metadata, after the state and the replies.
    expect(rowBadges).toHaveLength(1);
    const badge = rowBadges[0]!;
    expect(badge.dataset.feedbackClient).toBe("android");
    expect(badge.classList.contains("hands-feedback-ticket-client")).toBe(true);
    expect(badge.parentElement?.classList.contains("hands-feedback-ticket-meta")).toBe(true);
    expect(badge.nextElementSibling).toBeNull();
    expect(badge.querySelector(".hands-feedback-sr-only")?.textContent).toBe(
      "Filed on Android",
    );
    // The row's button carries the label, since it covers the row.
    expect(rowLabel).toBe("Crash when opening a thread, Filed on Android");
  });

  it("names the other client once in the ticket, after the first message's time", async () => {
    const { container, messages } = await openTicket({
      currentClient: "web",
    });

    // Ticket message (you), Which version? (team), The latest one (you).
    expect(messages).toHaveLength(3);
    const header = messages[0]!.querySelector<HTMLElement>(
      "[data-slot='message-item-header']",
    )!;
    const badge = header.querySelector<HTMLElement>(
      ".hands-feedback-message-client",
    )!;
    expect(badge).toBeTruthy();
    expect(badge.dataset.feedbackClient).toBe("android");
    // Right after the message's time.
    expect(
      badge.previousElementSibling?.matches("[data-slot='message-item-time']"),
    ).toBe(true);
    // A screen reader hears "Filed on Android"; the visible name and the icon
    // are hidden from it so the name isn't read twice.
    expect(badge.querySelector(".hands-feedback-sr-only")?.textContent).toBe(
      "Filed on Android",
    );
    const visible = Array.from(badge.children).filter(
      (child) => !child.classList.contains("hands-feedback-sr-only"),
    );
    expect(visible.map((child) => child.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
    ]);
    expect(visible.map((child) => child.textContent)).toEqual(["", "Android"]);

    // Replies and the ticket's header don't name it.
    for (const reply of messages.slice(1))
      expect(reply.querySelector("[data-feedback-client]")).toBeNull();
    expect(
      container.querySelectorAll(".hands-feedback-detail [data-feedback-client]"),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        ".hands-feedback-detail [data-slot='panel-header'] [data-feedback-client]",
      ),
    ).toBeNull();
  });

  it("uses the locale's wording for the hidden prefix", async () => {
    const { messages } = await openTicket({
      currentClient: "desktop",
      summary: { ...ticket, client: "ohos" },
      locale: "zh-CN",
    });
    const badge = messages[0]!.querySelector(".hands-feedback-message-client")!;
    expect(badge.querySelector(".hands-feedback-sr-only")?.textContent).toBe(
      "提交自 HarmonyOS",
    );
  });

  it("shows nothing for a ticket filed on the current client", async () => {
    const { container, rowBadges, rowLabel } = await openTicket({
      currentClient: "android",
    });
    expect(rowBadges).toHaveLength(0);
    expect(rowLabel).toBe("Crash when opening a thread");
    expect(container.querySelector("[data-feedback-client]")).toBeNull();
    expect(screen.queryByText("Android")).toBeNull();
  });

  it("shows nothing when the host doesn't say which client it runs on", async () => {
    const { container } = await openTicket({});
    expect(container.querySelector("[data-feedback-client]")).toBeNull();
    expect(screen.queryByText("Android")).toBeNull();
  });

  it("shows nothing for a ticket without a client, or an unknown one", async () => {
    const { client: _omitted, ...withoutClient } = ticket;
    const first = await openTicket({
      currentClient: "web",
      summary: withoutClient,
    });
    expect(first.container.querySelector("[data-feedback-client]")).toBeNull();
    cleanup();

    const second = await openTicket({
      currentClient: "web",
      summary: { ...ticket, client: "linux" as FeedbackClient },
    });
    expect(second.container.querySelector("[data-feedback-client]")).toBeNull();
  });
});
