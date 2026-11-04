import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  useTheme,
} from "raft-ui";
import type { Theme, ThemeMode } from "raft-ui";
import { useText } from "../lib/locale";

const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "elegant", label: "Elegant" },
  { value: "brutal", label: "Brutal" },
];

const MODE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * Appearance controls: switches the RUI theme family (Elegant / Brutal) and,
 * for the Elegant family, the light/dark/system mode.
 *
 * Selections are owned by the app-level ThemeProvider (see src/main.tsx):
 * they persist through its `storageKey` / `modeStorageKey` and are mirrored
 * onto `document.documentElement`, so every theme-aware surface follows
 * immediately. The pre-paint restore script in index.html keeps first paint
 * consistent with the stored choice.
 */
export function AppearanceSettings() {
  const t = useText();
  const { theme, mode, setTheme } = useTheme();
  const isElegant = theme === "elegant";

  const selectTheme = (next: Theme) => {
    if (next === theme) return;
    if (next === "brutal") {
      // The provider pins Brutal to light mode by design.
      setTheme("brutal");
      return;
    }
    setTheme("elegant", { mode });
  };

  return (
    <div className="space-y-5" data-testid="appearance-settings">
      <div className="space-y-2">
        <div className="text-sm font-semibold text-foreground-strong">{t("Theme", "主题")}</div>
        <SegmentedControl<Theme>
          value={theme}
          onValueChange={selectTheme}
          aria-label={t("Theme", "主题")}
          className="w-fit max-w-full"
          data-testid="appearance-theme"
        >
          {THEME_OPTIONS.map((option) => (
            <SegmentedControlItem
              key={option.value}
              value={option.value}
              data-testid={`appearance-theme-${option.value}`}
            >
              <SegmentedControlLabel>{option.label}</SegmentedControlLabel>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <p className="text-xs text-foreground-muted">
          {t("Elegant uses the semantic surface palette; Brutal is the high-contrast, hard-edged family.", "Elegant 使用语义化界面色板；Brutal 使用高对比度、硬边风格。")}
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-semibold text-foreground-strong">
          {t("Dark mode", "深色模式")}
        </div>
        <SegmentedControl<ThemeMode>
          value={mode}
          onValueChange={(next) => setTheme("elegant", { mode: next })}
          aria-label={t("Dark mode", "深色模式")}
          className="w-fit max-w-full"
          disabled={!isElegant}
          data-testid="appearance-mode"
        >
          {MODE_OPTIONS.map((option) => (
            <SegmentedControlItem
              key={option.value}
              value={option.value}
              data-testid={`appearance-mode-${option.value}`}
            >
              <SegmentedControlLabel>{option.value === "light" ? t("Light", "浅色") : option.value === "dark" ? t("Dark", "深色") : t("System", "跟随系统")}</SegmentedControlLabel>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <p className="text-xs text-foreground-muted">
          {isElegant
            ? t("System follows your OS setting; your choice is saved in this browser.", "跟随系统使用操作系统的设置；你的选择会保存在当前浏览器中。")
            : t("Brutal is light-only — switch back to Elegant to use dark mode.", "Brutal 仅支持浅色；切回 Elegant 后可使用深色模式。")}
        </p>
      </div>
    </div>
  );
}
