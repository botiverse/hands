import { errorMessage } from "../lib/errorMessage";
/**
 * TestFlight tab — one place to see every Hands→Apple upload and distribution
 * request. Upload attempts are recorded as `testflight-upload` operations;
 * each successful one carries a
 * build_upload_id whose Apple state (PROCESSING → COMPLETE | FAILED) is
 * polled live, so the operation's "upload succeeded" is separated from
 * Apple's async accept/reject verdict. Group assignment/review attempts are
 * recorded as `testflight-publish` operations.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge, EmptyState, EmptyStateContent, EmptyStateIcon, EmptyStateTitle } from "raft-ui";
import { Plane } from "lucide-react";
import {
  listOperations,
  getTestflightPublishStatus,
  getTestflightUploadStatus,
  type Operation,
  type AscUploadState,
  type TestflightPublishState,
} from "../lib/api";
import { useText } from "../lib/locale";

const STATE_ZH: Record<string, string> = {
  pending: "等待中", in_progress: "进行中", success: "成功", failed: "失败", cancelled: "已取消",
  rejected: "已拒绝", expired: "已过期", processing_failed: "处理失败", blocked_export_compliance: "等待出口合规信息",
  not_applicable: "不适用", testing: "测试中", approved: "已批准", approved_not_notified: "已批准，尚未通知",
  internal: "内部", external: "外部",
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

export function Testflight({ appId }: { appId: string }) {
  const t = useText();
  const ops = useQuery({
    queryKey: ["operations", appId],
    queryFn: () => listOperations(appId, 100),
    refetchInterval: 10000,
  });

  const uploads = (ops.data?.operations ?? []).filter(
    (o) => o.kind === "testflight-upload",
  );
  const publishes = (ops.data?.operations ?? []).filter(
    (o) => o.kind === "testflight-publish",
  );

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold">TestFlight</h2>
        <p className="text-xs text-foreground-muted mt-1">
          {t("Hands→Apple uploads, processing, beta-group distribution, and review state. Configure the key in", "查看 Hands 向 Apple 上传、处理、测试组分发和审核的状态。在")}{" "}
          <a className="underline" href={`/apps/${appId}/integrations`}>
            {t("Integrations → TestFlight", "集成 → TestFlight")}
          </a>
          {t("; upload a build from the", "中配置密钥；从")}{" "}
          <a className="underline" href={`/apps/${appId}/builds`}>
            {t("Builds", "构建")}
          </a>{" "}
          {t("tab.", "页面上传构建。")}
        </p>
      </div>

      {ops.isLoading && <p className="text-foreground-muted text-sm">{t("Loading…", "加载中…")}</p>}
      {!ops.isLoading && uploads.length === 0 && publishes.length === 0 && (
        <EmptyState>
          <EmptyStateContent>
            <EmptyStateIcon>
              <Plane aria-hidden="true" />
            </EmptyStateIcon>
            <EmptyStateTitle>{t("No TestFlight activity yet", "暂无 TestFlight 活动")}</EmptyStateTitle>
          </EmptyStateContent>
        </EmptyState>
      )}

      {uploads.length > 0 && (
        <section className="mb-6">
          <h3 className="text-sm font-medium text-foreground-strong mb-2">{t("Uploads", "上传")}</h3>
          <div className="space-y-6">
            {uploads.map((op) => (
              <UploadRow key={op.id} appId={appId} op={op} />
            ))}
          </div>
        </section>
      )}

      {publishes.length > 0 && (
        <section>
          <h3 className="text-sm font-medium text-foreground-strong mb-2">{t("Distributions", "分发")}</h3>
          <div className="space-y-6">
            {publishes.map((op) => (
              <PublishRow key={op.id} appId={appId} op={op} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function UploadRow({ appId, op }: { appId: string; op: Operation }) {
  const t = useText();
  let input: UploadInput = {};
  let output: UploadOutput = {};
  try {
    input = JSON.parse(op.input || "{}");
  } catch {
    /* ignore */
  }
  try {
    output = JSON.parse(op.output || "{}");
  } catch {
    /* ignore */
  }
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
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="font-mono font-medium">
          {input.version_name ? `v${input.version_name}` : "—"}
          {input.version_code ? ` (${input.version_code})` : ""}
        </span>
        {input.bundle_id && <Badge variant="muted">{input.bundle_id}</Badge>}
        <StateBadge uploadFailed={uploadFailed} appleState={appleState} />
        {!uploadFailed && (
          <a
            className="text-xs underline text-info-strong"
            href={ascTestflightUrl(output.asc_app_id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("View in App Store Connect ↗", "在 App Store Connect 中查看 ↗")}
          </a>
        )}
        <span className="text-xs text-foreground-muted ml-auto">
          {new Date(op.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>

      {uploadFailed && op.error && (
        <p className="mt-1 text-xs text-danger font-mono break-all">
          {friendlyError(op.error)}
        </p>
      )}
      {appleState?.errors && appleState.errors.length > 0 && (
        <ul className="mt-1 text-xs text-danger list-disc pl-5">
          {appleState.errors.map((e, i) => (
            <li key={i}>
              {e.code ? `[${e.code}] ` : ""}
              {e.description}
            </li>
          ))}
        </ul>
      )}
      {appleState?.state === "COMPLETE" && (
        <p className="mt-1 text-xs text-success-strong">
          {t("Upload processed. Ready for group distribution. Inspect the build in", "上传已处理完成，可以分发给测试组。在")}{" "}
          <a
            className="underline"
            href={ascTestflightUrl(output.asc_app_id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            App Store Connect → TestFlight
          </a>
          {t(".", "中查看构建。")}
        </p>
      )}
    </section>
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

function PublishRow({ appId, op }: { appId: string; op: Operation }) {
  const t = useText();
  let input: PublishInput = {};
  let output: PublishOutput = {};
  try {
    input = JSON.parse(op.input || "{}");
  } catch {
    /* ignore */
  }
  try {
    output = JSON.parse(op.output || "{}");
  } catch {
    /* ignore */
  }
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
  const badgeVariant =
    failed || blocked
      ? "danger"
      : state === "testing"
        ? "success"
        : "information";
  const localizationLocales = (current.localizations ?? [])
    .map((item) => item.locale)
    .filter((locale): locale is string => Boolean(locale));

  return (
    <section className="border-t border-line-hairline pt-5">
      <div className="flex items-center gap-3 flex-wrap text-sm">
        <span className="font-mono font-medium">
          {current.version
            ? `v${current.version}`
            : input.hands_build_id?.slice(0, 8) ?? "—"}
          {current.build_number ? ` (${current.build_number})` : ""}
        </span>
        {input.distribution && (
          <Badge variant="muted">{t(input.distribution, STATE_ZH[input.distribution] ?? input.distribution)}</Badge>
        )}
        <Badge variant={badgeVariant}>{t(state, STATE_ZH[state] ?? state)}</Badge>
        {current.beta_review?.state && (
          <Badge variant="muted">
            {t("review:", "审核：")} {current.beta_review.state}
          </Badge>
        )}
        {current.beta_detail?.auto_notify_enabled && (
          <Badge variant="muted">{t("auto notify on", "已开启自动通知")}</Badge>
        )}
        <span className="text-xs text-foreground-muted ml-auto">
          {new Date(op.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>
      {current.assigned_groups && current.assigned_groups.length > 0 && (
        <p className="mt-1 text-xs text-foreground">
          {t("Groups:", "测试组：")} {current.assigned_groups.map((group) => group.name ?? group.id).join(", ")}
        </p>
      )}
      {localizationLocales.length > 0 && (
        <p className="mt-1 text-xs text-foreground">
          {t("What to Test:", "测试说明：")} {localizationLocales.join(", ")}
        </p>
      )}
      {current.expiration_date && (
        <p className="mt-1 text-xs text-foreground-muted">
          {t("Expires:", "过期日期：")} {new Date(current.expiration_date).toISOString().slice(0, 10)}
        </p>
      )}
      {output.notification && (
        <p className="mt-1 text-xs text-foreground">
          {t("Notification action:", "通知操作：")} {output.notification}
        </p>
      )}
      {failed && op.error && (
        <p className="mt-1 text-xs text-danger font-mono break-all">
          {friendlyError(op.error)}
        </p>
      )}
      {liveStatus.isError && !failed && (
        <p className="mt-1 text-xs text-danger">
          {t("Live state refresh failed:", "实时状态刷新失败：")} {friendlyError(liveStatus.error)}
        </p>
      )}
    </section>
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
    return <Badge variant="danger">{t("upload failed", "上传失败")}</Badge>;
  }
  const s = appleState?.state;
  if (!s) return <Badge variant="muted">{t("uploaded", "已上传")}</Badge>;
  if (s === "COMPLETE")
    return <Badge variant="success">{t("complete", "已完成")}</Badge>;
  if (s === "FAILED")
    return <Badge variant="danger">{t("Apple rejected", "Apple 已拒绝")}</Badge>;
  return <Badge variant="information">{t("Apple processing…", "Apple 处理中…")}</Badge>;
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
