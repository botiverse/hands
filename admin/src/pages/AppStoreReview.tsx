/**
 * The App Store page of an iOS app (/apps/:appId/appstore): the live review
 * state of its recent App Store versions and TestFlight builds, read from
 * App Store Connect. Read-only.
 *
 * Layout: the current version's state as the first row, then a section of
 * App Store versions and one of TestFlight builds' beta review, each a group
 * of rows with the state as a soft badge. What keeps the page from loading
 * (no App Store Connect key, no bundle ID, an Apple error) is an empty state
 * or a banner that links to where it is fixed.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  type BadgeProps,
  Banner,
  BannerDescription,
  BannerTitle,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowGroup,
  ListRowMeta,
  ListRowTitle,
  ListRowTop,
  Text,
  TextLink,
  TextLinkExternalIcon,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { AlertTriangle, Plane, Store } from "lucide-react";
import { getAppStoreReview, listApps, type App } from "../lib/api";
import { useLocale, useText } from "../lib/locale";
import { SettingsPage, SettingsSection } from "../components/SettingsPage";

/** The App Store page of an iOS app (/apps/:appId/appstore). */
export function AppStoreReview({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  return (
    <SettingsPage icon={<Store aria-hidden="true" />} title="App Store" meta={app?.name} busy={apps.isLoading}>
      {app && app.platform === "ios" ? (
        <AppStoreReviewPanel appId={appId} app={app} />
      ) : app ? (
        <EmptyState className="py-16">
          <EmptyStateContent>
            <EmptyStateIcon><Store aria-hidden="true" /></EmptyStateIcon>
            <EmptyStateTitle>{t("Only for iOS apps", "仅适用于 iOS 应用")}</EmptyStateTitle>
            <EmptyStateDescription>
              {t("App Store review states are shown for iOS apps.", "App Store 审核状态只对 iOS 应用显示。")}
            </EmptyStateDescription>
          </EmptyStateContent>
        </EmptyState>
      ) : null}
    </SettingsPage>
  );
}

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
      return { variant: "muted", label: "Waiting for review" };
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
      return { variant: "muted", label: "Waiting for review" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    default:
      return { variant: "muted", label: "No beta review" };
  }
}

const BADGE_ZH: Record<string, string> = { "Ready for sale": "已上架", "In review": "审核中", "Waiting for review": "等待审核", "Pending developer release": "等待开发者发布", "Pending Apple release": "等待 Apple 发布", "Preparing": "准备中", "Rejected": "已拒绝", "Metadata rejected": "元数据被拒绝", "Developer rejected": "开发者已撤回", "Unknown": "未知", "Approved": "已批准", "No beta review": "暂无测试审核" };
const PROCESSING_ZH: Record<string, string> = { PROCESSING: "处理中", FAILED: "处理失败", INVALID: "无效" };
const REJECTED = new Set(["REJECTED", "METADATA_REJECTED", "DEVELOPER_REJECTED"]);

function StateBadge({ badge, raw }: { badge: { variant: BadgeVariant; label: string }; raw: string | null }) {
  const t = useText();
  const label = t(badge.label, BADGE_ZH[badge.label] ?? raw ?? badge.label);
  return badge.variant === "muted"
    ? <Badge appearance="outline">{label}</Badge>
    : <Badge appearance="soft" variant={badge.variant}>{label}</Badge>;
}

function shortDate(value: string | null, locale: string) {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
}

function ascAppUrl(ascAppId: string | undefined) {
  return ascAppId ? `https://appstoreconnect.apple.com/apps/${ascAppId}/distribution` : "https://appstoreconnect.apple.com/apps";
}

export function AppStoreReviewPanel({ appId }: { appId: string; app: App }) {
  const t = useText();
  const { locale } = useLocale();
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

  if (review.isLoading) {
    return (
      <ListRowGroup>
        {[0, 1, 2].map((n) => <ListRowSkeleton key={n} />)}
      </ListRowGroup>
    );
  }

  if (review.error) {
    return (
      <Banner status="warning">
        <AlertTriangle aria-hidden="true" />
        <BannerTitle>{t("Could not load the review status", "无法加载审核状态")}</BannerTitle>
        <BannerDescription>{review.error instanceof Error ? review.error.message : String(review.error)}</BannerDescription>
      </Banner>
    );
  }

  if (data?.configured === false) {
    return (
      <EmptyState className="py-16">
        <EmptyStateContent>
          <EmptyStateIcon><Store aria-hidden="true" /></EmptyStateIcon>
          <EmptyStateTitle>{t("App Store Connect not configured", "尚未配置 App Store Connect")}</EmptyStateTitle>
          <EmptyStateDescription>
            {t("Add the App Store Connect key in Integrations to see review states here.", "在“集成”中添加 App Store Connect 密钥后，这里会显示审核状态。")}
          </EmptyStateDescription>
        </EmptyStateContent>
        <EmptyStateActions>
          <Button variant="primary" render={<Link to={`/apps/${appId}/integrations`} />} nativeButton={false}>
            {t("Open Integrations", "打开集成")}
          </Button>
        </EmptyStateActions>
      </EmptyState>
    );
  }

  if (data?.bundle_id === null) {
    return (
      <EmptyState className="py-16">
        <EmptyStateContent>
          <EmptyStateIcon><Store aria-hidden="true" /></EmptyStateIcon>
          <EmptyStateTitle>{t("No App Store bundle ID configured", "尚未配置 App Store Bundle ID")}</EmptyStateTitle>
          <EmptyStateDescription>
            {t("Set the production App Store bundle ID on the main channel. Only the main channel's bundle ID is used here; preview and nightly bundle IDs are ignored.", "请在 main 渠道设置正式版 App Store Bundle ID。这里只使用 main 渠道的 Bundle ID，不会使用 preview 或 nightly 的 Bundle ID。")}
          </EmptyStateDescription>
        </EmptyStateContent>
        <EmptyStateActions>
          <Button variant="outline" render={<Link to={`/apps/${appId}/channels`} />} nativeButton={false}>
            {t("Open Channels", "打开渠道")}
          </Button>
        </EmptyStateActions>
      </EmptyState>
    );
  }

  if (data?.error) {
    return (
      <Banner status="warning">
        <AlertTriangle aria-hidden="true" />
        <BannerTitle>{t("Could not load review status from App Store Connect", "无法从 App Store Connect 加载审核状态")}</BannerTitle>
        <BannerDescription>
          <span className="block font-mono [overflow-wrap:anywhere]">{data.error}</span>
          {data.bundle_id && (
            <span className="mt-1 block">
              {t("Bundle ID ", "Bundle ID ")}
              <span className="font-mono">{data.bundle_id}</span>
              {t(" is set on the main channel. If it doesn't match your App Store app, change it in ", " 设置在 main 渠道上。如果与 App Store 应用不一致，请在")}
              <TextLink render={<Link to={`/apps/${appId}/channels`} />} nativeButton={false}>{t("Channels", "渠道")}</TextLink>
              {t(".", "中修改。")}
            </span>
          )}
        </BannerDescription>
      </Banner>
    );
  }

  return (
    <>
      <Text.Sans size="small" variant="muted">
        {t("Live from App Store Connect for ", "实时读取自 App Store Connect，Bundle ID ")}
        <span className="font-mono">{data?.bundle_id}</span>
        {t(". Read-only; submit and release in ", "。仅供查看；提交和发布请在 ")}
        <TextLink render={<a href={ascAppUrl(data?.asc_app_id)} target="_blank" rel="noopener noreferrer" />} nativeButton={false}>
          App Store Connect
          <TextLinkExternalIcon label={t("(opens in a new tab)", "（在新标签页打开）")} />
        </TextLink>
        {t(".", " 中进行。")}
      </Text.Sans>

      <SettingsSection id="appstore-versions" icon={<Store />} title={t("App Store versions", "App Store 版本")}>
        <ListRowGroup>
          {versions.length === 0 && (
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowDescription wrap>{t("No App Store versions yet.", "暂无 App Store 版本。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          )}
          {versions.map((v, i) => {
            const date = shortDate(v.createdDate, locale);
            return (
              <ListRow key={`${v.versionString}-${i}`} variant="plain" interactive={false} data-testid="appstore-version">
                <ListRowBody>
                  <ListRowTop>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <ListRowTitle className="flex-none font-mono">{v.versionString ?? "—"}</ListRowTitle>
                      {v === current && <Badge appearance="outline" className="shrink-0">{t("Latest", "最新")}</Badge>}
                    </span>
                    {date && <ListRowMeta>{date}</ListRowMeta>}
                  </ListRowTop>
                  <ListRowBottom>
                    <ListRowDescription>
                      {REJECTED.has(v.appStoreState ?? "")
                        ? t("See App Store Connect for why.", "拒绝原因请查看 App Store Connect。")
                        : ""}
                    </ListRowDescription>
                    <StateBadge badge={appStoreStateBadge(v.appStoreState)} raw={v.appStoreState} />
                  </ListRowBottom>
                </ListRowBody>
              </ListRow>
            );
          })}
        </ListRowGroup>
      </SettingsSection>

      <SettingsSection id="appstore-beta-review" icon={<Plane />} title={t("TestFlight builds: beta review", "TestFlight 构建：测试审核")}>
        <ListRowGroup>
          {builds.length === 0 && (
            <ListRow variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowDescription wrap>{t("No builds on App Store Connect yet.", "App Store Connect 暂无构建。")}</ListRowDescription>
              </ListRowBody>
            </ListRow>
          )}
          {builds.map((bld, i) => {
            const date = shortDate(bld.uploadedDate, locale);
            const processing = bld.processingState && bld.processingState !== "VALID" ? bld.processingState : null;
            return (
              <ListRow key={`${bld.version}-${i}`} variant="plain" interactive={false} data-testid="appstore-build">
                <ListRowBody>
                  <ListRowTop>
                    <ListRowTitle className="font-mono">{bld.version ?? "—"}</ListRowTitle>
                    {date && <ListRowMeta>{date}</ListRowMeta>}
                  </ListRowTop>
                  <ListRowBottom>
                    <ListRowDescription>
                      {processing
                        ? t(`Apple: ${processing.toLowerCase()}`, `Apple：${PROCESSING_ZH[processing] ?? processing}`)
                        : t("Processed", "已处理")}
                    </ListRowDescription>
                    <StateBadge badge={betaReviewStateBadge(bld.betaReviewState)} raw={bld.betaReviewState} />
                  </ListRowBottom>
                </ListRowBody>
              </ListRow>
            );
          })}
        </ListRowGroup>
      </SettingsSection>
    </>
  );
}
