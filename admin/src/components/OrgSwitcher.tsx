/**
 * OrgSwitcher — top-bar dropdown for switching between orgs the user is in.
 *
 * v1: most users are in a single org (Raft server). The dropdown is a
 * no-op for them. When the user is in 2+ orgs (multi-Raft-server case),
 * the chevron appears in the Org nav link and clicking opens a dropdown
 * listing the orgs.
 *
 * Future (P5.4.6 follow-up): when switching orgs, the SPA will need to
 * invalidate all /api/apps cache, refetch everything. Today the switch
 * is just a navigation — the underlying queries will refetch on focus
 * or page reload.
 */

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listOrgs, type Org } from "../lib/api";

export function OrgSwitcher({
  currentOrgId,
  buttonLabel,
  onClose,
}: {
  currentOrgId: string | null;
  buttonLabel: string;
  onClose: () => void;
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
      className="absolute top-full left-0 mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-30"
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
            <Link
              key={o.id}
              to={`/orgs/${o.id}`}
              onClick={onClose}
              className={`flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 ${
                isCurrent ? "bg-slate-50 font-medium" : ""
              }`}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
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
              {isCurrent && <span className="text-xs text-blue-600">●</span>}
            </Link>
          );
        })}
      </div>
      <div className="text-xs text-slate-400 px-3 py-2 border-t border-slate-100">
        v1 single-org: switching requires re-login.
      </div>
    </div>
  );
}