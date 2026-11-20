/**
 * Contents of a build's APK or IPA, in the build's side column: what takes
 * the space (size by category), the SDKs and libraries it ships, its
 * permissions and other components, and a comparison with the previous
 * build of the same product type (what grew, what was added or removed).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  ListRow,
  ListRowBody,
  ListRowGroup,
  ListRowSubtitle,
  ListRowTitle,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Skeleton,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import {
  ApiError,
  getBuildInventory,
  getBuildInventoryDiff,
  refreshBuildInventory,
  type BuildInventory,
  type InventoryDiff,
  type InventoryLibrary,
} from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { formatBuildAssetSize } from "../lib/buildAssetDisplay";
import { useLocale, useText } from "../lib/locale";
import { useToast } from "./Toast";

type T = ReturnType<typeof useText>;
type Locale = "en" | "zh-CN";

const LIBRARY_ROWS = 12;
const COMPONENT_ROWS = 8;

export function formatSignedSize(delta: number, locale: Locale): string {
  if (delta === 0) return locale === "zh-CN" ? "无变化" : "no change";
  return `${delta > 0 ? "+" : "−"}${formatBuildAssetSize(Math.abs(delta), locale)}`;
}

function componentLabel(key: string, t: T): string {
  const labels: Record<string, [string, string]> = {
    permissions: ["Permissions", "权限"],
    declared_permissions: ["Declared permissions", "声明的权限"],
    features: ["Hardware features", "硬件特性"],
    activities: ["Activities", "Activity"],
    services: ["Services", "服务"],
    receivers: ["Broadcast receivers", "广播接收器"],
    providers: ["Content providers", "内容提供者"],
    meta_data: ["Manifest meta-data keys", "清单 meta-data 键"],
    background_modes: ["Background modes", "后台模式"],
    url_schemes: ["URL schemes", "URL Scheme"],
    queries_schemes: ["Queried URL schemes", "查询的 URL Scheme"],
    ats_exceptions: ["App Transport Security exceptions", "App Transport Security 例外"],
    extensions: ["App extensions", "App 扩展"],
    entitlements: ["Entitlements", "权利（Entitlements）"],
  };
  const l = labels[key];
  return l ? t(l[0], l[1]) : key;
}

function kindLabel(kind: string, t: T): string {
  if (kind === "dex-package") return t("Java/Kotlin package", "Java/Kotlin 包");
  if (kind === "native") return t("Native library", "原生库");
  if (kind === "framework") return t("Framework", "框架");
  if (kind === "extension") return t("Extension", "扩展");
  return kind;
}

function isMissing(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 404 && (e.body as { code?: string } | null)?.code === "INVENTORY_MISSING";
}

export function BuildContents({ appId, buildId }: { appId: string; buildId: string }) {
  const t = useText();
  const [view, setView] = useState<"build" | "compare">("build");
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl<"build" | "compare">
        aria-label={t("Contents view", "内容视图")}
        value={view}
        onValueChange={(v) => setView(v)}
      >
        <SegmentedControlItem value="build">
          <SegmentedControlLabel>{t("This build", "本构建")}</SegmentedControlLabel>
        </SegmentedControlItem>
        <SegmentedControlItem value="compare">
          <SegmentedControlLabel>{t("Compare with previous", "与上一构建比较")}</SegmentedControlLabel>
        </SegmentedControlItem>
      </SegmentedControl>
      {view === "build" ? <InventoryView appId={appId} buildId={buildId} /> : <DiffView appId={appId} buildId={buildId} />}
    </div>
  );
}

function useRefresh(appId: string) {
  const t = useText();
  const toast = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (buildId: string) => refreshBuildInventory(appId, buildId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["build-inventory", appId] });
      qc.invalidateQueries({ queryKey: ["build-inventory-diff", appId] });
    },
    onError: (e) => toast.show({ kind: "error", title: t("Could not read the package", "无法读取安装包"), description: errorMessage(e) }),
  });
}

function InventoryView({ appId, buildId }: { appId: string; buildId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const refresh = useRefresh(appId);
  const q = useQuery({
    queryKey: ["build-inventory", appId, buildId],
    queryFn: () => getBuildInventory(appId, buildId),
    retry: false,
  });
  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (q.error) {
    if (isMissing(q.error)) {
      return (
        <div className="flex flex-col items-start gap-2">
          <Text.Sans size="small" variant="muted">
            {t("Contents have not been read for this build yet. Builds uploaded from now on get them automatically.", "尚未读取此构建的内容。今后上传的构建会自动读取。")}
          </Text.Sans>
          <Button variant="default" loading={refresh.isPending} loadingLabel={t("Reading package…", "正在读取安装包…")} onClick={() => refresh.mutate(buildId)}>
            {t("Read contents", "读取内容")}
          </Button>
        </div>
      );
    }
    return <Text.Sans size="small" variant="warning">{t("Could not load contents:", "无法加载内容：")} {errorMessage(q.error)}</Text.Sans>;
  }
  const data = q.data!;
  const inv = data.inventory;
  return (
    <div className="flex flex-col gap-5">
      <Text.Sans size="small" variant="muted">
        {t(
          `${formatBuildAssetSize(inv.total_bytes, locale)} package · ${formatBuildAssetSize(inv.uncompressed_bytes, locale)} uncompressed · ${inv.file_count.toLocaleString(locale)} files`,
          `安装包 ${formatBuildAssetSize(inv.total_bytes, locale)} · 解压后 ${formatBuildAssetSize(inv.uncompressed_bytes, locale)} · ${inv.file_count.toLocaleString(locale)} 个文件`,
        )}
      </Text.Sans>
      <SizeBreakdown inventory={inv} />
      {inv.sdks.length > 0 && (
        <Group title={t("Known SDKs", "已识别的 SDK")}>
          <div className="flex flex-wrap gap-1.5">
            {inv.sdks.map((s) => (
              <Badge key={s.name} appearance="outline">
                {s.name} · {formatBuildAssetSize(s.compressed_bytes, locale)}
              </Badge>
            ))}
          </div>
        </Group>
      )}
      <LibraryList inventory={inv} />
      <Components components={inv.components} />
      {inv.notes.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-footnote text-foreground-hint">
          {inv.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text.Sans size="small" variant="muted">
          {t("Read", "读取于")} {new Date(data.computed_at).toLocaleString(locale)}
        </Text.Sans>
        <TextLink onClick={() => refresh.mutate(buildId)} aria-disabled={refresh.isPending || undefined}>
          {refresh.isPending ? t("Reading…", "读取中…") : t("Read again", "重新读取")}
        </TextLink>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Text.Sans render={<h4 />} size="small" className="font-medium">{title}</Text.Sans>
      {children}
    </div>
  );
}

function SizeBreakdown({ inventory: inv }: { inventory: BuildInventory }) {
  const t = useText();
  const { locale } = useLocale();
  const total = inv.categories.reduce((s, c) => s + c.compressed_bytes, 0) || 1;
  return (
    <Group title={t("Size by category (in the package)", "按类别的大小（安装包内）")}>
      <ul className="flex flex-col gap-2" aria-label={t("Size by category", "按类别的大小")}>
        {inv.categories.map((c) => {
          const share = c.compressed_bytes / total;
          return (
            <li key={c.key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-footnote">
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                <span className="shrink-0 font-mono text-foreground-hint">
                  {formatBuildAssetSize(c.compressed_bytes, locale)} · {Math.round(share * 100)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-(--fill-muted)" aria-hidden="true">
                <div className="h-full rounded-full bg-(--info)" style={{ width: `${Math.max(share * 100, 0.5)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Group>
  );
}

function libraryDetail(l: InventoryLibrary, t: T, locale: Locale): string {
  return [
    kindLabel(l.kind, t),
    l.version ? `v${l.version}` : null,
    l.classes != null ? t(`${l.classes.toLocaleString(locale)} classes`, `${l.classes.toLocaleString(locale)} 个类`) : null,
    l.abis?.length ? l.abis.join(", ") : null,
    l.sdk,
  ].filter(Boolean).join(" · ");
}

/** Whether package names came from the R8 mapping, or why they look minified. */
function MappingNote({ inventory: inv }: { inventory: BuildInventory }) {
  const t = useText();
  const { locale } = useLocale();
  if (inv.platform !== "android") return null;
  if (inv.mapping?.used) {
    const n = inv.mapping.classes_mapped.toLocaleString(locale);
    return (
      <Text.Sans size="small" variant="muted">
        {t(`Names restored with the R8 mapping (${n} classes).`, `已用 R8 mapping 还原名称（${n} 个类）。`)}
      </Text.Sans>
    );
  }
  if (inv.dex?.obfuscated) {
    return (
      <Text.Sans size="small" variant="warning">
        {t(
          "This build is obfuscated by R8, so packages show minified names. Upload its mapping.txt to see library names.",
          "此构建经过 R8 混淆，包名为混淆后的名称。上传它的 mapping.txt 即可看到库名。",
        )}
      </Text.Sans>
    );
  }
  return null;
}

function LibraryList({ inventory: inv }: { inventory: BuildInventory }) {
  const t = useText();
  const { locale } = useLocale();
  const [all, setAll] = useState(false);
  if (inv.libraries.length === 0) return null;
  const rows = [...inv.libraries].sort((a, b) => (b.compressed_bytes ?? b.bytes) - (a.compressed_bytes ?? a.bytes));
  const shown = all ? rows : rows.slice(0, LIBRARY_ROWS);
  return (
    <Group title={t("Libraries", "库")}>
      {inv.platform === "android" && (
        <Text.Sans size="small" variant="muted">
          {t("Package sizes are estimates: each dex file's size split by its packages' share of code.", "包大小为估算值：按各包代码占比拆分每个 dex 文件的大小。")}
        </Text.Sans>
      )}
      <MappingNote inventory={inv} />
      <ListRowGroup>
        {shown.map((l) => (
          <ListRow key={`${l.kind}:${l.name}`} variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle className="whitespace-normal font-mono text-footnote [overflow-wrap:anywhere]">{l.name}</ListRowTitle>
              <ListRowSubtitle className="whitespace-normal">{libraryDetail(l, t, locale)}</ListRowSubtitle>
            </ListRowBody>
            <span className="shrink-0 font-mono text-footnote text-foreground-hint">
              {l.estimated ? "≈ " : ""}{formatBuildAssetSize(l.compressed_bytes ?? l.bytes, locale)}
            </span>
          </ListRow>
        ))}
      </ListRowGroup>
      {rows.length > LIBRARY_ROWS && (
        <TextLink onClick={() => setAll((v) => !v)}>
          {all ? t("Show fewer", "收起") : t(`Show all ${rows.length}`, `显示全部 ${rows.length} 个`)}
        </TextLink>
      )}
    </Group>
  );
}

function Components({ components }: { components: Record<string, string[]> }) {
  const t = useText();
  const keys = Object.keys(components).filter((k) => components[k]!.length > 0);
  if (keys.length === 0) return null;
  return (
    <Group title={t("Components and capabilities", "组件与能力")}>
      <div className="flex flex-col gap-3">
        {keys.map((k) => <ComponentList key={k} title={componentLabel(k, t)} items={components[k]!} />)}
      </div>
    </Group>
  );
}

function ComponentList({ title, items }: { title: string; items: string[] }) {
  const t = useText();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, COMPONENT_ROWS);
  return (
    <div className="flex flex-col gap-1">
      <Text.Sans size="small" variant="muted">{title} · {items.length}</Text.Sans>
      <ul className="flex flex-col gap-0.5 font-mono text-footnote [overflow-wrap:anywhere]">
        {shown.map((i) => <li key={i}>{i}</li>)}
      </ul>
      {items.length > COMPONENT_ROWS && (
        <TextLink onClick={() => setAll((v) => !v)}>
          {all ? t("Show fewer", "收起") : t(`Show all ${items.length}`, `显示全部 ${items.length} 个`)}
        </TextLink>
      )}
    </div>
  );
}

// ---------- comparison ----------

function DiffView({ appId, buildId }: { appId: string; buildId: string }) {
  const t = useText();
  const { locale } = useLocale();
  const refresh = useRefresh(appId);
  const q = useQuery({
    queryKey: ["build-inventory-diff", appId, buildId, "previous"],
    queryFn: () => getBuildInventoryDiff(appId, buildId, "previous"),
    retry: false,
  });
  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (q.error) {
    const body = q.error instanceof ApiError ? (q.error.body as { code?: string; build_id?: string } | null) : null;
    if (body?.code === "NO_PREVIOUS_BUILD") {
      return <Text.Sans size="small" variant="muted">{t("There is no earlier build of this product type to compare with.", "没有同一产品类型的更早构建可供比较。")}</Text.Sans>;
    }
    if (body?.code === "INVENTORY_MISSING" && body.build_id) {
      const missingId = body.build_id;
      return (
        <div className="flex flex-col items-start gap-2">
          <Text.Sans size="small" variant="muted">
            {missingId === buildId
              ? t("Contents have not been read for this build yet.", "尚未读取此构建的内容。")
              : t("Contents have not been read for the previous build yet.", "尚未读取上一个构建的内容。")}
          </Text.Sans>
          <Button variant="default" loading={refresh.isPending} loadingLabel={t("Reading package…", "正在读取安装包…")} onClick={() => refresh.mutate(missingId)}>
            {missingId === buildId ? t("Read contents", "读取内容") : t("Read previous build", "读取上一个构建")}
          </Button>
        </div>
      );
    }
    return <Text.Sans size="small" variant="warning">{t("Could not compare:", "无法比较：")} {errorMessage(q.error)}</Text.Sans>;
  }
  const { base, diff } = q.data!;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Text.Sans size="small" variant="muted">
          {t("Compared with", "对比")} <span className="font-mono">{base.version_name} ({base.version_code})</span>
        </Text.Sans>
        <Text.Sans size="body" className="font-medium">
          {formatBuildAssetSize(diff.total.before, locale)} → {formatBuildAssetSize(diff.total.after, locale)}{" "}
          <Delta value={diff.total.delta} />
        </Text.Sans>
      </div>
      <CategoryDeltas diff={diff} />
      <SdkChanges diff={diff} />
      <LibraryChanges diff={diff} />
      <ComponentChanges diff={diff} />
      <FileChanges diff={diff} />
      {diff.notes.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-footnote text-foreground-hint">
          {diff.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Growth is shown in the warning color, never red; shrinkage and no change are muted. */
function Delta({ value }: { value: number }) {
  const { locale } = useLocale();
  return (
    <span className={`font-mono text-footnote ${value > 0 ? "text-warning-strong" : "text-foreground-hint"}`}>
      {formatSignedSize(value, locale)}
    </span>
  );
}

function CategoryDeltas({ diff }: { diff: InventoryDiff }) {
  const t = useText();
  const { locale } = useLocale();
  const rows = diff.categories.filter((c) => c.compressed_delta !== 0);
  if (rows.length === 0) return null;
  return (
    <Group title={t("What changed size", "大小变化")}>
      <ListRowGroup>
        {rows.map((c) => (
          <ListRow key={c.key} variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle className="whitespace-normal text-footnote">{c.label}</ListRowTitle>
              <ListRowSubtitle className="font-mono">
                {formatBuildAssetSize(c.compressed_before, locale)} → {formatBuildAssetSize(c.compressed_after, locale)}
              </ListRowSubtitle>
            </ListRowBody>
            <Delta value={c.compressed_delta} />
          </ListRow>
        ))}
      </ListRowGroup>
    </Group>
  );
}

function ChangeBadge({ kind }: { kind: "added" | "removed" | "changed" }) {
  const t = useText();
  if (kind === "added") return <Badge appearance="outline" variant="warning" className="shrink-0">{t("Added", "新增")}</Badge>;
  if (kind === "removed") return <Badge appearance="outline" variant="muted" className="shrink-0">{t("Removed", "移除")}</Badge>;
  return <Badge appearance="outline" className="shrink-0">{t("Changed", "变化")}</Badge>;
}

function SdkChanges({ diff }: { diff: InventoryDiff }) {
  const t = useText();
  const { locale } = useLocale();
  const { added, removed, changed } = diff.sdks;
  if (added.length + removed.length + changed.length === 0) return null;
  return (
    <Group title={t("SDKs", "SDK")}>
      <ListRowGroup>
        {added.map((s) => (
          <ListRow key={`a:${s.name}`} variant="plain" interactive={false}>
            <ListRowBody><ListRowTitle>{s.name}</ListRowTitle></ListRowBody>
            <Delta value={s.compressed_bytes} />
            <ChangeBadge kind="added" />
          </ListRow>
        ))}
        {removed.map((s) => (
          <ListRow key={`r:${s.name}`} variant="plain" interactive={false}>
            <ListRowBody><ListRowTitle>{s.name}</ListRowTitle></ListRowBody>
            <Delta value={-s.compressed_bytes} />
            <ChangeBadge kind="removed" />
          </ListRow>
        ))}
        {changed.map((s) => (
          <ListRow key={`c:${s.name}`} variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle>{s.name}</ListRowTitle>
              <ListRowSubtitle className="font-mono">{formatBuildAssetSize(s.before, locale)} → {formatBuildAssetSize(s.after, locale)}</ListRowSubtitle>
            </ListRowBody>
            <Delta value={s.delta} />
          </ListRow>
        ))}
      </ListRowGroup>
    </Group>
  );
}

function LibraryChanges({ diff }: { diff: InventoryDiff }) {
  const t = useText();
  const { locale } = useLocale();
  const [all, setAll] = useState(false);
  type Row = { key: string; name: string; detail: string; delta: number; kind: "added" | "removed" | "changed" };
  const rows: Row[] = [
    ...diff.libraries.added.map((l) => ({ key: `a:${l.kind}:${l.name}`, name: l.name, detail: libraryDetail(l, t, locale), delta: l.compressed_bytes ?? l.bytes, kind: "added" as const })),
    ...diff.libraries.removed.map((l) => ({ key: `r:${l.kind}:${l.name}`, name: l.name, detail: libraryDetail(l, t, locale), delta: -(l.compressed_bytes ?? l.bytes), kind: "removed" as const })),
    ...diff.libraries.changed.map((l) => ({
      key: `c:${l.kind}:${l.name}`,
      name: l.name,
      detail: [kindLabel(l.kind, t), l.version_before !== l.version_after ? `v${l.version_before ?? "?"} → v${l.version_after ?? "?"}` : null, l.sdk].filter(Boolean).join(" · "),
      delta: l.compressed_delta,
      kind: "changed" as const,
    })),
  ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, LIBRARY_ROWS);
  return (
    <Group title={t("Libraries", "库")}>
      <ListRowGroup>
        {shown.map((r) => (
          <ListRow key={r.key} variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle className="whitespace-normal font-mono text-footnote [overflow-wrap:anywhere]">{r.name}</ListRowTitle>
              <ListRowSubtitle className="whitespace-normal">{r.detail}</ListRowSubtitle>
            </ListRowBody>
            <Delta value={r.delta} />
            {r.kind !== "changed" && <ChangeBadge kind={r.kind} />}
          </ListRow>
        ))}
      </ListRowGroup>
      {rows.length > LIBRARY_ROWS && (
        <TextLink onClick={() => setAll((v) => !v)}>
          {all ? t("Show fewer", "收起") : t(`Show all ${rows.length}`, `显示全部 ${rows.length} 个`)}
        </TextLink>
      )}
    </Group>
  );
}

function ComponentChanges({ diff }: { diff: InventoryDiff }) {
  const t = useText();
  const keys = Object.keys(diff.components);
  if (keys.length === 0) return null;
  return (
    <Group title={t("Components and capabilities", "组件与能力")}>
      <div className="flex flex-col gap-3">
        {keys.map((k) => {
          const c = diff.components[k]!;
          return (
            <div key={k} className="flex flex-col gap-1">
              <Text.Sans size="small" variant="muted">{componentLabel(k, t)}</Text.Sans>
              <ul className="flex flex-col gap-1">
                {c.added.map((v) => (
                  <li key={`a:${v}`} className="flex items-start gap-2">
                    <ChangeBadge kind="added" />
                    <span className="font-mono text-footnote [overflow-wrap:anywhere]">{v}</span>
                  </li>
                ))}
                {c.removed.map((v) => (
                  <li key={`r:${v}`} className="flex items-start gap-2">
                    <ChangeBadge kind="removed" />
                    <span className="font-mono text-footnote [overflow-wrap:anywhere]">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Group>
  );
}

function FileChanges({ diff }: { diff: InventoryDiff }) {
  const t = useText();
  const { locale } = useLocale();
  const rows = [...diff.files.added, ...diff.files.grown].sort((a, b) => b.delta - a.delta).slice(0, 10);
  if (rows.length === 0) return null;
  return (
    <Group title={t("Files that grew most", "增长最多的文件")}>
      <ListRowGroup>
        {rows.map((f) => (
          <ListRow key={f.path} variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle className="whitespace-normal font-mono text-footnote [overflow-wrap:anywhere]">{f.path}</ListRowTitle>
              <ListRowSubtitle className="font-mono">
                {f.before === 0 ? t("new", "新文件") : formatBuildAssetSize(f.before, locale)} → {formatBuildAssetSize(f.after, locale)}
              </ListRowSubtitle>
            </ListRowBody>
            <Delta value={f.delta} />
          </ListRow>
        ))}
      </ListRowGroup>
      <Text.Sans size="small" variant="muted">{t("Uncompressed sizes; only the largest files of each build are compared.", "未压缩大小；只比较每个构建中最大的文件。")}</Text.Sans>
    </Group>
  );
}
