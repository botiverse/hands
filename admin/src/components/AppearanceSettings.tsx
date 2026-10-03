import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  useTheme,
} from "raft-ui";
import type { Theme, ThemeMode } from "raft-ui";

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
        <div className="text-sm font-semibold text-foreground-strong">Theme</div>
        <SegmentedControl<Theme>
          value={theme}
          onValueChange={selectTheme}
          aria-label="Theme"
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
          Elegant uses the semantic surface palette; Brutal is the
          high-contrast, hard-edged family.
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-semibold text-foreground-strong">
          Dark mode
        </div>
        <SegmentedControl<ThemeMode>
          value={mode}
          onValueChange={(next) => setTheme("elegant", { mode: next })}
          aria-label="Dark mode"
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
              <SegmentedControlLabel>{option.label}</SegmentedControlLabel>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <p className="text-xs text-foreground-muted">
          {isElegant
            ? "System follows your OS setting; your choice is saved in this browser."
            : "Brutal is light-only — switch back to Elegant to use dark mode."}
        </p>
      </div>
    </div>
  );
}
