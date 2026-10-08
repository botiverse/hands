import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Apple, ChevronDown } from "lucide-react";
import {
  Badge,
  Button,
  Input,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "raft-ui";
import {
  deleteAscCredentials,
  getAscCredentials,
  setAscCredentials,
  verifyAscCredentials,
} from "../../lib/api";
import { useToast } from "../Toast";

/**
 * App Store Connect / TestFlight connector row for the Integrations page.
 * Moved out of the app Settings section unchanged: same queries, mutations
 * and form flow — the row is collapsed until configured, then expandable.
 */
export function TestFlightConnector({ appId }: { appId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["asc-credentials", appId],
    queryFn: () => getAscCredentials(appId),
  });
  const meta = creds.data?.asc_credentials ?? null;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [p8, setP8] = useState("");

  const save = useMutation({
    mutationFn: () =>
      setAscCredentials(appId, {
        key_id: keyId.trim(),
        issuer_id: issuerId.trim(),
        p8: p8.trim(),
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "TestFlight credentials saved" });
      setEditing(false);
      setKeyId("");
      setIssuerId("");
      setP8("");
      qc.invalidateQueries({ queryKey: ["asc-credentials", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Save failed", description: (e as Error).message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAscCredentials(appId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "TestFlight credentials removed" });
      qc.invalidateQueries({ queryKey: ["asc-credentials", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Remove failed", description: (e as Error).message }),
  });

  const test = useMutation({
    mutationFn: () => {
      const bundleId = window.prompt(
        "Bundle ID to verify against App Store Connect (e.g. build.raft.app):",
        "",
      );
      if (!bundleId || !bundleId.trim()) throw new Error("cancelled");
      return verifyAscCredentials(appId, bundleId.trim());
    },
    onSuccess: (res) => {
      if (res.ok) {
        toast.show({
          kind: "success",
          title: "Connection OK",
          description: res.asc_app_id
            ? `App Store Connect app ${res.asc_app_id} found.`
            : res.detail ?? "",
        });
      } else {
        toast.show({
          kind: "error",
          title: "Verification failed",
          description: res.detail ?? res.error ?? "unknown",
        });
      }
    },
    onError: (e) => {
      if ((e as Error).message === "cancelled") return;
      toast.show({ kind: "error", title: "Test failed", description: (e as Error).message });
    },
  });

  const readP8File = (file: File | undefined) => {
    if (!file) return;
    file.text().then(
      (text) => setP8(text),
      () => toast.show({ kind: "error", title: "Could not read the .p8 file" }),
    );
  };

  const formValid =
    keyId.trim().length > 0 && issuerId.trim().length > 0 && p8.includes("BEGIN") && p8.includes("KEY");

  const form = (
    <div className="space-y-3">
      {!meta && (
        <ol className="text-xs text-foreground-muted list-decimal pl-4 space-y-1">
          <li>
            In{" "}
            <a
              className="text-info-strong hover:underline"
              href="https://appstoreconnect.apple.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              App Store Connect
            </a>
            {" → My Apps, create an app record for this bundle ID if one "}
            does not exist yet (TestFlight only needs the record — no store
            listing or review required).
          </li>
          <li>
            Go to{" "}
            <a
              className="text-info-strong hover:underline"
              href="https://appstoreconnect.apple.com/access/integrations/api"
              target="_blank"
              rel="noopener noreferrer"
            >
              Users and Access → Integrations → App Store Connect API
            </a>
            {" and generate a Team Key with the "}
            <strong>App Manager</strong> role (requires an Admin account).
          </li>
          <li>
            Note the <strong>Issuer ID</strong> (top of that page) and the
            key's <strong>Key ID</strong>, then download the{" "}
            <span className="font-mono">AuthKey_XXXXXXXXXX.p8</span> file —
            Apple lets you download it <strong>once</strong>.
          </li>
          <li>Paste all three below and save.</li>
        </ol>
      )}
      <div className="flex flex-col gap-3 md:flex-row">
        <label className="flex-1 text-xs text-foreground-muted">
          Key ID
          <Input
            className="h-8! w-full text-sm! font-mono mt-1"
            placeholder="ABC123DEFG"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
          />
        </label>
        <label className="flex-1 text-xs text-foreground-muted">
          Issuer ID
          <Input
            className="h-8! w-full text-sm! font-mono mt-1"
            placeholder="12345678-90ab-cdef-1234-567890abcdef"
            value={issuerId}
            onChange={(e) => setIssuerId(e.target.value)}
          />
        </label>
      </div>
      <label className="block text-xs text-foreground-muted">
        Private key (.p8 contents)
        <Textarea
          className="w-full font-mono h-24 resize-y mt-1"
          placeholder={"Paste the contents of the downloaded .p8 AuthKey file"}
          value={p8}
          onChange={(e) => setP8(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="xs" render={<label className="cursor-pointer" />}>
          Load from .p8 file
          <input
            type="file"
            accept=".p8,.pem"
            className="hidden"
            onChange={(e) => readP8File(e.target.files?.[0])}
          />
        </Button>
        <div className="flex-1" />
        {editing && (
          <Button
            variant="outline"
            onClick={() => {
              setEditing(false);
              setKeyId("");
              setIssuerId("");
              setP8("");
            }}
          >
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!formValid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "…" : meta ? "Replace credentials" : "Save & enable"}
        </Button>
      </div>
      {p8.trim().length > 0 && !(p8.includes("BEGIN") && p8.includes("KEY")) && (
        <p className="text-xs text-warning-strong">
          This does not look like a .p8 private key — paste the full PEM
          contents of the downloaded AuthKey file, including the header and
          footer lines.
        </p>
      )}
      <p className="text-xs text-foreground-hint">
        The App Store Connect app record must match the bundle ID your IPAs
        are signed with.
      </p>
    </div>
  );

  return (
    <section data-testid="testflight-connector" className="border-t border-line-hairline pt-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fill-muted text-foreground-muted">
          <Apple className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground-strong">TestFlight</h3>
          <p className="mt-0.5 text-xs text-foreground-muted">
            App Store Connect API key used to upload builds of this app to
            TestFlight. Stored encrypted; the private key is never shown again
            after saving.
          </p>
        {meta ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
            <Badge variant="success">Configured</Badge>
            <span className="min-w-0 truncate font-mono">Key ID {meta.key_id}</span>
            <span className="min-w-0 truncate font-mono">Issuer {meta.issuer_id}</span>
            <span>updated {new Date(meta.updated_at).toISOString().slice(0, 10)}</span>
          </div>
        ) : null}
        </div>
        <div className="flex items-center gap-2">
          {meta ? (
            <Button
              variant="outline"
              size="icon-sm"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown
                className={`size-4 transition-transform${expanded ? " rotate-180" : ""}`}
                aria-hidden="true"
              />
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={creds.isLoading}
              onClick={() => setExpanded(true)}
            >
              Configure
            </Button>
          )}
        </div>
      </div>
      {meta && expanded ? (
        <div className="mt-3 space-y-3 border-t border-line-hairline pt-4">
          {!editing && (
            <div className="flex flex-wrap gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      disabled={test.isPending}
                      onClick={() => test.mutate()}
                    >
                      {test.isPending ? "Testing…" : "Test connection"}
                    </Button>
                  }
                />
                <TooltipContent>
                  Verify the stored key against App Store Connect for this app's
                  bundle id
                </TooltipContent>
              </Tooltip>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Replace key
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Remove the App Store Connect key? TestFlight uploads for this app stop until a new key is saved.",
                    )
                  ) {
                    remove.mutate();
                  }
                }}
              >
                {remove.isPending ? "…" : "Remove"}
              </Button>
            </div>
          )}
          {editing ? form : null}
        </div>
      ) : null}
      {!meta && expanded ? (
        <div className="mt-3 border-t border-line-hairline pt-4">{form}</div>
      ) : null}
    </section>
  );
}
