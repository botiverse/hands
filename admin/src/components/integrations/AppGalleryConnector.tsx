import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Smartphone } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardLeading,
  CardTitle,
  CardTrailing,
} from "raft-ui";
import {
  deleteAgcCredentials,
  getAgcCredentials,
  setAgcCredentials,
  verifyAgcCredentials,
} from "../../lib/api";
import { useToast } from "../Toast";

/**
 * AppGallery Connect connector row for the Integrations page. Moved out of
 * the app Settings section unchanged: same queries, mutations and form flow —
 * the row is collapsed until configured, then expandable.
 */
export function AppGalleryConnector({ appId }: { appId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["agc-credentials", appId],
    queryFn: () => getAgcCredentials(appId),
  });
  const meta = query.data?.agc_credentials ?? null;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [credentialJson, setCredentialJson] = useState("");
  const save = useMutation({
    mutationFn: () => setAgcCredentials(appId, credentialJson),
    onSuccess: () => {
      setCredentialJson("");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["agc-credentials", appId] });
      toast.show({ kind: "success", title: "AppGallery Connect credential saved" });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Save failed", description: (e as Error).message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAgcCredentials(appId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agc-credentials", appId] });
      toast.show({ kind: "success", title: "AppGallery Connect credential removed" });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Remove failed", description: (e as Error).message }),
  });
  const test = useMutation({
    mutationFn: () => verifyAgcCredentials(appId),
    onSuccess: (r) =>
      toast.show(
        r.ok
          ? {
              kind: "success",
              title: "Connection OK",
              description: `${r.credential_kind === "service_account" ? "Service Account JWT signing" : "AGC token exchange"} succeeded; credential expires in ${Math.round((r.expires_in ?? 0) / 3600)} hours.`,
            }
          : { kind: "error", title: "Verification failed", description: r.error ?? "Unknown AGC error" },
      ),
    onError: (e) =>
      toast.show({ kind: "error", title: "Test failed", description: (e as Error).message }),
  });

  const form = (
    <div className="space-y-3">
      <label className="block text-xs font-medium">AGC Service Account private JSON</label>
      <Button variant="outline" size="xs" className="self-start" render={<label className="cursor-pointer" />}>
        Choose JSON file
        <input
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              file.text().then(setCredentialJson, () =>
                toast.show({ kind: "error", title: "Could not read the credential file" }),
              );
          }}
        />
      </Button>
      <div className="text-xs text-foreground-muted">
        Select the private JSON downloaded from AppGallery Connect. Service
        Account is recommended; legacy API client JSON remains supported during
        migration.
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!credentialJson || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save credential"}
        </Button>
        {meta && (
          <Button
            variant="outline"
            onClick={() => {
              setCredentialJson("");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Card data-testid="appgallery-connector">
      <CardHeader>
        <CardLeading>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line-muted bg-layer-inset text-foreground-muted">
            <Smartphone className="size-4" aria-hidden="true" />
          </span>
        </CardLeading>
        <CardTitle>AppGallery Connect</CardTitle>
        <CardDescription>
          Service Account or legacy API client credential used for HarmonyOS
          testing and publishing. The uploaded JSON is encrypted and private
          material is never shown again.
        </CardDescription>
        {meta ? (
          <div className="col-start-2 space-y-0.5 text-xs text-foreground-muted">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant="success">Configured</Badge>
              <span>{meta.credential_kind}</span>
              <span>updated {new Date(meta.updated_at).toISOString().slice(0, 10)}</span>
            </div>
            {meta.credential_kind === "service_account" ? (
              <div className="font-mono break-all">
                Sub-account {meta.sub_account} · Key {meta.key_id} · Project {meta.project_id || "default"}
              </div>
            ) : (
              <div className="font-mono break-all">
                Developer {meta.developer_id} · Project {meta.project_id} · Client {meta.client_id}
              </div>
            )}
            <div className="font-mono">
              Region {meta.region || "default"} · Fingerprint {meta.credential_fingerprint.slice(0, 12)}…
            </div>
          </div>
        ) : null}
        <CardTrailing className="gap-2">
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
              disabled={query.isLoading}
              onClick={() => setExpanded(true)}
            >
              Configure
            </Button>
          )}
        </CardTrailing>
      </CardHeader>
      {meta && expanded ? (
        <div className="space-y-3 border-t border-line-hairline p-4">
          {!editing && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button variant="outline" onClick={() => setEditing(true)}>
                Replace credential
              </Button>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Remove the AppGallery Connect credential? Publishing stops until a new credential is saved.",
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
        <div className="border-t border-line-hairline p-4">{form}</div>
      ) : null}
    </Card>
  );
}
