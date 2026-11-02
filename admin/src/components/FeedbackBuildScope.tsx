import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import type { FeedbackBuildScope } from "../lib/api";

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
  return (
    <SegmentedControl value={value} onValueChange={(next) => onChange(feedbackBuildScope(next))}
      aria-label="Report origin" className="w-fit">
      <SegmentedControlItem value="standard"><SegmentedControlLabel>App + unknown</SegmentedControlLabel></SegmentedControlItem>
      <SegmentedControlItem value="external"><SegmentedControlLabel>External</SegmentedControlLabel></SegmentedControlItem>
      <SegmentedControlItem value="all"><SegmentedControlLabel>All reports</SegmentedControlLabel></SegmentedControlItem>
    </SegmentedControl>
  );
}
