import { dashboardOrigin } from "./origin";

/** The dashboard origin for links in Play access alerts, or null when it is not configured. */
export function settingsOrigin(env: Env): string | null {
  try {
    return dashboardOrigin(env, () => "");
  } catch {
    return null;
  }
}
