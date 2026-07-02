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
        <div className="card !p-4 space-y-2 text-sm mb-4">
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
            Login is via Login with Raft. The Worker owns the OAuth callback
            and session cookie. To change role, ask an org owner / admin in
            the Org settings page (under construction).
          </p>
        </div>
      )}

      {/* Infrastructure (existing static info) */}
      <div className="card space-y-3 text-sm">
        <p className="text-slate-600">
          Admin authentication is Login with Raft only. The Worker owns the
          OAuth callback and session cookie; Cloudflare Access can be disabled
          after the Raft client secret is configured.
        </p>
        <div>
          <div className="text-slate-500">Raft Callback URL</div>
          <div className="font-mono">{raftCallbackUrl}</div>
        </div>
        <div>
          <div className="text-slate-500">Cloudflare Account</div>
          <div className="font-mono">cfb85626a067371c6e9a75191b5fb09d</div>
        </div>
        <div>
          <div className="text-slate-500">D1 Database</div>
          <div className="font-mono">quiver-db (fdc960cc-d1c5-41ae-96f3-c74df4b97d6b)</div>
        </div>
        <div>
          <div className="text-slate-500">R2 Bucket</div>
          <div className="font-mono">quiver-apks</div>
        </div>
        <div>
          <div className="text-slate-500">Container</div>
          <div className="font-mono">apk-parser (Node 24 + aapt + apksigner)</div>
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
