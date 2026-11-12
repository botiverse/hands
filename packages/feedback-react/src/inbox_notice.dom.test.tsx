// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FeedbackInbox, FeedbackWorkspace } from "./components.js";
import { FeedbackProvider } from "./provider.js";
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
  unread: false,
  unreadCount: 0,
  attachmentCount: 0,
  commentCount: 0,
};

const page: FeedbackTicketPage = {
  tickets: [ticket],
  nextCursor: null,
  unreadTotal: 0,
};

const detail: FeedbackTicketDetail = {
  ticket,
  comments: [],
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

const notice = <p data-testid="host-notice">Did you know?</p>;

describe("FeedbackWorkspace inboxNotice", () => {
  it("renders the notice between the toolbar and the ticket list", async () => {
    const { container } = render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace inboxNotice={notice} />
      </FeedbackProvider>,
    );

    await screen.findByRole("button", { name: /^A reporter-visible ticket/ });
    const hostNotice = screen.getByTestId("host-notice");
    const wrapper = hostNotice.parentElement!;
    expect(wrapper.matches(".hands-feedback-inset.hands-feedback-inbox-notice"))
      .toBe(true);

    const toolbar = container.querySelector(".hands-feedback-toolbar")!;
    const scroll = container.querySelector("[data-feedback-list-scroll]")!;
    const list = container.querySelector("ul.hands-feedback-ticket-list")!;
    // Inside the list scroll region, like the error banner.
    expect(wrapper.parentElement).toBe(scroll);
    expect(
      toolbar.compareDocumentPosition(wrapper) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      wrapper.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the notice mounted but hidden on the ticket and new-feedback views", async () => {
    const statusNotice = (
      <p data-testid="host-notice" role="status">
        Did you know?
      </p>
    );
    render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace inboxNotice={statusNotice} />
      </FeedbackProvider>,
    );
    const visibleNotice = () =>
      screen
        .queryAllByRole("status")
        .find((el) => el.dataset.testid === "host-notice") ?? null;

    const row = await screen.findByRole("button", {
      name: /^A reporter-visible ticket/,
    });
    const original = visibleNotice();
    expect(original).not.toBeNull();

    fireEvent.click(row);
    // Ticket view: still in the DOM (same node) but inside the hidden inbox.
    await screen.findByRole("button", { name: "Back" });
    expect(screen.getByTestId("host-notice")).toBe(original);
    expect(original!.closest("section")?.hidden).toBe(true);
    expect(visibleNotice()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(visibleNotice()).toBe(original));

    fireEvent.click(screen.getByRole("button", { name: "New feedback" }));
    expect(screen.getByRole("heading", { name: "New feedback" })).toBeTruthy();
    expect(screen.getByTestId("host-notice")).toBe(original);
    expect(original!.closest("section")?.hidden).toBe(true);
    expect(visibleNotice()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(visibleNotice()).toBe(original));
  });

  it.each([
    ["false", false],
    ["true", true],
    ["empty string", ""],
    ["null", null],
  ] as const)("renders no wrapper for %s", async (_label, value) => {
    const { container } = render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace inboxNotice={value} />
      </FeedbackProvider>,
    );
    await screen.findByRole("button", { name: /^A reporter-visible ticket/ });
    expect(container.querySelector("[data-feedback-inbox-notice]")).toBeNull();
  });

  it("renders the notice in a directly used FeedbackInbox", async () => {
    const { container } = render(
      <FeedbackProvider transport={transport()}>
        <FeedbackInbox
          onSelectTicket={vi.fn()}
          onNewFeedback={vi.fn()}
          inboxNotice={notice}
        />
      </FeedbackProvider>,
    );
    await screen.findByRole("button", { name: /^A reporter-visible ticket/ });
    const wrapper = screen.getByTestId("host-notice").parentElement!;
    expect(wrapper.hasAttribute("data-feedback-inbox-notice")).toBe(true);
    expect(wrapper.parentElement).toBe(
      container.querySelector("[data-feedback-list-scroll]"),
    );
    expect(
      wrapper.compareDocumentPosition(
        container.querySelector("ul.hands-feedback-ticket-list")!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders no extra wrapper when the prop is absent", async () => {
    const { container } = render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    await screen.findByRole("button", { name: /^A reporter-visible ticket/ });
    expect(container.querySelector("[data-feedback-inbox-notice]")).toBeNull();
    expect(container.querySelector(".hands-feedback-inbox-notice")).toBeNull();
    const scroll = container.querySelector("[data-feedback-list-scroll]")!;
    expect(scroll.querySelectorAll(":scope > .hands-feedback-inset")).toHaveLength(
      0,
    );
  });
});
