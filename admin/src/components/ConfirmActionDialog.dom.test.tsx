// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

afterEach(cleanup);

describe("ConfirmActionDialog responsive identity header", () => {
  it("keeps the title and long object identity in separate full-width rows", async () => {
    render(
      <ConfirmActionDialog
        open
        title="Remove asset registration?"
        objectLabel="valid-1000002-to-1000003.patch.gz"
        objectHint="delta-patch · android/arm64-v8a · patch · 10.77 MiB"
        body="The underlying R2 binary is kept."
        confirmLabel="Remove asset"
        confirmKind="danger"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole("alertdialog");
    const header = dialog.querySelector('[data-slot="alert-dialog-header"]');
    const description = dialog.querySelector(
      '[data-slot="alert-dialog-description"]',
    );

    expect(header?.className).toContain("grid-cols-1");
    expect(header?.className).toContain("items-start");
    expect(description?.className).toContain("w-full");
    expect(description?.className).toContain("min-w-0");
    expect(
      screen.getByText("valid-1000002-to-1000003.patch.gz"),
    ).toBeTruthy();
    expect(
      screen.getByText("delta-patch · android/arm64-v8a · patch · 10.77 MiB"),
    ).toBeTruthy();
  });
});
