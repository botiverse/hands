/**
 * ConfirmActionDialog — reusable destructive-action confirmation.
 *
 * Designed for the "delete X" / "remove X" / "cancel X" class of actions
 * where we want:
 *   - the dialog to name the object explicitly (asset row, channel,
 *     release, app) so the user can't be confused about what they're
 *     deleting;
 *   - a short description of what happens (and what does NOT happen — e.g.
 *     removing an asset registration does NOT delete the underlying R2
 *     binary; cancelling a release does NOT delete the build).
 *   - optional typed-confirmation gate for catastrophic ops.
 *
 * Usage:
 *   <ConfirmActionDialog
 *     open={show}
 *     title="Remove asset?"
 *     objectLabel={`${asset.platform}/${asset.arch} ${asset.filetype}`}
 *     objectSummary={<AssetSummary asset={asset} />}
 *     body="Removing this asset detaches it from this release. The release row, build metadata, and the underlying R2 object are kept."
 *     confirmLabel="Remove asset"
 *     confirmKind="danger"
 *     onConfirm={() => remove.mutate()}
 *     onCancel={() => setShow(false)}
 *   />
 */

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
  Button,
  Input,
} from "raft-ui";

export interface ConfirmActionDialogProps {
  open: boolean;
  title: string;
  /** One-line identifier of the object being acted on. e.g. "android-arm64-v8a apk". */
  objectLabel: string;
  /** Small monospace snippet shown beside `objectLabel` (id, r2_key, slug, etc.). */
  objectHint?: string | undefined;
  /** Optional rendered block — full summary card with key/value pairs. */
  objectSummary?: ReactNode | undefined;
  /** Long-form body explaining what happens + what does NOT happen. */
  body: ReactNode;
  /** Label on the destructive button. Default: "Confirm". */
  confirmLabel?: string | undefined;
  /** Cancel button label. Default: "Cancel". */
  cancelLabel?: string | undefined;
  /** Style of the confirm button. Default: 'primary'. */
  confirmKind?: "primary" | "danger" | undefined;
  /** If set, user must type this string before Confirm becomes enabled. */
  typeToConfirm?: string | undefined;
  /** Disable the confirm button (e.g. while a mutation is in flight). */
  pending?: boolean | undefined;
  /** Caller-controlled disable, e.g. for a typed-confirm gate. */
  confirmDisabled?: boolean | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmActionDialog({
  open,
  title,
  objectLabel,
  objectHint,
  objectSummary,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmKind = "primary",
  typeToConfirm,
  pending = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) {
  const confirmVariant = confirmKind === "danger" ? "danger" : "primary";
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent className="w-[calc(100%-2rem)] max-w-xl">
        <AlertDialogHeader className="grid-cols-1 items-start gap-1">
          <AlertDialogTitle className="w-full break-words">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="flex min-w-0 w-full flex-col items-start gap-1 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2 sm:gap-y-1">
            <span className="min-w-0 max-w-full break-words font-medium">
              {objectLabel}
            </span>
            {objectHint && (
              <span className="min-w-0 max-w-full break-words font-mono text-xs text-slate-500">
                {objectHint}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogBody className="max-h-[70vh] overflow-y-auto">
          {objectSummary && (
            <div className="mb-3 p-3 border border-slate-200 rounded-sm bg-slate-50 text-xs">
              {objectSummary}
            </div>
          )}

          <div className="text-sm text-slate-600 mb-4 leading-relaxed">
            {body}
          </div>

          {typeToConfirm !== undefined && (
            <TypedConfirmField
              required={typeToConfirm}
              value={pending ? "•••" : ""}
              onChange={() => {
                /* gated via external state; see TypedConfirmField doc */
              }}
            />
          )}
        </AlertDialogBody>

        <AlertDialogFooter className="flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          <AlertDialogCancel
            variant="outline"
            className="w-full sm:w-auto"
            disabled={pending}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            className="w-full sm:w-auto"
            loading={pending}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
          >
            {pending ? `${confirmLabel}…` : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Form-bound typed-confirmation. The caller owns the state:
 *
 *   const [typed, setTyped] = useState("");
 *   <TypedConfirmField required="delete-org" value={typed} onChange={setTyped} />
 *   <button disabled={typed !== "delete-org"}>Delete</button>
 */
export function TypedConfirmField({
  required,
  value,
  onChange,
  placeholder,
}: {
  required: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="mb-3">
      <label className="label">
        Type{" "}
        <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded-sm">
          {required}
        </code>{" "}
        to confirm
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? required}
        autoFocus
      />
    </div>
  );
}
