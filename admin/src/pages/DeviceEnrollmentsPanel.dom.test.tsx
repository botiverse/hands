// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type DeviceEnrollment, type DeviceEnrollmentResult } from "../lib/api";

const mocks = vi.hoisted(() => ({
  listDeviceGroups: vi.fn(),
  listDeviceEnrollments: vi.fn(),
  createDeviceEnrollment: vi.fn(),
  rebindDeviceEnrollment: vi.fn(),
  revokeDeviceEnrollment: vi.fn(),
  toast: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  listDeviceGroups: mocks.listDeviceGroups,
  listDeviceEnrollments: mocks.listDeviceEnrollments,
  createDeviceEnrollment: mocks.createDeviceEnrollment,
  rebindDeviceEnrollment: mocks.rebindDeviceEnrollment,
  revokeDeviceEnrollment: mocks.revokeDeviceEnrollment,
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

import { DeviceEnrollmentRow, DeviceEnrollmentsPanel, DeviceGroupsPanel } from "./AppDetail";

const enrollment: DeviceEnrollment = {
  id: "enrollment-123",
  app_id: "app-1",
  alias: "artin-huawei-tablet",
  label: "Android 12 QA",
  current_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
      current_device_id: kind === "rebind" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : null,
      status: kind === "rebind" ? "active" : "revoked",
      revision: 8,
    },
    replayed,
    operation: {
      operation_id: "operation-first",
      kind,
      from_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      to_device_id: kind === "rebind" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : null,
      expected_revision: 7,
      resulting_revision: 8,
      migrated_group_memberships: 2,
      migrated_feature_flags: 3,
      actor: "artin",
      created_at: 3,
    },
  };
}

function createResult(id: string, replayed = false): DeviceEnrollmentResult {
  return {
    enrollment: {
      ...enrollment,
      id,
      current_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revision: 1,
    },
    replayed,
    operation: {
      operation_id: "operation-first",
      kind: "create",
      from_device_id: null,
      to_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expected_revision: null,
      resulting_revision: 1,
      migrated_group_memberships: 0,
      migrated_feature_flags: 0,
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
  mocks.uuid.mockReset();
  mocks.uuid.mockReturnValueOnce("operation-first").mockReturnValueOnce("operation-second");
  vi.stubGlobal("crypto", { randomUUID: mocks.uuid });
});

describe("Android test-device enrollments", () => {
  it("does not render or query Android enrollment controls for non-Android apps", async () => {
    render(wrapper(<DeviceGroupsPanel appId="app-1" platform="ios" />));

    expect(screen.queryByText("Test-device enrollments")).toBeNull();
    expect(screen.queryByText(/Enrolled aliases above/)).toBeNull();
    expect(mocks.listDeviceEnrollments).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.listDeviceGroups).toHaveBeenCalledWith("app-1"));
  });

  it("renders the enrollment panel for Android apps", async () => {
    render(wrapper(<DeviceGroupsPanel appId="app-1" platform="android" />));

    expect(await screen.findByText("Test-device enrollments")).toBeTruthy();
    expect(mocks.listDeviceEnrollments).toHaveBeenCalledWith("app-1");
  });

  it("retries ambiguous create with one frozen operation key and shows replay receipt", async () => {
    mocks.createDeviceEnrollment
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(createResult("created-enrollment", true));
    render(wrapper(<DeviceEnrollmentsPanel appId="app-1" />));

    fireEvent.change(screen.getByRole("textbox", { name: "Enrollment alias" }), {
      target: { value: "artin-huawei-tablet" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Current Android installation ID" }), {
      target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    const payload = {
      alias: "artin-huawei-tablet",
      device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation_id: "operation-first",
    };
    await waitFor(() => expect(mocks.createDeviceEnrollment).toHaveBeenCalledTimes(1));
    expect(mocks.createDeviceEnrollment).toHaveBeenLastCalledWith("app-1", payload);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Enroll" }));
    await waitFor(() => expect(mocks.createDeviceEnrollment).toHaveBeenCalledTimes(2));
    expect(mocks.createDeviceEnrollment).toHaveBeenLastCalledWith("app-1", payload);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("created: created-enrollment")).toBeTruthy();
    expect(await screen.findByText("operation: operation-first")).toBeTruthy();
    expect(screen.getByText("revision: 1")).toBeTruthy();
    expect(screen.getByText("replayed: true")).toBeTruthy();
  });

  it("clears the last confirmed create receipt when a different create starts and fails", async () => {
    mocks.createDeviceEnrollment
      .mockResolvedValueOnce(createResult("created-A"))
      .mockRejectedValueOnce(new Error("B response lost"));
    render(wrapper(<DeviceEnrollmentsPanel appId="app-1" />));
    const alias = screen.getByRole("textbox", { name: "Enrollment alias" });
    const device = screen.getByRole("textbox", { name: "Current Android installation ID" });
    const submit = screen.getByRole("button", { name: "Enroll" });

    fireEvent.change(alias, { target: { value: "device-A" } });
    fireEvent.change(device, { target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });
    fireEvent.click(submit);
    expect(await screen.findByText("created: created-A")).toBeTruthy();

    fireEvent.change(alias, { target: { value: "device-B" } });
    fireEvent.change(device, { target: { value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.createDeviceEnrollment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("created: created-A")).toBeNull());
    expect(screen.queryByText("operation: operation-first")).toBeNull();
  });

  it("drops a definitive create 409 intent and uses a fresh operation key on resubmit", async () => {
    mocks.createDeviceEnrollment.mockRejectedValue(
      new ApiError(409, { error: "operation conflict" }, "operation conflict"),
    );
    render(wrapper(<DeviceEnrollmentsPanel appId="app-1" />));
    fireEvent.change(screen.getByRole("textbox", { name: "Enrollment alias" }), {
      target: { value: "artin-huawei-tablet" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Current Android installation ID" }), {
      target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    const submit = screen.getByRole("button", { name: "Enroll" });

    fireEvent.click(submit);
    await waitFor(() => expect(mocks.createDeviceEnrollment).toHaveBeenCalledTimes(1));
    expect(mocks.createDeviceEnrollment.mock.calls[0]?.[1]).toMatchObject({
      operation_id: "operation-first",
    });
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.createDeviceEnrollment).toHaveBeenCalledTimes(2));
    expect(mocks.createDeviceEnrollment.mock.calls[1]?.[1]).toMatchObject({
      operation_id: "operation-second",
    });
    expect(mocks.uuid).toHaveBeenCalledTimes(2);
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
    fireEvent.change(input, { target: { value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebind enrollment artin-huawei-tablet" }));

    expect(mocks.rebindDeviceEnrollment).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getAllByText("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeTruthy();
    expect(screen.getByText("operation-first")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebind installation" }));

    const expectedPayload = {
      device_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expected_revision: 7,
      operation_id: "operation-first",
    };
    await waitFor(() => expect(mocks.rebindDeviceEnrollment).toHaveBeenCalledTimes(1));
    expect(mocks.rebindDeviceEnrollment).toHaveBeenLastCalledWith(
      "app-1",
      "enrollment-123",
      expectedPayload,
    );
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rebind installation" }));
    await waitFor(() => expect(mocks.rebindDeviceEnrollment).toHaveBeenCalledTimes(2));
    expect(mocks.rebindDeviceEnrollment).toHaveBeenLastCalledWith(
      "app-1",
      "enrollment-123",
      expectedPayload,
    );
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("operation: operation-first")).toBeTruthy();
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
    expect(screen.getAllByText("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("operation-first")).toBeTruthy();

    const confirm = screen.getByRole("button", { name: "Revoke enrollment" });
    expect(confirm.className).toMatch(/danger|red/);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.revokeDeviceEnrollment).toHaveBeenCalledWith(
      "app-1",
      "enrollment-123",
      {
        expected_revision: 7,
        operation_id: "operation-first",
      },
    ));
    expect(await screen.findByText("operation: operation-first")).toBeTruthy();
  });

  it("closes a definitive 409 intent and requires a fresh confirmation key", async () => {
    mocks.rebindDeviceEnrollment.mockRejectedValue(
      new ApiError(409, { error: "revision conflict" }, "revision conflict"),
    );
    const changed = vi.fn();
    render(wrapper(
      <DeviceEnrollmentRow appId="app-1" enrollment={enrollment} onChanged={changed} />,
    ));

    const input = screen.getByRole("textbox", {
      name: "Replacement installation ID for artin-huawei-tablet",
    });
    fireEvent.change(input, { target: { value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebind enrollment artin-huawei-tablet" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rebind installation" }));

    await waitFor(() => expect(mocks.rebindDeviceEnrollment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(input).toHaveProperty("value", "");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(mocks.uuid).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } });
    fireEvent.click(screen.getByRole("button", { name: "Rebind enrollment artin-huawei-tablet" }));
    expect(await screen.findByText("operation-second")).toBeTruthy();
    expect(mocks.uuid).toHaveBeenCalledTimes(2);
  });
});
