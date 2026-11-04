import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import type { FeedbackBuildScope } from "../lib/api";
import { useText } from "../lib/locale";

export function feedbackBuildScope(value: string | null): FeedbackBuildScope {
  return value === "external" || value === "all" ? value : "standard";
}

/** The reported bundle is a hint, not verified client identity. */
export function FeedbackBuildScopeSelector({
  value,
  onChange,
}: {
  value: FeedbackBuildScope;
  onChange: (value: FeedbackBuildScope) => void;
}) {
  const t = useText();
  return (
    <SegmentedControl value={value} onValueChange={(next) => onChange(feedbackBuildScope(next))}
      aria-label={t("Report origin", "报告来源")} className="w-fit">
      <SegmentedControlItem value="standard"><SegmentedControlLabel>{t("App + unknown", "本应用及未知来源")}</SegmentedControlLabel></SegmentedControlItem>
      <SegmentedControlItem value="external"><SegmentedControlLabel>{t("External", "外部构建")}</SegmentedControlLabel></SegmentedControlItem>
      <SegmentedControlItem value="all"><SegmentedControlLabel>{t("All reports", "所有报告")}</SegmentedControlLabel></SegmentedControlItem>
    </SegmentedControl>
  );
}
