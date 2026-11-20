/**
 * Apps — a page of a list (design: patterns/page-structure "A page of a
 * list"): the head with the title and the count, a toolbar with the scope
 * (Active / Archived) and New app, then one row per app.
 */
import { errorMessage } from "../lib/errorMessage";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getAuthMe,
  listApps,
  listProductTypes,
  listChannels,
  type App,
} from "../lib/api";
import { AppCreationWizard } from "../components/AppCreationWizard";
import { useText } from "../lib/locale";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  EmptyState,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowChevron,
  ListRowDescription,
  ListRowSubtitle,
  ListRowTitle,
  ListRowTop,
  Panel,
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelHeading,
  PanelMeta,
  PanelScrollViewport,
  PanelTitle,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
  SegmentedControlLabel,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { AlertTriangle, Archive, LayoutGrid, Plus } from "lucide-react";

type Scope = "active" | "archived";

export const PLATFORM_LABELS: Record<string, string> = {
  android: "Android",
  ios: "iOS",
  ohos: "HarmonyOS",
  electron: "Electron",
  node: "Node.js",
  web: "Web",
};

export function AppsList({ onSelectApp, initialShowCreate }: { onSelectApp: (id: string) => void; initialShowCreate?: boolean }) {
  const t = useText();
  const qc = useQueryClient();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["apps"],
    queryFn: () => listApps(),
  });

  const [showCreate, setShowCreate] = useState(initialShowCreate ?? false);
  const [scope, setScope] = useState<Scope>("active");

  // Archived apps are filtered client-side (the server has no query param yet).
  const apps = data?.apps ?? [];
  const activeCount = apps.filter((a) => !a.archived).length;
  const archivedCount = apps.length - activeCount;
  const visible = apps.filter((a) => (scope === "archived" ? !!a.archived : !a.archived));

  return (
    <Panel className="flex min-h-0 flex-1 flex-col" aria-label={t("Apps", "应用")}>
      <PanelHeader>
        <PanelHeaderIcon className="max-md:hidden">
          <LayoutGrid aria-hidden="true" />
        </PanelHeaderIcon>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h1 />}>{t("Apps", "应用")}</PanelTitle>
          </PanelHeading>
          {data && <PanelMeta className="font-mono">{activeCount}</PanelMeta>}
        </PanelHeaderContent>
      </PanelHeader>

      <div className="flex min-h-11 items-center gap-3 border-b border-line-seam px-(--column-margin) py-0.5">
        <SegmentedControl<Scope>
          aria-label={t("Which apps", "显示哪些应用")}
          value={scope}
          onValueChange={(value) => setScope(value)}
        >
          <SegmentedControlItem value="active">
            <SegmentedControlLabel>{t("Active", "使用中")}</SegmentedControlLabel>
            <SegmentedControlCount>{activeCount}</SegmentedControlCount>
          </SegmentedControlItem>
          <SegmentedControlItem value="archived">
            <SegmentedControlLabel>{t("Archived", "已归档")}</SegmentedControlLabel>
            <SegmentedControlCount>{archivedCount}</SegmentedControlCount>
          </SegmentedControlItem>
        </SegmentedControl>
        <Button variant="primary" className="ml-auto" onClick={() => setShowCreate(true)}>
          <Plus aria-hidden="true" />
          {t("New app", "新建应用")}
        </Button>
      </div>

      <PanelScrollViewport className="min-h-0 flex-1" contentClassName="flex flex-col gap-0.5 py-2" aria-busy={isLoading || undefined}>
        {isLoading && [0, 1, 2].map((n) => <ListRowSkeleton key={n} cell />)}

        {error && (
          <div className="px-(--column-margin)">
            <Banner status="warning">
              <AlertTriangle aria-hidden="true" />
              <BannerTitle>{t("Could not load apps", "无法加载应用")}</BannerTitle>
              <BannerDescription>{errorMessage(error)}</BannerDescription>
              <BannerAction>
                <Button variant="outline" onClick={() => void refetch()}>{t("Retry", "重试")}</Button>
              </BannerAction>
            </Banner>
          </div>
        )}

        {data && visible.length === 0 && (
          <EmptyState className="py-16">
            <EmptyStateContent>
              <EmptyStateIcon>
                {scope === "archived" ? <Archive aria-hidden="true" /> : <LayoutGrid aria-hidden="true" />}
              </EmptyStateIcon>
              {scope === "archived" ? (
                <>
                  <EmptyStateTitle>{t("No archived apps", "没有已归档的应用")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Apps you archive in their settings show up here.", "在应用设置中归档的应用会显示在这里。")}</EmptyStateDescription>
                </>
              ) : archivedCount > 0 ? (
                <>
                  <EmptyStateTitle>{t("No active apps", "没有使用中的应用")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Every app is archived. Switch to Archived to see them.", "所有应用都已归档。切换到“已归档”即可查看。")}</EmptyStateDescription>
                </>
              ) : (
                <>
                  <EmptyStateTitle>{t("No apps yet", "还没有应用")}</EmptyStateTitle>
                  <EmptyStateDescription>{t("Create an app to start shipping builds and releases.", "新建一个应用，开始发布构建和版本。")}</EmptyStateDescription>
                </>
              )}
            </EmptyStateContent>
          </EmptyState>
        )}

        {visible.map((app) => (
          <AppRow key={app.id} app={app} onSelect={() => onSelectApp(app.id)} />
        ))}
      </PanelScrollViewport>

      {showCreate && (
        <AppCreationWizard
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["apps"] });
          }}
        />
      )}
    </Panel>
  );
}

function AppRow({ app, onSelect }: { app: App; onSelect: () => void }) {
  const t = useText();
  const isArchived = !!app.archived;

  // Counts of product types and channels per app, shown as the row's byline.
  const productTypes = useQuery({
    queryKey: ["product-types", app.id],
    queryFn: () => listProductTypes(app.id),
  });
  const channels = useQuery({
    queryKey: ["channels", app.id],
    queryFn: () => listChannels(app.id),
  });
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const otherOrg = !!app.org_id && !!me.data && app.org_id !== me.data.account.org_id;

  const ptCount = productTypes.data?.product_types.length;
  const chCount = channels.data?.channels.length;
  const counts = [
    chCount === undefined ? null : t(`${chCount} channel${chCount === 1 ? "" : "s"}`, `${chCount} 个渠道`),
    ptCount === undefined ? null : t(`${ptCount} product type${ptCount === 1 ? "" : "s"}`, `${ptCount} 种产品类型`),
  ].filter(Boolean).join(" · ");

  return (
    <ListRow cell tone={isArchived ? "muted" : "default"} onClick={onSelect}>
      <Avatar type="server" size="md">
        <AvatarFallback>{app.name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <ListRowBody>
        <ListRowTop>
          <span className="flex min-w-0 items-center gap-2">
            <ListRowTitle>{app.name}</ListRowTitle>
            <Badge appearance="outline" className="shrink-0">{PLATFORM_LABELS[app.platform] ?? app.platform}</Badge>
            {isArchived ? (
              <Badge appearance="soft" variant="muted" className="shrink-0">{t("Archived", "已归档")}</Badge>
            ) : otherOrg ? (
              <Tooltip>
                <TooltipTrigger
                  render={<Badge appearance="soft" variant="warning" className="shrink-0">{t("Other organization", "其他组织")}</Badge>}
                />
                <TooltipContent>
                  {t(`This app belongs to a different organization (${app.org_id})`, `此应用属于其他组织（${app.org_id}）`)}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        </ListRowTop>
        <ListRowSubtitle>
          <span className="font-mono">{app.slug}</span>
          {counts && <span className="text-foreground-muted"> · {counts}</span>}
        </ListRowSubtitle>
        {app.description && (
          <ListRowBottom>
            <ListRowDescription>{app.description}</ListRowDescription>
          </ListRowBottom>
        )}
      </ListRowBody>
      <ListRowChevron />
    </ListRow>
  );
}
