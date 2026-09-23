// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listReleaseApprovals: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listReleaseApprovals: mocks.listReleaseApprovals,
  approveReleaseApproval: mocks.approve,
  rejectReleaseApproval: mocks.reject,
}));

import { PendingReleaseApprovals } from "./Releases";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PendingReleaseApprovals appId="app-a" gateOn={true} />
    </QueryClientProvider>,
  );
}

const baseApproval = {
  id: "req1",
  app_id: "app-a",
  release_id: "rel1",
  requested_by_actor: "agent:ci",
  requested_by_token_id: "tok1",
  expected_revision: 0,
  status: "pending",
  decided_by: null,
  decided_at: null,
  decision_note: null,
  created_at: 1700000000000,
  release_status: "draft",
  version_name: "2.0.0",
  version_code: 2000000,
  changelog: "notes",
  build_id: "b1",
  channel_slug: "production",
  assets: [],
};

describe("PendingReleaseApprovals card — publish-intent context", () => {
  it("renders the requested scopes and required external targets the approver is signing off on", async () => {
    mocks.listReleaseApprovals.mockResolvedValue({
      app_id: "app-a",
      status: "pending",
      approvals: [
        {
          ...baseApproval,
          expected_scopes: JSON.stringify([{ scope_type: "full", scope_value: "all" }]),
          required_external_targets: JSON.stringify(["darwin-arm64", "linux-x64"]),
        },
      ],
    });
    renderCard();
    expect(await screen.findByText("full:all")).toBeTruthy();
    expect(screen.getByText("darwin-arm64")).toBeTruthy();
    expect(screen.getByText("linux-x64")).toBeTruthy();
  });

  it("renders multiple non-full scopes as chips", async () => {
    mocks.listReleaseApprovals.mockResolvedValue({
      app_id: "app-a",
      status: "pending",
      approvals: [
        {
          ...baseApproval,
          expected_scopes: JSON.stringify([
            { scope_type: "platform", scope_value: "android" },
            { scope_type: "user_cohort", scope_value: "beta" },
          ]),
          required_external_targets: null,
        },
      ],
    });
    renderCard();
    expect(await screen.findByText("platform:android")).toBeTruthy();
    expect(screen.getByText("user_cohort:beta")).toBeTruthy();
  });

  it("a malformed stored targets value does not crash the card (guard tooth)", async () => {
    mocks.listReleaseApprovals.mockResolvedValue({
      app_id: "app-a",
      status: "pending",
      approvals: [
        {
          ...baseApproval,
          expected_scopes: JSON.stringify([{ scope_type: "full", scope_value: "all" }]),
          // object, not an array — would have thrown on .map before the guard
          required_external_targets: JSON.stringify({ length: 1 }),
        },
      ],
    });
    renderCard();
    // Card still renders; falls back, no throw.
    expect(await screen.findByText("full:all")).toBeTruthy();
  });
});
