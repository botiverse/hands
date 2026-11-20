/**
 * Errors (/apps/:appId/errors): errors the app captured (kind=error),
 * grouped by signature. Opening a group shows it beside the list with its
 * tickets.
 */
import { AlertTriangle } from "lucide-react";
import { CrashGroupsPage } from "../components/CrashGroups";
import { useText } from "../lib/locale";

export function AppErrors({ appId }: { appId: string }) {
  const t = useText();
  return (
    <CrashGroupsPage
      appId={appId}
      kind="error"
      icon={<AlertTriangle aria-hidden="true" />}
      title={t("Errors", "错误")}
      empty={{
        title: t("No errors yet", "还没有错误"),
        description: t(
          "Errors the app reports are grouped here by signature: the type of error and where it happened in your code.",
          "应用上报的错误会按特征分组显示在这里：错误类型和代码中发生的位置。",
        ),
      }}
    />
  );
}
