/**
 * OrgSwitcher — sidebar dropdown for switching the active organization.
 *
 * P5.4.6 follow-up (task #23): when switching orgs, the SPA invalidates
 * the entire TanStack Query cache so apps / channels / releases / audit
 * logs for the previous org don't leak into the new org's view.
 */

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Settings } from "lucide-react";
import { Link } from "react-router-dom";
import { getAuthMe, listOrgs, setActiveOrgId, type Org } from "../lib/api";

export function OrgSwitcher({
  currentOrgId,
  buttonLabel,
  onClose,
  onSwitch,
}: {
  currentOrgId: string | null;
  buttonLabel: string;
  onClose: () => void;
  onSwitch?: (org: Org) => void;
}) {
  const orgs = useQuery({ queryKey: ["orgs"], queryFn: () => listOrgs() });
  const ref = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="w-72 rounded-md border border-slate-200 bg-white shadow-lg"
    >
      <div className="text-xs text-slate-500 px-3 py-2 border-b border-slate-100">
        {buttonLabel}
      </div>
      <div className="py-1 max-h-64 overflow-y-auto">
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
            <button
              type="button"
              key={o.id}
              onClick={() => {
                if (onSwitch && !isCurrent) onSwitch(o);
                onClose();
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                isCurrent ? "bg-slate-50 font-medium" : ""
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    o.external_provider === "raft" ? "#3b82f6" : "#6b7280",
                }}
              />
              <span className="flex-1 truncate">
                <div>{o.name}</div>
                {o.slug && (
                  <div className="text-xs text-slate-500 font-mono">{o.slug}</div>
                )}
              </span>
              {isCurrent && <Check className="h-4 w-4 text-slate-700" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="border-t border-slate-100 p-1">
        {currentOrgId && (
          <Link
            to={`/orgs/${currentOrgId}`}
            onClick={onClose}
            className="flex items-center gap-2 rounded-sm px-2 py-2 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
            Organization settings
          </Link>
        )}
      </div>
    </div>
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
