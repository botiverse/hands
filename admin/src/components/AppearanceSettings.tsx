import {
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowTitle,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  useTheme,
} from "@botiverse/raft-ui";
import type { ThemeMode } from "@botiverse/raft-ui";
import { useText } from "../lib/locale";

const MODE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: [string, string] }> = [
  { value: "light", label: ["Light", "浅色"] },
  { value: "dark", label: ["Dark", "深色"] },
  { value: "system", label: ["System", "跟随系统"] },
];

/**
 * Appearance: light, dark or follow the system, as one settings row (it
 * applies at once). Raft has one look, so the mode is the only choice. The
 * app-level ThemeProvider (src/main.tsx) owns it, persists it through its
 * `storageKey` and mirrors it onto `document.documentElement`; index.html
 * restores it before first paint.
 */
export function AppearanceSettings() {
  const t = useText();
  const { mode, setMode } = useTheme();
  return (
    <ListRow variant="plain" interactive={false} className="flex-wrap" data-testid="appearance-settings">
      <ListRowBody className="min-w-48">
        <ListRowTitle id="appearance-mode-title">{t("Mode", "模式")}</ListRowTitle>
        <ListRowDescription wrap>
          {t("System follows your OS setting. Saved in this browser.", "跟随系统使用操作系统的设置。保存在当前浏览器中。")}
        </ListRowDescription>
      </ListRowBody>
      <SegmentedControl<ThemeMode>
        value={mode}
        onValueChange={setMode}
        aria-labelledby="appearance-mode-title"
        className="w-fit max-w-full shrink-0"
        data-testid="appearance-mode"
      >
        {MODE_OPTIONS.map((option) => (
          <SegmentedControlItem key={option.value} value={option.value} data-testid={`appearance-mode-${option.value}`}>
            <SegmentedControlLabel>{t(...option.label)}</SegmentedControlLabel>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </ListRow>
  );
}
