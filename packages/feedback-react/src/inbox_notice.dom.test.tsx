// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FeedbackWorkspace } from "./components.js";
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

  it("does not render the notice on the new-feedback or ticket views", async () => {
    const view = render(
      <FeedbackProvider transport={transport()}>
        <FeedbackWorkspace inboxNotice={notice} />
      </FeedbackProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New feedback" }));
    expect(screen.getByRole("heading", { name: "New feedback" })).toBeTruthy();
    expect(screen.queryByTestId("host-notice")).toBeNull();
    view.unmount();

    const adapter = transport();
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace
          inboxNotice={notice}
          route={{ view: "ticket", ticketId: "ticket-1" }}
        />
      </FeedbackProvider>,
    );
    await screen.findAllByText("A reporter-visible ticket");
    await waitFor(() => expect(adapter.getTicket).toHaveBeenCalled());
    expect(screen.queryByTestId("host-notice")).toBeNull();
    expect(
      document.querySelector("[data-feedback-inbox-notice]"),
    ).toBeNull();
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
