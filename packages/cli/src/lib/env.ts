/**
 * Environment variables during the Quiver → Hands rebrand: prefer the new
 * `HANDS_<name>` and fall back to the legacy `QUIVER_<name>` so existing CI
 * (which sets e.g. `QUIVER_BEARER_TOKEN`) keeps working unchanged. Same
 * backward-compat approach as the X-Hands / X-Quiver request headers.
 */
export function readEnv(suffix: string): string | undefined {
  return process.env[`HANDS_${suffix}`] ?? process.env[`QUIVER_${suffix}`];
}
