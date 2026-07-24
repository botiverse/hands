import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Button, Input } from "raft-ui";
import {
  addChangelogLanguage,
  isValidChangelogLanguage,
  normalizeChangelogLanguage,
  parseChangelog,
  removeChangelogLanguage,
  serializeChangelog,
  updateChangelogEntry,
  type ChangelogDocument,
} from "../lib/changelogFormat";

const EDITOR_COMMANDS = new Set(["bold", "code", "unordered-list"]);
const PUBLIC_MARKDOWN_ELEMENTS = ["p", "ul", "li", "strong", "code"];
const MarkdownEditor = lazy(() => import("@uiw/react-md-editor/nohighlight"));
const MarkdownPreview = lazy(() =>
  import("@uiw/react-md-editor/nohighlight").then((module) => ({ default: module.default.Markdown })),
);

function MarkdownContent({ markdown }: { markdown: string }) {
  if (!markdown.trim()) {
    return <p className="text-sm text-slate-400">No release notes for this language.</p>;
  }
  return (
    <div data-color-mode="light">
      <Suspense fallback={<p className="text-sm text-slate-400">Loading preview…</p>}>
        <MarkdownPreview
          source={markdown}
          skipHtml
          allowedElements={PUBLIC_MARKDOWN_ELEMENTS}
          unwrapDisallowed
          className="!bg-transparent !text-sm !text-slate-700"
          style={{ padding: 0, overflowWrap: "anywhere" }}
        />
      </Suspense>
    </div>
  );
}

function LanguageTabs({
  document,
  activeLanguage,
  onChange,
}: {
  document: ChangelogDocument;
  activeLanguage: string;
  onChange: (language: string) => void;
}) {
  if (!document.localized) return null;
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="Release note languages">
      {document.entries.map((entry) => (
        <Button
          key={entry.language}
          type="button"
          size="sm"
          variant={entry.language === activeLanguage ? "default" : "ghost"}
          className="shrink-0 text-xs"
          onClick={() => onChange(entry.language)}
        >
          {entry.language}
        </Button>
      ))}
    </div>
  );
}

export function ChangelogViewer({
  value,
  compact = false,
}: {
  value: string;
  compact?: boolean;
}) {
  const document = useMemo(() => parseChangelog(value), [value]);
  const [activeLanguage, setActiveLanguage] = useState(document.entries[0]?.language ?? "default");
  useEffect(() => {
    if (!document.entries.some((entry) => entry.language === activeLanguage)) {
      setActiveLanguage(document.entries[0]?.language ?? "default");
    }
  }, [activeLanguage, document]);
  const active = document.entries.find((entry) => entry.language === activeLanguage) ?? document.entries[0];

  return (
    <div className="space-y-2">
      <LanguageTabs document={document} activeLanguage={activeLanguage} onChange={setActiveLanguage} />
      <div className={compact ? "max-h-40 overflow-y-auto pr-2" : undefined}>
        <MarkdownContent markdown={active?.markdown ?? ""} />
      </div>
    </div>
  );
}

export function ChangelogEditor({
  value,
  onChange,
  minHeight = 260,
}: {
  value: string;
  onChange: (value: string) => void;
  minHeight?: number;
}) {
  const document = useMemo(() => parseChangelog(value), [value]);
  const [activeLanguage, setActiveLanguage] = useState(document.entries[0]?.language ?? "default");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [newLanguage, setNewLanguage] = useState("");

  useEffect(() => {
    if (!document.entries.some((entry) => entry.language === activeLanguage)) {
      setActiveLanguage(document.entries[0]?.language ?? "default");
    }
  }, [activeLanguage, document]);

  const active = document.entries.find((entry) => entry.language === activeLanguage) ?? document.entries[0];
  const markdown = active?.markdown ?? "";
  const commit = (next: ChangelogDocument) => onChange(serializeChangelog(next));
  const setMarkdown = (next: string) => {
    commit(updateChangelogEntry(document, active?.language ?? "default", next));
  };

  const canonicalNewLanguage = normalizeChangelogLanguage(newLanguage);
  const languageCollision = document.entries.some(
    (entry) => normalizeChangelogLanguage(entry.language) === canonicalNewLanguage,
  );
  const languageValid = isValidChangelogLanguage(newLanguage) && !languageCollision;

  const addLanguage = () => {
    if (!languageValid) return;
    const next = addChangelogLanguage(document, canonicalNewLanguage);
    commit(next);
    setActiveLanguage(canonicalNewLanguage);
    setNewLanguage("");
  };

  const removeLanguage = () => {
    if (!document.localized || !active) return;
    const next = removeChangelogLanguage(document, active.language);
    commit(next);
    setActiveLanguage(next.entries[0]?.language ?? "default");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2 py-2">
        <LanguageTabs document={document} activeLanguage={activeLanguage} onChange={setActiveLanguage} />
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant={mode === "edit" ? "default" : "ghost"} onClick={() => setMode("edit")}>Edit</Button>
          <Button type="button" size="sm" variant={mode === "preview" ? "default" : "ghost"} onClick={() => setMode("preview")}>Preview</Button>
        </div>
      </div>

      {mode === "edit" ? (
        <div data-color-mode="light" className="changelog-markdown-editor">
          <Suspense fallback={<div className="px-3 py-4 text-sm text-slate-400" style={{ minHeight }}>Loading editor…</div>}>
            <MarkdownEditor
              value={markdown}
              onChange={(next) => setMarkdown(next ?? "")}
              preview="edit"
              height={minHeight}
              minHeight={minHeight}
              maxHeight={640}
              visibleDragbar
              overflow={false}
              commandsFilter={(command, isExtra) =>
                !isExtra && EDITOR_COMMANDS.has(command.name ?? "") ? command : false
              }
              textareaProps={{
                "aria-label": activeLanguage === "default"
                  ? "Release notes Markdown"
                  : `Release notes Markdown (${activeLanguage})`,
                placeholder: "- Fixed an issue\n- Improved **reliability**\n- Updated `runtime` behavior",
                spellCheck: true,
              }}
            />
          </Suspense>
        </div>
      ) : (
        <div className="overflow-y-auto px-4 py-3" style={{ minHeight }}>
          <MarkdownContent markdown={markdown} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-2 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Input
            className="max-w-44 bg-white text-xs"
            value={newLanguage}
            onChange={(event) => setNewLanguage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLanguage();
              }
            }}
            placeholder="Language, e.g. zh-CN"
            aria-label="New release note language"
          />
          <Button type="button" size="sm" variant="outline" className="text-xs" disabled={!languageValid} onClick={addLanguage}>
            Add language
          </Button>
          {document.localized && document.entries.length > 1 && (
            <Button type="button" size="sm" variant="ghost" className="text-xs text-red-600" onClick={removeLanguage}>
              Remove {activeLanguage}
            </Button>
          )}
        </div>
        <span className="shrink-0 text-xs text-slate-400">
          {document.localized ? `${document.entries.length} languages` : "single language"} · {Array.from(markdown).length} chars
        </span>
      </div>
      <p className="border-t border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-400">
        Editor powered by @uiw/react-md-editor. Public preview allows paragraphs, bullets, <strong>**bold**</strong>, and <code>`code`</code>; raw HTML and unsupported elements are not rendered.
      </p>
    </div>
  );
}
