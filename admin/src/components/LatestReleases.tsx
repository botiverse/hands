/**
 * The latest live release of each channel, on the app overview. A row per
 * channel opens the Releases page; the section's one button publishes a
 * release, or creates the first channel when there is none.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Radio, Rocket } from "lucide-react";
import {
  Badge,
  Button,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowChevron,
  ListRowDescription,
  ListRowGroup,
  ListRowSubtitle,
  ListRowTitle,
  Skeleton,
  Text,
} from "@botiverse/raft-ui";
import { listChannels, listReleases, type App, type Channel, type Release } from "../lib/api";
import { errorMessage } from "../lib/errorMessage";
import { useLocale, useText } from "../lib/locale";
import { timeAgo } from "../pages/Operations";
import { OverviewEmpty, OverviewSection } from "./OverviewSection";

/** The newest active release of a channel, and how many product types are live on it. */
export function latestReleaseByChannel(releases: Release[]): Map<string, { latest: Release; liveTypes: number }> {
  const byChannel = new Map<string, { latest: Release; types: Set<string> }>();
  for (const r of releases) {
    if (r.status !== "active") continue;
    const at = r.activated_at ?? r.created_at;
    const entry = byChannel.get(r.channel_id);
    if (!entry) {
      byChannel.set(r.channel_id, { latest: r, types: new Set([r.product_type]) });
      continue;
    }
    entry.types.add(r.product_type);
    if (at > (entry.latest.activated_at ?? entry.latest.created_at)) entry.latest = r;
  }
  return new Map([...byChannel].map(([id, { latest, types }]) => [id, { latest, liveTypes: types.size }]));
}

export function LatestReleases({ appId, app }: { appId: string; app: App | undefined }) {
  const t = useText();
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const releases = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => listReleases(appId),
  });
  const channelList = channels.data?.channels ?? [];
  const latest = latestReleaseByChannel(releases.data?.releases ?? []);
  const hasChannels = channelList.length > 0;

  return (
    <OverviewSection
      id="overview-releases"
      icon={<Rocket />}
      title={t("Latest releases", "最新版本")}
      action={
        hasChannels ? (
          <Button variant="primary" render={<Link to={`/apps/${appId}/releases`} />} nativeButton={false} role="link">
            {t("Publish release", "发布版本")}
          </Button>
        ) : undefined
      }
    >
      {channels.isLoading && <Skeleton className="h-28 w-full" />}
      {releases.error && (
        <Text.Sans size="small" variant="warning">
          {t("Could not load releases:", "无法加载版本：")} {errorMessage(releases.error)}
        </Text.Sans>
      )}
      {channels.data && !hasChannels && (
        <OverviewEmpty
          icon={<Radio />}
          title={t("No channels yet", "还没有渠道")}
          description={t("Releases go out through channels. Create one to publish the first release.", "版本通过渠道发布。先创建一个渠道，再发布第一个版本。")}
          action={
            <Button variant="primary" render={<Link to={`/apps/${appId}/channels`} />} nativeButton={false} role="link">
              {t("Create channel", "创建渠道")}
            </Button>
          }
        />
      )}
      {hasChannels && (
        <ListRowGroup>
          {channelList.map((channel) => (
            <ChannelReleaseRow
              key={channel.id}
              appId={appId}
              channel={channel}
              isDefault={app?.default_channel_id === channel.id}
              entry={latest.get(channel.id)}
              loading={releases.isLoading}
            />
          ))}
        </ListRowGroup>
      )}
    </OverviewSection>
  );
}

function ChannelReleaseRow({
  appId,
  channel,
  isDefault,
  entry,
  loading,
}: {
  appId: string;
  channel: Channel;
  isDefault: boolean;
  entry: { latest: Release; liveTypes: number } | undefined;
  loading: boolean;
}) {
  const t = useText();
  const { locale } = useLocale();
  const r = entry?.latest;
  const rollout = r?.rollout_cohort_count;
  const partial = rollout != null && rollout < 100;
  const version = r
    ? `${r.version_name ?? t("Unknown version", "未知版本")}${r.version_code != null ? ` (${r.version_code})` : ""}`
    : null;
  const more = entry && entry.liveTypes > 1
    ? t(` · ${entry.liveTypes} product types live`, ` · ${entry.liveTypes} 种产品类型在线`)
    : "";

  return (
    <ListRow variant="plain" render={<Link to={`/apps/${appId}/releases`} />}>
      <ListRowBody>
        <span className="flex min-w-0 items-center gap-2">
          <ListRowTitle>{channel.name}</ListRowTitle>
          {isDefault && <Badge appearance="outline" className="shrink-0">{t("default", "默认")}</Badge>}
        </span>
        <ListRowSubtitle className="font-mono">{channel.slug}</ListRowSubtitle>
        <ListRowBottom>
          <ListRowDescription>
            {loading
              ? t("Loading…", "加载中…")
              : r
                ? `${version} · ${r.product_type} · ${timeAgo(r.activated_at ?? r.created_at, locale)}${more}`
                : t("No release yet", "还没有版本")}
          </ListRowDescription>
          {partial && (
            <Badge appearance="soft" variant="information">
              {t(`${rollout}% rollout`, `已发布 ${rollout}%`)}
            </Badge>
          )}
        </ListRowBottom>
      </ListRowBody>
      <ListRowChevron />
    </ListRow>
  );
}
