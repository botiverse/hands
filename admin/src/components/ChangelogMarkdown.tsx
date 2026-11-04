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
import { useText } from "../lib/locale";

const EDITOR_COMMANDS = new Set(["bold", "code", "unordered-list"]);
const PUBLIC_MARKDOWN_ELEMENTS = ["p", "ul", "li", "strong", "code"];
const MarkdownEditor = lazy(() => import("@uiw/react-md-editor/nohighlight"));
const MarkdownPreview = lazy(() =>
  import("@uiw/react-md-editor/nohighlight").then((module) => ({ default: module.default.Markdown })),
);

function MarkdownContent({ markdown }: { markdown: string }) {
  const t = useText();
  if (!markdown.trim()) {
    return <p className="text-sm text-foreground-hint">{t("No release notes for this language.", "此语言暂无更新说明。")}</p>;
  }
  return (
    <div data-color-mode="light">
      <Suspense fallback={<p className="text-sm text-foreground-hint">{t("Loading preview…", "正在加载预览…")}</p>}>
        <MarkdownPreview
          source={markdown}
          skipHtml
          allowedElements={PUBLIC_MARKDOWN_ELEMENTS}
          unwrapDisallowed
          className="!bg-transparent !text-sm !text-foreground-strong"
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
  const t = useText();
  if (!document.localized) return null;
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label={t("Release note languages", "更新说明语言")}>
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
  const t = useText();
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
  const toolbarLabels: Record<string, string> = {
    bold: t("Add bold text", "添加粗体文字"),
    code: t("Insert code", "插入代码"),
    "unordered-list": t("Add bulleted list", "添加项目列表"),
  };
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
    <div className="overflow-hidden rounded-lg border border-line-strong bg-layer-panel shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-muted bg-layer-canvas-muted px-2 py-2">
        <LanguageTabs document={document} activeLanguage={activeLanguage} onChange={setActiveLanguage} />
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant={mode === "edit" ? "default" : "ghost"} onClick={() => setMode("edit")}>{t("Edit", "编辑")}</Button>
          <Button type="button" size="sm" variant={mode === "preview" ? "default" : "ghost"} onClick={() => setMode("preview")}>{t("Preview", "预览")}</Button>
        </div>
      </div>

      {mode === "edit" ? (
        <div data-color-mode="light" className="changelog-markdown-editor">
          <Suspense fallback={<div className="px-3 py-4 text-sm text-foreground-hint" style={{ minHeight }}>{t("Loading editor…", "正在加载编辑器…")}</div>}>
            <MarkdownEditor
              value={markdown}
              onChange={(next) => setMarkdown(next ?? "")}
              preview="edit"
              height={minHeight}
              minHeight={minHeight}
              maxHeight={640}
              visibleDragbar
              overflow={false}
              commandsFilter={(command, isExtra) => {
                const name = command.name ?? "";
                if (isExtra || !EDITOR_COMMANDS.has(name)) return false;
                const label = toolbarLabels[name];
                return { ...command, buttonProps: { ...command.buttonProps, title: label, "aria-label": label } };
              }}
              textareaProps={{
                "aria-label": activeLanguage === "default"
                  ? t("Release notes Markdown", "更新说明 Markdown")
                  : t(`Release notes Markdown (${activeLanguage})`, `更新说明 Markdown（${activeLanguage}）`),
                placeholder: t("- Fixed an issue\n- Improved **reliability**\n- Updated `runtime` behavior", "- 修复了一个问题\n- 提高了**可靠性**\n- 更新了 `runtime` 行为"),
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

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-muted bg-layer-canvas-muted px-2 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Input
            className="max-w-44 bg-layer-panel text-xs"
            value={newLanguage}
            onChange={(event) => setNewLanguage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLanguage();
              }
            }}
            placeholder={t("Language, e.g. zh-CN", "语言，例如 zh-CN")}
            aria-label={t("New release note language", "新建更新说明语言")}
          />
          <Button type="button" size="sm" variant="outline" className="text-xs" disabled={!languageValid} onClick={addLanguage}>
            {t("Add language", "添加语言")}
          </Button>
          {document.localized && document.entries.length > 1 && (
            <Button type="button" size="sm" variant="ghost" className="text-xs text-danger" onClick={removeLanguage}>
              {t(`Remove ${activeLanguage}`, `移除 ${activeLanguage}`)}
            </Button>
          )}
        </div>
        <span className="shrink-0 text-xs text-foreground-hint">
          {document.localized ? t(`${document.entries.length} languages`, `${document.entries.length} 种语言`) : t("single language", "单一语言")} · {t(`${Array.from(markdown).length} chars`, `${Array.from(markdown).length} 个字符`)}
        </span>
      </div>
      <p className="border-t border-line-muted bg-layer-panel px-3 py-2 text-[11px] text-foreground-hint">
        {t("Public preview supports paragraphs, bullets,", "公开预览支持段落、列表、")} <strong>**{t("bold", "粗体")}**</strong>{t(", and", "和")} <code>`{t("code", "代码")}`</code>{t(". Raw HTML and unsupported elements are not shown.", "。原始 HTML 和不支持的元素不会显示。")}
      </p>
    </div>
  );
}
