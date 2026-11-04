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
  Badge,
  Button,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Checkbox,
  EmptyState,
  EmptyStateContent,
  EmptyStateIcon,
  EmptyStateTitle,
  Skeleton,
} from "raft-ui";
import { AlertTriangle, Archive, LayoutGrid, Package, Rocket } from "lucide-react";

export function AppsList({ onSelectApp, initialShowCreate }: { onSelectApp: (id: string) => void; initialShowCreate?: boolean }) {
  const t = useText();
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["apps"],
    queryFn: () => listApps(),
  });

  const [showCreate, setShowCreate] = useState(initialShowCreate ?? false);
  const [showArchived, setShowArchived] = useState(false);

  // Phase 1: filter archived client-side (server doesn't yet support query param).
  const visible = data?.apps.filter((a) => showArchived || !a.archived) ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("Apps", "应用")}</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <Checkbox
              checked={showArchived}
              onCheckedChange={(v) => setShowArchived(Boolean(v))}
              className="rounded-sm"
            />
            {t(`Show archived (${data?.apps.filter((a) => a.archived).length ?? 0})`, `显示已归档（${data?.apps.filter((a) => a.archived).length ?? 0}）`)}
          </label>
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            {t("+ New app", "+ 新建应用")}
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="grid gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {error && (
        <p className="text-danger">{t("Failed:", "操作失败：")} {errorMessage(error)}</p>
      )}

      {visible.length === 0 && !isLoading && (
        <EmptyState>
          <EmptyStateContent>
          <EmptyStateIcon>
            <LayoutGrid aria-hidden="true" />
          </EmptyStateIcon>
          <EmptyStateTitle>
            {showArchived
              ? t('No apps yet. Click "+ New app" to create your first one.', '还没有应用。点击“+ 新建应用”创建第一个应用。')
              : data?.apps.some((a) => a.archived)
                ? t('All apps are archived. Toggle "Show archived" to view them.', '所有应用都已归档。开启“显示已归档”即可查看。')
                : t('No apps yet. Click "+ New app" to create your first one.', '还没有应用。点击“+ 新建应用”创建第一个应用。')}
          </EmptyStateTitle>
          </EmptyStateContent>
        </EmptyState>
      )}

      <div>
        {visible.map((app) => (
          <AppRow key={app.id} app={app} onSelect={() => onSelectApp(app.id)} />
        ))}
      </div>

      {showCreate && (
        <AppCreationWizard
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["apps"] });
          }}
        />
      )}
    </div>
  );
}

function AppRow({ app, onSelect }: { app: App; onSelect: () => void }) {
  const t = useText();
  const isArchived = !!app.archived;

  // Fetch counts for product_types / channels per app.
  // (Phase 2.3.A — lightweight stats inline on AppsList cards.)
  const productTypes = useQuery({
    queryKey: ["product-types", app.id],
    queryFn: () => listProductTypes(app.id),
  });
  const channels = useQuery({
    queryKey: ["channels", app.id],
    queryFn: () => listChannels(app.id),
  });
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const sameOrg = !app.org_id || app.org_id === me.data?.account.org_id;

  const ptCount = productTypes.data?.product_types.length ?? 0;
  const chCount = channels.data?.channels.length ?? 0;

  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-md border-t border-line-hairline px-3 pt-4 pb-3 text-left transition-colors hover:bg-fill-muted/60 ${
        isArchived ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-base font-medium">{app.name}</div>
            {isArchived && (
              <Badge variant="muted">
                <Archive className="size-3.5" aria-hidden="true" /> {t("Archived", "已归档")}
              </Badge>
            )}
            {!sameOrg && app.org_id && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Badge variant="warning">
                      <AlertTriangle className="size-3.5" aria-hidden="true" /> {t("other org", "其他组织")}
                    </Badge>
                  }
                />
                <TooltipContent>
                  {t(`This app belongs to a different org (${app.org_id})`, `此应用属于其他组织（${app.org_id}）`)}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="text-sm text-foreground-muted font-mono">{app.slug}</div>
          {app.description && (
            <div className="text-sm text-foreground mt-1 line-clamp-2">
              {app.description}
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-2 text-xs">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="information">
                    <Package className="size-3.5" aria-hidden="true" /> {t(`${ptCount} product type${ptCount === 1 ? "" : "s"}`, `${ptCount} 种产品类型`)}
                  </Badge>
                }
              />
              <TooltipContent>{t("Product types (what we ship)", "产品类型（发布的内容）")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="muted">
                    <Rocket className="size-3.5" aria-hidden="true" /> {t(`${chCount} channel${chCount === 1 ? "" : "s"}`, `${chCount} 个渠道`)}
                  </Badge>
                }
              />
              <TooltipContent>
                {t("Distribution channels (main / preview / nightly)", "分发渠道（main / preview / nightly）")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <Badge variant="information" className="ml-3">{app.platform}</Badge>
      </div>
    </button>
  );
}
