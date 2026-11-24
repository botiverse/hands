/**
 * Per-app rules that classify incoming crash and error reports as noise.
 *
 * A rule matches on what a report carries (kind, crash group signature, the
 * Android exit info the SDK records, channel, device, version) and either
 * closes the ticket as not_planned ("close") or keeps it open but out of
 * real-time alerts ("mute"). The report is always stored, and the ticket's
 * metadata names the rule (`hands_rule`). A rule protects high-risk exits by
 * default: native crashes, ANRs and Java exceptions never match unless the
 * rule turns protection off. Rules start disabled; preview a rule against
 * past tickets before enabling it.
 */

export type FeedbackRuleMatch = {
  kinds?: string[];
  /** Exact, or a prefix ending in "*". */
  signatures?: string[];
  crash_types?: string[];
  exit_reason_codes?: number[];
  exit_statuses?: number[];
  exit_importance_min?: number;
  exit_importance_max?: number;
  foreground?: boolean;
  channels?: string[];
  /** Case-insensitive; matches device_brand or device_manufacturer. */
  device_brands?: string[];
  /** Case-insensitive; exact, or a prefix ending in "*". */
  device_models?: string[];
  version_code_min?: number;
  version_code_max?: number;
};

export type FeedbackRuleAction = "close" | "mute";

export type FeedbackRule = {
  id: string;
  app_id: string;
  name: string;
  enabled: boolean;
  action: FeedbackRuleAction;
  match: FeedbackRuleMatch;
  protect_high_risk: boolean;
  hits: number;
  last_hit_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

type Row = {
  id: string; app_id: string; name: string; enabled: number; action: string; match_json: string;
  protect_high_risk: number; hits: number; last_hit_at: number | null; created_by: string | null;
  created_at: number; updated_at: number;
};

export function ruleFromRow(row: Row): FeedbackRule {
  let match: FeedbackRuleMatch = {};
  try { match = JSON.parse(row.match_json) as FeedbackRuleMatch; } catch { match = {}; }
  return {
    id: row.id, app_id: row.app_id, name: row.name, enabled: row.enabled === 1,
    action: row.action === "mute" ? "mute" : "close", match, protect_high_risk: row.protect_high_risk !== 0,
    hits: Number(row.hits ?? 0), last_hit_at: row.last_hit_at, created_by: row.created_by,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

const STRING_LISTS = ["kinds", "signatures", "crash_types", "channels", "device_brands", "device_models"] as const;
const NUMBER_LISTS = ["exit_reason_codes", "exit_statuses"] as const;
const NUMBERS = ["exit_importance_min", "exit_importance_max", "version_code_min", "version_code_max"] as const;
const KNOWN = new Set<string>([...STRING_LISTS, ...NUMBER_LISTS, ...NUMBERS, "foreground"]);

/** Validates a rule's match; at least one condition besides kinds is required. */
export function validateMatch(value: unknown): { match: FeedbackRuleMatch } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "match must be an object" };
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!KNOWN.has(key)) return { error: `match has an unknown condition: ${key}` };
  const out: FeedbackRuleMatch = {};
  for (const key of STRING_LISTS) {
    const v = input[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0 || v.length > 50 || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) {
      return { error: `match.${key} must be a non-empty list of strings` };
    }
    (out as Record<string, unknown>)[key] = v;
  }
  for (const key of NUMBER_LISTS) {
    const v = input[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0 || v.length > 50 || !v.every((x) => Number.isInteger(x))) {
      return { error: `match.${key} must be a non-empty list of integers` };
    }
    (out as Record<string, unknown>)[key] = v;
  }
  for (const key of NUMBERS) {
    const v = input[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v)) return { error: `match.${key} must be an integer` };
    (out as Record<string, unknown>)[key] = v;
  }
  if (input.foreground !== undefined) {
    if (typeof input.foreground !== "boolean") return { error: "match.foreground must be true or false" };
    out.foreground = input.foreground;
  }
  const conditions = Object.keys(out).filter((k) => k !== "kinds");
  if (conditions.length === 0) return { error: "match needs at least one condition besides kinds" };
  return { match: out };
}

/** What a rule sees of a report. */
export type ReportFacts = {
  kind: string;
  signature: string | null;
  channel: string | null;
  device_model: string | null;
  version_code: number | null;
  metadata: Record<string, unknown>;
};

const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};
const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const pattern = (entry: string, value: string) =>
  entry.endsWith("*") ? value.startsWith(entry.slice(0, -1)) : value === entry;

/** Native crashes, ANRs and Java exceptions, including system exits that report them. */
export function isHighRiskExit(facts: ReportFacts): boolean {
  const type = lower(facts.metadata.crash_type);
  if (type === "anr" || type === "native" || type === "native_crash" || type === "java_exception") return true;
  const reason = lower(facts.metadata.crash_exit_reason ?? facts.metadata.crash_reason);
  if (reason === "anr" || reason === "crash" || reason === "crash_native") return true;
  // Android exit reason codes: 4 CRASH, 5 CRASH_NATIVE, 6 ANR.
  const code = int(facts.metadata.crash_exit_reason_code);
  return code === 4 || code === 5 || code === 6;
}

export function ruleMatches(rule: Pick<FeedbackRule, "match" | "protect_high_risk">, facts: ReportFacts): boolean {
  const m = rule.match;
  if (facts.kind !== "crash" && facts.kind !== "error") return false;
  if (rule.protect_high_risk && isHighRiskExit(facts)) return false;
  if (m.kinds && !m.kinds.includes(facts.kind)) return false;
  if (m.signatures && !(facts.signature && m.signatures.some((s) => pattern(s, facts.signature!)))) return false;
  if (m.crash_types && !m.crash_types.includes(lower(facts.metadata.crash_type))) return false;
  if (m.exit_reason_codes) {
    const code = int(facts.metadata.crash_exit_reason_code);
    if (code === null || !m.exit_reason_codes.includes(code)) return false;
  }
  if (m.exit_statuses) {
    const status = int(facts.metadata.crash_exit_status);
    if (status === null || !m.exit_statuses.includes(status)) return false;
  }
  if (m.exit_importance_min !== undefined || m.exit_importance_max !== undefined) {
    const importance = int(facts.metadata.crash_exit_importance);
    if (importance === null) return false;
    if (m.exit_importance_min !== undefined && importance < m.exit_importance_min) return false;
    if (m.exit_importance_max !== undefined && importance > m.exit_importance_max) return false;
  }
  if (m.foreground !== undefined && facts.metadata.crash_foreground !== m.foreground) return false;
  if (m.channels && !(facts.channel && m.channels.includes(facts.channel))) return false;
  if (m.device_brands) {
    const brands = [lower(facts.metadata.device_brand), lower(facts.metadata.device_manufacturer)].filter(Boolean);
    if (!m.device_brands.some((b) => brands.includes(b.toLowerCase()))) return false;
  }
  if (m.device_models) {
    const model = lower(facts.device_model ?? facts.metadata.device_model);
    if (!model || !m.device_models.some((p) => pattern(p.toLowerCase(), model))) return false;
  }
  if (m.version_code_min !== undefined || m.version_code_max !== undefined) {
    if (facts.version_code === null) return false;
    if (m.version_code_min !== undefined && facts.version_code < m.version_code_min) return false;
    if (m.version_code_max !== undefined && facts.version_code > m.version_code_max) return false;
  }
  return true;
}

/** The app's enabled rules, oldest first; the first match decides. */
export async function enabledRules(db: D1Database, appId: string): Promise<FeedbackRule[]> {
  const { results } = await db.prepare(
    "SELECT * FROM feedback_rules WHERE app_id = ?1 AND enabled = 1 ORDER BY created_at, id",
  ).bind(appId).all<Row>();
  return results.map(ruleFromRow);
}

export function firstMatch(rules: FeedbackRule[], facts: ReportFacts): FeedbackRule | null {
  return rules.find((rule) => ruleMatches(rule, facts)) ?? null;
}
