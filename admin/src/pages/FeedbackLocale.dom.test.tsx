// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ detail: vi.fn(), me: vi.fn(), update: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  getFeedback: mocks.detail,
  getAuthMe: mocks.me,
  updateFeedbackTicket: mocks.update,
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
import { FeedbackTicketPage } from "./Feedback";
import { LanguagePicker, LocaleProvider } from "../lib/locale";

afterEach(() => { cleanup(); localStorage.clear(); document.cookie = "hands_locale=; Path=/; Max-Age=0"; });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.me.mockResolvedValue({ account: { display_name: "Alice" } });
  mocks.detail.mockResolvedValue({ ticket: {
    id: "ticket-123", kind: "feedback", status: "open", assignee: null,
    created_at: 1700000000000, message: "Keep this user text", contact: null,
    metadata_json: "{}", closure_reason: null, duplicate_of_ticket_id: null,
  }, comments: [], attachments: [] });
  mocks.update.mockResolvedValue({});
});

it("switches ticket controls without losing a comment or changing the closure request", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<LocaleProvider><LanguagePicker /><QueryClientProvider client={client}><MemoryRouter>
    <FeedbackTicketPage appId="app-a" ticketId="ticket-123" />
  </MemoryRouter></QueryClientProvider></LocaleProvider>);
  const comment = await screen.findByPlaceholderText("Add a comment…") as HTMLTextAreaElement;
  fireEvent.change(comment, { target: { value: "Unsent user comment" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  expect(screen.getByPlaceholderText("添加评论…")).toHaveProperty("value", "Unsent user comment");
  expect(screen.getByText("Keep this user text")).toBeTruthy();
  expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "选择关闭原因" }));
  fireEvent.click(await screen.findByText("重复工单"));
  fireEvent.change(screen.getByPlaceholderText("完整 ID 或唯一前缀"), { target: { value: "original-123" } });
  fireEvent.click(screen.getByRole("button", { name: "关闭工单" }));
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("app-a", "ticket-123", {
    status: "closed", closure_reason: "duplicate", duplicate_of_ticket_id: "original-123",
  }));
});
