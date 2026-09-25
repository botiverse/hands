// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FeedbackWorkspace,
  NewFeedback,
  MAX_FEEDBACK_HOST_ATTACHMENT_BYTES,
  type FeedbackWorkspaceHandle,
} from "./components.js";
import { FeedbackProvider } from "./provider.js";
import type {
  FeedbackTicketDetail,
  FeedbackTicketPage,
  HandsFeedbackTransport,
} from "./types.js";

// jsdom has no navigator.userActivation; the tests drive it explicitly so the
// gate is observable. `userActive` models "inside a real user gesture".
let userActive = false;
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    get: () => ({ isActive: userActive, hasBeenActive: userActive }),
  });
});

afterEach(() => {
  userActive = false;
  cleanup();
});

const ticket = {
  id: "ticket-1",
  kind: "feedback" as const,
  status: "open" as const,
  closureReason: null,
  duplicateOfTicketId: null,
  message: "m",
  createdAt: 1,
  updatedAt: 2,
  unread: false,
  unreadCount: 0,
  attachmentCount: 0,
  commentCount: 0,
};
const page: FeedbackTicketPage = { tickets: [], nextCursor: null, unreadTotal: 0 };
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

function diagnostic(name = "unread-activity.json", body = '{"v":1}', type = "application/json") {
  return new File([body], name, { type, lastModified: 1 });
}

/** Runs `fn` as if inside a host button's click handler. */
function asUser<T>(fn: () => T): T {
  userActive = true;
  try {
    let result!: T;
    act(() => {
      result = fn();
    });
    return result;
  } finally {
    userActive = false;
  }
}

async function openNew(adapter = transport()) {
  const ref = createRef<FeedbackWorkspaceHandle>();
  render(
    <FeedbackProvider transport={adapter}>
      <FeedbackWorkspace ref={ref} />
    </FeedbackProvider>,
  );
  fireEvent.click(await screen.findByText("New feedback"));
  await screen.findByLabelText("What would you like us to know?");
  return { ref, adapter };
}

const pendingNames = () =>
  screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((button) => button.getAttribute("aria-label"));

describe("FeedbackWorkspace host pending-attachment API", () => {
  it("rejects without a user gesture and mutates nothing (gate is load-bearing)", async () => {
    const { ref, adapter } = await openNew();
    let result;
    act(() => {
      result = ref.current!.attachPendingFile({ file: diagnostic() });
    });
    expect(result).toEqual({ ok: false, reason: "user_activation_required" });
    expect(pendingNames()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(adapter.createTicket).not.toHaveBeenCalled();
  });

  it("only stages the file: no upload until the reporter reviews and submits", async () => {
    const { ref, adapter } = await openNew();
    const file = diagnostic();
    expect(asUser(() => ref.current!.attachPendingFile({ file }))).toEqual({ ok: true });
    expect(pendingNames()).toEqual(["Remove unread-activity.json"]);
    expect(screen.getByText("unread-activity.json")).toBeTruthy();
    expect(URL.createObjectURL).not.toHaveBeenCalledWith(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.createTicket).not.toHaveBeenCalled();

    // Reporter can remove it; submitting then sends no attachment.
    fireEvent.click(screen.getByRole("button", { name: "Remove unread-activity.json" }));
    expect(pendingNames()).toEqual([]);
    expect(asUser(() => ref.current!.attachPendingFile({ file }))).toEqual({ ok: true });
    expect(adapter.createTicket).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("What would you like us to know?"), {
      target: { value: "Unread badge is wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(adapter.createTicket).toHaveBeenCalledTimes(1));
    expect(vi.mocked(adapter.createTicket).mock.calls[0]![0].attachments).toEqual([file]);
  });

  it("dedupes the same file and bounds host injections to one", async () => {
    const { ref } = await openNew();
    const file = diagnostic();
    expect(asUser(() => ref.current!.attachPendingFile({ file }))).toEqual({ ok: true });
    expect(asUser(() => ref.current!.attachPendingFile({ file }))).toEqual({
      ok: false,
      reason: "duplicate",
    });
    expect(
      asUser(() =>
        ref.current!.attachPendingFile({ file: diagnostic("second.json") }),
      ),
    ).toEqual({ ok: false, reason: "limit_reached" });
    expect(pendingNames()).toEqual(["Remove unread-activity.json"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("counts toward the shared attachment limit alongside reporter screenshots", async () => {
    const { ref } = await openNew();
    const images = [1, 2, 3].map(
      (index) => new File([new Uint8Array(8)], `s${index}.png`, { type: "image/png" }),
    );
    fireEvent.change(screen.getByLabelText("Screenshots (up to 3)"), {
      target: { files: images },
    });
    expect(asUser(() => ref.current!.attachPendingFile({ file: diagnostic() }))).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    expect(pendingNames()).toHaveLength(3);
  });

  it.each([
    ["too_large", { file: new File([new Uint8Array(MAX_FEEDBACK_HOST_ATTACHMENT_BYTES + 1)], "big.json", { type: "application/json" }) }],
    ["empty", { file: new File([], "empty.json", { type: "application/json" }) }],
    ["unsupported_type", { file: diagnostic("page.html", "<b>", "text/html") }],
    ["unsupported_type", { file: diagnostic("blob.bin", "x", "") }],
    ["invalid_name", { file: diagnostic("../etc/passwd") }],
    ["invalid_name", { file: diagnostic("a\nb.json") }],
    ["invalid_input", { file: diagnostic(), url: "https://example.com/x" }],
    ["invalid_input", { path: "/tmp/diag.json" }],
    ["invalid_input", { file: "{\"v\":1}" }],
    ["invalid_input", null],
  ])("rejects %s with zero mutation", async (reason, input) => {
    const { ref, adapter } = await openNew();
    expect(
      asUser(() => ref.current!.attachPendingFile(input as never)),
    ).toEqual({ ok: false, reason });
    expect(pendingNames()).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(adapter.createTicket).not.toHaveBeenCalled();
  });

  it("gates the standalone NewFeedback handle on a user gesture too", async () => {
    const ref = createRef<FeedbackWorkspaceHandle>();
    render(
      <FeedbackProvider transport={transport()}>
        <NewFeedback ref={ref} onCancel={() => {}} onCreated={() => {}} />
      </FeedbackProvider>,
    );
    await screen.findByLabelText("What would you like us to know?");
    let result;
    act(() => {
      result = ref.current!.attachPendingFile({ file: diagnostic() });
    });
    expect(result).toEqual({ ok: false, reason: "user_activation_required" });
    expect(pendingNames()).toEqual([]);
    expect(asUser(() => ref.current!.attachPendingFile({ file: diagnostic() }))).toEqual({ ok: true });
    expect(pendingNames()).toEqual(["Remove unread-activity.json"]);
  });

  it("returns composer_closed outside the new-feedback view", async () => {
    const ref = createRef<FeedbackWorkspaceHandle>();
    const adapter = transport();
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace ref={ref} />
      </FeedbackProvider>,
    );
    await screen.findByText("New feedback");
    expect(asUser(() => ref.current!.attachPendingFile({ file: diagnostic() }))).toEqual({
      ok: false,
      reason: "composer_closed",
    });
    expect(adapter.createTicket).not.toHaveBeenCalled();
  });

  it("rejects while a submission is in flight", async () => {
    const adapter = transport();
    adapter.createTicket = vi.fn(() => new Promise<FeedbackTicketDetail>(() => {}));
    const { ref } = await openNew(adapter);
    fireEvent.change(screen.getByLabelText("What would you like us to know?"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(adapter.createTicket).toHaveBeenCalledTimes(1));
    expect(asUser(() => ref.current!.attachPendingFile({ file: diagnostic() }))).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(pendingNames()).toEqual([]);
  });

  it("never uploads from props or mounting alone", async () => {
    const adapter = transport();
    const ref = createRef<FeedbackWorkspaceHandle>();
    render(
      <FeedbackProvider transport={adapter}>
        <FeedbackWorkspace
          ref={ref}
          route={{ view: "new" }}
          onRouteChange={() => {}}
          onOpenAttachment={() => {}}
          onOpenPendingAttachment={() => {}}
          enablePullToRefresh
        />
      </FeedbackProvider>,
    );
    await screen.findByLabelText("What would you like us to know?");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingNames()).toEqual([]);
    expect(adapter.createTicket).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });
});
