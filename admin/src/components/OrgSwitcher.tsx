/**
 * OrgSwitcher — sidebar dropdown for switching the active organization.
 *
 * P5.4.6 follow-up (task #23): when switching orgs, the SPA invalidates
 * the entire TanStack Query cache so apps / channels / releases / audit
 * logs for the previous org don't leak into the new org's view.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Settings } from "lucide-react";
import { Link } from "react-router-dom";
import {
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "raft-ui";
import { getAuthMe, listOrgs, setActiveOrgId, type Org } from "../lib/api";

/**
 * OrgSwitcher — renders the org-switch rows as raft-ui DropdownMenu children.
 * Mount it inside a <DropdownMenuContent>; the enclosing DropdownMenu owns
 * open/close (each DropdownMenuItem auto-closes the menu on select).
 */
export function OrgSwitcher({
  currentOrgId,
  buttonLabel,
  onSwitch,
}: {
  currentOrgId: string | null;
  buttonLabel: string;
  onSwitch?: (org: Org) => void;
}) {
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });

  return (
    <>
      <DropdownMenuLabel>{buttonLabel}</DropdownMenuLabel>
      {orgs.isLoading && (
        <p className="text-xs text-slate-400 px-3 py-2">Loading…</p>
      )}
      {orgs.error && (
        <p className="text-xs text-red-600 px-3 py-2">
          Failed: {(orgs.error as Error).message}
        </p>
      )}
      {orgs.data?.orgs.map((o: Org) => {
        const isCurrent = o.id === currentOrgId;
        return (
          <DropdownMenuItem
            key={o.id}
            className={isCurrent ? "bg-slate-50 font-medium" : ""}
            onClick={() => {
              if (onSwitch && !isCurrent) onSwitch(o);
            }}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{
                backgroundColor:
                  o.external_provider === "raft" ? "#3b82f6" : "#6b7280",
              }}
            />
            <span className="flex-1 truncate">
              <span className="block truncate">{o.name}</span>
              {o.slug && (
                <span className="block truncate text-xs text-slate-500 font-mono">
                  {o.slug}
                </span>
              )}
            </span>
            {isCurrent && <Check className="h-4 w-4 text-slate-700" aria-hidden="true" />}
          </DropdownMenuItem>
        );
      })}
      {currentOrgId && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link to={`/orgs/${currentOrgId}`} />}>
            <Settings className="h-4 w-4" aria-hidden="true" />
            Organization settings
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

// Re-export so callers can use the same QueryClient ref pattern.
export function useClearOrgCache() {
  const qc = useQueryClient();
  return (org: Org) => {
    setActiveOrgId(org.id);
    // Wipe the entire query cache for the previous org. This includes:
    //   - orgs list (will refetch with the new org at the top)
    //   - org-members / invites / audit-logs / webhooks
    //   - apps list + per-app detail / channels / releases / builds / audit
    //   - auth-me (org_id / org_role may change)
    qc.removeQueries();
    // Re-prefetch the orgs list + auth-me in the background so the
    // new-org landing page doesn't show stale top bar.
    qc.prefetchQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
    qc.prefetchQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
  };
}
