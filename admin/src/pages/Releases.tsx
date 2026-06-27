/**
 * Releases tab — live releases per (channel, product_type, release_type).
 *
 * Phase 2.5.2: table view with status, scope, actions (Bump rollout,
 * Force update, Rollback, Promote, Delete).
 *
 * Currently a thin shell — will populate from `listReleases` endpoint when
 * the expert lands Task #11 (release endpoints). For now shows placeholder
 * with info about the model.
 */

import { useQuery } from "@tanstack/react-query";
import { listApps, listChannels, listProductTypes, listReleaseTypes } from "../lib/api";

export function Releases({ appId }: { appId: string }) {
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
        <div className="text-sm text-slate-500">Releases</div>
        <h1 className="text-2xl font-bold">
          {thisApp?.name ?? "..."}
          <span className="badge-blue align-middle ml-2">{thisApp?.platform}</span>
        </h1>
        <div className="text-sm text-slate-500 font-mono">{thisApp?.slug}</div>
      </div>

      <div className="card !p-4 text-sm text-slate-600">
        <p className="mb-2">
          <strong>Releases tab scaffold.</strong> Will populate from the releases
          endpoint (Task #11) when the backend lands.
        </p>
        <p className="text-xs text-slate-500">
          Schema in place: <code>releases</code> + <code>release_scopes</code> tables on
          remote D1 (migrations 0011 + 0012). Endpoint list:
        </p>
        <ul className="text-xs text-slate-500 list-disc list-inside mt-1">
          <li>GET /api/apps/:appId/releases — list (status / channel filter)</li>
          <li>GET /api/apps/:appId/releases/:releaseId — detail (build + assets + scopes)</li>
          <li>POST /api/apps/:appId/releases — promote build (transactional supersede)</li>
          <li>POST /api/apps/:appId/releases/:releaseId/rollback</li>
          <li>POST /api/apps/:appId/releases/:releaseId/bump-rollout</li>
          <li>POST /api/apps/:appId/releases/:releaseId/force-update</li>
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          Scope model: full / platform (e.g. darwin-arm64,darwin-x64) / ip_range
          (CIDR list) / user_cohort (Phase 5). Resolution priority: ip_range &gt;
          user_cohort &gt; platform &gt; full.
        </p>
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