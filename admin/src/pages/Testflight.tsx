import { errorMessage } from "../lib/errorMessage";
/**
 * TestFlight tab — one place to see every Hands→Apple upload and distribution
 * request. Upload attempts are recorded as `testflight-upload` operations;
 * each successful one carries a
 * build_upload_id whose Apple state (PROCESSING → COMPLETE | FAILED) is
 * polled live, so the operation's "upload succeeded" is separated from
 * Apple's async accept/reject verdict. Group assignment/review attempts are
 * recorded as `testflight-publish` operations.
 *
 * Layout: a page of two sections, Uploads and Distributions, each a group
 * of rows (version and build number in mono, the time, the state as a
 * badge, details under it). The page is read-only: uploads start from
 * Builds and the key lives in Integrations, which the header line links to.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  type BadgeProps,
  Banner,
  BannerDescription,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ListRow,
  ListRowBody,
  ListRowGroup,
  ListRowMeta,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  Text,
  TextLink,
  TextLinkExternalIcon,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { AlertTriangle, Plane, Send, Upload } from "lucide-react";
import {
  getAscCredentials,
  listApps,
  listOperations,
  getTestflightPublishStatus,
  getTestflightUploadStatus,
  type Operation,
  type AscUploadState,
  type TestflightPublishState,
} from "../lib/api";
import { useLocale, useText } from "../lib/locale";
import { SettingsPage, SettingsSection } from "../components/SettingsPage";
import { timeAgo } from "./Operations";

const STATE_ZH: Record<string, string> = {
  pending: "等待中", in_progress: "进行中", success: "成功", failed: "失败", cancelled: "已取消",
  rejected: "已拒绝", expired: "已过期", processing_failed: "处理失败", blocked_export_compliance: "等待出口合规信息",
  not_applicable: "不适用", testing: "测试中", approved: "已批准", approved_not_notified: "已批准，尚未通知",
  internal: "内部", external: "外部",
};
const STATE_EN: Record<string, string> = {
  pending: "Pending", in_progress: "In progress", success: "Done", failed: "Failed", cancelled: "Cancelled",
  rejected: "Rejected", expired: "Expired", processing_failed: "Processing failed", blocked_export_compliance: "Needs export compliance",
  not_applicable: "Not applicable", testing: "Testing", approved: "Approved", approved_not_notified: "Approved, not notified",
  waiting_for_review: "Waiting for review", in_review: "In review", processing: "Processing", ready: "Ready",
};

interface UploadInput {
  version_name?: string;
  version_code?: number;
  bundle_id?: string;
}
interface UploadOutput {
  build_upload_id?: string;
  asc_app_id?: string;
}
interface PublishInput {
  hands_build_id?: string;
  bundle_id?: string;
  distribution?: "internal" | "external";
  group_ids?: string[];
  notify_testers?: boolean;
}
type PublishOutput = Partial<TestflightPublishState>;

function ascTestflightUrl(ascAppId: string | undefined): string {
  return ascAppId
    ? `https://appstoreconnect.apple.com/apps/${ascAppId}/testflight/ios`
    : "https://appstoreconnect.apple.com/apps";
}

function parse<T>(raw: string | null | undefined): T {
  try {
    return JSON.parse(raw || "{}") as T;
  } catch {
    return {} as T;
  }
}

export function Testflight({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const ops = useQuery({
    queryKey: ["operations", appId],
    queryFn: () => listOperations(appId, 100),
    refetchInterval: 10000,
  });
  const creds = useQuery({
    queryKey: ["asc-credentials", appId],
    queryFn: () => getAscCredentials(appId),
  });
  const notConfigured = creds.data !== undefined && creds.data.asc_credentials === null;

  const uploads = (ops.data?.operations ?? []).filter(
    (o) => o.kind === "testflight-upload",
  );
  const publishes = (ops.data?.operations ?? []).filter(
    (o) => o.kind === "testflight-publish",
  );
  const empty = !ops.isLoading && !ops.error && uploads.length === 0 && publishes.length === 0;

  return (
    <SettingsPage
      icon={<Plane aria-hidden="true" />}
      title="TestFlight"
      meta={app?.name}
      busy={ops.isLoading}
    >
      {!(empty && notConfigured) && (
        <Text.Sans size="small" variant="muted">
          {t("Builds Hands sent to Apple, Apple's processing, and the beta groups they went to. Upload a build from ", "Hands 发送给 Apple 的构建、Apple 的处理状态和分发到的测试组。从")}
          <TextLink render={<Link to={`/apps/${appId}/builds`} />} nativeButton={false}>{t("Builds", "构建")}</TextLink>
          {t("; the App Store Connect key is in ", "页面上传构建；App Store Connect 密钥在")}
          <TextLink render={<Link to={`/apps/${appId}/integrations`} />} nativeButton={false}>{t("Integrations", "集成")}</TextLink>
          {t(".", "中设置。")}
        </Text.Sans>
      )}

      {notConfigured && !empty && (
        <Banner status="warning" size="sm">
          <AlertTriangle aria-hidden="true" />
          <BannerDescription>
            {t("The App Store Connect key is no longer set, so states below stop updating. Add it again in ", "App Store Connect 密钥已不存在，下面的状态不再更新。请在")}
            <TextLink render={<Link to={`/apps/${appId}/integrations`} />} nativeButton={false}>{t("Integrations", "集成")}</TextLink>
            {t(".", "中重新添加。")}
          </BannerDescription>
        </Banner>
      )}

      {ops.error && (
        <Banner status="warning">
          <AlertTriangle aria-hidden="true" />
          <BannerDescription>
            {t("Could not load TestFlight activity:", "无法加载 TestFlight 记录：")} {errorMessage(ops.error)}
          </BannerDescription>
        </Banner>
      )}

      {ops.isLoading && (
        <ListRowGroup>
          {[0, 1, 2].map((n) => <ListRowSkeleton key={n} />)}
        </ListRowGroup>
      )}

      {empty && (
        <EmptyState className="py-16">
          <EmptyStateContent>
            <EmptyStateIcon>
              <Plane aria-hidden="true" />
            </EmptyStateIcon>
            {notConfigured ? (
              <>
                <EmptyStateTitle>{t("Connect App Store Connect first", "请先连接 App Store Connect")}</EmptyStateTitle>
                <EmptyStateDescription>
                  {t("Hands uploads builds to TestFlight with this app's App Store Connect API key. Add the key in Integrations, then upload a build from Builds.", "Hands 用此应用的 App Store Connect API 密钥把构建上传到 TestFlight。请先在“集成”中添加密钥，再从“构建”页面上传。")}
                </EmptyStateDescription>
              </>
            ) : (
              <>
                <EmptyStateTitle>{t("No TestFlight activity yet", "暂无 TestFlight 活动")}</EmptyStateTitle>
                <EmptyStateDescription>
                  {t("Upload a build to TestFlight from Builds; it shows here with Apple's processing state.", "从“构建”页面把构建上传到 TestFlight 后，会在这里显示 Apple 的处理状态。")}
                </EmptyStateDescription>
              </>
            )}
          </EmptyStateContent>
          <EmptyStateActions>
            {notConfigured ? (
              <Button variant="primary" render={<Link to={`/apps/${appId}/integrations`} />} nativeButton={false}>
                {t("Open Integrations", "打开集成")}
              </Button>
            ) : (
              <Button variant="outline" render={<Link to={`/apps/${appId}/builds`} />} nativeButton={false}>
                {t("Open Builds", "打开构建")}
              </Button>
            )}
          </EmptyStateActions>
        </EmptyState>
      )}

      {uploads.length > 0 && (
        <SettingsSection id="testflight-uploads" icon={<Upload />} title={t("Uploads", "上传")}>
          <ListRowGroup>
            {uploads.map((op) => (
              <UploadRow key={op.id} appId={appId} op={op} />
            ))}
          </ListRowGroup>
        </SettingsSection>
      )}

      {publishes.length > 0 && (
        <SettingsSection id="testflight-distributions" icon={<Send />} title={t("Distributions", "分发")}>
          <ListRowGroup>
            {publishes.map((op) => (
              <PublishRow key={op.id} appId={appId} op={op} />
            ))}
          </ListRowGroup>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}

/** A row's facts under its title: badges on one wrapping line, then lines. */
function RowFacts({ badges, children }: { badges: ReactNode; children?: ReactNode }) {
  return (
    <>
      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">{badges}</span>
      {children}
    </>
  );
}

function Line({ tone, mono, children }: { tone?: "danger" | "success" | "muted"; mono?: boolean; children: ReactNode }) {
  const color = tone === "danger" ? "text-danger-strong" : tone === "success" ? "text-success-strong" : tone === "muted" ? "text-foreground-muted" : "text-foreground";
  return <span className={`mt-1 block text-footnote ${color} ${mono ? "font-mono [overflow-wrap:anywhere]" : ""}`}>{children}</span>;
}

function versionTitle(version: string | undefined, build: string | number | undefined, fallback: string) {
  if (!version) return fallback;
  return `${version}${build ? ` (${build})` : ""}`;
}

function UploadRow({ appId, op }: { appId: string; op: Operation }) {
  const t = useText();
  const { locale } = useLocale();
  const input = parse<UploadInput>(op.input);
  const output = parse<UploadOutput>(op.output);
  const buildUploadId = output.build_upload_id;

  const status = useQuery({
    queryKey: ["testflight-status", appId, buildUploadId],
    queryFn: () => getTestflightUploadStatus(appId, buildUploadId!),
    enabled: Boolean(buildUploadId) && op.status === "success",
    refetchInterval: (q) => {
      const s = q.state.data?.state?.state;
      return s === "COMPLETE" || s === "FAILED" ? false : 8000;
    },
  });

  const appleState: AscUploadState | null | undefined = status.data?.state;
  const uploadFailed = op.status === "failed";

  return (
    <ListRow variant="plain" interactive={false} data-testid="testflight-upload">
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle className="font-mono">
            {versionTitle(input.version_name, input.version_code, "—")}
          </ListRowTitle>
          <ListRowMeta title={new Date(op.created_at).toISOString()}>{timeAgo(op.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        {input.bundle_id && <ListRowSubtitle className="font-mono">{input.bundle_id}</ListRowSubtitle>}
        <RowFacts badges={<StateBadge uploadFailed={uploadFailed} appleState={appleState} />}>
          {uploadFailed && op.error && <Line tone="danger" mono>{friendlyError(op.error)}</Line>}
          {appleState?.errors && appleState.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-footnote text-danger-strong">
              {appleState.errors.map((e, i) => (
                <li key={i}>
                  {e.code ? `[${e.code}] ` : ""}
                  {e.description}
                </li>
              ))}
            </ul>
          )}
          {appleState?.state === "COMPLETE" && (
            <Line tone="muted">{t("Processed by Apple. Ready to send to beta groups.", "Apple 已处理完成，可以分发给测试组。")}</Line>
          )}
          {!uploadFailed && (
            <span className="mt-1 block text-footnote">
              <TextLink render={<a href={ascTestflightUrl(output.asc_app_id)} target="_blank" rel="noopener noreferrer" />} nativeButton={false}>
                {t("View in App Store Connect", "在 App Store Connect 中查看")}
                <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
              </TextLink>
            </span>
          )}
        </RowFacts>
      </ListRowBody>
    </ListRow>
  );
}

function isTerminalPublishState(
  state: string | undefined,
  input: PublishInput,
): boolean {
  if (!state) return false;
  if (
    state === "rejected" ||
    state === "expired" ||
    state === "processing_failed" ||
    state === "blocked_export_compliance" ||
    state === "not_applicable"
  ) {
    return true;
  }
  if (state === "testing") return true;
  return (
    input.distribution === "external" &&
    !input.notify_testers &&
    (state === "approved" || state === "approved_not_notified")
  );
}

function stateLabel(state: string, t: ReturnType<typeof useText>) {
  const en = STATE_EN[state] ?? state.replace(/_/g, " ").toLowerCase();
  return t(en, STATE_ZH[state] ?? en);
}

function PublishRow({ appId, op }: { appId: string; op: Operation }) {
  const t = useText();
  const { locale } = useLocale();
  const input = parse<PublishInput>(op.input);
  const output = parse<PublishOutput>(op.output);
  const buildId = input.hands_build_id;
  const liveStatus = useQuery({
    queryKey: [
      "testflight-publish-status",
      appId,
      buildId,
      input.distribution,
      input.bundle_id,
    ],
    queryFn: () =>
      getTestflightPublishStatus(appId, buildId!, {
        ...(input.distribution ? { distribution: input.distribution } : {}),
        ...(input.bundle_id ? { bundleId: input.bundle_id } : {}),
      }),
    enabled: Boolean(buildId) && op.status === "success",
    staleTime: 5000,
    refetchInterval: (query) =>
      isTerminalPublishState(query.state.data?.state, input) ? 300000 : 12000,
  });
  const current: PublishOutput = { ...output, ...(liveStatus.data ?? {}) };
  const failed = op.status === "failed";
  const state = failed ? "failed" : current.state ?? op.status;
  const blocked =
    state === "rejected" ||
    state === "expired" ||
    state === "processing_failed" ||
    state === "blocked_export_compliance" ||
    state === "not_applicable";
  const badgeVariant: BadgeProps["variant"] =
    failed || blocked
      ? "danger"
      : state === "testing"
        ? "success"
        : "information";
  const localizationLocales = (current.localizations ?? [])
    .map((item) => item.locale)
    .filter((locale): locale is string => Boolean(locale));
  const groups = (current.assigned_groups ?? []).map((group) => group.name ?? group.id);

  return (
    <ListRow variant="plain" interactive={false} data-testid="testflight-distribution">
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle className="font-mono">
            {versionTitle(current.version, current.build_number, input.hands_build_id?.slice(0, 8) ?? "—")}
          </ListRowTitle>
          <ListRowMeta title={new Date(op.created_at).toISOString()}>{timeAgo(op.created_at, locale)}</ListRowMeta>
        </ListRowTop>
        {groups.length > 0 && (
          <ListRowSubtitle>{t("Groups:", "测试组：")} {groups.join(", ")}</ListRowSubtitle>
        )}
        <RowFacts
          badges={
            <>
              <Badge appearance="soft" variant={badgeVariant}>{stateLabel(state, t)}</Badge>
              {input.distribution && (
                <Badge appearance="outline">{t(input.distribution === "internal" ? "Internal" : "External", STATE_ZH[input.distribution] ?? input.distribution)}</Badge>
              )}
              {current.beta_review?.state && (
                <Badge appearance="outline">
                  {t("Review:", "审核：")} {stateLabel(current.beta_review.state.toLowerCase(), t)}
                </Badge>
              )}
              {current.beta_detail?.auto_notify_enabled && (
                <Badge appearance="outline">{t("Auto notify on", "已开启自动通知")}</Badge>
              )}
            </>
          }
        >
          {localizationLocales.length > 0 && (
            <Line tone="muted">{t("What to Test:", "测试说明：")} {localizationLocales.join(", ")}</Line>
          )}
          {current.expiration_date && (
            <Line tone="muted">{t("Expires", "过期日期")} {new Date(current.expiration_date).toISOString().slice(0, 10)}</Line>
          )}
          {output.notification && (
            <Line tone="muted">{t("Notification:", "通知操作：")} {output.notification}</Line>
          )}
          {failed && op.error && <Line tone="danger" mono>{friendlyError(op.error)}</Line>}
          {liveStatus.isError && !failed && (
            <Line tone="danger">{t("Live state refresh failed:", "实时状态刷新失败：")} {friendlyError(liveStatus.error)}</Line>
          )}
        </RowFacts>
      </ListRowBody>
    </ListRow>
  );
}

function StateBadge({
  uploadFailed,
  appleState,
}: {
  uploadFailed: boolean;
  appleState: AscUploadState | null | undefined;
}) {
  const t = useText();
  if (uploadFailed) {
    return <Badge appearance="soft" variant="danger">{t("Upload failed", "上传失败")}</Badge>;
  }
  const s = appleState?.state;
  if (!s) return <Badge appearance="outline">{t("Uploaded", "已上传")}</Badge>;
  if (s === "COMPLETE")
    return <Badge appearance="soft" variant="success">{t("Processed", "已完成")}</Badge>;
  if (s === "FAILED")
    return <Badge appearance="soft" variant="danger">{t("Apple rejected", "Apple 已拒绝")}</Badge>;
  return <Badge appearance="soft" variant="information">{t("Apple processing", "Apple 处理中")}</Badge>;
}

function friendlyError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw);
  try {
    const parsed = JSON.parse(text) as { error?: string; detail?: string | null };
    return [parsed.error && errorMessage(parsed.error), parsed.detail && errorMessage(parsed.detail)].filter(Boolean).join(" — ") || errorMessage(text);
  } catch {
    return errorMessage(text);
  }
}
