// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listTrustedPublishers: mocks.list,
  createTrustedPublisher: mocks.create,
  revokeTrustedPublisher: mocks.revoke,
}));

import { TrustedPublisherList } from "./TrustedPublishers";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TrustedPublisherList appId="app-a" appSlug="raft-deck" />
    </QueryClientProvider>,
  );
}

describe("TrustedPublisherList", () => {
  it("lists publishers and adds one with split ref patterns", async () => {
    mocks.list.mockResolvedValue({ trusted_publishers: [{
      id: "tp-1", app_id: "app-a", provider: "github", repository: "botiverse/raft-deck", repository_id: "42",
      workflow_path: ".github/workflows/desktop.yml", ref_patterns: ["refs/heads/main", "refs/tags/desktop-v*"],
      environment: null, app_role: "publisher", created_by_actor: "x", created_at: 1, last_used_at: null, revoked_at: null,
    }] });
    mocks.create.mockResolvedValue({ trusted_publisher: {} });
    renderList();
    expect(await screen.findByText("botiverse/raft-deck")).toBeTruthy();
    expect(screen.getByText("refs/heads/main refs/tags/desktop-v*")).toBeTruthy();
    expect(screen.getByText(/hands github-oidc-login --app raft-deck/)).toBeTruthy();

    fireEvent.click(screen.getByText("+ Add"));
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: " botiverse/raft-deck " } });
    fireEvent.change(screen.getByLabelText("Workflow file"), { target: { value: ".github/workflows/mobile.yml" } });
    fireEvent.change(screen.getByLabelText("Allowed refs"), { target: { value: "refs/heads/main, refs/tags/mobile-v*" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("app-a", {
      repository: "botiverse/raft-deck",
      workflow_path: ".github/workflows/mobile.yml",
      ref_patterns: ["refs/heads/main", "refs/tags/mobile-v*"],
    }));
  });
});
