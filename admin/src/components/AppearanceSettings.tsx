import {
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
 * Appearance: light, dark or follow the system. Raft has one look, so the
 * mode is the only choice. The app-level ThemeProvider (src/main.tsx) owns
 * it, persists it through its `storageKey` and mirrors it onto
 * `document.documentElement`; index.html restores it before first paint.
 */
export function AppearanceSettings() {
  const t = useText();
  const { mode, setMode } = useTheme();
  return (
    <div className="space-y-2" data-testid="appearance-settings">
      <div className="text-sm font-semibold text-foreground-strong">{t("Appearance", "外观")}</div>
      <SegmentedControl<ThemeMode>
        value={mode}
        onValueChange={setMode}
        aria-label={t("Appearance", "外观")}
        className="w-fit max-w-full"
        data-testid="appearance-mode"
      >
        {MODE_OPTIONS.map((option) => (
          <SegmentedControlItem key={option.value} value={option.value} data-testid={`appearance-mode-${option.value}`}>
            <SegmentedControlLabel>{t(...option.label)}</SegmentedControlLabel>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <p className="text-xs text-foreground-muted">
        {t("System follows your OS setting; your choice is saved in this browser.", "跟随系统使用操作系统的设置；你的选择会保存在当前浏览器中。")}
      </p>
    </div>
  );
}
