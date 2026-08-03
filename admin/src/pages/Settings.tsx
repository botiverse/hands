import { useQuery } from "@tanstack/react-query";
import { getAuthMe } from "../lib/api";

export function Settings() {
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const account = me.data?.account;
  const raftCallbackUrl = `${window.location.origin}/login/raft/callback`;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Settings</h1>

      {/* Current account + org context */}
      {account && (
        <div className="card p-4! space-y-2 text-sm mb-4">
          <h2 className="text-base font-semibold text-slate-700">
            Current account
          </h2>
          <Row k="Display name" v={account.display_name} />
          <Row
            k="Principal type"
            v={
              account.principal_type === "agent"
                ? "agent (Raft)"
                : account.principal_type === "human"
                  ? "human (Raft)"
                  : account.principal_type
            }
            color={
              account.principal_type === "agent" ? "#a855f7" : undefined
            }
          />
          <Row k="Server" v={account.server_slug ?? account.server_id} mono />
          <Row k="Server role (from Raft)" v={account.server_role ?? "—"} />
          <Row k="Org id" v={account.org_id ?? "—"} mono />
          <Row
            k="Your org role"
            v={account.org_role ?? "—"}
            color={
              account.org_role === "owner"
                ? "#a855f7"
                : account.org_role === "admin"
                  ? "#3b82f6"
                  : undefined
            }
          />
          <p className="text-xs text-slate-500 pt-3 border-t border-slate-100">
            Signed in with Raft. To change role, ask an organization owner or
            admin in Organization settings.
          </p>
        </div>
      )}

      {/* Infrastructure (existing static info) */}
      <div className="card space-y-3 text-sm">
        <p className="text-slate-600">
          Admin access uses Login with Raft. Access follows your Raft
          organization membership and role.
        </p>
        <div>
          <div className="text-slate-500">Raft Callback URL</div>
          <div className="font-mono">{raftCallbackUrl}</div>
        </div>
      </div>
    </div>
  );
}

function Row({
  k,
  v,
  mono,
  color,
}: {
  k: string;
  v: string;
  mono?: boolean | undefined;
  color?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-44 text-xs text-slate-500">{k}</div>
      <div className={mono ? "font-mono text-xs" : "text-sm"} style={{ color }}>
        {v}
      </div>
    </div>
  );
}
