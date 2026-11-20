import { useState, type ReactElement } from "react";
import type { LucideIcon } from "lucide-react";
import { Apple, Play, Plug, Smartphone } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  IconTile,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowChevron,
  ListRowDescription,
  ListRowSubtitle,
  ListRowTitle,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { listApps } from "../lib/api";
import { useText } from "../lib/locale";
import { DetailColumn, ListPage } from "../components/ListPage";
import { AppGalleryConnector, useAppGalleryState } from "../components/integrations/AppGalleryConnector";
import { GooglePlayConnector, useGooglePlayState } from "../components/integrations/GooglePlayConnector";
import { TestFlightConnector, useTestFlightState } from "../components/integrations/TestFlightConnector";
import { ConnectorStateBadge, type ConnectorState } from "../components/integrations/ConnectorParts";

type T = ReturnType<typeof useText>;

/**
 * Connector registry. The page lists every connector as one row (icon, name,
 * what it does, its state); opening a row shows the connector's column beside
 * the list, with its configuration and actions. A new connector only adds a
 * definition here plus its component and state hook.
 *
 * All connectors are listed for every app: rows whose platform does not match
 * the app's platform stay visible (muted, with an "Only for X apps" badge) so
 * the page reads as the full integration catalog (artin, b5d06d23).
 */
const CONNECTORS: ReadonlyArray<{
  id: string;
  label: string;
  platform: "android" | "ios" | "ohos";
  platformLabel: string;
  Icon: LucideIcon;
  summary: (t: T) => string;
  Component: (props: { appId: string }) => ReactElement;
  useState: (appId: string, enabled?: boolean) => ConnectorState | undefined;
}> = [
  {
    id: "google-play",
    label: "Google Play",
    platform: "android",
    platformLabel: "Android",
    Icon: Play,
    summary: (t) => t("Promote releases to Play tracks and read Play statistics.", "将版本推送到 Play 轨道，并读取 Play 统计。"),
    Component: GooglePlayConnector,
    useState: useGooglePlayState,
  },
  {
    id: "testflight",
    label: "TestFlight",
    platform: "ios",
    platformLabel: "iOS",
    Icon: Apple,
    summary: (t) => t("Upload builds to TestFlight with an App Store Connect key.", "使用 App Store Connect 密钥将构建上传到 TestFlight。"),
    Component: TestFlightConnector,
    useState: useTestFlightState,
  },
  {
    id: "appgallery",
    label: "AppGallery Connect",
    platform: "ohos",
    platformLabel: "HarmonyOS",
    Icon: Smartphone,
    summary: (t) => t("Test and publish HarmonyOS builds on AppGallery.", "在 AppGallery 测试和发布 HarmonyOS 构建。"),
    Component: AppGalleryConnector,
    useState: useAppGalleryState,
  },
];

type Connector = (typeof CONNECTORS)[number];

/** Opened by default: the connector a Google authorization just returned to,
 *  or, on a wide window, the one for the app's own platform. */
function initialOpen(): "auto" | string | null {
  if (new URLSearchParams(window.location.search).has("google_play_oauth")) return "google-play";
  return typeof window.matchMedia === "function" && window.matchMedia("(min-width: 1024px)").matches ? "auto" : null;
}

export function Integrations({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((candidate) => candidate.id === appId);
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  // Connectors for the app's platform first; the others follow, muted.
  const ordered = app ? [...CONNECTORS].sort((a, b) => Number(b.platform === app.platform) - Number(a.platform === app.platform)) : [];
  const resolvedId = openId === "auto" ? (CONNECTORS.find((c) => c.platform === app?.platform)?.id ?? null) : openId;
  const open = app ? CONNECTORS.find((c) => c.id === resolvedId && c.platform === app.platform) ?? null : null;

  return (
    <ListPage
      icon={<Plug aria-hidden="true" />}
      title={t("Integrations", "集成")}
      busy={apps.isLoading}
      detail={open && <ConnectorColumn key={open.id} connector={open} appId={appId} onClose={() => setOpenId(null)} />}
    >
      <div className="flex flex-col gap-0.5">
        {apps.isLoading && [0, 1, 2].map((n) => <ListRowSkeleton key={n} cell />)}
        {app && ordered.map((connector) =>
          app.platform === connector.platform ? (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              appId={appId}
              selected={open?.id === connector.id}
              onOpen={() => setOpenId(connector.id)}
            />
          ) : (
            <InactiveConnectorRow key={connector.id} connector={connector} />
          ),
        )}
      </div>
    </ListPage>
  );
}

function ConnectorRow({ connector, appId, selected, onOpen }: { connector: Connector; appId: string; selected: boolean; onOpen: () => void }) {
  const t = useText();
  const state = connector.useState(appId);
  const { Icon } = connector;
  return (
    <ListRow cell selected={selected} aria-current={selected || undefined} onClick={onOpen} data-testid={`connector-row-${connector.id}`}>
      <IconTile size="md"><Icon /></IconTile>
      <ListRowBody>
        <ListRowTitle>{connector.label}</ListRowTitle>
        <ListRowSubtitle>{connector.summary(t)}</ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>{state?.detail ?? ""}</ListRowDescription>
          {state && <ConnectorStateBadge state={state} />}
        </ListRowBottom>
      </ListRowBody>
      <ListRowChevron />
    </ListRow>
  );
}

function InactiveConnectorRow({ connector }: { connector: Connector }) {
  const t = useText();
  const { Icon } = connector;
  return (
    <ListRow cell tone="muted" interactive={false} data-testid={`connector-inactive-${connector.id}`}>
      <IconTile size="md"><Icon /></IconTile>
      <ListRowBody>
        <ListRowTitle>{connector.label}</ListRowTitle>
        <ListRowSubtitle>{connector.summary(t)}</ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription />
          <Badge appearance="outline" variant="muted">{t(`Only for ${connector.platformLabel} apps`, `仅适用于 ${connector.platformLabel} 应用`)}</Badge>
        </ListRowBottom>
      </ListRowBody>
    </ListRow>
  );
}

function ConnectorColumn({ connector, appId, onClose }: { connector: Connector; appId: string; onClose: () => void }) {
  const t = useText();
  const state = connector.useState(appId);
  const { Component } = connector;
  return (
    <DetailColumn
      label={connector.label}
      title={connector.label}
      meta={state?.label ?? t(`${connector.platformLabel} apps`, `${connector.platformLabel} 应用`)}
      onClose={onClose}
    >
      <Component appId={appId} />
    </DetailColumn>
  );
}
