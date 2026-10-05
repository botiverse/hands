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
import {
  Badge,
  Button,
  Card,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Checkbox,
  EmptyState,
  EmptyStateTitle,
  Skeleton,
} from "raft-ui";

export function AppsList({ onSelectApp, initialShowCreate }: { onSelectApp: (id: string) => void; initialShowCreate?: boolean }) {
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
        <h1 className="text-2xl font-bold">Apps</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <Checkbox
              checked={showArchived}
              onCheckedChange={(v) => setShowArchived(Boolean(v))}
              className="rounded-sm"
            />
            Show archived ({data?.apps.filter((a) => a.archived).length ?? 0})
          </label>
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            + New app
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
        <p className="text-danger">Failed: {(error as Error).message}</p>
      )}

      {visible.length === 0 && !isLoading && (
        <EmptyState>
          <EmptyStateTitle>
            {showArchived
              ? "No apps yet. Click \"+ New app\" to create your first one."
              : data?.apps.some((a) => a.archived)
                ? "All apps are archived. Toggle \"Show archived\" to view them."
                : "No apps yet. Click \"+ New app\" to create your first one."}
          </EmptyStateTitle>
        </EmptyState>
      )}

      <div className="grid gap-3">
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
    <Card
      render={<button onClick={onSelect} />}
      className={`text-left transition-colors w-full ${
        isArchived
          ? "opacity-60 hover:border-line-strong"
          : "hover:border-info"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-lg font-medium">{app.name}</div>
            {isArchived && (
              <Badge variant="muted">📦 Archived</Badge>
            )}
            {!sameOrg && app.org_id && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Badge variant="warning">⚠ other org</Badge>
                  }
                />
                <TooltipContent>
                  {`This app belongs to a different org (${app.org_id})`}
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
                    📦 {ptCount} product type{ptCount === 1 ? "" : "s"}
                  </Badge>
                }
              />
              <TooltipContent>Product types (what we ship)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="muted">
                    🚀 {chCount} channel{chCount === 1 ? "" : "s"}
                  </Badge>
                }
              />
              <TooltipContent>
                Distribution channels (main / preview / nightly)
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <Badge variant="information" className="ml-3">{app.platform}</Badge>
      </div>
    </Card>
  );
}
