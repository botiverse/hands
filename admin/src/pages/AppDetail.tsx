import { errorMessage } from "../lib/errorMessage";
import {
  Banner,
  BannerDescription,
  BannerTitle,
  Panel,
  PanelHeader,
  PanelHeaderContent,
  PanelHeaderIcon,
  PanelHeading,
  PanelMeta,
  PanelScrollViewport,
  PanelTitle,
} from "@botiverse/raft-ui";
import { AlertTriangle, Archive, Gauge } from "lucide-react";
import { LatestReleases } from "../components/LatestReleases";
import { DeviceAnalytics } from "../components/DeviceAnalytics";
import { ReleaseHealth } from "../components/ReleaseHealth";
import { useQuery } from "@tanstack/react-query";
import { listApps, listChannels } from "../lib/api";
import { Operations } from "./Operations";
import { useText } from "../lib/locale";

/** The app's overview: its latest release per channel, release health,
 *  devices and versions, and recent operations, as sections of one page
 *  under the panel header. */
export function AppDetail({ appId }: { appId: string }) {
  const t = useText();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const appMissing = !apps.isLoading && !apps.error && !app;
  const overview = t("Overview", "概览");

  return (
    <Panel className="flex min-h-0 flex-1 flex-col" aria-label={app ? `${overview} · ${app.name}` : overview}>
      <PanelHeader>
        <PanelHeaderIcon className="max-md:hidden">
          <Gauge aria-hidden="true" />
        </PanelHeaderIcon>
        <PanelHeaderContent>
          <PanelHeading>
            <PanelTitle render={<h1 />}>{overview}</PanelTitle>
          </PanelHeading>
          {app && <PanelMeta>{app.name}</PanelMeta>}
        </PanelHeaderContent>
      </PanelHeader>
      <PanelScrollViewport
        className="min-h-0 flex-1"
        contentClassName="flex w-full max-w-5xl flex-col gap-8 px-(--column-margin) pt-4 pb-10"
      >
        {apps.error && (
          <AppErrorBanner
            title={t("Cannot load apps", "无法加载应用列表")}
            error={apps.error}
          />
        )}
        {appMissing && (
          <AppErrorBanner
            title={t("App is not available", "应用不可用")}
            description={t("This app is not visible to the current account, or it no longer exists.", "当前账号无法查看此应用，或应用已不存在。")}
          />
        )}
        {channels.error && (
          <AppErrorBanner
            title={t("Cannot load app details", "无法加载应用详情")}
            error={channels.error}
          />
        )}
        {app?.archived ? (
          <Banner status="warning" size="sm">
            <Archive aria-hidden="true" />
            <BannerDescription>
              {t("This app is archived and rejects new uploads. Restore it in Settings.", "此应用已归档，不再接受新上传。可在设置中恢复。")}
            </BannerDescription>
          </Banner>
        ) : null}

        <LatestReleases appId={appId} app={app} />
        <ReleaseHealth appId={appId} />
        <DeviceAnalytics appId={appId} />
        <Operations appId={appId} />
      </PanelScrollViewport>
    </Panel>
  );
}

function AppErrorBanner({
  title,
  description,
  error,
}: {
  title: string;
  description?: string;
  error?: unknown;
}) {
  return (
    <Banner status="warning">
      <AlertTriangle aria-hidden="true" />
      <BannerTitle>{title}</BannerTitle>
      <BannerDescription>{description ?? errorMessage(error)}</BannerDescription>
    </Banner>
  );
}

