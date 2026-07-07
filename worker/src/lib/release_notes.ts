export type ReleaseNotes = Record<string, string>;

export function normalizeReleaseNotesKey(key: string): string {
  const raw = key.trim();
  const lower = raw.toLowerCase();
  if (lower === "zh" || lower === "cn" || lower === "zh-cn") return "zh-CN";
  if (lower === "zh-hans") return "zh-CN";
  if (lower === "zh-tw" || lower === "zh-hant") return "zh-TW";
  if (lower === "en" || lower === "en-us") return "en";
  return raw;
}

export function normalizeReleaseNotes(value: unknown): ReleaseNotes | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const notes: ReleaseNotes = {};
  for (const [key, note] of Object.entries(value)) {
    if (typeof note !== "string") continue;
    const trimmed = note.trim();
    if (!trimmed) continue;
    notes[normalizeReleaseNotesKey(key)] = trimmed;
  }
  return Object.keys(notes).length > 0 ? notes : null;
}

export function parseReleaseNotes(raw: string | null): ReleaseNotes | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return null;
  try {
    return normalizeReleaseNotes(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function stringifyReleaseNotes(value: unknown): string | null {
  const normalized = normalizeReleaseNotes(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export function resolveReleaseNote(raw: string | null, lang: string | null): string | null {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  let notes: ReleaseNotes | null;
  try {
    notes = normalizeReleaseNotes(JSON.parse(trimmed));
  } catch {
    return raw;
  }
  if (!notes) return null;
  const entries = Object.entries(notes).filter(([, value]) => value.length > 0);
  if (entries.length === 0) return null;
  const lower = (lang ?? "").toLowerCase();
  const exact = entries.find(([key]) => key.toLowerCase() === lower);
  if (exact) return exact[1];
  const prefix = lower.split("-")[0];
  if (prefix) {
    const partial = entries.find(([key]) => key.toLowerCase().split("-")[0] === prefix);
    if (partial) return partial[1];
  }
  const en = entries.find(([key]) => key.toLowerCase().split("-")[0] === "en");
  return (en ?? entries[0]!)[1];
}
