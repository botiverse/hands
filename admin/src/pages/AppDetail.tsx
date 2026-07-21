import {
  Button,
  Input,
  Switch,
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectContent,
  SelectItem,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  EmptyState,
  EmptyStateTitle,
  EmptyStateDescription,
  Skeleton,
  Badge,
  type BadgeProps,
} from "raft-ui";
import { DeviceAnalytics } from "../components/DeviceAnalytics";
import { ReleaseHealth } from "../components/ReleaseHealth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ConfirmActionDialog, TypedConfirmField } from "../components/ConfirmActionDialog";
import {
  archiveApp,
  getAuthMe,
  listApps,
  listChannels,
  createChannel,
  updateChannel,
  deleteChannel,
  updateApp,
  type App,
  type Channel,
  uploadAppIcon,
  publicAppIconUrl,
  updateAppPublicHistory,
  updateAppDeltaUpdates,
  getAppClientKey,
  rotateAppClientKey,
  purgeApp,
  getAscCredentials,
  setAscCredentials,
  deleteAscCredentials,
  verifyAscCredentials,
  getAgcCredentials,
  setAgcCredentials,
  deleteAgcCredentials,
  verifyAgcCredentials,
  getAppStoreReview,
  addDeviceGroupMember,
  createDeviceGroup,
  deleteDeviceGroup,
  listDeviceGroups,
  removeDeviceGroupMember,
  updateDeviceGroup,
  type DeviceGroup,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { Operations } from "./Operations";
import { deviceGroupUpdatePayload } from "../lib/deviceGroupForm";

export function AppDetail({ appId }: { appId: string }) {
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const appMissing = !apps.isLoading && !apps.error && !app;

  return (
    <div>
      {apps.error && (
        <AppErrorBanner
          title="Cannot load apps"
          error={apps.error}
        />
      )}
      {appMissing && (
        <AppErrorBanner
          title="App is not available"
          description="This app is not visible to the current account, or it no longer exists."
        />
      )}
      {channels.error && (
        <AppErrorBanner
          title="Cannot load app details"
          error={channels.error}
        />
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">App overview</h2>
            <p className="text-xs text-slate-500">
              Releases are managed from the{" "}
              <a href={`/apps/${appId}/releases`} className="underline">
                Releases
              </a>{" "}
              tab.
            </p>
          </div>
          {channels.data?.channels.length ? (
            <Button
              variant="primary"
              className="text-sm"
              render={<a href={`/apps/${appId}/releases`} />}
            >
              Publish release →
            </Button>
          ) : (
            <Button
              variant="primary"
              className="text-sm"
              render={<a href={`/apps/${appId}/channels`} />}
            >
              Create channel first
            </Button>
          )}
        </div>
      </section>

      <section className="mt-6">
        <ReleaseHealth appId={appId} />
        <DeviceAnalytics appId={appId} />
      </section>

      <section className="mt-8">
        <Operations appId={appId} />
      </section>
    </div>
  );
}

function AppErrorBanner({
  title,
  description,
  error,
}: {
  title: string;
  description?: string;
  error?: unknown;
}) {
  return (
    <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <div className="font-medium">{title}</div>
      <div className="text-xs mt-1">
        {description ?? (error instanceof Error ? error.message : String(error))}
      </div>
    </div>
  );
}

export function AppChannels({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);

  return (
    <div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Channels</h2>
          <Button
            variant="outline"
            onClick={() => setShowCreateChannel(true)}
          >
            + New channel
          </Button>
        </div>
        {channels.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )}
        <div className="space-y-2">
          {channels.data?.channels.length === 0 && (
            <EmptyState>
              <EmptyStateTitle>No channels yet.</EmptyStateTitle>
            </EmptyState>
          )}
          {channels.data?.channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              onEdit={() => setEditingChannel(c)}
              busy={false}
            />
          ))}
        </div>
        {showCreateChannel && (
          <CreateChannelDialog
            appId={appId}
            onClose={() => setShowCreateChannel(false)}
            onCreated={() => {
              setShowCreateChannel(false);
              qc.invalidateQueries({ queryKey: ["channels", appId] });
            }}
          />
        )}
        {editingChannel && (
          <EditChannelDialog
            appId={appId}
            app={app}
            channel={editingChannel}
            onClose={() => setEditingChannel(null)}
            onSaved={() => {
              setEditingChannel(null);
              qc.invalidateQueries({ queryKey: ["channels", appId] });
            }}
          />
        )}
      </section>
    </div>
  );
}

function AppNamePanel({ appId, app }: { appId: string; app: App }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState(app.name);
  const rename = useMutation({
    mutationFn: () => updateApp(appId, { name: name.trim() }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "App renamed" });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Rename failed", description: (e as Error).message }),
  });
  const dirty = name.trim().length > 0 && name.trim() !== app.name;
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">App name</div>
        <div className="text-xs text-slate-500">
          Display name shown in the console and on share pages. The slug (
          <span className="font-mono">{app.slug}</span>) is permanent — SDKs
          and CI reference it.
        </div>
      </div>
      <Input
        className="h-8! w-full md:w-56 text-sm!"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && dirty && !rename.isPending) rename.mutate();
        }}
      />
      <Button
        variant="primary"
        loading={rename.isPending}
        disabled={!dirty || rename.isPending}
        onClick={() => rename.mutate()}
      >
        Save
      </Button>
    </div>
  );
}

function AppDescriptionPanel({ appId, app }: { appId: string; app: App }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [description, setDescription] = useState(app.description ?? "");
  const save = useMutation({
    mutationFn: () => updateApp(appId, { description: description.trim() || null }),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Description saved" });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Save failed", description: (e as Error).message }),
  });
  const dirty = description.trim() !== (app.description ?? "");
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">Description</div>
        <div className="text-xs text-slate-500">
          Internal note about what this app is — shown in the console app
          list, not on public pages.
        </div>
      </div>
      <textarea
        className="input w-full md:w-72 text-sm! h-16! resize-y"
        value={description}
        placeholder="What is this app?"
        onChange={(e) => setDescription(e.target.value)}
      />
      <Button
        variant="primary"
        loading={save.isPending}
        disabled={!dirty || save.isPending}
        onClick={() => save.mutate()}
      >
        Save
      </Button>
    </div>
  );
}

function ClientKeyPanel({ appId }: { appId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const keyQuery = useQuery({
    queryKey: ["client-key", appId],
    queryFn: () => getAppClientKey(appId),
  });
  const rotate = useMutation({
    mutationFn: () => rotateAppClientKey(appId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Client key rotated — update client configs" });
      qc.invalidateQueries({ queryKey: ["client-key", appId] });
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Rotate failed", description: (e as Error).message }),
  });
  const key = keyQuery.data?.client_key ?? null;
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">Client key</div>
        <div className="text-xs text-slate-500">
          Required on feedback/crash submissions (X-Hands-Client-Key; legacy
          X-Quiver-Client-Key still accepted). Embedded in client builds; rotate if leaked.
        </div>
        {key && revealed && (
          <div className="mt-1 font-mono text-xs break-all">{key}</div>
        )}
        {!key && !keyQuery.isLoading && (
          <div className="mt-1 text-xs text-amber-700">
            No key set — submissions are currently unauthenticated. Rotate to generate one.
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2 md:contents">
        {key && (
          <>
            <Button
              variant="outline"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(key);
                toast.show({ kind: "success", title: "Client key copied" });
              }}
            >
              Copy
            </Button>
          </>
        )}
        <Button
          variant="outline"
          disabled={rotate.isPending}
          onClick={() => {
            if (window.confirm("Rotate the client key? Older client builds stop reporting until they carry the new key.")) {
              rotate.mutate();
            }
          }}
        >
          {rotate.isPending ? "…" : key ? "Rotate" : "Generate"}
        </Button>
      </div>
    </div>
  );
}

function DeviceGroupsPanel({ appId }: { appId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const groups = useQuery({
    queryKey: ["device-groups", appId],
    queryFn: () => listDeviceGroups(appId),
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => createDeviceGroup(appId, {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    }),
    onSuccess: () => {
      setName("");
      setDescription("");
      void queryClient.invalidateQueries({ queryKey: ["device-groups", appId] });
      toast.show({ kind: "success", title: "Device group created" });
    },
    onError: (error) => toast.show({ kind: "error", title: "Create failed", description: (error as Error).message }),
  });

  return (
    <div className="border-t border-slate-100 pt-3 space-y-3">
      <div>
        <div className="text-sm font-medium">Device groups</div>
        <p className="text-xs text-slate-500">
          Exact rollout groups use the stable installation device id sent by the Hands update SDK.
        </p>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Artin test devices" />
        <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Operator note (optional)" />
        <Button variant="outline" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          Create group
        </Button>
      </div>
      {groups.isLoading && <p className="text-xs text-slate-500">Loading device groups…</p>}
      {groups.error && <p className="text-xs text-red-700">{(groups.error as Error).message}</p>}
      {(groups.data?.groups ?? []).map((group) => (
        <DeviceGroupCard key={group.id} appId={appId} group={group} />
      ))}
    </div>
  );
}

function DeviceGroupCard({ appId, group }: { appId: string; group: DeviceGroup }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [deviceId, setDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState(false);
  const [groupName, setGroupName] = useState(group.name);
  const [groupDescription, setGroupDescription] = useState(group.description ?? "");
  useEffect(() => {
    if (!editing) {
      setGroupName(group.name);
      setGroupDescription(group.description ?? "");
    }
  }, [editing, group.description, group.name]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["device-groups", appId] });
  const update = useMutation({
    mutationFn: () => updateDeviceGroup(appId, group.id, deviceGroupUpdatePayload(groupName, groupDescription)),
    onSuccess: () => {
      setEditing(false);
      void refresh();
      toast.show({ kind: "success", title: "Device group updated" });
    },
    onError: (error) => toast.show({ kind: "error", title: "Update failed", description: (error as Error).message }),
  });
  const add = useMutation({
    mutationFn: () => addDeviceGroupMember(appId, group.id, {
      device_id: deviceId.trim(),
      ...(label.trim() ? { label: label.trim() } : {}),
    }),
    onSuccess: () => {
      setDeviceId("");
      setLabel("");
      void refresh();
      toast.show({ kind: "success", title: "Device added" });
    },
    onError: (error) => toast.show({ kind: "error", title: "Add failed", description: (error as Error).message }),
  });
  const remove = useMutation({
    mutationFn: (memberDeviceId: string) => removeDeviceGroupMember(appId, group.id, memberDeviceId),
    onSuccess: () => void refresh(),
    onError: (error) => toast.show({ kind: "error", title: "Remove failed", description: (error as Error).message }),
  });
  const destroy = useMutation({
    mutationFn: () => deleteDeviceGroup(appId, group.id),
    onSuccess: () => {
      void refresh();
      toast.show({ kind: "success", title: "Device group deleted" });
    },
    onError: (error) => toast.show({ kind: "error", title: "Delete failed", description: (error as Error).message }),
  });

  return (
    <div className="rounded-md border border-slate-200 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          {editing ? (
            <div className="space-y-2">
              <Input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name" />
              <Input
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
                placeholder="Operator note"
              />
            </div>
          ) : (
            <>
              <div className="text-sm font-medium">{group.name}</div>
              {group.description && <div className="text-xs text-slate-500">{group.description}</div>}
            </>
          )}
          <div className="text-[11px] font-mono text-slate-400">{group.id}</div>
        </div>
        <div className="flex gap-2">
          {editing ? (
            <>
              <Button variant="outline" disabled={!groupName.trim() || update.isPending} onClick={() => update.mutate()}>
                Save
              </Button>
              <Button variant="outline" disabled={update.isPending} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setEditing(true)}>Edit</Button>
          )}
          <Button
            variant="outline"
            disabled={destroy.isPending || editing}
            onClick={() => { if (window.confirm(`Delete device group '${group.name}'?`)) destroy.mutate(); }}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        {group.members.length === 0 && <p className="text-xs text-slate-500">No devices yet.</p>}
        {group.members.map((member) => (
          <div key={member.device_id} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              <span className="font-medium">{member.label || "Device"}</span>{" "}
              <span className="font-mono text-slate-500">{member.device_id}</span>
            </span>
            <Button variant="outline" onClick={() => remove.mutate(member.device_id)} disabled={remove.isPending}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[1fr_160px_auto] gap-2">
        <Input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="Installation device id" />
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" />
        <Button variant="outline" disabled={!deviceId.trim() || add.isPending} onClick={() => add.mutate()}>
          Add
        </Button>
      </div>
    </div>
  );
}

function TestFlightPanel({ appId }: { appId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const creds = useQuery({
    queryKey: ["asc-credentials", appId],
    queryFn: () => getAscCredentials(appId),
  });
  const meta = creds.data?.asc_credentials ?? null;
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
    keyId.trim().length > 0 && issuerId.trim().length > 0 && p8.includes("BEGIN PRIVATE KEY");
  const showForm = editing || (!meta && !creds.isLoading);

  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">TestFlight</div>
          <div className="text-xs text-slate-500">
            App Store Connect API key used to upload builds of this app to
            TestFlight. Stored encrypted; the private key is never shown again
            after saving.
          </div>
          {meta && (
            <div className="mt-1 text-xs">
              <span className="text-green-700 font-medium">Configured</span>
              {" — "}
              <span className="font-mono">Key ID {meta.key_id}</span>
              {" · "}
              <span className="font-mono">Issuer {meta.issuer_id}</span>
              {" · updated "}
              {new Date(meta.updated_at).toISOString().slice(0, 10)}
            </div>
          )}
        </div>
        {meta && !editing && (
          <div className="flex flex-wrap gap-2 md:contents">
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
            <Button
              variant="outline"
              onClick={() => setEditing(true)}
            >
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
      </div>

      {showForm && (
        <div className="mt-3 p-3 border border-slate-200 rounded-md space-y-3">
          {!meta && (
            <ol className="text-xs text-slate-600 list-decimal pl-4 space-y-1">
              <li>
                In{" "}
                <a
                  className="underline"
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
                  className="underline"
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
            <label className="flex-1 text-xs text-slate-600">
              Key ID
              <Input
                className="h-8! w-full text-sm! font-mono mt-1"
                placeholder="ABC123DEFG"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
              />
            </label>
            <label className="flex-1 text-xs text-slate-600">
              Issuer ID
              <Input
                className="h-8! w-full text-sm! font-mono mt-1"
                placeholder="12345678-90ab-cdef-1234-567890abcdef"
                value={issuerId}
                onChange={(e) => setIssuerId(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-xs text-slate-600">
            Private key (.p8 contents)
            <textarea
              className="input w-full text-xs! font-mono h-24! resize-y mt-1"
              placeholder={"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}
              value={p8}
              onChange={(e) => setP8(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2">
            <label className="btn-secondary py-1! px-2! text-xs! cursor-pointer">
              Load from .p8 file
              <input
                type="file"
                accept=".p8,.pem"
                className="hidden"
                onChange={(e) => readP8File(e.target.files?.[0])}
              />
            </label>
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
              variant="outline"
              disabled={!formValid || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "…" : meta ? "Replace credentials" : "Save & enable"}
            </Button>
          </div>
          {p8.trim().length > 0 && !p8.includes("BEGIN PRIVATE KEY") && (
            <p className="text-xs text-amber-700">
              This does not look like a .p8 private key — paste the full PEM
              contents of the downloaded AuthKey file, including the BEGIN/END
              lines.
            </p>
          )}
          <p className="text-xs text-slate-400">
            The App Store Connect app record must match the bundle ID your IPAs
            are signed with.
          </p>
        </div>
      )}
    </div>
  );
}

function AppGalleryConnectPanel({ appId }: { appId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["agc-credentials", appId], queryFn: () => getAgcCredentials(appId) });
  const meta = query.data?.agc_credentials ?? null;
  const [editing, setEditing] = useState(false);
  const [credentialJson, setCredentialJson] = useState("");
  const save = useMutation({
    mutationFn: () => setAgcCredentials(appId, credentialJson),
    onSuccess: () => { setCredentialJson(""); setEditing(false); qc.invalidateQueries({ queryKey: ["agc-credentials", appId] }); toast.show({ kind: "success", title: "AppGallery Connect credential saved" }); },
    onError: (e) => toast.show({ kind: "error", title: "Save failed", description: (e as Error).message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteAgcCredentials(appId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["agc-credentials", appId] }); toast.show({ kind: "success", title: "AppGallery Connect credential removed" }); },
    onError: (e) => toast.show({ kind: "error", title: "Remove failed", description: (e as Error).message }),
  });
  const test = useMutation({
    mutationFn: () => verifyAgcCredentials(appId),
    onSuccess: (r) => toast.show(r.ok
      ? { kind: "success", title: "Connection OK", description: `${r.credential_kind === "service_account" ? "Service Account JWT signing" : "AGC token exchange"} succeeded; credential expires in ${Math.round((r.expires_in ?? 0) / 3600)} hours.` }
      : { kind: "error", title: "Verification failed", description: r.error ?? "Unknown AGC error" }),
    onError: (e) => toast.show({ kind: "error", title: "Test failed", description: (e as Error).message }),
  });
  const showForm = editing || (!meta && !query.isLoading);
  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">AppGallery Connect</div>
          <div className="text-xs text-slate-500">Service Account or legacy API client credential used for HarmonyOS testing and publishing. The uploaded JSON is encrypted and private material is never shown again.</div>
          {meta && <div className="mt-1 text-xs space-y-0.5">
            <div><span className="text-green-700 font-medium">Configured</span>{" · "}{meta.credential_kind}{" · updated "}{new Date(meta.updated_at).toISOString().slice(0, 10)}</div>
            {meta.credential_kind === "service_account" ? (
              <div className="font-mono break-all">Sub-account {meta.sub_account} · Key {meta.key_id} · Project {meta.project_id || "default"}</div>
            ) : (
              <div className="font-mono break-all">Developer {meta.developer_id} · Project {meta.project_id} · Client {meta.client_id}</div>
            )}
            <div className="font-mono">Region {meta.region || "default"} · Fingerprint {meta.credential_fingerprint.slice(0, 12)}…</div>
          </div>}
        </div>
        {meta && !editing && <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? "Testing…" : "Test connection"}</Button>
          <Button variant="outline" onClick={() => setEditing(true)}>Replace credential</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => { if (window.confirm("Remove the AppGallery Connect credential? Publishing stops until a new credential is saved.")) remove.mutate(); }}>{remove.isPending ? "…" : "Remove"}</Button>
        </div>}
      </div>
      {showForm && <div className="mt-3 p-3 border border-slate-200 rounded-md space-y-3">
        <label className="block text-xs font-medium">AGC Service Account private JSON</label>
        <input type="file" accept=".json,application/json" onChange={(e) => { const file = e.target.files?.[0]; if (file) file.text().then(setCredentialJson, () => toast.show({ kind: "error", title: "Could not read the credential file" })); }} />
        <div className="text-xs text-slate-500">Select the private JSON downloaded from AppGallery Connect. Service Account is recommended; legacy API client JSON remains supported during migration.</div>
        <div className="flex gap-2">
          <Button variant="primary" disabled={!credentialJson || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save credential"}</Button>
          {meta && <Button variant="outline" onClick={() => { setCredentialJson(""); setEditing(false); }}>Cancel</Button>}
        </div>
      </div>}
    </div>
  );
}

// --- App Store review status (read-only) ---------------------------------

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/** Map an appStoreState enum to a Badge variant + a human label. */
function appStoreStateBadge(state: string | null): {
  variant: BadgeVariant;
  label: string;
} {
  switch (state) {
    case "READY_FOR_SALE":
      return { variant: "success", label: "Ready for sale" };
    case "IN_REVIEW":
      return { variant: "information", label: "In review" };
    case "WAITING_FOR_REVIEW":
      return { variant: "warning", label: "Waiting for review" };
    case "PENDING_DEVELOPER_RELEASE":
      return { variant: "accent", label: "Pending developer release" };
    case "PENDING_APPLE_RELEASE":
      return { variant: "accent", label: "Pending Apple release" };
    case "PREPARE_FOR_SUBMISSION":
      return { variant: "muted", label: "Preparing" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    case "METADATA_REJECTED":
      return { variant: "danger", label: "Metadata rejected" };
    case "DEVELOPER_REJECTED":
      return { variant: "danger", label: "Developer rejected" };
    default:
      // Unknown/other states (e.g. PROCESSING_FOR_APP_STORE): show verbatim.
      return {
        variant: "muted",
        label: state ? state.replace(/_/g, " ").toLowerCase() : "Unknown",
      };
  }
}

/** Map a TestFlight betaReviewState to a Badge variant + label. */
function betaReviewStateBadge(state: string | null): {
  variant: BadgeVariant;
  label: string;
} {
  switch (state) {
    case "APPROVED":
      return { variant: "success", label: "Approved" };
    case "IN_REVIEW":
      return { variant: "information", label: "In review" };
    case "WAITING_FOR_REVIEW":
      return { variant: "warning", label: "Waiting for review" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    default:
      return { variant: "muted", label: "No beta review" };
  }
}

export function AppStoreReviewPanel({ appId }: { appId: string; app: App }) {
  // Non-iOS apps never render this panel — the parent guards on
  // app.platform === "ios" (mirrors the worker's applicable:false response).
  const review = useQuery({
    queryKey: ["appstore-review", appId],
    queryFn: () => getAppStoreReview(appId),
  });

  const data = review.data;
  const versions = data?.app_store_versions ?? [];
  const builds = data?.testflight_builds ?? [];
  const current = versions[0];
  const currentBadge = current ? appStoreStateBadge(current.appStoreState) : null;

  return (
    <div className="border-t border-slate-100 pt-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">App Store review status</div>
            {currentBadge && (
              <Badge variant={currentBadge.variant}>{currentBadge.label}</Badge>
            )}
          </div>
          <div className="text-xs text-slate-500">
            Live review state of this app's recent App Store versions and
            TestFlight builds, from App Store Connect. Read-only.
          </div>
        </div>
      </div>

      <div className="mt-3">
        {review.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : data?.configured === false ? (
          <EmptyState>
            <EmptyStateTitle>App Store Connect not configured</EmptyStateTitle>
            <EmptyStateDescription>
              Add ASC credentials in the TestFlight settings above to see review
              status.
            </EmptyStateDescription>
          </EmptyState>
        ) : data?.bundle_id === null ? (
          <EmptyState>
            <EmptyStateTitle>No App Store bundle ID configured</EmptyStateTitle>
            <EmptyStateDescription>
              Set the production App Store bundle ID on the{" "}
              <a
                href={`/apps/${appId}/channels`}
                className="underline font-medium"
              >
                main channel
              </a>{" "}
              (Channels tab). Only the main channel's bundle ID is used —
              preview/nightly channels are ignored, so their beta bundle IDs won't
              be picked up here.
            </EmptyStateDescription>
          </EmptyState>
        ) : data?.error ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Could not load review status from App Store Connect: {data.error}
            {data.bundle_id && (
              <div className="mt-1">
                Bundle ID{" "}
                <span className="font-mono">{data.bundle_id}</span> is set on the
                main channel. If it doesn't match your App Store app, update it in{" "}
                <a
                  href={`/apps/${appId}/channels`}
                  className="underline font-medium"
                >
                  Channels
                </a>
                .
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">
                Recent App Store versions
              </div>
              {versions.length === 0 ? (
                <div className="text-xs text-slate-400">
                  No App Store versions yet.
                </div>
              ) : (
                <ul className="space-y-1">
                  {versions.map((v, i) => {
                    const b = appStoreStateBadge(v.appStoreState);
                    return (
                      <li
                        key={`${v.versionString}-${i}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="font-mono">
                          {v.versionString ?? "—"}
                        </span>
                        <Badge variant={b.variant}>{b.label}</Badge>
                        {(v.appStoreState === "REJECTED" ||
                          v.appStoreState === "METADATA_REJECTED" ||
                          v.appStoreState === "DEVELOPER_REJECTED") && (
                          <span className="text-xs text-slate-400">
                            (see App Store Connect for the rejection details)
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <div className="text-xs font-medium text-slate-600 mb-1">
                Recent TestFlight builds — beta review
              </div>
              {builds.length === 0 ? (
                <div className="text-xs text-slate-400">
                  No builds on App Store Connect yet.
                </div>
              ) : (
                <ul className="space-y-1">
                  {builds.map((bld, i) => {
                    const b = betaReviewStateBadge(bld.betaReviewState);
                    return (
                      <li
                        key={`${bld.version}-${i}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="font-mono">{bld.version ?? "—"}</span>
                        <Badge variant={b.variant}>{b.label}</Badge>
                        {bld.processingState &&
                          bld.processingState !== "VALID" && (
                            <span className="text-xs text-slate-400">
                              {bld.processingState.toLowerCase()}
                            </span>
                          )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PublicHistoryToggle({ appId, app }: { appId: string; app: App }) {
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(app.public_history);
  const toggle = useMutation({
    mutationFn: () => updateAppPublicHistory(appId, !enabled),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !enabled ? "Public version history enabled" : "Public version history disabled",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Update failed",
        description: (e as Error).message,
      }),
  });
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">Public version history</div>
        <div className="text-xs text-slate-500">
          {enabled ? (
            <>
              Anyone can browse and download published versions at{" "}
              <a
                className="underline"
                href={`/apps/${app.slug}/history`}
                target="_blank"
                rel="noopener noreferrer"
              >
                /apps/{app.slug}/history
              </a>
              {" · latest landing: "}
              <a
                className="underline"
                href={`/apps/${app.slug}/latest`}
                target="_blank"
                rel="noopener noreferrer"
              >
                /apps/{app.slug}/latest
              </a>
              .
            </>
          ) : (
            "Expose a public page listing published versions with changelogs and downloads."
          )}
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={() => toggle.mutate()}
      />
    </div>
  );
}

function DeltaUpdatesToggle({ appId, app }: { appId: string; app: App }) {
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(app.delta_updates_enabled);
  const toggle = useMutation({
    mutationFn: () => updateAppDeltaUpdates(appId, !enabled),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: !enabled ? "Delta updates enabled" : "Delta updates disabled",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Update failed",
        description: (e as Error).message,
      }),
  });
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-medium">Delta updates</div>
        <div className="text-xs text-slate-500">
          {enabled
            ? "On publish, small differential patches are generated from recent versions so users download less to update."
            : "Auto-generate differential update patches when a release is published, shrinking update downloads for users on recent versions."}
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={toggle.isPending}
        onCheckedChange={() => toggle.mutate()}
      />
    </div>
  );
}

function AppIconUploader({ appId, slug }: { appId: string; slug: string }) {
  const toast = useToast();
  const [bust, setBust] = useState(0);
  const upload = useMutation({
    mutationFn: (file: File) => uploadAppIcon(appId, file),
    onSuccess: () => {
      toast.show({ kind: "success", title: "App icon updated" });
      setBust(Date.now());
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Icon upload failed",
        description: (e as Error).message,
      }),
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <img
        src={`${publicAppIconUrl(slug)}${bust ? `?v=${bust}` : ""}`}
        alt=""
        width={44}
        height={44}
        className="h-11 w-11 rounded-lg border border-slate-200 bg-slate-50 object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).style.visibility = "hidden";
        }}
        onLoad={(e) => {
          (e.target as HTMLImageElement).style.visibility = "visible";
        }}
      />
      <div className="min-w-0">
        <div className="text-sm font-medium">App icon</div>
        <div className="text-xs text-slate-500">
          Shown on share/download pages. PNG/WebP/JPEG, max 1MB.
        </div>
      </div>
      <label className="btn-secondary py-1! px-2! text-xs! ml-auto cursor-pointer">
        {upload.isPending ? "Uploading…" : "Upload"}
        <input
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.currentTarget.value = "";
          }}
        />
      </label>
    </div>
  );
}

export function AppSettings({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const orgRole = me.data?.account.org_role ?? null;
  const isOrgAdmin = orgRole === "owner" || orgRole === "admin";

  const [confirmArchive, setConfirmArchive] = useState(false);

  const [confirmPurge, setConfirmPurge] = useState(false);
  const purge = useMutation({
    mutationFn: () => purgeApp(appId, app?.slug ?? ""),
    onSuccess: (res) => {
      toast.show({
        kind: "success",
        title: `App purged (${res.r2_objects_deleted} stored files removed)`,
      });
      setConfirmPurge(false);
      qc.invalidateQueries({ queryKey: ["apps"] });
      window.location.assign("/apps");
    },
    onError: (e) =>
      toast.show({ kind: "error", title: "Purge failed", description: (e as Error).message }),
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveApp(appId, { archived }),
    onSuccess: (_, archived) => {
      toast.show({
        kind: "success",
        title: archived ? "App archived" : "App restored",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["builds", appId] });
      qc.invalidateQueries({ queryKey: ["releases", appId] });
      setConfirmArchive(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Archive failed",
        description: (e as Error).message,
      }),
  });

  if (!app) return null;

  return (
    <div>

      <div className="card p-4! text-sm space-y-3">
        <h2 className="text-base font-semibold">Settings</h2>

        {/* App name (slug is immutable) */}
        <AppNamePanel appId={appId} app={app} />

        {/* App description */}
        <AppDescriptionPanel appId={appId} app={app} />

        {/* App icon */}
        <AppIconUploader appId={appId} slug={app.slug} />

        {/* Public version history */}
        <PublicHistoryToggle appId={appId} app={app} />

        {/* Delta/differential updates — Android apps only */}
        {app.platform === "android" && <DeltaUpdatesToggle appId={appId} app={app} />}

        {/* Client key (feedback/crash reporting auth) */}
        <ClientKeyPanel appId={appId} />

        {/* Exact per-installation rollout groups */}
        <DeviceGroupsPanel appId={appId} />

        {/* TestFlight upload credentials — iOS apps only */}
        {app.platform === "ios" && <TestFlightPanel appId={appId} />}
        {app.platform === "ohos" && <AppGalleryConnectPanel appId={appId} />}

        {/* Default release channel picker */}
        <DefaultChannelPicker appId={appId} app={app} isOrgAdmin={isOrgAdmin} />

        {/* Danger zone: archive / restore */}
        <div className="border-t border-slate-100 pt-3">
          <h3 className="text-sm font-medium text-slate-700 mb-2">
            Danger zone
          </h3>
          {!isOrgAdmin && (
            <p className="text-xs text-yellow-700 mb-2">
              ⚠ Org owner / admin required to archive apps.
            </p>
          )}

          <div className="flex items-center justify-between gap-2 p-3 border border-slate-200 rounded-md">
            <div>
              <div className="font-medium">
                {app.archived ? "App is archived" : "App is active"}
              </div>
              <div className="text-xs text-slate-500">
                {app.archived
                  ? "Archived apps reject new uploads but remain restorable. " +
                    "Restore the app to resume normal operation."
                  : "Active apps accept uploads + releases normally."}
              </div>
              {app.archived_at && (
                <div className="text-xs text-slate-400 mt-1">
                  archived_at: {new Date(app.archived_at).toISOString()}
                </div>
              )}
            </div>
            {isOrgAdmin && (
              <div className="flex flex-col items-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setConfirmArchive(true)}
                  disabled={archive.isPending}
                >
                  {app.archived ? "Restore app" : "Archive app"}
                </Button>
                {Boolean(app.archived) && (
                  <Button
                    variant="danger"
                    disabled={purge.isPending}
                    onClick={() => setConfirmPurge(true)}
                  >
                    Purge permanently
                  </Button>
                )}
              </div>
            )}
          </div>

          <ConfirmActionDialog
            open={confirmPurge}
            title="Purge this app permanently?"
            objectLabel={app.name ?? app.slug ?? app.id}
            objectHint={`slug: ${app.slug}`}
            body={
              <>
                Deletes the app and <strong>everything it owns</strong> — builds,
                releases, share links, feedback tickets, and all stored files in
                R2. <strong>This cannot be undone.</strong>
              </>
            }
            confirmLabel="Purge permanently"
            confirmKind="danger"
            typeToConfirm={app.slug}
            pending={purge.isPending}
            onConfirm={() => purge.mutate()}
            onCancel={() => setConfirmPurge(false)}
          />

          <ConfirmActionDialog
            open={confirmArchive}
            title={app.archived ? "Restore this app?" : "Archive this app?"}
            objectLabel={app.name ?? app.slug ?? app.id}
            objectHint={`slug: ${app.slug}`}
            objectSummary={
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
                <div className="text-slate-500">id</div>
                <div>{app.id.slice(0, 8)}…</div>
                <div className="text-slate-500">slug</div>
                <div>{app.slug}</div>
                <div className="text-slate-500">status</div>
                <div>{app.archived ? "archived" : "active"}</div>
              </div>
            }
            body={
              app.archived ? (
                <>
                  Restoring returns the app to <strong>active</strong> status.{" "}
                  New uploads and releases will be accepted again.
                  <br />
                  <span className="text-xs text-slate-500">
                    Existing builds, releases, and assets are kept as-is.
                  </span>
                </>
              ) : (
                <>
                  Archiving marks the app as <strong>archived</strong>.
                  The app remains viewable in lists and admin pages, but{" "}
                  <strong>new uploads are rejected</strong>.
                  <br />
                  <span className="text-xs text-slate-500">
                    This is reversible: builds,
                    releases, and assets are kept as-is. The underlying binary
                    data in R2 is not removed.
                  </span>
                </>
              )
            }
            confirmLabel={app.archived ? "Restore app" : "Archive app"}
            cancelLabel={app.archived ? "Keep archived" : "Keep app"}
            confirmKind={app.archived ? "primary" : "danger"}
            pending={archive.isPending}
            onCancel={() => setConfirmArchive(false)}
            onConfirm={() => {
              archive.mutate(!app.archived);
              setConfirmArchive(false);
            }}
          />
          <p className="text-xs text-slate-500 mt-2">
            Future: signing credential binding, custom domains, app
            ownership transfer.
          </p>
        </div>
      </div>
    </div>
  );
}

function DefaultChannelPicker({
  appId,
  app,
  isOrgAdmin,
}: {
  appId: string;
  app:
    | (App & {
        default_channel_id?: string | null;
        default_channel_slug?: string | null;
        default_channel_name?: string | null;
      })
    | undefined;
  isOrgAdmin: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const [selected, setSelected] = useState<string | null>(
    app?.default_channel_id ?? null,
  );
  useEffect(() => {
    setSelected(app?.default_channel_id ?? null);
  }, [app?.default_channel_id]);

  const save = useMutation({
    mutationFn: () => updateApp(appId, { default_channel_id: selected }),
    onSuccess: () => {
      toast.show({
        kind: "success",
        title: selected
          ? "Default release channel updated"
          : "Default channel cleared (will fall back to first channel)",
      });
      qc.invalidateQueries({ queryKey: ["apps"] });
      qc.invalidateQueries({ queryKey: ["app-detail", appId] });
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Save failed",
        description: (e as Error).message,
      }),
  });

  const dirty = selected !== (app?.default_channel_id ?? null);

  return (
    <div className="border-t border-slate-100 pt-3">
      <h3 className="text-sm font-medium text-slate-700 mb-2">
        Default release channel
      </h3>
      <p className="text-xs text-slate-500 mb-2">
        Pre-fills the channel dropdown in the New Release dialog. Falls
        back to the first channel (by created_at) if unset.
      </p>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <Select
          items={{
            "": "— none (use first channel) —",
            ...Object.fromEntries(
              (channels.data?.channels ?? []).map((c: Channel) => [
                c.id,
                `${c.slug} (${c.name})`,
              ]),
            ),
          }}
          value={selected ?? ""}
          onValueChange={(v) => setSelected((v as string) || null)}
          disabled={!isOrgAdmin || save.isPending}
        >
          <SelectTrigger className="text-sm flex-1">
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none (use first channel) —</SelectItem>
            {channels.data?.channels.map((c: Channel) => (
              <SelectItem key={c.id} value={c.id}>
                {c.slug} ({c.name})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isOrgAdmin && (
          <Button
            className="btn-primary text-xs"
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {!isOrgAdmin && (
        <p className="text-xs text-yellow-700 mt-2">
          ⚠ Org owner / admin required to change settings.
        </p>
      )}
    </div>
  );
}

function CreateChannelDialog({
  appId,
  onClose,
  onCreated,
}: {
  appId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [slug, setSlug] = useState("main");
  const [name, setName] = useState("Main");
  const [bundleId, setBundleId] = useState("");
  const toast = useToast();

  const create = useMutation({
    mutationFn: () =>
      createChannel(appId, {
        slug,
        name,
        bundle_id: bundleId.trim() || undefined,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Channel '${slug}' created` });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Failed to create channel",
        description: (e as Error).message,
      }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New channel</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id="create-channel-form"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="space-y-3"
          >
            <div>
              <label className="label">Slug</label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Bundle ID override (optional)</label>
              <Input
                className="font-mono text-xs"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder="com.example.myapp.beta"
              />
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-channel-form"
            className="btn-primary"
            disabled={create.isPending}
          >
            {create.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelRow({
  channel: c,
  onEdit,
  busy,
}: {
  channel: Channel;
  onEdit: () => void;
  busy: boolean;
}) {
  return (
    <div className="card p-3! flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{c.name}</span>
          <span className="text-xs font-mono text-slate-500">{c.slug}</span>
          {c.bundle_id && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="badge-blue text-xs font-mono">
                    {c.bundle_id}
                  </span>
                }
              />
              <TooltipContent>Bundle ID override</TooltipContent>
            </Tooltip>
          )}
          {c.password && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="badge-orange text-xs">🔒 gated</span>
                }
              />
              <TooltipContent>Downloads require password</TooltipContent>
            </Tooltip>
          )}
          {c.git_url && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    className="text-xs text-blue-600 hover:underline font-mono truncate max-w-xs"
                    href={c.git_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.git_url}
                  </a>
                }
              />
              <TooltipContent>{c.git_url}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onEdit}
        disabled={busy}
      >
        Edit
      </Button>
    </div>
  );
}

function EditChannelDialog({
  appId,
  app,
  channel,
  onClose,
  onSaved,
}: {
  appId: string;
  app:
    | (App & {
        default_channel_id?: string | null;
        default_channel_slug?: string | null;
        default_channel_name?: string | null;
      })
    | null
    | undefined;
  channel: Channel;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(channel.name);
  const [bundleId, setBundleId] = useState(channel.bundle_id ?? "");
  const [password, setPassword] = useState(channel.password ?? "");
  const [gitUrl, setGitUrl] = useState(channel.git_url ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState("");

  const save = useMutation({
    mutationFn: () =>
      updateChannel(appId, channel.id, {
        name,
        bundle_id: bundleId.trim() || null,
        password: password.trim() || null,
        git_url: gitUrl.trim() || null,
      }),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Channel '${channel.slug}' saved` });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Save failed",
        description: (e as Error).message,
      }),
  });

  const remove = useMutation({
    mutationFn: () => deleteChannel(appId, channel.id),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Channel '${channel.slug}' deleted` });
      onSaved();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Delete failed",
        description: (e as Error).message,
      }),
  });

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
      >
        {/* z-10 keeps this dialog below the nested delete-confirm (z-20),
            matching the original hand-rolled stacking. */}
        <DialogContent className="max-w-md z-10" overlay={{ className: "z-10" }}>
          <DialogHeader>
            <DialogTitle>Edit channel '{channel.slug}'</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <form
              id="edit-channel-form"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
              className="space-y-3"
            >
              <div>
                <label className="label">Slug (immutable)</label>
                <Input
                  className="font-mono text-xs bg-slate-50"
                  value={channel.slug}
                  readOnly
                />
              </div>
              <div>
                <label className="label">Name</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="label">Bundle ID override</label>
                <Input
                  className="font-mono text-xs"
                  value={bundleId}
                  onChange={(e) => setBundleId(e.target.value)}
                  placeholder="com.example.myapp.beta"
                />
              </div>
              <div>
                <label className="label">Download password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="leave blank for no gate"
                />
              </div>
              <div>
                <label className="label">Git URL</label>
                <Input
                  className="font-mono text-xs"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/foo/bar/tree/beta"
                />
              </div>
            </form>
          </DialogBody>
          <DialogFooter className="justify-between">
            <Button
              type="button"
              className="text-red-600 text-sm hover:underline"
              onClick={() => setConfirmDelete(true)}
              disabled={save.isPending || remove.isPending}
            >
              Delete channel
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                className="btn-secondary"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="edit-channel-form"
                className="btn-primary"
                disabled={save.isPending}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Channel delete confirmation (typed-confirm + default-channel warning) */}
      <ConfirmActionDialog
        open={confirmDelete}
        title="Delete channel?"
        objectLabel={channel.slug}
        objectHint={`id: ${channel.id.slice(0, 8)}…`}
        objectSummary={
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono">
            <div className="text-slate-500">slug</div>
            <div>{channel.slug}</div>
            <div className="text-slate-500">name</div>
            <div>{channel.name}</div>
            <div className="text-slate-500">bundle_id</div>
            <div>{channel.bundle_id ?? "—"}</div>
          </div>
        }
        body={
          <>
            Deleting this channel removes it from this app.{" "}
            <strong>
              All releases pointing at this channel must be cancelled or moved
              first
            </strong>{" "}
            — otherwise the public API will start 404'ing your clients.
            {app?.default_channel_id === channel.id && (
              <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded-sm text-xs text-yellow-900">
                ⚠ This is the app's <strong>default release channel</strong>.
                After deletion, the New Release wizard will fall back to the
                first channel by created_at.
              </div>
            )}
            <TypedConfirmField
              required={channel.slug}
              value={typedConfirm}
              onChange={setTypedConfirm}
            />
          </>
        }
        confirmLabel="Delete channel"
        cancelLabel="Keep channel"
        confirmKind="danger"
        confirmDisabled={typedConfirm !== channel.slug}
        pending={remove.isPending}
        onCancel={() => {
          setConfirmDelete(false);
          setTypedConfirm("");
        }}
        onConfirm={() => {
          remove.mutate();
          setConfirmDelete(false);
          setTypedConfirm("");
        }}
      />
    </>
  );
}
