import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Play } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import {
  deleteGooglePlayBinding,
  getGooglePlayBinding,
  listBuilds,
  listChannels,
  setGooglePlayBinding,
  setGooglePlayBindingEnabled,
  startGooglePlayOAuth,
  verifyGooglePlayBinding,
} from "../../lib/api";
import { googlePlayPackageOptions } from "../../lib/googlePlayPackages";
import { googlePlayMessage as gp } from "../../lib/googlePlayMessages";
import { useToast } from "../Toast";

export function GooglePlayConnector({ appId }: { appId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["google-play-binding", appId], queryFn: () => getGooglePlayBinding(appId) });
  const meta = query.data?.google_play ?? null;
  const [editing, setEditing] = useState(false);
  const [credentialJson, setCredentialJson] = useState("");
  const [connectionMethod, setConnectionMethod] = useState<"google" | "service">("google");
  const packageChannels = useQuery({ queryKey: ["channels", appId], queryFn: () => listChannels(appId) });
  const packageBuilds = useQuery({ queryKey: ["builds", appId], queryFn: () => listBuilds(appId) });
  const packageOptions = googlePlayPackageOptions(packageChannels.data?.channels ?? [], packageBuilds.data?.builds ?? []);
  const mainPackages = packageOptions.filter((option) => option.isMain);
  const suggestedPackage = mainPackages.length === 1 ? mainPackages[0]!.packageName : "";
  const [packageName, setPackageName] = useState("");
  const [internalTrack, setInternalTrack] = useState("internal");
  const [closedTrack, setClosedTrack] = useState("closed");
  const [productionTrack, setProductionTrack] = useState("production");

  useEffect(() => {
    if (!meta || editing) return;
    setPackageName(meta.package_name);
    setInternalTrack(meta.internal_track);
    setClosedTrack(meta.closed_track);
    setProductionTrack(meta.production_track);
  }, [meta, editing]);

  useEffect(() => {
    if (!meta && suggestedPackage) setPackageName((current) => current || suggestedPackage);
  }, [meta, suggestedPackage]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["google-play-binding", appId] });
  const fail = (error: unknown) => toast.show({ kind: "error", title: gp("actionFailed"), description: (error as Error).message });
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("google_play_oauth");
    if (!result || query.isLoading) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("google_play_oauth");
    window.history.replaceState(null, "", url);
    if (result === "connected" && meta?.credential_kind === "authorized_user") {
      toast.show({ kind: "success", title: gp("saveSuccess") });
    } else if (result === "failed" || result === "cancelled") {
      toast.show({ kind: "error", title: gp(result === "failed" ? "oauthFailed" : "oauthCancelled") });
    }
  }, [query.isLoading, meta, toast]);

  const authorize = useMutation({
    mutationFn: () => startGooglePlayOAuth(appId, {
      package_name: packageName.trim(),
      tracks: { internal: internalTrack.trim(), closed: closedTrack.trim(), production: productionTrack.trim() },
    }),
    onSuccess: ({ authorization_url }) => {
      const url = new URL(authorization_url);
      if (url.origin !== "https://accounts.google.com") { fail(new Error(gp("oauthFailed"))); return; }
      window.location.assign(url.toString());
    },
    onError: fail,
  });
  const save = useMutation({
    mutationFn: () => setGooglePlayBinding(appId, {
      service_account_json: credentialJson,
      package_name: packageName.trim(),
      tracks: { internal: internalTrack.trim(), closed: closedTrack.trim(), production: productionTrack.trim() },
    }),
    onSuccess: () => {
      setCredentialJson("");
      setEditing(false);
      refresh();
      toast.show({ kind: "success", title: gp("saveSuccess") });
    },
    onError: fail,
  });
  const verify = useMutation({
    mutationFn: () => verifyGooglePlayBinding(appId),
    onSuccess: () => { toast.show({ kind: "success", title: gp("verifySuccess") }); },
    onError: fail,
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setGooglePlayBindingEnabled(appId, enabled),
    onSuccess: (_, enabled) => {
      toast.show({ kind: "success", title: gp(enabled ? "enableSuccess" : "disableSuccess") });
    },
    onError: fail,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteGooglePlayBinding(appId),
    onSuccess: () => {
      setEditing(false);
      setCredentialJson("");
      setPackageName("");
      refresh();
      toast.show({ kind: "success", title: gp("unbindSuccess") });
    },
    onError: fail,
  });

  let credentialLooksValid = false;
  try {
    const parsed = JSON.parse(credentialJson) as Record<string, unknown>;
    credentialLooksValid = parsed.type === "service_account" && typeof parsed.client_email === "string" && typeof parsed.private_key === "string";
  } catch {
    credentialLooksValid = false;
  }
  const formValid = Boolean(
    credentialLooksValid
    && packageName.trim()
    && internalTrack.trim()
    && closedTrack.trim()
    && productionTrack.trim(),
  );
  const showForm = editing || (!meta && !query.isLoading);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? !meta;
  const tracksComplete = Boolean(
    packageName.trim() && internalTrack.trim() && closedTrack.trim() && productionTrack.trim(),
  );

  const startConnect = () => {
    setUserExpanded(true);
    if (query.data?.oauth_available && tracksComplete) {
      authorize.mutate();
    }
  };

  return (
    <Card data-testid="google-play-binding-panel">
      <div className="flex items-start gap-3 p-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line-muted bg-layer-inset text-foreground-muted">
          <Play className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-semibold text-foreground-strong">{gp("title")}</div>
          <div className="text-xs text-foreground-muted">{gp("description")}</div>
          {meta ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
              <Badge variant={meta.enabled ? "success" : "muted"}>{gp(meta.enabled ? "enabled" : "disabled")}</Badge>
              <Badge variant={meta.verification_state === "verified" ? "muted" : "warning"}>
                {gp(meta.verification_state === "verified" ? "verified" : "stale")}
              </Badge>
              <span className="min-w-0 truncate font-mono">{meta.package_name}</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!meta ? (
            <Button
              variant="primary"
              disabled={query.isLoading || authorize.isPending}
              onClick={startConnect}
            >
              {gp(authorize.isPending ? "testing" : "connect")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="icon-sm"
              aria-expanded={expanded}
              aria-label={gp(expanded ? "collapse" : "expand")}
              onClick={() => setUserExpanded(!expanded)}
            >
              <ChevronDown
                className={`size-4 transition-transform${expanded ? " rotate-180" : ""}`}
                aria-hidden="true"
              />
            </Button>
          )}
        </div>
      </div>
      {expanded ? (
        <div className="space-y-3 border-t border-line-hairline p-4">
          {meta ? (
            <div className="space-y-0.5 text-xs text-foreground-muted">
              <div className="break-all font-mono">
                {gp(meta.credential_kind === "authorized_user" ? "authorizedAccount" : "serviceAccount")}: {meta.service_account_email}
              </div>
              <div className="font-mono">{meta.internal_track} · {meta.closed_track} · {meta.production_track}</div>
            </div>
          ) : null}
          {meta && !editing && <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>
              {verify.isPending ? gp("testing") : gp("test")}
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)}>{gp("replace")}</Button>
            <Button
              variant="outline"
              disabled={toggle.isPending}
              onClick={() => {
                if (meta.enabled && !window.confirm(gp("confirmDisable"))) return;
                toggle.mutate(!meta.enabled);
              }}
            >
              {gp(meta.enabled ? "disable" : "enable")}
            </Button>
            <Button variant="danger" disabled={remove.isPending} onClick={() => {
              if (window.confirm(gp("confirmUnbind"))) remove.mutate();
            }}>{gp("unbind")}</Button>
          </div>}
          {meta?.credential_kind === "authorized_user" && <p className="text-xs text-foreground-muted">{gp("disconnectHelp")}{" "}
            <a className="text-info-strong hover:underline" href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">{gp("authorizedAccount")}</a>
          </p>}
          {showForm && <div className="space-y-3 rounded-md border border-line-muted p-3">
            <div className="flex gap-2">
              <Button variant={connectionMethod === "google" ? "primary" : "outline"} onClick={() => { setConnectionMethod("google"); setCredentialJson(""); }}>{gp("googleMethod")}</Button>
              <Button variant={connectionMethod === "service" ? "primary" : "outline"} onClick={() => setConnectionMethod("service")}>{gp("serviceAccount")}</Button>
            </div>
            <p className="text-xs text-foreground">{gp(connectionMethod === "google" ? "oauthHelp" : "formHelp")}</p>
            {!packageName.trim() && <p className="text-xs text-foreground-muted">{gp("packageMissing")}</p>}
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                {packageOptions.length > 0 && <>
                  <div className="text-xs text-foreground">{gp("packageName")}</div>
                  <Select items={Object.fromEntries([...packageOptions.map((option) => [option.packageName, `${option.packageName} · ${gp(option.source)}`]), ["__manual__", gp("manualPackage")]])}
                    value={packageOptions.some((option) => option.packageName === packageName) ? packageName : "__manual__"}
                    onValueChange={(value) => setPackageName(value === "__manual__" ? "" : String(value))}>
                    <SelectTrigger className="mt-1 w-full" aria-label={gp("existingPackage")}><SelectValue /><SelectIcon /></SelectTrigger>
                    <SelectContent>
                      {packageOptions.map((option) => <SelectItem key={option.packageName} value={option.packageName}>{option.packageName} · {gp(option.source)}</SelectItem>)}
                      <SelectItem value="__manual__">{gp("manualPackage")}</SelectItem>
                    </SelectContent>
                  </Select>
                </>}
                {!packageOptions.some((option) => option.packageName === packageName) && <label className="text-xs text-foreground">{gp("manualPackage")}
                  <Input aria-label={gp("packageName")} className="mt-1 font-mono" value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="com.example.app" />
                </label>}
              </div>
              <label className="text-xs text-foreground">{gp("internalTrack")}
                <Input className="mt-1 font-mono" value={internalTrack} onChange={(event) => setInternalTrack(event.target.value)} />
              </label>
              <label className="text-xs text-foreground">{gp("closedTrack")}
                <Input className="mt-1 font-mono" value={closedTrack} onChange={(event) => setClosedTrack(event.target.value)} />
              </label>
              <label className="text-xs text-foreground">{gp("productionTrack")}
                <Input className="mt-1 font-mono" value={productionTrack} onChange={(event) => setProductionTrack(event.target.value)} />
              </label>
            </div>
            {connectionMethod === "google" && <>
            <Button variant="primary" disabled={!query.data?.oauth_available || !tracksComplete || authorize.isPending} onClick={() => authorize.mutate()}>{gp("authorize")}</Button>
            {!query.data?.oauth_available && <p className="text-xs text-foreground-muted">{gp("oauthUnavailable")}</p>}
            </>}
            {connectionMethod === "service" && <>
            <label className="block text-xs font-medium">{gp("credentialJson")}</label>
            <input type="file" accept=".json,application/json" aria-label={gp("chooseFile")} onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) file.text().then(setCredentialJson, fail);
            }} />
            {credentialJson && !credentialLooksValid && <p className="text-xs text-warning">{gp("invalidJson")}</p>}
            </>}
            <p className="text-xs text-foreground-muted">{gp("noPublish")}</p>
            <div className="flex justify-end gap-2">
              {meta && <Button variant="outline" onClick={() => { setCredentialJson(""); setEditing(false); }}>{gp("cancel")}</Button>}
              {connectionMethod === "service" && <Button variant="primary" disabled={!formValid || save.isPending} onClick={() => save.mutate()}>{gp("saveEnable")}</Button>}
            </div>
          </div>}
        </div>
      ) : null}
    </Card>
  );
}
