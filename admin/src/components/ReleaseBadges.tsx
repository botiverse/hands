/**
 * Badges for a release's state and for who receives it, shared by the
 * Releases and Channels pages. A cancelled release can be restored, so no
 * state is red; partial rollouts are information, not warnings.
 */
import { Badge } from "@botiverse/raft-ui";
import type { Release } from "../lib/api";
import { useText } from "../lib/locale";

export function releaseStatusLabel(status: string, t: ReturnType<typeof useText>): string {
  const labels: Record<string, string> = {
    draft: t("Draft", "草稿"),
    active: t("Active", "生效中"),
    superseded: t("Superseded", "已替代"),
    cancelled: t("Cancelled", "已取消"),
  };
  return labels[status] ?? status;
}

/** The release's state; an active release rolled out to part of the devices shows the share. */
export function ReleaseStatusBadge({ release: r }: { release: Pick<Release, "status" | "rollout_cohort_count"> }) {
  const t = useText();
  const label = releaseStatusLabel(r.status, t);
  const partial = r.rollout_cohort_count != null && r.rollout_cohort_count < 100;
  if (r.status === "active") {
    return partial
      ? <Badge appearance="soft" variant="information">{`${label} · ${r.rollout_cohort_count}%`}</Badge>
      : <Badge appearance="soft" variant="success">{label}</Badge>;
  }
  if (r.status === "draft") return <Badge appearance="soft" variant="warning">{label}</Badge>;
  if (r.status === "superseded") return <Badge appearance="outline">{label}</Badge>;
  return <Badge appearance="soft" variant="muted">{label}</Badge>;
}

/** Who receives a live release: everyone, a share of devices, or a scope. */
export function RolloutBadge({ release: r }: { release: Pick<Release, "is_full" | "rollout_cohort_count"> }) {
  const t = useText();
  if (!r.is_full) return <Badge appearance="outline">{t("Scoped", "限定范围")}</Badge>;
  if (r.rollout_cohort_count != null && r.rollout_cohort_count < 100) {
    return <Badge appearance="soft" variant="information">{t(`${r.rollout_cohort_count}% rollout`, `已发布 ${r.rollout_cohort_count}%`)}</Badge>;
  }
  return <Badge appearance="soft" variant="success">{t("Everyone", "全部用户")}</Badge>;
}
