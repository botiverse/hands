import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Card, TextHeading, TextSans } from "raft-ui";
import { listApps } from "../lib/api";
import { AppGalleryConnector } from "../components/integrations/AppGalleryConnector";
import { GooglePlayConnector } from "../components/integrations/GooglePlayConnector";
import { TestFlightConnector } from "../components/integrations/TestFlightConnector";

/**
 * Connector registry. Each entry renders one complete connector row (icon,
 * name, description, status badge, Connect button / expandable detail) — the
 * page itself never changes when a connector is added; new connectors only add
 * a definition here plus their component. Google Play (Android) is the first.
 */
const CONNECTORS: ReadonlyArray<{
  id: string;
  platform?: "android" | "ios" | "ohos" | "electron";
  Component: (props: { appId: string }) => ReactElement;
}> = [
  { id: "google-play", platform: "android", Component: GooglePlayConnector },
  { id: "testflight", platform: "ios", Component: TestFlightConnector },
  { id: "appgallery", platform: "ohos", Component: AppGalleryConnector },
];

export function Integrations({ appId }: { appId: string }) {
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((candidate) => candidate.id === appId);
  const connectors = CONNECTORS.filter(
    (connector) => !connector.platform || connector.platform === app?.platform,
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <TextHeading level={1} className="text-2xl leading-8">
          Integrations
        </TextHeading>
        <TextSans size="small">
          Connect the external services this app publishes or reports to.
          Integrations follow the app's platform: Google Play for Android,
          TestFlight for iOS, AppGallery Connect for HarmonyOS.
        </TextSans>
      </div>
      {app && connectors.length > 0 && (
        <div className="space-y-3">
          {connectors.map(({ id, Component }) => (
            <Component key={id} appId={appId} />
          ))}
        </div>
      )}
      {app && connectors.length === 0 && (
        <Card className="p-4 text-sm text-foreground-muted">
          No integrations are available for this platform yet.
        </Card>
      )}
    </div>
  );
}
