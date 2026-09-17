// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

describe("ConfirmActionDialog typed-confirmation gate", () => {
  // Regression: the gate used to be decorative. The dialog rendered the field but wired
  // onChange to a no-op and never disabled Confirm, while the purge caller passed the app's
  // own slug as `confirm_slug`. An operator who typed nothing could therefore still complete
  // an irreversible purge. These tests pin both halves of the contract.
  function Harness({ onConfirm }: { onConfirm: () => void }) {
    const [typed, setTyped] = useState("");
    return (
      <ConfirmActionDialog
        open
        title="Purge this app permanently?"
        objectLabel="My App"
        objectHint="slug: myapp-android"
        body="Deletes everything it owns. This cannot be undone."
        confirmLabel="Purge permanently"
        confirmKind="danger"
        requiredText="myapp-android"
        typedValue={typed}
        onTypedChange={setTyped}
        confirmDisabled={typed !== "myapp-android"}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
  }

  it("accepts typed input and only enables Confirm once the slug matches", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    const field = screen.getByRole("textbox");
    const confirm = screen.getByRole("button", { name: "Purge permanently" });

    // Nothing typed: the destructive action must be unreachable.
    expect((field as HTMLInputElement).value).toBe("");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // A wrong value must not arm it either.
    fireEvent.change(field, { target: { value: "myapp-androi" } });
    expect((field as HTMLInputElement).value).toBe("myapp-androi");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // Only the exact slug arms it, and typing must actually reach the field.
    fireEvent.change(field, { target: { value: "myapp-android" } });
    expect((field as HTMLInputElement).value).toBe("myapp-android");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
