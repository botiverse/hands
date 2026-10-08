import type { ReactElement } from "react";
import type { LucideIcon } from "lucide-react";
import { Apple, Play, Smartphone } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Badge, TextHeading, TextSans } from "raft-ui";
import { listApps } from "../lib/api";
import { AppGalleryConnector } from "../components/integrations/AppGalleryConnector";
import { GooglePlayConnector } from "../components/integrations/GooglePlayConnector";
import { TestFlightConnector } from "../components/integrations/TestFlightConnector";

/**
 * Connector registry. Every entry renders one complete connector row (icon,
 * name, description, status badge, Connect button / expandable detail) — the
 * page itself never changes when a connector is added; new connectors only add
 * a definition here plus their component.
 *
 * All connectors are listed for every app: rows whose platform does not match
 * the app's platform stay visible (muted, with an "only for X apps" badge) so
 * the page reads as the full integration catalog (artin, b5d06d23).
 */
const CONNECTORS: ReadonlyArray<{
  id: string;
  label: string;
  platform: "android" | "ios" | "ohos";
  platformLabel: string;
  Icon: LucideIcon;
  Component: (props: { appId: string }) => ReactElement;
}> = [
  {
    id: "google-play",
    label: "Google Play",
    platform: "android",
    platformLabel: "Android",
    Icon: Play,
    Component: GooglePlayConnector,
  },
  {
    id: "testflight",
    label: "TestFlight",
    platform: "ios",
    platformLabel: "iOS",
    Icon: Apple,
    Component: TestFlightConnector,
  },
  {
    id: "appgallery",
    label: "AppGallery Connect",
    platform: "ohos",
    platformLabel: "HarmonyOS",
    Icon: Smartphone,
    Component: AppGalleryConnector,
  },
];

export function Integrations({ appId }: { appId: string }) {
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((candidate) => candidate.id === appId);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <TextHeading level={1} className="text-2xl leading-8">
          Integrations
        </TextHeading>
        <TextSans size="small">
          Connect the external services this app publishes or reports to.
          Rows that don't apply to this app's platform are shown for
          reference.
        </TextSans>
      </div>
      {app && (
        // Connector chips: soft fill, no outline (option B). Brand-colored
        // glyphs are deferred — brand hues would compete with the status
        // colors used in the same rows. See admin/ICONS.md.
        <div className="space-y-3">
          {CONNECTORS.map(({ id, label, platform, platformLabel, Icon, Component }) =>
            app.platform === platform ? (
              <Component key={id} appId={appId} />
            ) : (
              <div key={id} data-testid={`connector-inactive-${id}`} className="flex items-center gap-3 rounded-md bg-fill-muted/60 px-3 py-2.5 text-sm">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-fill-muted text-foreground-muted">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground-muted">{label}</div>
                  <div className="text-xs text-foreground-muted">
                    Available for {platformLabel} apps.
                  </div>
                </div>
                <Badge variant="muted">Only for {platformLabel} apps</Badge>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
