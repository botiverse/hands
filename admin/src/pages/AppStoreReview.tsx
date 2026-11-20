import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  type BadgeProps,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  Skeleton,
} from "@botiverse/raft-ui";
import { getAppStoreReview, listApps, type App } from "../lib/api";
import { useText } from "../lib/locale";

/** The App Store page of an iOS app (/apps/:appId/appstore). */
export function AppStoreReview({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">{t("App Store review status", "App Store 审核状态")}</h1>
      </div>
      {app && app.platform === "ios" ? (
        <AppStoreReviewPanel appId={appId} app={app} />
      ) : app ? (
        <p className="text-sm text-foreground-muted">
          {t("This is only available for iOS apps.", "此功能仅适用于 iOS 应用。")}
        </p>
      ) : null}
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
  const t = useText();
  const badgeZh: Record<string, string> = { "Ready for sale": "已上架", "In review": "审核中", "Waiting for review": "等待审核", "Pending developer release": "等待开发者发布", "Pending Apple release": "等待 Apple 发布", "Preparing": "准备中", "Rejected": "已拒绝", "Metadata rejected": "元数据被拒绝", "Developer rejected": "开发者已撤回", "Unknown": "未知", "Approved": "已批准", "No beta review": "暂无测试审核" };
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
    <div className="border-t border-line-hairline pt-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">{t("App Store review status", "App Store 审核状态")}</div>
            {currentBadge && (
              <Badge variant={currentBadge.variant}>{t(currentBadge.label, badgeZh[currentBadge.label] ?? current?.appStoreState ?? currentBadge.label)}</Badge>
            )}
          </div>
          <div className="text-xs text-foreground-muted">
            {t("Live review state of this app's recent App Store versions and TestFlight builds, from App Store Connect. Read-only.", "从 App Store Connect 查看此应用近期 App Store 版本和 TestFlight 构建的实时审核状态。仅供查看。")}
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
            <EmptyStateTitle>{t("App Store Connect not configured", "尚未配置 App Store Connect")}</EmptyStateTitle>
            <EmptyStateDescription>
              {t("Add App Store Connect credentials under Integrations → TestFlight to see review status.", "请在“集成 → TestFlight”中添加 App Store Connect 凭据，以查看审核状态。")}
            </EmptyStateDescription>
          </EmptyState>
        ) : data?.bundle_id === null ? (
          <EmptyState>
            <EmptyStateTitle>{t("No App Store bundle ID configured", "尚未配置 App Store Bundle ID")}</EmptyStateTitle>
            <EmptyStateDescription>
              {t("Set the production App Store bundle ID on the", "请在")}{" "}
              <a
                href={`/apps/${appId}/channels`}
                className="underline font-medium"
              >
                {t("main channel", "main 渠道")}
              </a>{" "}
              {t("(Channels tab). Only the main channel's bundle ID is used — preview/nightly channels are ignored, so their beta bundle IDs won't be picked up here.", "（渠道页面）设置正式版 App Store Bundle ID。这里只使用 main 渠道的 Bundle ID，不会使用 preview 或 nightly 的测试版 Bundle ID。")}
            </EmptyStateDescription>
          </EmptyState>
        ) : data?.error ? (
          <div className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-strong">
            {t("Could not load review status from App Store Connect:", "无法从 App Store Connect 加载审核状态：")} {data.error}
            {data.bundle_id && (
              <div className="mt-1">
                {t("Bundle ID", "Bundle ID")} {" "}
                <span className="font-mono">{data.bundle_id}</span>{t(" is set on the main channel. If it doesn't match your App Store app, update it in", "设置在 main 渠道上。如果与 App Store 应用不一致，请在")}{" "}
                <a
                  href={`/apps/${appId}/channels`}
                  className="underline font-medium"
                >
                  {t("Channels", "渠道")}
                </a>
                {t(".", "中更新。")}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-xs font-medium text-foreground-muted mb-1">
                {t("Recent App Store versions", "近期 App Store 版本")}
              </div>
              {versions.length === 0 ? (
                <div className="text-xs text-foreground-hint">
                  {t("No App Store versions yet.", "暂无 App Store 版本。")}
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
                        <Badge variant={b.variant}>{t(b.label, badgeZh[b.label] ?? v.appStoreState ?? b.label)}</Badge>
                        {(v.appStoreState === "REJECTED" ||
                          v.appStoreState === "METADATA_REJECTED" ||
                          v.appStoreState === "DEVELOPER_REJECTED") && (
                          <span className="text-xs text-foreground-hint">
                            {t("(see App Store Connect for the rejection details)", "（拒绝详情请查看 App Store Connect）")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <div className="text-xs font-medium text-foreground-muted mb-1">
                {t("Recent TestFlight builds — beta review", "近期 TestFlight 构建 — 测试审核")}
              </div>
              {builds.length === 0 ? (
                <div className="text-xs text-foreground-hint">
                  {t("No builds on App Store Connect yet.", "App Store Connect 暂无构建。")}
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
                        <Badge variant={b.variant}>{t(b.label, badgeZh[b.label] ?? b.label)}</Badge>
                        {bld.processingState &&
                          bld.processingState !== "VALID" && (
                            <span className="text-xs text-foreground-hint">
                              {t(bld.processingState.toLowerCase(), ({ PROCESSING: "处理中", FAILED: "处理失败", INVALID: "无效" } as Record<string, string>)[bld.processingState] ?? bld.processingState)}
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

