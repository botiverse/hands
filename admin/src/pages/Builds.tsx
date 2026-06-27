/**
 * Builds tab — list of build artifacts for an app.
 *
 * Phase 2.5.1: table view, status badge, Prepare release button.
 *
 * Currently a thin shell — will populate from `listBuilds` endpoint when
 * the expert lands Task #10 (builds endpoints). For now shows placeholder
 * with info about the model.
 */

import { useQuery } from "@tanstack/react-query";
import { listApps, listChannels, listProductTypes, listReleaseTypes } from "../lib/api";

export function Builds({ appId }: { appId: string }) {
  const app = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });
  const releaseTypes = useQuery({
    queryKey: ["release-types", appId],
    queryFn: () => listReleaseTypes(appId),
  });

  const thisApp = app.data?.apps.find((a) => a.id === appId);

  return (
    <div className="p-4">
      <div className="mb-6">
        <div className="text-sm text-slate-500">Builds</div>
        <h1 className="text-2xl font-bold">
          {thisApp?.name ?? "..."}
          <span className="badge-blue align-middle ml-2">{thisApp?.platform}</span>
        </h1>
        <div className="text-sm text-slate-500 font-mono">{thisApp?.slug}</div>
      </div>

      <div className="card !p-4 text-sm text-slate-600">
        <p className="mb-2">
          <strong>Builds tab scaffold.</strong> Will populate from the builds
          endpoint (Task #10) when the backend lands.
        </p>
        <p className="text-xs text-slate-500">
          Schema in place: <code>builds</code> + <code>build_assets</code> tables on
          remote D1 (migrations 0005 + 0015). Endpoint list:
        </p>
        <ul className="text-xs text-slate-500 list-disc list-inside mt-1">
          <li>GET /api/apps/:appId/builds — list</li>
          <li>GET /api/apps/:appId/builds/:buildId — detail</li>
          <li>POST /api/apps/:appId/builds — create (replace parse-apk + upload)</li>
          <li>POST /api/apps/:appId/builds/:buildId/assets — add asset</li>
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          Preview counts from existing schema:
        </p>
        <ul className="text-xs text-slate-500 list-disc list-inside mt-1">
          <li>Channels: {channels.data?.channels.length ?? "?"}</li>
          <li>Product types: {productTypes.data?.product_types.length ?? "?"}</li>
          <li>Release types: {releaseTypes.data?.release_types.length ?? "?"}</li>
        </ul>
      </div>
    </div>
  );
}