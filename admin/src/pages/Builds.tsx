/**
 * Builds tab — list of build artifacts for an app.
 *
 * Wires the new /api/apps/:appId/builds + /builds/:id/assets endpoints.
 * Shows: status badge, product_type, version, changelog, asset matrix,
 * "Prepare release" button (becomes active when status=succeeded).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAgcBuildSubmission,
  getAgcSubmission,
  getBuildAssetDownloadUrl,
  getBuild,
  listBuildAssets,
  listBuilds,
  listChannels,
  listProductTypes,
  startAgcInvitationTest,
  submitAgcInvitationTest,
  uploadBuildToTestflight,
  getTestflightUploadStatus,
  type Build,
  type BuildAsset,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { useText } from "../lib/locale";
import { Package } from "lucide-react";
import {
  Badge,
  Button,
  Input,
  Label,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  RadioGroup,
  RadioGroupItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogClose,
  EmptyState,
  EmptyStateContent,
  EmptyStateIcon,
  EmptyStateTitle,
  Skeleton,
} from "raft-ui";
import type { BadgeProps } from "raft-ui";

export function Builds({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();
  const toast = useToast();

  const app = useQuery({ queryKey: ["apps"], queryFn: () => import("../lib/api").then((m) => m.listApps()) });
  const builds = useQuery({
    queryKey: ["builds", appId],
    queryFn: () => listBuilds(appId),
  });
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });

  const thisApp = app.data?.apps.find((a) => a.id === appId);
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);
  const [prepareBuild, setPrepareBuild] = useState<Build | null>(null);

  return (
    <div>
      <div className="mb-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t("Builds", "构建")}</h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="primary"
                  className="text-sm"
                  render={<a href={`/apps/${appId}/releases`} />}
                >
                  {t("+ New release", "+ 新建版本")}
                </Button>
              }
            />
            <TooltipContent>
              {!channels.data?.channels.length
                ? t("Create a channel first", "请先创建渠道")
                : t("Create a release + attach APK assets", "创建版本并附加 APK 文件")}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {builds.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {builds.error && (
        <p className="text-danger">{t("Failed:", "加载失败：")} {(builds.error as Error).message}</p>
      )}

      {builds.data && builds.data.builds.length === 0 && !builds.isLoading && (
        <EmptyState>
          <EmptyStateContent>
          <EmptyStateIcon>
            <Package aria-hidden="true" />
          </EmptyStateIcon>
          <EmptyStateTitle>
            {t("No builds yet. Create a release from the Releases tab to upload assets.", "暂无构建。请在“版本”页面创建版本并上传文件。")}
          </EmptyStateTitle>
          </EmptyStateContent>
        </EmptyState>
      )}

      <div className="space-y-6">
        {builds.data?.builds.map((b) => {
          const channel = channels.data?.channels.find((c) => c.id === b.channel_id);
          const pt = productTypes.data?.product_types.find((p) => p.name === b.product_type);
          const isExpanded = expandedBuildId === b.id;
          return (
            <section key={b.id} className="border-t border-line-hairline pt-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono font-medium">
                  v{b.version_name} ({b.version_code})
                </span>
                <Badge variant="muted">{b.product_type}</Badge>
                {channel && <Badge variant="information">{channel.slug}</Badge>}
                <BuildStatusBadge status={b.status} />
                {b.should_force_update ? (
                  <Badge variant="warning">{t("⚠ force", "⚠ 强制更新")}</Badge>
                ) : null}
                {b.availability_at && b.availability_at > Date.now() ? (
                  <Badge variant="information">
                    {t(`scheduled ${new Date(b.availability_at).toISOString().slice(0, 16)}Z`, `计划于 ${new Date(b.availability_at).toISOString().slice(0, 16)}Z 生效`)}
                  </Badge>
                ) : null}
                <span className="text-xs text-foreground-muted ml-auto">
                  {new Date(b.created_at).toISOString().slice(0, 16)}Z
                </span>
              </div>
              {b.changelog && (
                <details className="text-xs text-foreground mt-1">
                  <summary className="cursor-pointer hover:text-foreground-strong">
                    {(b.changelog.split("\n")[0] ?? "").slice(0, 80)}
                    {b.changelog.split("\n").length > 1 ? "…" : ""}
                  </summary>
                  <pre className="mt-1 pl-2 border-l-2 border-line-hairline font-mono whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">
                    {b.changelog}
                  </pre>
                </details>
              )}
              <div className="flex gap-2 mt-2">
                <Button
                  variant="outline"
                  className="text-xs"
                  onClick={() => setExpandedBuildId(isExpanded ? null : b.id)}
                >
                  {isExpanded ? t("Hide assets", "隐藏文件") : t("Show assets", "查看文件")}
                </Button>
                {b.status === "succeeded" && (
                  <Button
                    variant="primary"
                    className="text-xs"
                    onClick={() => setPrepareBuild(b)}
                  >
                    {t("Prepare release", "准备版本")}
                  </Button>
                )}
              </div>
              {b.product_type === "ios-ipa" && (
                <TestflightUploadPanel appId={appId} build={b} />
              )}
              {b.product_type === "ohos-app" && (
                <AgcTestingPanel appId={appId} build={b} packageName={channel?.bundle_id ?? null} />
              )}
              {isExpanded && <BuildAssetList appId={appId} buildId={b.id} />}
            </section>
          );
        })}
      </div>

      {prepareBuild && (
        <PrepareReleaseDialog
          build={prepareBuild}
          onClose={() => setPrepareBuild(null)}
          onCreated={() => {
            setPrepareBuild(null);
            qc.invalidateQueries({ queryKey: ["releases", appId] });
            qc.invalidateQueries({ queryKey: ["builds", appId] });
          }}
        />
      )}
    </div>
  );
}

function AgcTestingPanel({ appId, build, packageName }: { appId: string; build: Build; packageName: string | null }) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  const existing = useQuery({
    queryKey: ["agc-build-submission", appId, build.id],
    queryFn: () => getAgcBuildSubmission(appId, build.id),
  });
  const upload = useMutation({
    mutationFn: () => startAgcInvitationTest(appId, build.id, packageName!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agc-build-submission", appId, build.id] });
      toast.show({ kind: "success", title: t("Build uploaded to AppGallery", "构建已上传到 AppGallery"), description: t("Huawei is compiling the App Pack. Testing has not been submitted.", "华为正在编译 App Pack，尚未提交测试。") });
    },
    onError: (e) => toast.show({ kind: "error", title: t("AppGallery upload failed", "上传到 AppGallery 失败"), description: (e as Error).message }),
  });
  const submissionId = upload.data?.submission_id ?? upload.data?.submission?.id ?? existing.data?.submission?.id ?? null;
  const status = useQuery({
    queryKey: ["agc-submission", appId, submissionId],
    queryFn: () => getAgcSubmission(appId, submissionId!),
    enabled: submissionId != null,
    refetchInterval: (q) => {
      const state = q.state.data?.submission.state;
      return state === "uploading" || state === "processing" ? 5000 : false;
    },
  });
  const submission = status.data?.submission ?? upload.data?.submission ?? existing.data?.submission ?? null;
  const submit = useMutation({
    mutationFn: () => submitAgcInvitationTest(appId, submission!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agc-submission", appId, submission?.id] });
      qc.invalidateQueries({ queryKey: ["agc-build-submission", appId, build.id] });
      toast.show({ kind: "success", title: t("Submitted to invitation testing", "已提交邀请测试") });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Review submission failed", "提交审核失败"), description: (e as Error).message }),
  });
  const state = submission?.state;
  const stateClass = state === "failed" || state === "rejected" ? "text-danger" : state === "stopped" ? "text-foreground-muted" : state === "ready" || state === "testing_review" || state === "testing_scheduled" || state === "testing_active" ? "text-success-strong" : "text-info-strong";
  const auditOpinion = typeof submission?.provider_state?.audit_opinion === "string" ? submission.provider_state.audit_opinion : null;

  return (
    <div className="mt-2 pt-2 border-t border-line-hairline">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Badge variant="muted">AppGallery</Badge>
        {!submission || state === "failed" || state === "rejected" || state === "stopped" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  className="py-1! px-2! text-xs!"
                  disabled={upload.isPending || build.status !== "succeeded" || !packageName}
                  onClick={() => upload.mutate()}
                >
                  {upload.isPending ? t("Uploading build…", "正在上传构建…") : state === "failed" || state === "rejected" || state === "stopped" ? t("Upload again", "重新上传") : t("Upload build to AppGallery", "上传构建到 AppGallery")}
                </Button>
              }
            />
            <TooltipContent>
              {!packageName ? t("Set the channel bundle ID first", "请先设置渠道的 Bundle ID") : build.status !== "succeeded" ? t("Build must be succeeded", "构建必须成功") : t("Upload the signed .app and wait for Huawei build processing", "上传已签名的 .app 并等待华为处理构建")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {state === "ready" && (
          <Button
            variant="primary"
            className="py-1! px-2! text-xs!"
            disabled={submit.isPending}
            onClick={() => {
              if (window.confirm(t("Submit this uploaded build to AppGallery invitation testing?", "将此已上传构建提交到 AppGallery 邀请测试？"))) submit.mutate();
            }}
          >
            {submit.isPending ? t("Submitting…", "提交中…") : t("Submit to invitation testing", "提交邀请测试")}
          </Button>
        )}
        {state && <span className={`font-medium ${stateClass}`}>{state === "processing" ? t("Huawei processing build…", "华为正在处理构建…") : state === "ready" ? t("Build uploaded", "构建已上传") : t(state.replaceAll("_", " "), ({ uploading: "上传中", failed: "失败", rejected: "已拒绝", stopped: "已停止", testing_review: "测试审核中", testing_scheduled: "测试已安排", testing_active: "测试中" } as Record<string, string>)[state] ?? state)}</span>}
      </div>
      {submission?.error_message && <p className="mt-1 text-xs text-danger">{submission.error_message}</p>}
      {state === "ready" && <p className="mt-1 text-xs text-foreground-muted">{t("Build compiled and ready. Invitation testing has not been submitted.", "构建已编译完成，尚未提交邀请测试。")}</p>}
      {state === "testing_review" && <p className="mt-1 text-xs text-success-strong">{t("Submitted to AppGallery invitation testing review. Status refreshes from Huawei each time this panel loads.", "已提交 AppGallery 邀请测试审核。每次加载此面板时都会从华为刷新状态。")}</p>}
      {state === "testing_scheduled" && <p className="mt-1 text-xs text-success-strong">{t("Approved; invitation testing starts at the scheduled time.", "已批准；邀请测试将在计划时间开始。")}</p>}
      {state === "testing_active" && <p className="mt-1 text-xs text-success-strong">{t("Invitation testing is live for the selected test group.", "所选测试组的邀请测试已开始。")}</p>}
      {state === "rejected" && <p className="mt-1 text-xs text-danger">{t("Huawei rejected the test version", "华为拒绝了测试版本")}{auditOpinion ? `: ${auditOpinion}` : t(".", "。")}</p>}
      {state === "stopped" && <p className="mt-1 text-xs text-foreground-muted">{t("Invitation testing has ended on Huawei's side.", "华为侧的邀请测试已结束。")}</p>}
      {status.data?.sync_error && <p className="mt-1 text-xs text-warning">{t("Could not refresh from Huawei:", "无法从华为刷新：")} {status.data.sync_error}</p>}
    </div>
  );
}

function TestflightUploadPanel({ appId, build }: { appId: string; build: Build }) {
  const t = useText();
  const toast = useToast();
  const [buildUploadId, setBuildUploadId] = useState<string | null>(null);
  const [ascAppId, setAscAppId] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: () => uploadBuildToTestflight(appId, build.id),
    onSuccess: (res) => {
      if (res.ok && res.build_upload_id) {
        setBuildUploadId(res.build_upload_id);
        if (res.asc_app_id) setAscAppId(res.asc_app_id);
        toast.show({ kind: "success", title: t("Uploaded to Apple — processing", "已上传到 Apple，正在处理") });
      } else {
        toast.show({
          kind: "error",
          title: t("Upload rejected", "上传被拒绝"),
          description: res.error ?? res.detail ?? t("unknown error", "未知错误"),
        });
      }
    },
    onError: (e) =>
      toast.show({ kind: "error", title: t("Upload failed", "上传失败"), description: (e as Error).message }),
  });

  const status = useQuery({
    queryKey: ["testflight-status", appId, buildUploadId],
    queryFn: () => getTestflightUploadStatus(appId, buildUploadId!),
    enabled: buildUploadId != null,
    refetchInterval: (q) => {
      const s = q.state.data?.state?.state;
      return s === "COMPLETE" || s === "FAILED" ? false : 5000;
    },
  });

  const state = status.data?.state;
  const stateName = state?.state;
  const stateColor =
    stateName === "COMPLETE"
      ? "text-success-strong"
      : stateName === "FAILED"
        ? "text-danger"
        : "text-info-strong";

  return (
    <div className="mt-2 pt-2 border-t border-line-hairline">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Badge variant="muted"> TestFlight</Badge>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                className="py-1! px-2! text-xs!"
                disabled={upload.isPending || build.status !== "succeeded"}
                onClick={() => upload.mutate()}
              >
                {upload.isPending ? t("Uploading…", "上传中…") : t("Upload to TestFlight", "上传到 TestFlight")}
              </Button>
            }
          />
          <TooltipContent>
            {build.status !== "succeeded"
              ? t("Build must be succeeded", "构建必须成功")
              : t("Upload this IPA to App Store Connect / TestFlight", "将此 IPA 上传到 App Store Connect / TestFlight")}
          </TooltipContent>
        </Tooltip>
        <Button
          variant="outline"
          className="py-1! px-2! text-xs!"
          render={
            <a
              href={
                ascAppId
                  ? `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/ios`
                  : "https://appstoreconnect.apple.com/apps"
              }
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          {t("Open in App Store Connect ↗", "在 App Store Connect 中打开 ↗")}
        </Button>
        {stateName && (
          <span className={`font-medium ${stateColor}`}>
            {stateName === "PROCESSING" || stateName === "AWAITING_UPLOAD"
              ? t("Apple processing…", "Apple 处理中…")
              : t(stateName, stateName === "COMPLETE" ? "已完成" : stateName === "FAILED" ? "失败" : stateName)}
          </span>
        )}
      </div>
      {state?.errors && state.errors.length > 0 && (
        <ul className="mt-1 text-xs text-danger list-disc pl-5">
          {state.errors.map((e, i) => (
            <li key={i}>
              {e.code ? `[${e.code}] ` : ""}
              {e.description}
            </li>
          ))}
        </ul>
      )}
      {stateName === "COMPLETE" && (
        <p className="mt-1 text-xs text-success-strong">
          {t("Upload processed. Ready for TestFlight group distribution.", "上传已处理完成，可以分发到 TestFlight 测试组。")}
        </p>
      )}
    </div>
  );
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

function BuildStatusBadge({ status }: { status: string }) {
  const t = useText();
  const variantMap: Record<string, BadgeVariant> = {
    pending: "muted",
    building: "information",
    succeeded: "success",
    failed: "danger",
    smoke_testing: "warning",
    smoke_test_passed: "success",
    smoke_test_failed: "danger",
  };
  const labels: Record<string, string> = { pending: "等待中", building: "构建中", succeeded: "成功", failed: "失败", smoke_testing: "冒烟测试中", smoke_test_passed: "冒烟测试通过", smoke_test_failed: "冒烟测试失败" };
  return <Badge variant={variantMap[status] ?? "muted"}>{t(status, labels[status] ?? status)}</Badge>;
}

function BuildAssetList({ appId, buildId }: { appId: string; buildId: string }) {
  const t = useText();
  const toast = useToast();
  // Per-asset in-flight guard: a Download stays disabled ("Preparing…") from the
  // presign request until the browser navigation fires, so double-clicks don't
  // send a second presign / open a second download. Other assets are unaffected.
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set());
  const assets = useQuery({
    queryKey: ["build-assets", appId, buildId],
    queryFn: () => listBuildAssets(appId, buildId),
    enabled: !!appId && !!buildId,
  });
  return (
    <div className="mt-2 pt-2 border-t border-line-hairline text-xs">
      {assets.isLoading && <p className="text-foreground-muted">{t("Loading assets…", "正在加载文件…")}</p>}
      {assets.data && assets.data.assets.length === 0 && (
        <p className="text-foreground-muted">{t("No assets registered.", "尚未登记文件。")}</p>
      )}
      {assets.data && assets.data.assets.length > 0 && (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-foreground-muted text-left">
              <th className="font-normal pr-2">{t("platform", "平台")}</th>
              <th className="font-normal pr-2">{t("arch", "架构")}</th>
              <th className="font-normal pr-2">{t("filetype", "文件类型")}</th>
              <th className="font-normal pr-2">{t("kind", "类型")}</th>
              <th className="font-normal pr-2">{t("size", "大小")}</th>
              <th className="font-normal pr-2">sha256</th>
              <th className="font-normal pr-2 text-right">{t("download", "下载")}</th>
            </tr>
          </thead>
          <tbody>
            {assets.data.assets.map((a: BuildAsset) => (
              <tr key={a.id}>
                <td className="pr-2">{a.platform}</td>
                <td className="pr-2">{a.arch ?? "-"}</td>
                <td className="pr-2">{a.filetype}</td>
                <td className="pr-2">{a.artifact_kind}</td>
                <td className="pr-2">{(a.size_bytes / 1024 / 1024).toFixed(2)} MB</td>
                <td className="pr-2 truncate max-w-xs">
                  {a.file_hash.slice(0, 16)}…
                </td>
                <td className="pr-2 text-right">
                  <Button
                    variant="outline"
                    className="text-xs inline-flex"
                    loading={downloading.has(a.id)}
                    disabled={downloading.has(a.id)}
                    onClick={async () => {
                      if (downloading.has(a.id)) return;
                      setDownloading((s) => new Set(s).add(a.id));
                      try {
                        const { download_url } = await getBuildAssetDownloadUrl(
                          appId,
                          buildId,
                          a.id,
                        );
                        window.location.href = download_url;
                      } catch (e) {
                        toast.show({
                          kind: "error",
                          title: t("Download failed", "下载失败"),
                          description: (e as Error).message,
                        });
                      } finally {
                        setDownloading((s) => {
                          const next = new Set(s);
                          next.delete(a.id);
                          return next;
                        });
                      }
                    }}
                  >
                    {t("Download", "下载")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PrepareReleaseDialog({
  build,
  onClose,
  onCreated,
}: {
  build: Build;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useText();
  const appId = build.app_id;
  const toast = useToast();
  const [scopeType, setScopeType] = useState<"full" | "platform" | "ip_range">("full");
  const [platforms, setPlatforms] = useState<string>("");
  const [ipRanges, setIpRanges] = useState<string>("");

  const create = useMutation({
    mutationFn: () =>
      import("../lib/api").then((m) =>
        m.createRelease(appId, {
          build_id: build.id,
          channel_id: build.channel_id ?? undefined,
          changelog: build.changelog ?? undefined,
          should_force_update: !!build.should_force_update,
          scopes:
            scopeType === "full"
              ? []
              : scopeType === "platform"
                ? [
                    {
                      scope_type: "platform",
                      scope_value: platforms
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .join(","),
                    },
                  ]
                : [
                    {
                      scope_type: "ip_range",
                      scope_value: ipRanges
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                        .join(","),
                    },
                  ],
        }),
      ),
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Release created", "版本已创建") });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Failed to create release", "创建版本失败"),
        description: (e as Error).message,
      }),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div>
            <DialogTitle>{t("Prepare release", "准备版本")}</DialogTitle>
            <DialogDescription>
              {t("Release build", "发布构建")} <code className="text-xs">{build.id.slice(0, 8)}…</code> (v
              {build.version_name})
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody>
        <div className="space-y-3">
          <div>
            <Label>{t("Release scope", "发布范围")}</Label>
            <RadioGroup
              className="space-y-1"
              value={scopeType}
              onValueChange={(v) => setScopeType(v as "full" | "platform" | "ip_range")}
            >
              {(["full", "platform", "ip_range"] as const).map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value={scope} />
                  {scope === "full" && t("Full release — all users", "全量发布 — 所有用户")}
                  {scope === "platform" && t("Platform release — only specified platforms", "平台发布 — 仅限指定平台")}
                  {scope === "ip_range" && t("IP range — only specified CIDR list", "IP 范围 — 仅限指定 CIDR 列表")}
                </label>
              ))}
            </RadioGroup>
          </div>
          {scopeType === "platform" && (
            <div>
              <Label>{t("Platforms (comma-separated)", "平台（以逗号分隔）")}</Label>
              <Input
                className="text-xs font-mono"
                value={platforms}
                onChange={(e) => setPlatforms(e.target.value)}
                placeholder="darwin-arm64,darwin-x64,linux-x64"
              />
            </div>
          )}
          {scopeType === "ip_range" && (
            <div>
              <Label>{t("IP ranges (comma-separated CIDR)", "IP 范围（以逗号分隔的 CIDR）")}</Label>
              <Input
                className="text-xs font-mono"
                value={ipRanges}
                onChange={(e) => setIpRanges(e.target.value)}
                placeholder="10.0.0.0/8,192.168.0.0/16"
              />
            </div>
          )}
        </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("Cancel", "取消")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => create.mutate()}
            disabled={
              create.isPending ||
              (scopeType === "platform" && !platforms.trim()) ||
              (scopeType === "ip_range" && !ipRanges.trim())
            }
          >
            {create.isPending ? t("Releasing…", "发布中…") : t("Release", "发布")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
