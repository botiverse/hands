// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceEnrollment, DeviceEnrollmentResult } from "../lib/api";

const mocks = vi.hoisted(() => ({
  listDeviceGroups: vi.fn(),
  listDeviceEnrollments: vi.fn(),
  rebindDeviceEnrollment: vi.fn(),
  revokeDeviceEnrollment: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  listDeviceGroups: mocks.listDeviceGroups,
  listDeviceEnrollments: mocks.listDeviceEnrollments,
  rebindDeviceEnrollment: mocks.rebindDeviceEnrollment,
  revokeDeviceEnrollment: mocks.revokeDeviceEnrollment,
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

import { DeviceEnrollmentRow, DeviceGroupsPanel } from "./AppDetail";

const enrollment: DeviceEnrollment = {
  id: "enrollment-123",
  app_id: "app-1",
  alias: "artin-huawei-tablet",
  label: "Android 12 QA",
  current_device_id: "install-old",
  status: "active",
  revision: 7,
  created_by: "artin",
  updated_by: "artin",
  created_at: 1,
  updated_at: 2,
  last_rebound_at: null,
  revoked_at: null,
};

function result(kind: "rebind" | "revoke", replayed = false): DeviceEnrollmentResult {
  return {
    enrollment: {
      ...enrollment,
      current_device_id: kind === "rebind" ? "install-new" : null,
      status: kind === "rebind" ? "active" : "revoked",
      revision: 8,
    },
    replayed,
    operation: {
      operation_id: "operation-fixed",
      kind,
      from_device_id: "install-old",
      to_device_id: kind === "rebind" ? "install-new" : null,
      expected_revision: 7,
      resulting_revision: 8,
      migrated_group_memberships: 2,
      migrated_feature_flags: 3,
      actor: "artin",
      created_at: 3,
    },
  };
}

function wrapper(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDeviceGroups.mockResolvedValue({ groups: [] });
  mocks.listDeviceEnrollments.mockResolvedValue({ enrollments: [enrollment] });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "operation-fixed") });
});

describe("Android test-device enrollments", () => {
  it("does not render or query Android enrollment controls for non-Android apps", async () => {
    render(wrapper(<DeviceGroupsPanel appId="app-1" platform="ios" />));

    expect(screen.queryByText("Test-device enrollments")).toBeNull();
    expect(mocks.listDeviceEnrollments).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.listDeviceGroups).toHaveBeenCalledWith("app-1"));
  });

  it("renders the enrollment panel for Android apps", async () => {
    render(wrapper(<DeviceGroupsPanel appId="app-1" platform="android" />));

    expect(await screen.findByText("Test-device enrollments")).toBeTruthy();
    expect(mocks.listDeviceEnrollments).toHaveBeenCalledWith("app-1");
  });

  it("confirms exact rebind impact and retries an ambiguous failure with the same receipt key", async () => {
    mocks.rebindDeviceEnrollment
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(result("rebind", true));
    const changed = vi.fn();
    render(wrapper(
      <DeviceEnrollmentRow appId="app-1" enrollment={enrollment} onChanged={changed} />,
    ));

    const input = screen.getByRole("textbox", {
      name: "Replacement installation ID for artin-huawei-tablet",
    });
    expect(input.className).toContain("min-w-0");
    expect(input.className).toContain("w-full");
    fireEvent.change(input, { target: { value: "install-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebind enrollment artin-huawei-tablet" }));

    expect(mocks.rebindDeviceEnrollment).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getAllByText("install-old").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("install-new")).toBeTruthy();
    expect(screen.getByText("operation-fixed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebind installation" }));

    const expectedPayload = {
      device_id: "install-new",
      expected_revision: 7,
      operation_id: "operation-fixed",
    };
    await waitFor(() => expect(mocks.rebindDeviceEnrollment).toHaveBeenCalledTimes(1));
    expect(mocks.rebindDeviceEnrollment).toHaveBeenLastCalledWith(
      "app-1",
      "enrollment-123",
      expectedPayload,
    );
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebind installation" }));
    await waitFor(() => expect(mocks.rebindDeviceEnrollment).toHaveBeenCalledTimes(2));
    expect(mocks.rebindDeviceEnrollment).toHaveBeenLastCalledWith(
      "app-1",
      "enrollment-123",
      expectedPayload,
    );
    expect(await screen.findByText("operation: operation-fixed")).toBeTruthy();
    expect(screen.getByText("revision: 8")).toBeTruthy();
    expect(screen.getByText("replayed: true")).toBeTruthy();
    expect(screen.getByText(/migrated: 2 group slot/)).toBeTruthy();
  });

  it("uses a danger confirmation before revoke and shows exact identity receipt", async () => {
    mocks.revokeDeviceEnrollment.mockResolvedValue(result("revoke"));
    render(wrapper(
      <DeviceEnrollmentRow appId="app-1" enrollment={enrollment} onChanged={vi.fn()} />,
    ));

    const open = screen.getByRole("button", { name: "Revoke enrollment artin-huawei-tablet" });
    expect(open.className).toContain("w-full");
    fireEvent.click(open);
    expect(mocks.revokeDeviceEnrollment).not.toHaveBeenCalled();
    expect(await screen.findByText("Revoke test-device enrollment?")).toBeTruthy();
    expect(screen.getByText("current ID")).toBeTruthy();
    expect(screen.getAllByText("install-old").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("operation-fixed")).toBeTruthy();

    const confirm = screen.getByRole("button", { name: "Revoke enrollment" });
    expect(confirm.className).toMatch(/danger|red/);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.revokeDeviceEnrollment).toHaveBeenCalledWith(
      "app-1",
      "enrollment-123",
      {
        expected_revision: 7,
        operation_id: "operation-fixed",
      },
    ));
    expect(await screen.findByText("operation: operation-fixed")).toBeTruthy();
  });
});
