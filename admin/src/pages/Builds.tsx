import { errorMessage } from "../lib/errorMessage";
/**
 * Builds — a page of a list: one row per build, newest first, with its
 * version and code, product type, channel, how many files it has and their
 * size, and its state. Opening a build shows it beside the list: Prepare
 * release, its files with downloads, the contents of its APK or IPA (size
 * breakdown, SDKs, libraries, components, comparison with the previous
 * build), TestFlight or AppGallery testing for builds that go there, its
 * release notes and details.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Package, Plus } from "lucide-react";
import {
  createRelease,
  getAgcBuildSubmission,
  getAgcSubmission,
  getBuildAssetDownloadUrl,
  listApps,
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
import { useLocale, useText } from "../lib/locale";
import { buildAssetFilename, formatBuildAssetSize } from "../lib/buildAssetDisplay";
import { desktopAssetRole, groupDesktopTargets, isDesktopBuild } from "../lib/desktopTargets";
import { DetailColumn, DetailSection, ListPage } from "../components/ListPage";
import { BuildContents } from "../components/BuildContents";
import { timeAgo } from "./Operations";
import {
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  Field,
  FieldLabel,
  Input,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowGroup,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Text,
  TextLink,
  TextLinkExternalIcon,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@botiverse/raft-ui";
import type { BadgeProps } from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";

/** Rows shown before "Show more"; each visible row loads its files. */
const PAGE_SIZE = 25;

export function Builds({ appId }: { appId: string }) {
  const t = useText();
  const qc = useQueryClient();

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

  const [openId, setOpenId] = useState<string | null>(null);
  const [prepareBuild, setPrepareBuild] = useState<Build | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);

  const list = builds.data?.builds ?? [];
  const open = list.find((b) => b.id === openId) ?? null;
  const channelOf = (b: Build) => channels.data?.channels.find((c) => c.id === b.channel_id);
  const productTypeName = (b: Build) => productTypes.data?.product_types.find((p) => p.name === b.product_type)?.display_name ?? b.product_type;
  const hasChannels = (channels.data?.channels.length ?? 0) > 0;

  return (
    <ListPage
      icon={<Package aria-hidden="true" />}
      title={t("Builds", "构建")}
      count={builds.data ? list.length : undefined}
      busy={builds.isLoading}
      toolbar={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="primary"
                className="ml-auto"
                render={<Link to={`/apps/${appId}/releases`} />}
                nativeButton={false}
              >
                <Plus aria-hidden="true" />
                {t("New release", "新建版本")}
              </Button>
            }
          />
          <TooltipContent>
            {!hasChannels
              ? t("Create a channel first", "请先创建渠道")
              : t("Create a release + attach APK assets", "创建版本并附加 APK 文件")}
          </TooltipContent>
        </Tooltip>
      }
      detail={
        open && (
          <BuildDetail
            key={open.id}
            appId={appId}
            build={open}
            channelSlug={channelOf(open)?.slug ?? null}
            packageName={channelOf(open)?.bundle_id ?? null}
            productTypeName={productTypeName(open)}
            onClose={() => setOpenId(null)}
            onPrepare={() => setPrepareBuild(open)}
          />
        )
      }
    >
      <div className="flex flex-col gap-0.5">
        {builds.isLoading && [0, 1, 2, 3].map((n) => <ListRowSkeleton key={n} cell />)}

        {builds.error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load builds", "无法加载构建")}</BannerTitle>
              <BannerDescription>{errorMessage(builds.error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void builds.refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {builds.data && list.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon><Package aria-hidden="true" /></EmptyStateIcon>
              <EmptyStateTitle>{t("No builds yet", "还没有构建")}</EmptyStateTitle>
              <EmptyStateDescription>
                {t("Builds arrive from CI or the CLI, or with a new release's files.", "构建来自 CI、命令行，或新建版本时上传的文件。")}
              </EmptyStateDescription>
            </EmptyStateContent>
          </EmptyState>
        )}

        {list.slice(0, shown).map((b) => (
          <BuildListRow
            key={b.id}
            appId={appId}
            build={b}
            channelSlug={channelOf(b)?.slug ?? null}
            productTypeName={productTypeName(b)}
            selected={openId === b.id}
            onOpen={() => setOpenId(b.id)}
          />
        ))}

        {list.length > shown && (
          <div className="flex items-center gap-3 px-(--column-margin) pt-3">
            <TextLink onClick={() => setShown((n) => n + PAGE_SIZE)}>{t("Show more", "显示更多")}</TextLink>
            <Text.Sans size="small" variant="muted" className="font-mono">{`${shown} / ${list.length}`}</Text.Sans>
          </div>
        )}
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
    </ListPage>
  );
}

function useBuildAssets(appId: string, buildId: string) {
  return useQuery({
    queryKey: ["build-assets", appId, buildId],
    queryFn: () => listBuildAssets(appId, buildId),
    enabled: !!appId && !!buildId,
  });
}

function assetSummary(assets: BuildAsset[] | undefined, locale: "en" | "zh-CN", t: ReturnType<typeof useText>): string | null {
  if (!assets) return null;
  if (assets.length === 0) return t("No files", "没有文件");
  const total = assets.reduce((sum, a) => sum + a.size_bytes, 0);
  return t(
    `${assets.length} file${assets.length === 1 ? "" : "s"} · ${formatBuildAssetSize(total, locale)}`,
    `${assets.length} 个文件 · ${formatBuildAssetSize(total, locale)}`,
  );
}

function BuildListRow({
  appId,
  build: b,
  channelSlug,
  productTypeName,
  selected,
  onOpen,
}: {
  appId: string;
  build: Build;
  channelSlug: string | null;
  productTypeName: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const assets = useBuildAssets(appId, b.id);
  const files = assetSummary(assets.data?.assets, locale, t);
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen}>
      <ListRowBody>
        <ListRowTop>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <ListRowTitle className="flex-initial">{b.version_name}</ListRowTitle>
            <span className="shrink-0 font-mono text-footnote text-foreground-hint">{b.version_code}</span>
          </span>
          <ListRowMeta>{timeAgo(b.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        <ListRowSubtitle>
          {productTypeName}
          {channelSlug && <> · <span className="font-mono">{channelSlug}</span></>}
          {b.should_force_update ? t(" · force update", " · 强制更新") : ""}
        </ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>{files ?? (assets.error ? t("Files unavailable", "无法加载文件") : t("Loading files…", "正在加载文件…"))}</ListRowDescription>
          <BuildStatusBadge status={b.status} />
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function BuildDetail({
  appId,
  build: b,
  channelSlug,
  packageName,
  productTypeName,
  onClose,
  onPrepare,
}: {
  appId: string;
  build: Build;
  channelSlug: string | null;
  packageName: string | null;
  productTypeName: string;
  onClose: () => void;
  onPrepare: () => void;
}) {
  const t = useText();
  const { locale } = useLocale();
  const scheduled = b.availability_at && b.availability_at > Date.now() ? b.availability_at : null;
  // Contents are read from an APK or IPA; other builds have nothing to show.
  const assets = useBuildAssets(appId, b.id);
  const hasMobilePackage = (assets.data?.assets ?? []).some(
    (a) => a.artifact_kind === "installable" && ((a.platform === "android" && a.filetype === "apk") || (a.platform === "ios" && a.filetype === "ipa")),
  );
  return (
    <DetailColumn
      label={`${b.version_name} (${b.version_code})`}
      title={b.version_name}
      meta={<span className="font-mono">{b.version_code}</span>}
      onClose={onClose}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <BuildStatusBadge status={b.status} />
          <Text.Sans size="small" variant="muted">
            {productTypeName}
            {channelSlug && <> · <span className="font-mono">{channelSlug}</span></>}
            {" · "}{timeAgo(b.created_at, locale)}
          </Text.Sans>
        </div>
        {b.status === "succeeded" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="default" onClick={onPrepare}>{t("Prepare release", "准备版本")}</Button>
          </div>
        )}
      </div>

      <DetailSection title={t("Files", "文件")}>
        <BuildAssetList appId={appId} buildId={b.id} />
      </DetailSection>

      {hasMobilePackage && (
        <DetailSection title={t("Contents", "内容")}>
          <BuildContents appId={appId} buildId={b.id} />
        </DetailSection>
      )}

      {b.product_type === "ios-ipa" && (
        <DetailSection title="TestFlight">
          <TestflightUploadPanel appId={appId} build={b} />
        </DetailSection>
      )}
      {b.product_type === "ohos-app" && (
        <DetailSection title="AppGallery">
          <AgcTestingPanel appId={appId} build={b} packageName={packageName} />
        </DetailSection>
      )}

      {b.changelog && (
        <DetailSection title={t("Release notes", "发布说明")}>
          <Text.Sans size="small" className="whitespace-pre-wrap [overflow-wrap:anywhere]">{b.changelog}</Text.Sans>
        </DetailSection>
      )}

      <DetailSection title={t("Details", "详情")}>
        <DescriptionList direction="horizontal">
          <DescriptionItem>
            <DescriptionTerm>{t("Build", "构建")}</DescriptionTerm>
            <DescriptionDetails><span className="font-mono [overflow-wrap:anywhere]">{b.id}</span></DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Product type", "产品类型")}</DescriptionTerm>
            <DescriptionDetails><span className="font-mono">{b.product_type}</span></DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Source", "来源")}</DescriptionTerm>
            <DescriptionDetails>{b.source}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>{t("Created", "创建时间")}</DescriptionTerm>
            <DescriptionDetails>{new Date(b.created_at).toLocaleString(locale)}</DescriptionDetails>
          </DescriptionItem>
          {b.completed_at ? (
            <DescriptionItem>
              <DescriptionTerm>{t("Finished", "完成时间")}</DescriptionTerm>
              <DescriptionDetails>{new Date(b.completed_at).toLocaleString(locale)}</DescriptionDetails>
            </DescriptionItem>
          ) : null}
          {b.should_force_update ? (
            <DescriptionItem>
              <DescriptionTerm>{t("Force update", "强制更新")}</DescriptionTerm>
              <DescriptionDetails>{t("On", "开启")}</DescriptionDetails>
            </DescriptionItem>
          ) : null}
          {scheduled ? (
            <DescriptionItem>
              <DescriptionTerm>{t("Available from", "生效时间")}</DescriptionTerm>
              <DescriptionDetails>{new Date(scheduled).toLocaleString(locale)}</DescriptionDetails>
            </DescriptionItem>
          ) : null}
        </DescriptionList>
      </DetailSection>
    </DetailColumn>
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
    onError: (e) => toast.show({ kind: "error", title: t("AppGallery upload failed", "上传到 AppGallery 失败"), description: errorMessage(e) }),
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
    onError: (e) => toast.show({ kind: "error", title: t("Review submission failed", "提交审核失败"), description: errorMessage(e) }),
  });
  const state = submission?.state;
  const stateVariant: BadgeVariant =
    state === "failed" || state === "rejected" ? "warning"
      : state === "stopped" ? "muted"
        : state === "ready" || state === "testing_review" || state === "testing_scheduled" || state === "testing_active" ? "success"
          : "information";
  const auditOpinion = typeof submission?.provider_state?.audit_opinion === "string" ? submission.provider_state.audit_opinion : null;
  const canUpload = !submission || state === "failed" || state === "rejected" || state === "stopped";

  const stateText = state === "processing" ? t("Huawei processing build…", "华为正在处理构建…")
    : state === "ready" ? t("Build uploaded", "构建已上传")
      : state ? t(state.replaceAll("_", " "), ({ uploading: "上传中", failed: "失败", rejected: "已拒绝", stopped: "已停止", testing_review: "测试审核中", testing_scheduled: "测试已安排", testing_active: "测试中" } as Record<string, string>)[state] ?? state)
        : null;
  const note =
    state === "ready" ? t("Build compiled and ready. Invitation testing has not been submitted.", "构建已编译完成，尚未提交邀请测试。")
      : state === "testing_review" ? t("Submitted to AppGallery invitation testing review. Status refreshes from Huawei each time this panel loads.", "已提交 AppGallery 邀请测试审核。每次加载此面板时都会从华为刷新状态。")
        : state === "testing_scheduled" ? t("Approved; invitation testing starts at the scheduled time.", "已批准；邀请测试将在计划时间开始。")
          : state === "testing_active" ? t("Invitation testing is live for the selected test group.", "所选测试组的邀请测试已开始。")
            : state === "rejected" ? `${t("Huawei rejected the test version", "华为拒绝了测试版本")}${auditOpinion ? `: ${auditOpinion}` : t(".", "。")}`
              : state === "stopped" ? t("Invitation testing has ended on Huawei's side.", "华为侧的邀请测试已结束。")
                : null;

  return (
    <div className="flex flex-col gap-3">
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle>{t("Invitation testing", "邀请测试")}</ListRowTitle>
            {note
              ? <ListRowDescription wrap>{note}</ListRowDescription>
              : !submission && <ListRowDescription wrap>{t("Upload the signed .app and wait for Huawei build processing", "上传已签名的 .app 并等待华为处理构建")}</ListRowDescription>}
          </ListRowBody>
          {stateText && <Badge appearance="soft" variant={stateVariant}>{stateText}</Badge>}
        </ListRow>
      </ListRowGroup>
      {submission?.error_message && <Text.Sans size="small" variant="warning">{submission.error_message}</Text.Sans>}
      {status.data?.sync_error && <Text.Sans size="small" variant="warning">{t("Could not refresh from Huawei:", "无法从华为刷新：")} {status.data.sync_error}</Text.Sans>}
      <div className="flex flex-wrap items-center gap-2">
        {canUpload && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="default"
                  disabled={upload.isPending || build.status !== "succeeded" || !packageName}
                  loading={upload.isPending}
                  loadingLabel={t("Uploading build…", "正在上传构建…")}
                  onClick={() => upload.mutate()}
                >
                  {state === "failed" || state === "rejected" || state === "stopped" ? t("Upload again", "重新上传") : t("Upload build to AppGallery", "上传构建到 AppGallery")}
                </Button>
              }
            />
            <TooltipContent>
              {!packageName ? t("Set the channel bundle ID first", "请先设置渠道的 Bundle ID") : build.status !== "succeeded" ? t("Build must be succeeded", "构建必须成功") : t("Upload the signed .app and wait for Huawei build processing", "上传已签名的 .app 并等待华为处理构建")}
            </TooltipContent>
          </Tooltip>
        )}
        {state === "ready" && (
          <Button
            variant="default"
            disabled={submit.isPending}
            loading={submit.isPending}
            loadingLabel={t("Submitting…", "提交中…")}
            onClick={() => {
              if (window.confirm(t("Submit this uploaded build to AppGallery invitation testing?", "将此已上传构建提交到 AppGallery 邀请测试？"))) submit.mutate();
            }}
          >
            {t("Submit to invitation testing", "提交邀请测试")}
          </Button>
        )}
      </div>
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
      toast.show({ kind: "error", title: t("Upload failed", "上传失败"), description: errorMessage(e) }),
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
  const stateVariant: BadgeVariant = stateName === "COMPLETE" ? "success" : stateName === "FAILED" ? "warning" : "information";
  const stateText = !stateName ? null
    : stateName === "PROCESSING" || stateName === "AWAITING_UPLOAD"
      ? t("Apple processing…", "Apple 处理中…")
      : t(stateName === "COMPLETE" ? "Complete" : stateName === "FAILED" ? "Failed" : stateName, stateName === "COMPLETE" ? "已完成" : stateName === "FAILED" ? "失败" : stateName);

  return (
    <div className="flex flex-col gap-3">
      <ListRowGroup>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle>{t("Upload to TestFlight", "上传到 TestFlight")}</ListRowTitle>
            <ListRowDescription wrap>
              {stateName === "COMPLETE"
                ? t("Upload processed. Ready for TestFlight group distribution.", "上传已处理完成，可以分发到 TestFlight 测试组。")
                : build.status !== "succeeded"
                  ? t("Build must be succeeded", "构建必须成功")
                  : t("Upload this IPA to App Store Connect / TestFlight", "将此 IPA 上传到 App Store Connect / TestFlight")}
            </ListRowDescription>
          </ListRowBody>
          {stateText && <Badge appearance="soft" variant={stateVariant}>{stateText}</Badge>}
        </ListRow>
      </ListRowGroup>
      {state?.errors && state.errors.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-footnote text-warning-strong">
          {state.errors.map((e, i) => (
            <li key={i}>
              {e.code ? `[${e.code}] ` : ""}
              {e.description}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          variant="default"
          disabled={upload.isPending || build.status !== "succeeded"}
          loading={upload.isPending}
          loadingLabel={t("Uploading…", "上传中…")}
          onClick={() => upload.mutate()}
        >
          {t("Upload to TestFlight", "上传到 TestFlight")}
        </Button>
        <TextLink
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
          nativeButton={false}
        >
          {t("Open in App Store Connect", "在 App Store Connect 中打开")}
          <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
        </TextLink>
      </div>
    </div>
  );
}

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

function BuildStatusBadge({ status }: { status: string }) {
  const t = useText();
  // A failed build or smoke test can be rebuilt, so it is orange, not red.
  const variantMap: Record<string, BadgeVariant> = {
    pending: "muted",
    building: "information",
    succeeded: "success",
    failed: "warning",
    smoke_testing: "information",
    smoke_test_passed: "success",
    smoke_test_failed: "warning",
  };
  const en: Record<string, string> = { pending: "Pending", building: "Building", succeeded: "Succeeded", failed: "Failed", smoke_testing: "Smoke testing", smoke_test_passed: "Smoke test passed", smoke_test_failed: "Smoke test failed" };
  const zh: Record<string, string> = { pending: "等待中", building: "构建中", succeeded: "成功", failed: "失败", smoke_testing: "冒烟测试中", smoke_test_passed: "冒烟测试通过", smoke_test_failed: "冒烟测试失败" };
  return <Badge appearance="soft" variant={variantMap[status] ?? "muted"}>{t(en[status] ?? status, zh[status] ?? status)}</Badge>;
}

function BuildAssetList({ appId, buildId }: { appId: string; buildId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const toast = useToast();
  // Per-asset in-flight guard: a Download stays disabled ("Preparing…") from the
  // presign request until the browser navigation fires, so double-clicks don't
  // send a second presign / open a second download. Other assets are unaffected.
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(new Set());
  const assets = useBuildAssets(appId, buildId);
  if (assets.isLoading) return <Skeleton className="h-16 w-full" />;
  if (assets.error) return <Text.Sans size="small" variant="warning">{t("Could not load files:", "无法加载文件：")} {errorMessage(assets.error)}</Text.Sans>;
  const list = assets.data?.assets ?? [];
  if (list.length === 0) return <Text.Sans size="small" variant="muted">{t("No assets registered.", "尚未登记文件。")}</Text.Sans>;

  const download = async (a: BuildAsset) => {
    if (downloading.has(a.id)) return;
    setDownloading((s) => new Set(s).add(a.id));
    try {
      const { download_url } = await getBuildAssetDownloadUrl(appId, buildId, a.id);
      window.location.href = download_url;
    } catch (e) {
      toast.show({
        kind: "error",
        title: t("Download failed", "下载失败"),
        description: errorMessage(e),
      });
    } finally {
      setDownloading((s) => {
        const next = new Set(s);
        next.delete(a.id);
        return next;
      });
    }
  };

  const row = (a: BuildAsset, role?: { en: string; zh: string }) => {
    const filename = buildAssetFilename(a, locale);
    return (
      <ListRow key={a.id} variant="plain" interactive={false}>
        <ListRowBody>
          <ListRowTitle className="whitespace-normal font-mono text-footnote [overflow-wrap:anywhere]">{filename}</ListRowTitle>
          <ListRowSubtitle className="whitespace-normal font-mono">
            {(role
              ? [t(role.en, role.zh), formatBuildAssetSize(a.size_bytes, locale), a.filetype]
              : [formatBuildAssetSize(a.size_bytes, locale), `${a.platform}${a.arch ? `/${a.arch}` : ""}`, a.filetype, a.artifact_kind]
            ).join(" · ")}
          </ListRowSubtitle>
          <ListRowSubtitle className="font-mono text-foreground-hint">sha256 {a.file_hash.slice(0, 16)}…</ListRowSubtitle>
        </ListRowBody>
        <Button
          variant="default"
          aria-label={t(`Download ${filename}`, `下载 ${filename}`)}
          loading={downloading.has(a.id)}
          loadingLabel={t("Preparing…", "准备中…")}
          disabled={downloading.has(a.id)}
          onClick={() => void download(a)}
        >
          {t("Download", "下载")}
        </Button>
      </ListRow>
    );
  };

  if (!isDesktopBuild(list)) return <ListRowGroup>{list.map((a) => row(a))}</ListRowGroup>;

  // A desktop build carries every target of its version: show each target with
  // whether it is live for updates (its manifest sealed) and its files.
  const { targets, other } = groupDesktopTargets(list);
  return (
    <div className="flex flex-col gap-4">
      {targets.map((g) => (
        <section key={g.target} className="flex flex-col gap-2" aria-label={t(g.label.en, g.label.zh)}>
          <div className="flex flex-wrap items-center gap-2">
            <Text.Sans size="small" className="font-medium">{t(g.label.en, g.label.zh)}</Text.Sans>
            <Text.Sans size="small" variant="muted" className="font-mono">{g.target}</Text.Sans>
            {g.live
              ? <Badge appearance="soft" variant="success">{t("Live for updates", "已开放更新")}</Badge>
              : <Badge appearance="soft" variant="warning">{t("Not published: no manifest", "未发布：缺少更新清单")}</Badge>}
            <Text.Sans size="small" variant="muted">{formatBuildAssetSize(g.sizeBytes, locale)}</Text.Sans>
          </div>
          <ListRowGroup>
            {[g.manifest, g.archive, ...g.installers].filter((a): a is BuildAsset => !!a).map((a) => row(a, desktopAssetRole(a)))}
          </ListRowGroup>
        </section>
      ))}
      {other.length > 0 && (
        <section className="flex flex-col gap-2">
          <Text.Sans size="small" className="font-medium">{t("Other files", "其他文件")}</Text.Sans>
          <ListRowGroup>{other.map((a) => row(a))}</ListRowGroup>
        </section>
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
      createRelease(appId, {
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
    onSuccess: () => {
      toast.show({ kind: "success", title: t("Release created", "版本已创建") });
      onCreated();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: t("Failed to create release", "创建版本失败"),
        description: errorMessage(e),
      }),
  });

  const invalid = (scopeType === "platform" && !platforms.trim()) || (scopeType === "ip_range" && !ipRanges.trim());

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader>
          <div className="min-w-0">
            <DialogTitle>{t("Prepare release", "准备版本")}</DialogTitle>
            <DialogDescription>
              {t("Release build", "发布构建")} <span className="font-mono">{build.id.slice(0, 8)}…</span> ({build.version_name})
            </DialogDescription>
          </div>
          <DialogClose />
        </DialogHeader>
        <DialogBody className="grid gap-5">
          <Field>
            <FieldLabel nativeLabel={false} render={<div />}>{t("Release scope", "发布范围")}</FieldLabel>
            <RadioGroup
              className="grid gap-2"
              value={scopeType}
              onValueChange={(v) => setScopeType(v as "full" | "platform" | "ip_range")}
            >
              {(["full", "platform", "ip_range"] as const).map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value={scope} />
                  {scope === "full" && t("Full release: all users", "全量发布：所有用户")}
                  {scope === "platform" && t("Platform release: only the platforms listed", "平台发布：仅限指定平台")}
                  {scope === "ip_range" && t("IP range: only the CIDR ranges listed", "IP 范围：仅限指定 CIDR 列表")}
                </label>
              ))}
            </RadioGroup>
          </Field>
          {scopeType === "platform" && (
            <Field>
              <FieldLabel htmlFor="prepare-platforms">{t("Platforms (comma-separated)", "平台（以逗号分隔）")}</FieldLabel>
              <Input
                id="prepare-platforms"
                className="font-mono"
                value={platforms}
                onChange={(e) => setPlatforms(e.target.value)}
                placeholder="darwin-arm64,darwin-x64,linux-x64"
              />
            </Field>
          )}
          {scopeType === "ip_range" && (
            <Field>
              <FieldLabel htmlFor="prepare-ip-ranges">{t("IP ranges (comma-separated CIDR)", "IP 范围（以逗号分隔的 CIDR）")}</FieldLabel>
              <Input
                id="prepare-ip-ranges"
                className="font-mono"
                value={ipRanges}
                onChange={(e) => setIpRanges(e.target.value)}
                placeholder="10.0.0.0/8,192.168.0.0/16"
              />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" size="lg" />}>{t("Cancel", "取消")}</DialogClose>
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={() => create.mutate()}
            disabled={create.isPending || invalid}
            loading={create.isPending}
            loadingLabel={t("Releasing…", "发布中…")}
          >
            {t("Release", "发布")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
