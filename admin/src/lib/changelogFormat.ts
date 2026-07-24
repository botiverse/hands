export type ChangelogEntry = {
  language: string;
  markdown: string;
};

export type ChangelogDocument = {
  localized: boolean;
  entries: ChangelogEntry[];
};

const LANGUAGE_PRIORITY = ["zh-CN", "zh-TW", "en", "ja", "ko"];
const LANGUAGE_CODE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** Keep this alias contract in lockstep with worker/src/lib/release_notes.ts. */
export function normalizeChangelogLanguage(language: string): string {
  const raw = language.trim();
  const lower = raw.toLowerCase();
  if (lower === "zh" || lower === "cn" || lower === "zh-cn" || lower === "zh-hans") {
    return "zh-CN";
  }
  if (lower === "zh-tw" || lower === "zh-hant") return "zh-TW";
  if (lower === "en" || lower === "en-us") return "en";
  return raw;
}

export function isValidChangelogLanguage(language: string): boolean {
  const normalized = normalizeChangelogLanguage(language);
  return normalized !== "default" && LANGUAGE_CODE.test(normalized);
}

function changelogLanguageIdentity(language: string): string {
  return normalizeChangelogLanguage(language).toLowerCase();
}

function orderLanguages(a: string, b: string): number {
  const ai = LANGUAGE_PRIORITY.indexOf(a);
  const bi = LANGUAGE_PRIORITY.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return a.localeCompare(b);
}

export function parseChangelog(value: string | null | undefined): ChangelogDocument {
  const raw = value ?? "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0 &&
      Object.values(parsed).every((entry) => typeof entry === "string")
    ) {
      // Worker normalization is storage-order last-write-wins. Canonicalize in
      // that same order first; sorting aliases before reduction would change
      // which public value wins merely by opening and saving this editor.
      const canonical = new Map<string, string>();
      for (const [language, markdown] of Object.entries(parsed as Record<string, string>)) {
        const key = normalizeChangelogLanguage(language);
        // Worker ignores blank notes rather than letting a blank alias erase a
        // prior public value. Preserve an empty-only language so the editor can
        // fill it, but once a non-blank value exists only a later non-blank
        // alias may replace it.
        if (!markdown.trim() && canonical.has(key)) continue;
        canonical.set(key, markdown);
      }

      // Worker keeps generic BCP-47 keys verbatim, so differently-cased keys
      // (for example pt-BR and PT-br) remain separate. Its resolver then uses
      // a case-insensitive first-match in storage order. Collapse that second
      // identity layer before UI sorting: the first non-blank public value
      // wins, while an empty-only language remains editable. This prevents a
      // no-op Admin save from changing the public winner merely by reordering
      // two case variants.
      const publicIdentities = new Map<string, [string, string]>();
      for (const [language, markdown] of canonical) {
        const identity = changelogLanguageIdentity(language);
        const existing = publicIdentities.get(identity);
        if (!existing || (!existing[1].trim() && markdown.trim())) {
          publicIdentities.set(identity, [language, markdown]);
        }
      }
      return {
        localized: true,
        entries: [...publicIdentities.values()]
          .sort(([a], [b]) => orderLanguages(a, b))
          .map(([language, markdown]) => ({ language, markdown })),
      };
    }
  } catch {
    // Plain Markdown is the legacy and single-language representation.
  }

  return {
    localized: false,
    entries: [{ language: "default", markdown: raw }],
  };
}

export function serializeChangelog(document: ChangelogDocument): string {
  if (!document.localized) return document.entries[0]?.markdown ?? "";
  return JSON.stringify(
    Object.fromEntries(
      document.entries.map(({ language, markdown }) => [normalizeChangelogLanguage(language), markdown]),
    ),
  );
}

export function updateChangelogEntry(
  document: ChangelogDocument,
  language: string,
  markdown: string,
): ChangelogDocument {
  const canonical = normalizeChangelogLanguage(language);
  return {
    ...document,
    entries: document.entries.map((entry) =>
      entry.language === canonical ? { ...entry, markdown } : entry,
    ),
  };
}

export function addChangelogLanguage(
  document: ChangelogDocument,
  language: string,
): ChangelogDocument {
  const canonical = normalizeChangelogLanguage(language);
  if (
    !isValidChangelogLanguage(canonical) ||
    document.entries.some(
      (entry) => changelogLanguageIdentity(entry.language) === changelogLanguageIdentity(canonical),
    )
  ) {
    return document;
  }
  if (!document.localized) {
    // Legacy plain notes have always been the public English/default fallback.
    // Converting to localized storage must preserve that meaning; adding zh-CN
    // creates an empty zh-CN entry instead of relabeling the English text.
    const english = { language: "en", markdown: document.entries[0]?.markdown ?? "" };
    return {
      localized: true,
      entries: canonical === "en"
        ? [english]
        : [english, { language: canonical, markdown: "" }].sort((a, b) =>
            orderLanguages(a.language, b.language)),
    };
  }
  return {
    localized: true,
    entries: [...document.entries, { language: canonical, markdown: "" }]
      .sort((a, b) => orderLanguages(a.language, b.language)),
  };
}

export function removeChangelogLanguage(
  document: ChangelogDocument,
  language: string,
): ChangelogDocument {
  if (!document.localized || document.entries.length <= 1) return document;
  const identity = changelogLanguageIdentity(language);
  const entries = document.entries.filter(
    (entry) => changelogLanguageIdentity(entry.language) !== identity,
  );
  return { localized: true, entries };
}
