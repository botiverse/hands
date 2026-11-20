// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  listFeedback: vi.fn(),
  getFeedback: vi.fn(),
  getAuthMe: vi.fn(),
  updateFeedbackTicket: vi.fn(),
  addFeedbackComment: vi.fn(),
  getFeedbackBuildFilter: vi.fn(),
  getFeedbackStats: vi.fn(),
  listCrashGroups: vi.fn(),
  downloadFeedbackAttachment: vi.fn(),
  getFeedbackAttachmentText: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  ...Object.fromEntries(Object.entries(mocks).filter(([k]) => k !== "toast")),
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));

import { AppFeedback, FeedbackTicketPage } from "./Feedback";
import { AppCrashes } from "./Crashes";
import { AppErrors } from "./Errors";

const NOW = Date.now();
const ticket = (id: string, message: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "bug", status: "open", closure_reason: null, duplicate_of_ticket_id: null, assignee: null, message,
  contact: null, version_name: "1.2.0", version_code: 120, channel: "main", device_id: "dev-1", device_model: "Pixel 8",
  os_version: "Android 15", created_at: NOW - 60_000, updated_at: NOW, attachment_count: 0, comment_count: 0, ...extra,
});
const detail = (t: ReturnType<typeof ticket>, extra: Record<string, unknown> = {}) => ({
  ticket: { ...t, arch: null, locale: null, metadata_json: JSON.stringify({ device_id: "dev-1", version_code: 120 }), symbolication_status: null, symbolicated_stack: null, symbolicated_at: null, ...extra },
  attachments: [{ id: "att-1", filename: "logs.zip", content_type: "application/zip", size_bytes: 2048, created_at: NOW }],
  comments: [],
});

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

function renderAt(path: string, routes: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>{routes}</Routes>
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The crash log's ScrollArea and the selects measure themselves.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthMe.mockResolvedValue({ account: { display_name: "Alice" } });
  mocks.getFeedbackBuildFilter.mockResolvedValue({ default_enabled: 0 });
  mocks.getFeedbackStats.mockResolvedValue({ daily: [], crashes_by_version: [] });
  mocks.updateFeedbackTicket.mockResolvedValue({});
  mocks.addFeedbackComment.mockResolvedValue({ id: "c1" });
});

describe("Feedback list", () => {
  const a = ticket("aaaaaaaa-1", "Sidebar jumps\n\nMore detail below", { attachment_count: 2, comment_count: 1 });
  const b = ticket("bbbbbbbb-2", "Dark mode contrast", { kind: "feedback", status: "resolved", assignee: "lin" });
  beforeEach(() => {
    mocks.listFeedback.mockResolvedValue({ tickets: [a, b] });
    mocks.getFeedback.mockImplementation((_app: string, id: string) => Promise.resolve(detail(id === a.id ? a : b)));
  });

  it("shows one row per ticket with its first line, facts, counts and state", async () => {
    renderAt("/apps/app-1/feedback", <Route path="/apps/:appId/feedback" element={<AppFeedback appId="app-1" />} />);
    const row = (await screen.findByText("Sidebar jumps")).closest("button")!;
    expect(within(row).getByText("Bug · 1.2.0 (120) · Pixel 8 · Android 15")).toBeTruthy();
    expect(within(row).getByText("Unassigned · 2 attachments · 1 comment")).toBeTruthy();
    expect(within(row).getByText("Open")).toBeTruthy();
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(mocks.listFeedback).toHaveBeenCalledWith("app-1", expect.objectContaining({ kind: "feedback,bug", buildScope: "standard" }));
  });

  it("reads the state filter from the URL, searches the rows and clears both", async () => {
    renderAt("/apps/app-1/feedback?status=open", <Route path="/apps/:appId/feedback" element={<AppFeedback appId="app-1" />} />);
    await screen.findByText("Sidebar jumps");
    expect(mocks.listFeedback).toHaveBeenCalledWith("app-1", expect.objectContaining({ status: "open" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search feedback" }), { target: { value: "contrast" } });
    expect(screen.queryByText("Sidebar jumps")).toBeNull();
    expect(screen.getByText("Dark mode contrast")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/apps/app-1/feedback"));
    expect(await screen.findByText("Sidebar jumps")).toBeTruthy();
    expect(mocks.listFeedback).toHaveBeenLastCalledWith("app-1", expect.objectContaining({ status: undefined }));
  });

  it("opens a ticket beside the list, with a link to its own page", async () => {
    renderAt("/apps/app-1/feedback", <Route path="/apps/:appId/feedback" element={<AppFeedback appId="app-1" />} />);
    fireEvent.click(await screen.findByText("Sidebar jumps"));
    const column = await screen.findByRole("region", { name: "Ticket aaaaaaaa" });
    expect(await within(column).findByText("More detail below")).toBeTruthy();
    expect(mocks.getFeedback).toHaveBeenCalledWith("app-1", a.id);
    expect(within(column).getByRole("button", { name: "Open as a page" }).getAttribute("href")).toBe(`/apps/app-1/feedback/${a.id}`);
    fireEvent.click(within(column).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Ticket aaaaaaaa" })).toBeNull();
  });

  it("shows the scope a link set and clears it", async () => {
    renderAt("/apps/app-1/feedback?kind=crash&signature=Boom%40Main", <Route path="/apps/:appId/feedback" element={<AppFeedback appId="app-1" />} />);
    expect(await screen.findByText("Boom@Main")).toBeTruthy();
    expect(mocks.listFeedback).toHaveBeenCalledWith("app-1", expect.objectContaining({ kind: "crash", signature: "Boom@Main" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/apps/app-1/feedback?kind=crash"));
  });

  it("says when there is no feedback yet", async () => {
    mocks.listFeedback.mockResolvedValue({ tickets: [] });
    renderAt("/apps/app-1/feedback", <Route path="/apps/:appId/feedback" element={<AppFeedback appId="app-1" />} />);
    expect(await screen.findByText("No feedback yet")).toBeTruthy();
  });
});

describe("Ticket page", () => {
  const t = ticket("cccccccc-3", "Crash on share", { kind: "crash", crash_type: "exception", attachment_count: 1 });
  beforeEach(() => {
    mocks.getFeedback.mockResolvedValue({
      ...detail(t, { symbolication_status: "symbolicated", symbolicated_stack: "at ShareSheet.kt:212" }),
      attachments: [],
    });
  });
  const renderTicket = () =>
    renderAt(`/apps/app-1/feedback/${t.id}`, <Route path="/apps/:appId/feedback/:ticketId" element={<FeedbackTicketPage appId="app-1" ticketId={t.id} />} />);

  it("changes the state, assigns and comments through the ticket API", async () => {
    renderTicket();
    expect(await screen.findByText("at ShareSheet.kt:212")).toBeTruthy();
    expect(screen.getByText("Symbolicated")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "In progress" }));
    await waitFor(() => expect(mocks.updateFeedbackTicket).toHaveBeenCalledWith("app-1", t.id, { status: "in_progress" }));
    fireEvent.click(await screen.findByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(mocks.updateFeedbackTicket).toHaveBeenCalledWith("app-1", t.id, { assignee: "Alice" }));
    fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "Fixed in 1.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to reporter" }));
    await waitFor(() => expect(mocks.addFeedbackComment).toHaveBeenCalledWith("app-1", t.id, "Fixed in 1.3", false));
  });

  it("goes back to the page of the ticket's kind", async () => {
    renderTicket();
    await screen.findByText("Crash on share", { selector: "p" });
    expect(screen.getByRole("button", { name: "Back" }).getAttribute("href")).toBe("/apps/app-1/crashes");
  });
});

describe("Crashes and Errors", () => {
  const groups = [
    { signature: "IllegalState@Share", crash_type: "exception", fatal: 1, count: 12, device_count: 4, first_seen: NOW - 86_400_000, last_seen: NOW - 60_000, versions: "1.2.0", open_count: 2 },
    {
      signature: "SystemKill@background", crash_type: "system_kill", fatal: 1, count: 300, device_count: 90, first_seen: NOW - 86_400_000, last_seen: NOW - 60_000, versions: "1.2.0", open_count: 0,
      by_version: [{ version_name: "1.2.0", version_code: 120, count: 300, device_count: 90 }],
      by_device: [],
    },
  ];
  beforeEach(() => {
    mocks.listCrashGroups.mockResolvedValue({ groups });
    mocks.listFeedback.mockResolvedValue({ tickets: [ticket("dddddddd-4", "Killed in background", { kind: "crash", crash_type: "system_kill", background_system_kill: 1 })] });
  });

  it("lists crash groups as rows and opens a group with its tickets", async () => {
    renderAt("/apps/app-1/crashes?crash_type=system_kill", <Route path="/apps/:appId/*" element={<AppCrashes appId="app-1" />} />);
    expect(await screen.findByText("IllegalState@Share")).toBeTruthy();
    expect(mocks.listCrashGroups).toHaveBeenCalledWith("app-1", undefined, "system_kill", "standard");
    expect(screen.getByText("2 open")).toBeTruthy();
    fireEvent.click(screen.getByText("Killed by the system in the background"));
    const column = await screen.findByRole("region", { name: "Killed by the system in the background" });
    expect(await within(column).findByText("Killed in background")).toBeTruthy();
    expect(mocks.listFeedback).toHaveBeenCalledWith("app-1", { kind: "crash", signature: "SystemKill@background", buildScope: "standard" });
    fireEvent.click(within(column).getByText("1.2.0 (120)"));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(
      "/apps/app-1/feedback?kind=crash&signature=SystemKill%40background&build_scope=standard&version_code=120",
    ));
  });

  it("lists error groups and says when there are none", async () => {
    mocks.listCrashGroups.mockResolvedValue({ groups: [] });
    renderAt("/apps/app-1/errors", <Route path="/apps/:appId/*" element={<AppErrors appId="app-1" />} />);
    expect(await screen.findByText("No errors yet")).toBeTruthy();
    expect(mocks.listCrashGroups).toHaveBeenCalledWith("app-1", "error", undefined, "standard");
  });
});
