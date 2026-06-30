import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Navigate,
  useParams,
  useNavigate,
  Link,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppsList } from "./pages/AppsList";
import { AppDetail } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";
import { Builds } from "./pages/Builds";
import { Releases } from "./pages/Releases";
import { OrgSettings } from "./pages/OrgSettings";
import { AcceptInvite } from "./pages/AcceptInvite";
import { AppAccess } from "./pages/AppAccess";
import { OrgSwitcher, useClearOrgCache } from "./components/OrgSwitcher";
import { getAuthMe, listOrgs, loginUrl, logout, type AuthAccount } from "./lib/api";

function RaftIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 274 253"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M211.83 0.436221C219.54 -0.783748 227.69 0.466129 233.91 5.3161C238.3 8.73627 249.16 18.0962 252.21 20.5661C258.34 25.536 262.979 31.8459 264.349 39.6257L273.96 94.1559H273.95C276.75 110.076 266.079 125.386 250.189 128.286L247.08 128.866C247.69 130.536 248.2 132.276 248.51 134.076L257.929 187.566C260.769 203.576 250.029 218.886 234.019 221.726L62.4099 251.976C49.2399 254.296 44.0596 247.736 30.8796 235.996C19.5299 225.836 11.7302 220.566 9.53002 210.346L0.959706 161.736C-0.840294 151.396 -0.44045 145.475 5.04955 137.425C10.1096 129.986 18.4103 126.206 28.9001 124.346C28.3501 122.766 27.8693 121.146 27.5593 119.406L20.0593 76.8356C18.0493 65.4559 15.5198 54.326 24.0593 42.7663C31.4393 32.7963 41.0097 30.5656 52.9997 28.7956L211.83 0.436221ZM94.4099 174.725C92.2099 176.735 87.1797 179.395 81.9997 178.175C77.4897 177.105 74.2192 173.175 73.3992 168.595L68.7292 142.095L33.2898 148.345C27.9798 149.295 24.4191 154.356 25.3591 159.656L33.1697 203.906C34.1199 209.216 39.1795 212.785 44.4792 211.836V211.866L44.49 211.876L206.889 183.235C212.199 182.285 215.759 177.226 214.819 171.916L207.01 127.635C206.059 122.325 200.999 118.756 195.689 119.706C190.379 120.656 184.369 121.715 181.359 122.235C176.599 123.085 168.549 120.135 167.179 112.355L164.679 98.1755L94.4099 174.725ZM222.81 33.2556C221.86 27.9158 216.8 24.3859 211.46 25.3259L50.6804 53.9558C45.3704 54.9058 41.84 59.9663 42.78 65.2663L50.7703 110.556V110.596C51.7204 115.906 56.78 119.476 62.0798 118.526L76.4802 115.996C83.13 114.836 89.4402 119.256 90.6003 125.876L93.1003 140.056L163.37 63.5056C166.51 60.0857 171.33 58.7464 175.78 60.0563C180.23 61.3664 183.59 65.0865 184.38 69.6364L189.05 96.0759L222.93 89.9157C228.21 88.9355 231.739 83.906 230.8 78.6061L222.81 33.2556Z"
        fill="currentColor"
      />
    </svg>
  );
}

function Header({ account }: { account: AuthAccount }) {
  const onLogout = async () => {
    await logout();
    window.location.assign(loginUrl("/"));
  };
  const orgHref = account.org_id ? `/orgs/${account.org_id}` : "/orgs/placeholder";
  const orgs = useQuery({
    queryKey: ["orgs", account.id],
    queryFn: () => listOrgs(),
    enabled: !!account.id,
  });
  const switchOrg = useClearOrgCache();
  const [showOrgSwitcher, setShowOrgSwitcher] = useState(false);
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-6">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-xl font-bold tracking-tight">
            quiver
          </Link>
          <nav className="flex gap-2">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md text-sm ${
                  isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
                }`
              }
            >
              Apps
            </NavLink>
            <div className="relative">
              <NavLink
                to={orgHref}
                onClick={(e) => {
                  if (orgs.data && orgs.data.orgs.length > 1) {
                    e.preventDefault();
                    setShowOrgSwitcher((s) => !s);
                  }
                }}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md text-sm ${
                    isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
                  }`
                }
                title={
                  account.org_id
                    ? `Org ${account.server_slug ?? account.server_id} — your role: ${account.org_role ?? "—"}`
                    : "Org settings (no org yet — first login required)"
                }
              >
                <span className="inline-flex items-center gap-1">
                  Org
                  {account.org_role && (
                    <span
                      className="text-xs px-1 rounded"
                      style={{
                        color:
                          account.org_role === "owner"
                            ? "#a855f7"
                            : account.org_role === "admin"
                              ? "#3b82f6"
                              : "#6b7280",
                      }}
                    >
                      {account.org_role}
                    </span>
                  )}
                  {orgs.data && orgs.data.orgs.length > 1 && (
                    <span
                      className="text-xs text-slate-400"
                      title={`Member of ${orgs.data.orgs.length} organizations`}
                    >
                      ▾
                    </span>
                  )}
                </span>
              </NavLink>
              {showOrgSwitcher &&
                orgs.data &&
                orgs.data.orgs.length > 1 && (
                  <OrgSwitcher
                    currentOrgId={account.org_id ?? null}
                    buttonLabel={`Switch organization (${
                      orgs.data.orgs.length
                    } members of)`}
                    onClose={() => setShowOrgSwitcher(false)}
                    onSwitch={switchOrg}
                  />
                )}
            </div>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-md text-sm ${
                  isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
                }`
              }
            >
              Settings
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <div className="text-right leading-tight">
            <div className="font-medium flex items-center gap-1 justify-end">
              {account.display_name}
              {account.principal_type === "agent" && (
                <span
                  className="badge-purple text-xs"
                  title="Raft agent principal"
                >
                  agent
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500">
              {account.server_slug || account.server_id}
            </div>
          </div>
          {account.avatar_url ? (
            <img
              src={account.avatar_url}
              alt=""
              className="h-8 w-8 rounded-full border border-slate-200"
            />
          ) : (
            <div className="h-8 w-8 rounded-full border border-slate-200 bg-slate-100 flex items-center justify-center text-xs font-semibold text-slate-600">
              {account.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <button
            className="px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50"
            onClick={onLogout}
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}

function AppContextNav() {
  const { appId } = useParams();
  if (!appId) return null;
  const base = `/apps/${appId}`;
  return (
    <div className="bg-white border-b border-slate-200 -mt-px">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-2">
        <span className="text-xs text-slate-500 mr-2">App context:</span>
        <NavLink
          to={`${base}/releases`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm font-medium ${
              isActive ? "bg-slate-900 text-white" : "bg-slate-100 hover:bg-slate-200"
            }`
          }
        >
          Releases
        </NavLink>
        <NavLink
          to={base}
          end
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Overview
        </NavLink>
        <NavLink
          to={`${base}/builds`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Builds
        </NavLink>
        <NavLink
          to={`${base}/access`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Access
        </NavLink>
        <NavLink
          to={`${base}/audit`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Audit
        </NavLink>
      </div>
    </div>
  );
}

function AppDetailRoute() {
  const { appId } = useParams();
  const navigate = useNavigate();
  if (!appId) return null;
  return (
    <AppDetail
      appId={appId}
      onShowAudit={() => navigate(`/apps/${appId}/audit`)}
      onShowReleases={() => navigate(`/apps/${appId}/releases`)}
      onShowAccess={() => navigate(`/apps/${appId}/access`)}
    />
  );
}

function AppAccessRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppAccess appId={appId} />;
}

function AuditRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AuditLog appId={appId} />;
}

function BuildsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Builds appId={appId} />;
}

function ReleasesRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Releases appId={appId} />;
}

function LegacyPublishRedirect() {
  return <Navigate to="../releases" replace />;
}

function OrgSettingsRoute() {
  const { orgId } = useParams();
  if (!orgId) return null;
  return <OrgSettings orgId={orgId} />;
}

function AcceptInviteRoute() {
  const { token } = useParams();
  if (!token) return null;
  return <AcceptInvite token={token} />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  );
}

function AuthGate() {
  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: getAuthMe,
    retry: false,
  });

  if (me.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-500">Checking Raft session...</div>
      </div>
    );
  }

  if (me.isError || !me.data?.authenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
        <div className="card max-w-md w-full text-center space-y-4">
          <div>
            <h1 className="text-2xl font-bold">quiver</h1>
            <p className="text-sm text-slate-600 mt-2">
              Admin access requires Login with Raft.
            </p>
          </div>
          <a
            className="inline-flex w-full items-center justify-center gap-3 rounded-none border-2 border-slate-950 bg-[#ffd440] px-5 py-3 font-black text-slate-950 shadow-[6px_6px_0_#020617] transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[8px_8px_0_#020617] active:translate-x-1 active:translate-y-1 active:shadow-[3px_3px_0_#020617]"
            href={loginUrl()}
          >
            <RaftIcon className="h-6 w-6 text-slate-950" />
            Login with Raft
          </a>
          <p className="text-xs text-slate-500">
            Cloudflare Access and browser-visible API tokens are not used.
          </p>
        </div>
      </div>
    );
  }

  return <AuthenticatedApp account={me.data.account} />;
}

function AuthenticatedApp({ account }: { account: AuthAccount }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header account={account} />
      <Routes>
        <Route path="/" element={<AppsListWithNav />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/orgs/:orgId" element={<OrgSettingsRoute />} />
        <Route path="/invites/:token" element={<AcceptInviteRoute />} />
        <Route path="/apps/:appId" element={<AppShell />}>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<LegacyPublishRedirect />} />
          <Route path="builds" element={<BuildsRoute />} />
          <Route path="releases" element={<ReleasesRoute />} />
          <Route path="access" element={<AppAccessRoute />} />
          <Route path="audit" element={<AuditRoute />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="max-w-5xl mx-auto px-4 py-8">
              <p className="text-slate-500">404 - not found</p>
            </div>
          }
        />
      </Routes>
      <footer className="bg-white border-t border-slate-200 py-4 mt-8">
        <div className="max-w-5xl mx-auto px-4 text-xs text-slate-500 flex items-center justify-between">
          <span>quiver admin - Login with Raft</span>
          <a
            href="https://github.com/oranix-io/quiver"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary !py-1 !px-2 !text-xs inline-flex items-center gap-1.5"
            title="View quiver source on GitHub"
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="w-3.5 h-3.5"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
                clipRule="evenodd"
              />
            </svg>
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

function AppsListWithNav() {
  const navigate = useNavigate();
  return (
    <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
      <AppsList onSelectApp={(appId) => navigate(`/apps/${appId}`)} />
    </main>
  );
}

function AppShell() {
  return (
    <>
      <AppContextNav />
      <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
        <Routes>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<LegacyPublishRedirect />} />
          <Route path="builds" element={<BuildsRoute />} />
          <Route path="releases" element={<ReleasesRoute />} />
          <Route path="access" element={<AppAccessRoute />} />
          <Route path="audit" element={<AuditRoute />} />
        </Routes>
      </main>
    </>
  );
}
