import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Navigate,
  useParams,
  useNavigate,
  useLocation,
  Link,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AppsList } from "./pages/AppsList";
import { AppChannels, AppDetail, AppSettings } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";
import { Builds } from "./pages/Builds";
import { Releases } from "./pages/Releases";
import { AppShares } from "./pages/Shares";
import { AppFeedback, FeedbackTicketPage } from "./pages/Feedback";
import { OrgSettings } from "./pages/OrgSettings";
import { AcceptInvite } from "./pages/AcceptInvite";
import { AppAccess } from "./pages/AppAccess";
import { OrgSwitcher, useClearOrgCache } from "./components/OrgSwitcher";
import { getAuthMe, listApps, listOrgs, loginUrl, logout, type AuthAccount } from "./lib/api";

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

function QuiverMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="64" height="64" rx="14" fill="#0f172a" />
      <path
        d="M24 20l19 19M32 17l14 14M18 27l13 13"
        stroke="#f8fafc"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M44 37l7 7-10 3 3-10ZM46 29l6 6-9 2 3-8ZM31 39l6 6-9 2 3-8Z"
        fill="#38bdf8"
      />
      <path
        d="M17 39c3.5 4.8 8.6 7.6 15 7.6 4.9 0 9.1-1.6 12.4-4.8"
        stroke="#f8fafc"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M17 39c2.2 6.8 7.4 10.2 15.5 10.2"
        stroke="#38bdf8"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Header({ account }: { account: AuthAccount }) {
  const onLogout = async () => {
    await logout();
    window.location.assign("/");
  };
  const orgHref = account.org_id ? `/orgs/${account.org_id}` : "/orgs/placeholder";
  const orgs = useQuery({
    queryKey: ["orgs", account.id],
    queryFn: () => listOrgs(),
    enabled: !!account.id,
  });
  const switchOrg = useClearOrgCache();
  const [showOrgSwitcher, setShowOrgSwitcher] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showAccountMenu) return;
    function onPointerDown(event: MouseEvent) {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setShowAccountMenu(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setShowAccountMenu(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showAccountMenu]);

  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between gap-6">
        <div className="flex items-center gap-6">
          <Link
            to="/"
            className="inline-flex h-10 items-center gap-2 text-xl font-medium tracking-tight leading-none"
            aria-label="Quiver"
          >
            <QuiverMark className="h-8 w-8 flex-none" />
            <span>Quiver</span>
          </Link>
          <nav className="flex items-center gap-2">
            <NavLink
              to="/apps"
              end
              className={({ isActive }) =>
                `inline-flex h-10 items-center rounded-md px-3 text-sm leading-none ${
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
                  `inline-flex h-10 items-center rounded-md px-3 text-sm leading-none ${
                    isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
                  }`
                }
                aria-label={
                  account.org_id
                    ? `Org ${account.server_slug ?? account.server_id}, role ${account.org_role ?? "none"}`
                    : "Org settings"
                }
              >
                <span className="inline-flex items-center gap-1 leading-none">
                  Org
                  {account.org_role && (
                    <span
                      className="inline-flex items-center rounded px-1 text-xs leading-none"
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
          </nav>
        </div>
        <div ref={accountMenuRef} className="relative text-sm">
          <button
            type="button"
            className="inline-flex h-10 items-center gap-3 rounded-md px-2 hover:bg-slate-100"
            onClick={() => setShowAccountMenu((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={showAccountMenu}
          >
            <span className="text-right leading-tight">
              <span className="font-medium flex items-center gap-1 justify-end">
                {account.display_name}
                {account.principal_type === "agent" && (
                  <span
                    className="badge-purple text-xs"
                    title="Raft agent principal"
                  >
                    agent
                  </span>
                )}
              </span>
              <span className="block text-xs text-slate-500">
                {account.server_slug || account.server_id}
              </span>
            </span>
            {account.avatar_url ? (
              <img
                src={account.avatar_url}
                alt=""
                className="h-8 w-8 rounded-full border border-slate-200"
              />
            ) : (
              <span className="h-8 w-8 rounded-full border border-slate-200 bg-slate-100 flex items-center justify-center text-xs font-semibold text-slate-600">
                {account.display_name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </button>
          {showAccountMenu && (
            <div className="absolute right-0 top-full z-30 mt-2 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
              <div className="px-2 py-2 border-b border-slate-100">
                <div className="font-medium text-slate-900">
                  {account.display_name}
                </div>
                <div className="text-xs text-slate-500">
                  {account.server_slug || account.server_id}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {account.principal_type === "agent" ? "Raft agent" : "Raft user"}
                </div>
              </div>
              <Link
                to="/settings"
                role="menuitem"
                className="mt-2 flex w-full items-center rounded-md px-2 py-2 text-left text-sm text-slate-700 no-underline hover:bg-slate-100"
                onClick={() => setShowAccountMenu(false)}
              >
                Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                className="mt-1 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm text-red-600 hover:bg-red-50"
                onClick={onLogout}
              >
                <span>Logout</span>
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function AppContextNav() {
  const { appId } = useParams();
  if (!appId) return null;
  const base = `/apps/${appId}`;
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `inline-flex h-9 items-center rounded-md px-3 text-sm ${
      isActive
        ? "bg-slate-100 font-medium text-slate-950"
        : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
    }`;

  return (
    <div className="bg-white border-b border-slate-200 -mt-px">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-1 overflow-x-auto">
        <NavLink
          to={base}
          end
          className={tabClass}
        >
          Overview
        </NavLink>
        <NavLink
          to={`${base}/channels`}
          className={tabClass}
        >
          Channels
        </NavLink>
        <NavLink
          to={`${base}/releases`}
          className={tabClass}
        >
          Releases
        </NavLink>
        <NavLink
          to={`${base}/shares`}
          className={tabClass}
        >
          Shares
        </NavLink>
        <NavLink
          to={`${base}/feedback`}
          className={tabClass}
        >
          Feedback
        </NavLink>
        <NavLink
          to={`${base}/builds`}
          className={tabClass}
        >
          Builds
        </NavLink>
        <NavLink
          to={`${base}/access`}
          className={tabClass}
        >
          Access
        </NavLink>
        <NavLink
          to={`${base}/audit`}
          className={tabClass}
        >
          Audit
        </NavLink>
        <NavLink
          to={`${base}/settings`}
          className={tabClass}
        >
          Settings
        </NavLink>
      </div>
    </div>
  );
}

function AppDetailRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppDetail appId={appId} />;
}

function AppChannelsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppChannels appId={appId} />;
}

function AppSettingsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppSettings appId={appId} />;
}

function AppFeedbackRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppFeedback appId={appId} />;
}

function FeedbackTicketRoute() {
  const { appId, ticketId } = useParams();
  if (!appId || !ticketId) return null;
  return <FeedbackTicketPage appId={appId} ticketId={ticketId} />;
}

function AppSharesRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppShares appId={appId} />;
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

function SettingsPage() {
  return (
    <StandardPageShell>
      <Settings />
    </StandardPageShell>
  );
}

function OrgSettingsPage() {
  return (
    <StandardPageShell>
      <OrgSettingsRoute />
    </StandardPageShell>
  );
}

function StandardPageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
      {children}
    </main>
  );
}

function AcceptInviteRoute() {
  const { token } = useParams();
  if (!token) return null;
  return <AcceptInvite token={token} />;
}

function PageTitle() {
  const { pathname } = useLocation();
  const appId = pathname.startsWith("/apps/") ? pathname.split("/")[2] : null;
  const apps = useQuery({
    queryKey: ["apps"],
    queryFn: listApps,
    enabled: !!appId,
    retry: false,
  });
  const appName = appId ? apps.data?.apps.find((app) => app.id === appId)?.name : null;

  const section = (() => {
    if (pathname === "/") return "Home";
    if (pathname === "/apps") return "Apps";
    if (pathname === "/settings") return "Settings";
    if (pathname.startsWith("/orgs/")) return "Org";
    if (pathname.startsWith("/invites/")) return "Invite";
    if (pathname.includes("/channels")) return "Channels";
    if (pathname.includes("/releases")) return "Releases";
    if (pathname.includes("/builds")) return "Builds";
    if (pathname.includes("/access")) return "Access";
    if (pathname.includes("/audit")) return "Audit";
    if (pathname.includes("/settings")) return "Settings";
    if (pathname.startsWith("/apps/")) return "Overview";
    return "Not Found";
  })();
  const title = appId && appName ? `${section} - ${appName}` : section;

  useEffect(() => {
    document.title = `${title} - Quiver`;
  }, [title]);

  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <PageTitle />
      <AuthGate />
    </BrowserRouter>
  );
}

function AuthGate() {
  const location = useLocation();
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
    return <PublicLanding />;
  }

  if (location.pathname === "/") {
    return <PublicLanding account={me.data.account} />;
  }

  return <AuthenticatedApp account={me.data.account} />;
}

function PublicLanding({ account }: { account?: AuthAccount }) {
  useEffect(() => {
    document.title = "Quiver - Android release distribution";
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <a href="/" className="inline-flex items-center gap-2 font-medium">
            <QuiverMark className="h-9 w-9 flex-none" />
            <span className="text-xl leading-none">Quiver</span>
          </a>
          <nav className="flex items-center gap-2 text-sm">
            <a
              href="/docs"
              className="hidden h-10 items-center rounded-md px-3 text-slate-600 hover:bg-slate-100 hover:text-slate-950 sm:inline-flex"
            >
              Docs
            </a>
            <a
              href="/api-docs"
              className="hidden h-10 items-center rounded-md px-3 text-slate-600 hover:bg-slate-100 hover:text-slate-950 sm:inline-flex"
            >
              API explorer
            </a>
            <a
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-900 bg-slate-950 px-4 font-medium text-white hover:bg-slate-800"
              href={account ? "/apps" : loginUrl("/apps")}
            >
              <RaftIcon className="h-5 w-5" />
              {account ? "Open dashboard" : "Login"}
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.1fr_0.9fr] md:items-center md:py-20">
            <div className="max-w-2xl">
              <div className="mb-4 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
                Release distribution for Raft-built apps
              </div>
              <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
                Ship Android builds, releases, and share links from one place.
              </h1>
              <p className="mt-5 text-lg leading-8 text-slate-600">
                Quiver manages APK uploads, release channels, public update
                checks, share pages, and Raft-based access control for humans
                and agents.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-slate-950 px-5 text-sm font-medium text-white hover:bg-slate-800"
                  href={account ? "/apps" : loginUrl("/apps")}
                >
                  <RaftIcon className="h-5 w-5" />
                  {account ? "Open dashboard" : "Login with Raft"}
                </a>
                <a
                  className="inline-flex h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-5 text-sm font-medium text-slate-800 hover:bg-slate-100"
                  href="/docs"
                >
                  Read docs
                </a>
                <a
                  className="inline-flex h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-5 text-sm font-medium text-slate-800 hover:bg-slate-100"
                  href="https://github.com/oranix-io/quiver"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-950 p-5 text-sm text-slate-100 shadow-sm">
              <div className="mb-4 flex items-center justify-between border-b border-slate-700 pb-3">
                <span className="font-medium">quiver release</span>
                <span className="rounded bg-sky-400/15 px-2 py-0.5 text-xs text-sky-200">
                  main
                </span>
              </div>
              <div className="space-y-3 font-mono text-xs leading-6 text-slate-300">
                <div>$ npm exec --package @oranix/quiver-cli -- quiver builds publish-android raft-android</div>
                <div className="text-slate-500">uploading APK and metadata...</div>
                <div className="text-slate-500">creating release on channel main...</div>
                <div className="text-emerald-300">release: 14998dba-cfde-4002-8c01-230a2760f662</div>
                <div className="text-emerald-300">share: https://quiver.oranix.io/share/...</div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-8 sm:grid-cols-2 lg:grid-cols-4">
          <LandingFeature
            title="Channels"
            body="Keep main, preview, nightly, or debug releases separated by app."
          />
          <LandingFeature
            title="Update checks"
            body="Serve public latest/update responses with signed APK downloads."
          />
          <LandingFeature
            title="Share pages"
            body="Create expiring download pages with view and download counts."
          />
          <LandingFeature
            title="Raft access"
            body="Use Raft login, org roles, direct app members, and server visibility."
          />
        </section>

        <section className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Build from CI or local scripts.</h2>
              <p className="mt-1 text-sm text-slate-600">
                The public npm CLI can publish Android releases and create share
                links from GitHub Actions, local packaging lanes, or Raft agents.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <a
                className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/cli-reference/"
              >
                CLI reference
              </a>
              <a
                className="inline-flex h-10 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/admin-user-guide/"
              >
                Admin guide
              </a>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function LandingFeature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
    </div>
  );
}

function AuthenticatedApp({ account }: { account: AuthAccount }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header account={account} />
      <Routes>
        <Route path="/" element={<Navigate to="/apps" replace />} />
        <Route path="/apps" element={<AppsListWithNav />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/orgs/:orgId" element={<OrgSettingsPage />} />
        <Route path="/invites/:token" element={<AcceptInviteRoute />} />
        <Route path="/apps/:appId" element={<AppShell />}>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<LegacyPublishRedirect />} />
          <Route path="channels" element={<AppChannelsRoute />} />
          <Route path="builds" element={<BuildsRoute />} />
          <Route path="releases" element={<ReleasesRoute />} />
          <Route path="shares" element={<AppSharesRoute />} />
          <Route path="feedback" element={<AppFeedbackRoute />} />
          <Route path="feedback/:ticketId" element={<FeedbackTicketRoute />} />
          <Route path="access" element={<AppAccessRoute />} />
          <Route path="audit" element={<AuditRoute />} />
          <Route path="settings" element={<AppSettingsRoute />} />
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
          <span>Quiver - Login with Raft</span>
          <a
            href="https://github.com/oranix-io/quiver"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary !py-1 !px-2 !text-xs inline-flex items-center gap-1.5"
            title="View Quiver source on GitHub"
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
    <StandardPageShell>
      <AppsList onSelectApp={(appId) => navigate(`/apps/${appId}`)} />
    </StandardPageShell>
  );
}

const APP_NAV_SECTIONS: Array<{ label: string; items: Array<{ to: string; label: string; end?: boolean }> }> = [
  {
    label: "Distribute",
    items: [
      { to: "", label: "Overview", end: true },
      { to: "channels", label: "Channels" },
      { to: "releases", label: "Releases" },
      { to: "builds", label: "Builds" },
      { to: "shares", label: "Shares" },
    ],
  },
  {
    label: "Operate",
    items: [
      { to: "feedback", label: "Feedback" },
      { to: "access", label: "Access" },
      { to: "audit", label: "Audit" },
      { to: "settings", label: "Settings" },
    ],
  },
];

function AppSidebar() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  if (!appId) return null;
  const app = apps.data?.apps.find((a) => a.id === appId);
  const others = (apps.data?.apps ?? []).filter((a) => a.id !== appId && !a.archived);
  const base = `/apps/${appId}`;

  return (
    <aside className="hidden md:flex w-60 flex-none flex-col border-r border-slate-200 bg-white">
      <div className="relative border-b border-slate-100 p-3">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-slate-50"
          onClick={() => setSwitcherOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={switcherOpen}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">
              {app?.name ?? "…"}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5">
              {app?.platform && <span className="badge-blue">{app.platform}</span>}
              <span className="truncate text-xs text-slate-400 font-mono">{app?.slug}</span>
            </span>
          </span>
          <span className="text-slate-400" aria-hidden="true">⌄</span>
        </button>
        {switcherOpen && (
          <div className="absolute left-3 right-3 top-full z-30 -mt-1 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {others.map((a) => (
              <button
                key={a.id}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  setSwitcherOpen(false);
                  navigate(`/apps/${a.id}`);
                }}
              >
                <span className="truncate">{a.name}</span>
                <span className="badge-blue ml-auto">{a.platform}</span>
              </button>
            ))}
            {others.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-400">No other apps</div>
            )}
            <Link
              to="/apps"
              className="mt-1 flex items-center gap-1 border-t border-slate-100 px-3 py-2 text-xs text-slate-500 hover:bg-slate-50"
              onClick={() => setSwitcherOpen(false)}
            >
              ← All apps
            </Link>
          </div>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto p-3">
        {APP_NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mb-4">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {section.label}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <NavLink
                  key={item.label}
                  to={item.to ? `${base}/${item.to}` : base}
                  end={item.end ?? false}
                  className={({ isActive }) =>
                    `block rounded-md px-2 py-1.5 text-sm ${
                      isActive
                        ? "bg-slate-100 font-medium text-slate-950"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function AppShell() {
  return (
    <div className="flex flex-1 min-h-0 items-stretch">
      <AppSidebar />
      <div className="min-w-0 flex-1">
        <div className="md:hidden">
          <AppContextNav />
        </div>
        <main className="max-w-5xl px-6 py-6 w-full">
        <Routes>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<LegacyPublishRedirect />} />
          <Route path="channels" element={<AppChannelsRoute />} />
          <Route path="builds" element={<BuildsRoute />} />
          <Route path="releases" element={<ReleasesRoute />} />
          <Route path="shares" element={<AppSharesRoute />} />
          <Route path="feedback" element={<AppFeedbackRoute />} />
          <Route path="feedback/:ticketId" element={<FeedbackTicketRoute />} />
          <Route path="access" element={<AppAccessRoute />} />
          <Route path="audit" element={<AuditRoute />} />
          <Route path="settings" element={<AppSettingsRoute />} />
        </Routes>
        </main>
      </div>
    </div>
  );
}
