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
import {
  Bug,
  ChevronDown,
  ChevronsUpDown,
  Gauge,
  LayoutGrid,
  MessageSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plane,
  Plus,
  Radio,
  Rocket,
  ScrollText,
  Settings as SettingsIcon,
  Share2,
  Store,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  Badge,
  CopyableCode,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "raft-ui";
import { AppsList } from "./pages/AppsList";
import { AppChannels, AppDetail, AppSettings, AppStoreReviewPanel } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";
import { Builds } from "./pages/Builds";
import { Testflight } from "./pages/Testflight";
import { Releases } from "./pages/Releases";
import { AppShares } from "./pages/Shares";
import { AppFeedback, FeedbackTicketPage } from "./pages/Feedback";
import { AppCrashes } from "./pages/Crashes";
import { isOrgSettingsTab, OrgSettings } from "./pages/OrgSettings";
import { AcceptInvite } from "./pages/AcceptInvite";
import { AppAccess } from "./pages/AppAccess";
import { OrgSwitcher, useClearOrgCache } from "./components/OrgSwitcher";
import { dashboardHref } from "./lib/authNavigation";
import {
  clearActiveOrgId,
  getAuthToken,
  getAuthMe,
  listApps,
  listOrgs,
  logout,
  type AuthAccount,
} from "./lib/api";

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

const SIDEBAR_COLLAPSED_KEY = "hands:sidebar-collapsed";

function Header({ account }: { account: AuthAccount }) {
  const navigate = useNavigate();
  const onLogout = async () => {
    await logout();
    clearActiveOrgId();
    window.location.assign("/");
  };
  const location = useLocation();
  const appId = location.pathname.startsWith("/apps/")
    ? location.pathname.split("/")[2] ?? null
    : null;
  const orgs = useQuery({
    queryKey: ["orgs"],
    queryFn: () => listOrgs(),
    enabled: !!account.id,
  });
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const switchOrg = useClearOrgCache();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const currentOrg = orgs.data?.orgs.find((org) => org.id === account.org_id);
  const currentApp = apps.data?.apps.find((app) => app.id === appId);
  const otherApps = (apps.data?.apps ?? []).filter(
    (app) => app.id !== appId && !app.archived,
  );
  const appBase = appId ? `/apps/${appId}` : null;

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }
  }, [collapsed]);

  const railItem = ({ isActive }: { isActive: boolean }) =>
    `flex w-full items-center rounded-md py-2 text-sm ${collapsed ? "flex-col gap-0.5 px-1 text-[11px] leading-none" : "gap-2 px-2"} ${
      isActive
        ? "bg-slate-100 font-medium text-slate-950"
        : "text-slate-500 hover:bg-slate-100 hover:text-slate-950"
    }`;

  return (
    <header
      className={`sticky top-0 z-30 hidden h-screen flex-none flex-col border-r border-slate-200 bg-white py-3 transition-[width] duration-150 md:flex ${
        collapsed ? "w-16 items-center" : "w-16 items-stretch md:w-60"
      }`}
    >
      <div className={`mb-4 flex h-9 items-center ${collapsed ? "justify-center" : "justify-between px-3"}`}>
        <Link to="/" aria-label="Hands" className="flex min-w-0 items-center gap-2">
          <QuiverMark className="h-9 w-9 flex-none" />
          {!collapsed && <span className="hidden truncate text-sm font-semibold text-slate-900 md:inline">Hands</span>}
        </Link>
        {!collapsed && (
          <button
            type="button"
            className="relative z-10 hidden h-10 w-10 flex-none touch-manipulation items-center justify-center rounded-md text-slate-500 outline-hidden hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-sky-500 md:flex"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="flex min-h-0 w-full flex-1 flex-col items-stretch gap-1 px-2">
        {!appId &&
          (collapsed ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <NavLink to="/apps" end className={railItem}>
                    <LayoutGrid className="h-4 w-4" aria-hidden="true" />
                    {!collapsed && <span className="hidden md:inline">Apps</span>}
                  </NavLink>
                }
              />
              <TooltipContent side="right">Apps</TooltipContent>
            </Tooltip>
          ) : (
            <NavLink to="/apps" end className={railItem}>
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
              {!collapsed && <span className="hidden md:inline">Apps</span>}
            </NavLink>
          ))}
        <div className="relative w-full">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={railItem({ isActive: location.pathname.startsWith("/orgs/") })}
                  aria-label={`Organization ${currentOrg?.name ?? account.server_slug ?? account.server_id}`}
                  title={collapsed ? currentOrg?.name ?? "Switch organization" : undefined}
                >
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-600">
                    {(currentOrg?.name ?? account.server_slug ?? "O").slice(0, 1).toUpperCase()}
                  </span>
                  {!collapsed && (
                    <>
                      <span className="hidden min-w-0 flex-1 text-left md:block">
                        <span className="block truncate font-medium text-slate-800">
                          {currentOrg?.name ?? account.server_slug ?? "Organization"}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {account.org_role ?? "member"}
                        </span>
                      </span>
                      <ChevronDown className="hidden h-4 w-4 text-slate-400 md:block" aria-hidden="true" />
                    </>
                  )}
                </button>
              }
            />
            <DropdownMenuContent
              side={collapsed ? "right" : "bottom"}
              align="start"
              className="w-72"
            >
              <OrgSwitcher
                currentOrgId={account.org_id ?? null}
                buttonLabel="Switch organization"
                onSwitch={(org) => {
                  switchOrg(org);
                  window.location.assign("/apps");
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {appId && appBase && (
          <>
            <div className="relative w-full border-t border-slate-100 pt-2">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      className={railItem({ isActive: false })}
                      title={collapsed ? currentApp?.name ?? "Switch app" : undefined}
                      aria-label="Switch app"
                    >
                      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-sky-50 text-[10px] font-semibold text-sky-700">
                        {(currentApp?.name ?? "A").slice(0, 1).toUpperCase()}
                      </span>
                      {!collapsed && (
                        <>
                          <span className="hidden min-w-0 flex-1 text-left md:block">
                            <span className="block truncate font-medium text-slate-800">
                              {currentApp?.name ?? "Loading app…"}
                            </span>
                            <span className="block truncate text-xs font-mono text-slate-400">
                              {currentApp?.slug}
                            </span>
                          </span>
                          <ChevronsUpDown className="hidden h-4 w-4 text-slate-400 md:block" aria-hidden="true" />
                        </>
                      )}
                    </button>
                  }
                />
                <DropdownMenuContent side="bottom" align="start" className="w-64">
                  {otherApps.map((app) => (
                    <DropdownMenuItem
                      key={app.id}
                      onClick={() => {
                        const section = location.pathname.split("/")[3] ?? "";
                        navigate(section ? `/apps/${app.id}/${section}` : `/apps/${app.id}`);
                      }}
                    >
                      <span className="truncate">{app.name}</span>
                      <span className="badge-blue ml-auto">{app.platform}</span>
                    </DropdownMenuItem>
                  ))}
                  {otherApps.length === 0 && (
                    <div className="px-3 py-2 text-xs text-slate-400">No other apps</div>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem render={<Link to="/apps?new=1" />}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New app
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link to="/apps?all=1" />}>
                    <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> All apps
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="mt-1 flex-1 overflow-y-auto">
              {APP_NAV_SECTIONS.map((section) => (
                <div key={section.label} className="mb-3">
                  {!collapsed && (
                    <div className="hidden px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 md:block">
                      {section.label}
                    </div>
                  )}
                  <div className="space-y-0.5">
                    {section.items
                      .filter(
                        (item) =>
                          !item.platform || item.platform === currentApp?.platform,
                      )
                      .map((item) => {
                      const Icon = item.icon;
                      const link = (
                        <NavLink
                          key={item.label}
                          to={item.to ? `${appBase}/${item.to}` : appBase}
                          end={item.end ?? false}
                          className={railItem}
                        >
                          <Icon className="h-4 w-4 flex-none" aria-hidden="true" />
                          {!collapsed && <span className="hidden md:inline">{item.label}</span>}
                        </NavLink>
                      );
                      return collapsed ? (
                        <Tooltip key={item.label}>
                          <TooltipTrigger render={link} />
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </nav>
      <div className="relative mt-auto flex w-full flex-col px-2">
        {collapsed && (
          <button
            type="button"
            className="relative z-10 mb-2 hidden h-10 w-full touch-manipulation items-center justify-center rounded-md text-slate-500 outline-hidden hover:bg-slate-100 hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-sky-500 md:flex"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className={`flex w-full items-center rounded-md outline-hidden hover:bg-slate-100 ${
                  collapsed ? "justify-center p-1" : "gap-2 px-2 py-2 text-left"
                }`}
                title={`${account.display_name} · ${account.server_slug || account.server_id}`}
              >
                <Avatar
                  size="sm"
                  type={account.principal_type === "agent" ? "agent" : "human"}
                  className="border border-slate-200"
                >
                  {account.avatar_url ? (
                    <AvatarImage src={account.avatar_url} alt="" />
                  ) : null}
                  <AvatarFallback>
                    {account.display_name.slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <span className="hidden min-w-0 flex-1 md:block">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {account.display_name}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {account.server_slug || account.server_id}
                    </span>
                  </span>
                )}
              </button>
            }
          />
          <DropdownMenuContent side="right" align="end" className="w-64">
            <DropdownMenuLabel>
              <div className="font-medium text-slate-900 flex items-center gap-1">
                {account.display_name}
                {account.principal_type === "agent" && (
                  <span className="badge-purple text-xs" title="Raft agent principal">
                    agent
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500">
                {account.server_slug || account.server_id}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {account.principal_type === "agent" ? "Raft agent" : "Raft user"}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/settings" />}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem className="text-red-600" onClick={onLogout}>
              <span>Logout</span>
              <span aria-hidden="true">↗</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

// Mobile-only top navigation. Below `md` the vertical sidebar (`Header`) is
// hidden, so this horizontal bar provides the same navigation: org/app
// switchers + account menu on one row, and the section links (sourced from the
// SAME `APP_NAV_SECTIONS` const the desktop rail uses) as a horizontally
// scrollable chip row. It is `md:hidden` and sticky at the top on mobile.
function MobileTopNav({ account }: { account: AuthAccount }) {
  const navigate = useNavigate();
  const location = useLocation();
  const appId = location.pathname.startsWith("/apps/")
    ? location.pathname.split("/")[2] ?? null
    : null;
  const orgs = useQuery({
    queryKey: ["orgs"],
    queryFn: () => listOrgs(),
    enabled: !!account.id,
  });
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const switchOrg = useClearOrgCache();
  const currentOrg = orgs.data?.orgs.find((org) => org.id === account.org_id);
  const currentApp = apps.data?.apps.find((app) => app.id === appId);
  const otherApps = (apps.data?.apps ?? []).filter(
    (app) => app.id !== appId && !app.archived,
  );
  const appBase = appId ? `/apps/${appId}` : null;
  const onLogout = async () => {
    await logout();
    clearActiveOrgId();
    window.location.assign("/");
  };

  const chip = ({ isActive }: { isActive: boolean }) =>
    `inline-flex flex-none items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm ${
      isActive
        ? "bg-slate-100 font-medium text-slate-950"
        : "text-slate-500 hover:bg-slate-100 hover:text-slate-950"
    }`;

  return (
    <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-slate-200 bg-white px-3 py-2 md:hidden">
      <div className="flex items-center gap-2">
        <Link to="/" aria-label="Hands" className="flex flex-none items-center">
          <QuiverMark className="h-8 w-8" />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-slate-100"
                aria-label={`Organization ${currentOrg?.name ?? account.server_slug ?? account.server_id}`}
              >
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-600">
                  {(currentOrg?.name ?? account.server_slug ?? "O").slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate text-sm font-medium text-slate-800">
                  {currentOrg?.name ?? account.server_slug ?? "Organization"}
                </span>
                <ChevronDown className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
              </button>
            }
          />
          <DropdownMenuContent side="bottom" align="start" className="w-72">
            <OrgSwitcher
              currentOrgId={account.org_id ?? null}
              buttonLabel="Switch organization"
              onSwitch={(org) => {
                switchOrg(org);
                window.location.assign("/apps");
              }}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        {appId && appBase && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-slate-100"
                  aria-label="Switch app"
                >
                  <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-sky-50 text-[10px] font-semibold text-sky-700">
                    {(currentApp?.name ?? "A").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate text-sm font-medium text-slate-800">
                    {currentApp?.name ?? "Loading app…"}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 flex-none text-slate-400" aria-hidden="true" />
                </button>
              }
            />
            <DropdownMenuContent side="bottom" align="start" className="w-64">
              {otherApps.map((app) => (
                <DropdownMenuItem
                  key={app.id}
                  onClick={() => {
                    const section = location.pathname.split("/")[3] ?? "";
                    navigate(section ? `/apps/${app.id}/${section}` : `/apps/${app.id}`);
                  }}
                >
                  <span className="truncate">{app.name}</span>
                  <span className="badge-blue ml-auto">{app.platform}</span>
                </DropdownMenuItem>
              ))}
              {otherApps.length === 0 && (
                <div className="px-3 py-2 text-xs text-slate-400">No other apps</div>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link to="/apps?new=1" />}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New app
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link to="/apps?all=1" />}>
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" /> All apps
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex-none">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex items-center rounded-md p-1 hover:bg-slate-100"
                  title={`${account.display_name} · ${account.server_slug || account.server_id}`}
                >
                  <Avatar
                    size="sm"
                    type={account.principal_type === "agent" ? "agent" : "human"}
                    className="border border-slate-200"
                  >
                    {account.avatar_url ? (
                      <AvatarImage src={account.avatar_url} alt="" />
                    ) : null}
                    <AvatarFallback>
                      {account.display_name.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
              }
            />
            <DropdownMenuContent side="bottom" align="end" className="w-64">
              <DropdownMenuLabel>
                <div className="font-medium text-slate-900 flex items-center gap-1">
                  {account.display_name}
                  {account.principal_type === "agent" && (
                    <span className="badge-purple text-xs" title="Raft agent principal">
                      agent
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  {account.server_slug || account.server_id}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {account.principal_type === "agent" ? "Raft agent" : "Raft user"}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link to="/settings" />}>
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem className="text-red-600" onClick={onLogout}>
                <span>Logout</span>
                <span aria-hidden="true">↗</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto">
        {appId && appBase ? (
          APP_NAV_SECTIONS.flatMap((section) => section.items)
            .filter(
              (item) => !item.platform || item.platform === currentApp?.platform,
            )
            .map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.label}
                to={item.to ? `${appBase}/${item.to}` : appBase}
                end={item.end ?? false}
                className={chip}
              >
                <Icon className="h-4 w-4 flex-none" aria-hidden="true" />
                <span className="whitespace-nowrap">{item.label}</span>
              </NavLink>
            );
          })
        ) : (
          <NavLink to="/apps" end className={chip}>
            <LayoutGrid className="h-4 w-4 flex-none" aria-hidden="true" />
            <span className="whitespace-nowrap">Apps</span>
          </NavLink>
        )}
      </nav>
    </header>
  );
}

function AppDetailRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppDetail key={appId} appId={appId} />;
}

function AppChannelsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppChannels key={appId} appId={appId} />;
}

function AppSettingsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return (
    <div key={appId} className="space-y-6">
      <AppSettings appId={appId} />
      <AppAccess appId={appId} />
    </div>
  );
}

function AppFeedbackRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppFeedback key={appId} appId={appId} />;
}

function AppCrashesRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppCrashes key={appId} appId={appId} />;
}

function FeedbackTicketRoute() {
  const { appId, ticketId } = useParams();
  if (!appId || !ticketId) return null;
  return (
    <FeedbackTicketPage
      key={`${appId}:${ticketId}`}
      appId={appId}
      ticketId={ticketId}
    />
  );
}

function AppSharesRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppShares key={appId} appId={appId} />;
}

function AuditRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AuditLog key={appId} appId={appId} />;
}

function TestflightRoute() {
  const { appId } = useParams();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((candidate) => candidate.id === appId);
  if (!appId) return null;
  if (app && app.platform !== "ios") {
    return <Navigate to={`/apps/${appId}/builds`} replace />;
  }
  return <Testflight key={appId} appId={appId} />;
}

function AppStoreReviewRoute() {
  const { appId } = useParams();
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });
  const app = apps.data?.apps.find((a) => a.id === appId);
  if (!appId) return null;
  return (
    <div key={appId} className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">App Store review status</h1>
      </div>
      {app && app.platform === "ios" ? (
        <AppStoreReviewPanel appId={appId} app={app} />
      ) : app ? (
        <p className="text-sm text-slate-500">
          This is only available for iOS apps.
        </p>
      ) : null}
    </div>
  );
}

function BuildsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Builds key={appId} appId={appId} />;
}

function ReleasesRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Releases key={appId} appId={appId} />;
}

function LegacyPublishRedirect() {
  return <Navigate to="../releases" replace />;
}

function LegacyAccessRedirect() {
  return <Navigate to="../settings" replace />;
}

function OrgSettingsRoute() {
  const { orgId, tab } = useParams();
  if (!orgId) return null;
  if (!isOrgSettingsTab(tab)) {
    return <Navigate to={`/orgs/${orgId}/general`} replace />;
  }
  return <OrgSettings orgId={orgId} tab={tab} />;
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
    if (pathname.includes("/testflight")) return "TestFlight";
    if (pathname.includes("/builds")) return "Builds";
    if (pathname.includes("/access")) return "Settings";
    if (pathname.includes("/audit")) return "Audit";
    if (pathname.includes("/settings")) return "Settings";
    if (pathname.startsWith("/apps/")) return "Overview";
    return "Not Found";
  })();
  const title = appId && appName ? `${section} - ${appName}` : section;

  useEffect(() => {
    document.title = `${title} - Hands`;
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

  if (location.pathname === "/cli/callback") {
    return <CliCallback token={getAuthToken() ?? ""} />;
  }

  return <AuthenticatedApp account={me.data.account} />;
}

function CliCallback({ token }: { token: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section className="w-full max-w-xl rounded-md border border-slate-200 bg-white p-6 shadow-xs">
        <div className="mb-5 flex items-center gap-3">
          <QuiverMark className="h-9 w-9" />
          <div>
            <h1 className="text-lg font-semibold text-slate-950">Hands CLI login</h1>
            <p className="text-sm text-slate-500">Signed in with Raft</p>
          </div>
        </div>
        <CopyableCode
          className="w-full"
          ariaLabel="Copy JWT"
          copiedAriaLabel="Copied JWT"
          truncate
          codeClassName="font-mono text-xs text-slate-700"
        >
          {token}
        </CopyableCode>
      </section>
    </main>
  );
}

function PublicLanding({ account }: { account?: AuthAccount }) {
  useEffect(() => {
    document.title = "Hands - Agent-native platform for client apps";
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <a href="/" className="inline-flex items-center gap-2 font-medium">
            <QuiverMark className="h-9 w-9 flex-none" />
            <span className="text-xl leading-none">Hands</span>
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
            <Button variant="primary" render={<a href={dashboardHref(account)} />}>
              <RaftIcon className="h-5 w-5" />
              {account ? "Open dashboard" : "Login"}
            </Button>
          </nav>
        </div>
      </header>

      <main>
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-7 pb-14 md:grid-cols-[1.1fr_0.9fr] md:items-center md:pt-10 md:pb-20">
            <div className="max-w-2xl">
              <Badge className="mb-4">
                The agent-native platform for Raft-built client apps.
              </Badge>
              <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
                Ship it, roll it out, hear it break, fix it.
              </h1>
              <p className="mt-5 text-lg leading-8 text-slate-600">
                Hands runs the whole release loop: builds land as drafts,
                humans and agents review and publish with bilingual
                changelogs, staged rollouts meter exposure, and in-app
                feedback and crash reports come back as tickets — grouped,
                deobfuscated, and actionable from the console, CLI, and API.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-500">
                  Client platforms:
                </span>
                {["Android", "iOS", "HarmonyOS", "Electron"].map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-medium text-slate-600"
                  >
                    {p}
                  </span>
                ))}
              </div>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button variant="primary" size="lg" render={<a href={dashboardHref(account)} />}>
                  <RaftIcon className="h-5 w-5" />
                  {account ? "Open dashboard" : "Login with Raft"}
                </Button>
                <Button variant="outline" size="lg" render={<a href="/docs" />}>
                  Read docs
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  render={
                    <a
                      href="https://github.com/oranix-io/hands"
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  GitHub
                </Button>
              </div>
            </div>

            <LandingTerminal />
          </div>
        </section>

        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-8 sm:grid-cols-2 lg:grid-cols-4">
          <LandingFeature
            title="Channels & staged rollouts"
            body="Separate main, preview, and nightly; publish at 5% and raise it as confidence grows — devices keep their cohort."
          />
          <LandingFeature
            title="Share pages & history"
            body="Expiring, password-protectable download pages with QR codes, real app icons, and opt-in public version history."
          />
          <LandingFeature
            title="Feedback tickets"
            body="In-app feedback with attachments and device context lands in a built-in ticket system with assignees and comments."
          />
          <LandingFeature
            title="Crash reporting"
            body="Crash capture across Android, iOS, HarmonyOS, and Electron — grouped by signature and symbolicated server-side (R8 mappings, native symbols, dSYM, minidumps)."
          />
        </section>

        <section className="border-t border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Integrate an SDK, build from CI.</h2>
              <p className="mt-1 text-sm text-slate-600">
                SDKs for Android, iOS, HarmonyOS, and Electron add feedback and
                crash reporting (plus in-app update checks and staged rollouts
                on Android); the public npm CLI publishes releases and share
                links from CI or Raft agents.
              </p>
            </div>
            <div className="flex flex-none flex-col gap-2 sm:flex-row">
              <a
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/android-sdk/"
              >
                Android SDK
              </a>
              <a
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/ios-sdk/"
              >
                iOS SDK
              </a>
              <a
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/ohos-sdk/"
              >
                HarmonyOS SDK
              </a>
              <a
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/electron-sdk/"
              >
                Electron SDK
              </a>
              <a
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/cli-reference/"
              >
                CLI reference
              </a>
              <a
                className="inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-100"
                href="/docs/admin-user-guide/"
              >
                Admin guide
              </a>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-slate-500 sm:flex-row">
          <span>
            Hands — a{" "}
            <a
              href="https://botiverse.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-slate-600 hover:text-slate-900"
            >
              Botiverse
            </a>{" "}
            product
          </span>
          <div className="flex items-center gap-4">
            <a href="/docs" className="hover:text-slate-700">Docs</a>
            <a
              href="https://github.com/oranix-io/hands"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-700"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

type TerminalLine = { text: string; tone?: "muted" | "ok" | "warn" };

const TERMINAL_DEMOS: {
  key: string;
  label: string;
  badge: string;
  lines: TerminalLine[];
}[] = [
  {
    key: "release",
    label: "Release",
    badge: "main",
    lines: [
      { text: "$ hands builds publish-android raft-android --apk app-release.apk --channel main" },
      { text: "uploading APK and metadata...", tone: "muted" },
      { text: "creating release on channel main...", tone: "muted" },
      { text: "release: 14998dba-cfde-4002-8c01-230a2760f662", tone: "ok" },
      { text: `share: ${window.location.origin}/share/...`, tone: "ok" },
    ],
  },
  {
    key: "ios",
    label: "iOS + dSYM",
    badge: "stable",
    lines: [
      { text: "$ hands builds publish-ios raft-ios --ipa Raft.ipa --dsym Raft.dSYM.zip \\" },
      { text: "    --version-name 1.1.0 --version-code 1010000", tone: "muted" },
      { text: "uploading signed .ipa + dSYM for symbolication...", tone: "muted" },
      { text: "release: b0b3aeac-8201-4ab6-a3cc-a0229987953a", tone: "ok" },
      { text: "iOS crashes will now symbolicate against this dSYM", tone: "ok" },
    ],
  },
  {
    key: "feedback",
    label: "Feedback",
    badge: "triage",
    lines: [
      { text: "$ hands feedback list raft-android --status open --kind crash" },
      { text: "crash   1.1.0   NullPointerException in FeedView   37 devices", tone: "warn" },
      { text: "$ hands feedback update raft-android <id> --status in_progress --assignee cc" },
      { text: "ticket -> in_progress, assigned cc", tone: "ok" },
      { text: "$ hands feedback comment raft-android <id> \"repro'd, fixing\"", tone: "muted" },
    ],
  },
  {
    key: "metrics",
    label: "Metrics",
    badge: "30d",
    lines: [
      { text: `$ curl ${window.location.origin}/api/apps/$APP_ID/analytics/versions?window_days=30` },
      { text: "1.1.0   active devices 1,284   update offers 642", tone: "ok" },
      { text: "1.0.4   active devices   319   crash tickets 3", tone: "muted" },
    ],
  },
];

const DEFAULT_TERMINAL_DEMO = TERMINAL_DEMOS[0]!;

function LandingTerminal() {
  const [active, setActive] = useState(DEFAULT_TERMINAL_DEMO.key);
  const demo =
    TERMINAL_DEMOS.find((d) => d.key === active) ?? DEFAULT_TERMINAL_DEMO;
  const toneClass = (tone?: TerminalLine["tone"]) =>
    tone === "ok"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "muted"
          ? "text-slate-500"
          : "text-slate-200";
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-slate-200 bg-slate-950 p-5 text-sm text-slate-100 shadow-xs">
      <div className="mb-4 flex items-center justify-between border-b border-slate-700 pb-3">
        <div className="flex flex-wrap gap-1">
          {TERMINAL_DEMOS.map((d) => (
            <Button
              key={d.key}
              size="sm"
              variant="ghost"
              onClick={() => setActive(d.key)}
              className={
                d.key === active
                  ? "bg-white text-slate-900 hover:bg-white hover:text-slate-900"
                  : "text-slate-400 hover:bg-white/10 hover:text-slate-100"
              }
            >
              {d.label}
            </Button>
          ))}
        </div>
        <span className="rounded-sm bg-sky-400/15 px-2 py-0.5 text-xs text-sky-200">
          {demo.badge}
        </span>
      </div>
      <div className="space-y-3 font-mono text-xs leading-6">
        {demo.lines.map((line, i) => (
          <div key={i} className={`${toneClass(line.tone)} break-words`}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function LandingFeature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
    </div>
  );
}

function AuthenticatedApp({ account }: { account: AuthAccount }) {
  return (
    <div className="min-h-screen flex">
      <Header account={account} />
      <div className="min-w-0 flex-1 flex flex-col">
      <MobileTopNav account={account} />
      <Routes>
        <Route path="/" element={<Navigate to="/apps" replace />} />
        <Route path="/apps" element={<AppsListWithNav />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/orgs/:orgId/:tab?" element={<OrgSettingsPage />} />
        <Route path="/invites/:token" element={<AcceptInviteRoute />} />
        <Route path="/apps/:appId" element={<AppShell />}>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<LegacyPublishRedirect />} />
          <Route path="channels" element={<AppChannelsRoute />} />
          <Route path="builds" element={<BuildsRoute />} />
          <Route path="testflight" element={<TestflightRoute />} />
          <Route path="appstore" element={<AppStoreReviewRoute />} />
          <Route path="releases" element={<ReleasesRoute />} />
          <Route path="shares" element={<AppSharesRoute />} />
          <Route path="feedback" element={<AppFeedbackRoute />} />
          <Route path="crashes" element={<AppCrashesRoute />} />
          <Route path="feedback/:ticketId" element={<FeedbackTicketRoute />} />
          <Route path="access" element={<LegacyAccessRedirect />} />
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
      </div>
    </div>
  );
}

function AppsListWithNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const showAll = params.get("all") === "1";
  const openNew = params.get("new") === "1";
  const apps = useQuery({ queryKey: ["apps"], queryFn: listApps });

  // Default behavior per artin: /apps drops you into the first app; the
  // full list is reachable via ?all=1 (sidebar "All apps"), and with zero
  // apps we go straight to the creation wizard.
  if (!showAll && !openNew && apps.data) {
    const active = apps.data.apps.filter((a) => !a.archived);
    if (active.length > 0) {
      // Remember the last app the operator was in; fall back to the first
      // active app when there's no stored choice or it no longer exists.
      let target = active[0]!.id;
      try {
        const last = window.localStorage.getItem(LAST_APP_KEY);
        if (last && active.some((a) => a.id === last)) target = last;
      } catch {
        // storage disabled — use the default
      }
      return <Navigate to={`/apps/${target}`} replace />;
    }
  }
  const zeroApps = apps.data ? apps.data.apps.filter((a) => !a.archived).length === 0 : false;
  return (
    <StandardPageShell>
      <AppsList
        onSelectApp={(appId) => navigate(`/apps/${appId}`)}
        initialShowCreate={openNew || zeroApps}
      />
    </StandardPageShell>
  );
}

const APP_NAV_SECTIONS: Array<{
  label: string;
  items: Array<{
    to: string;
    label: string;
    icon: LucideIcon;
    end?: boolean;
    platform?: "ios" | "android" | "ohos" | "electron";
  }>;
}> = [
  {
    label: "Distribute",
    items: [
      { to: "", label: "Overview", icon: Gauge, end: true },
      { to: "channels", label: "Channels", icon: Radio },
      { to: "releases", label: "Releases", icon: Rocket },
      { to: "builds", label: "Builds", icon: Package },
      { to: "testflight", label: "TestFlight", icon: Plane, platform: "ios" },
      { to: "appstore", label: "App Store", icon: Store, platform: "ios" },
      { to: "shares", label: "Shares", icon: Share2 },
    ],
  },
  {
    label: "Operate",
    items: [
      { to: "feedback", label: "Feedback", icon: MessageSquare },
      { to: "crashes", label: "Crashes", icon: Bug },
      { to: "audit", label: "Audit", icon: ScrollText },
      { to: "settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

const LAST_APP_KEY = "quiver:last-app-id";

function AppShell() {
  const { appId } = useParams();
  useEffect(() => {
    if (appId) {
      try {
        window.localStorage.setItem(LAST_APP_KEY, appId);
      } catch {
        // private-mode / storage disabled — non-fatal
      }
    }
  }, [appId]);
  return (
    <div className="flex flex-1 min-h-0 items-stretch">
      <div className="min-w-0 flex-1">
        <main className="w-full px-8 py-6">
        <Routes>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<LegacyPublishRedirect />} />
          <Route path="channels" element={<AppChannelsRoute />} />
          <Route path="builds" element={<BuildsRoute />} />
          <Route path="testflight" element={<TestflightRoute />} />
          <Route path="appstore" element={<AppStoreReviewRoute />} />
          <Route path="releases" element={<ReleasesRoute />} />
          <Route path="shares" element={<AppSharesRoute />} />
          <Route path="feedback" element={<AppFeedbackRoute />} />
          <Route path="crashes" element={<AppCrashesRoute />} />
          <Route path="feedback/:ticketId" element={<FeedbackTicketRoute />} />
          <Route path="access" element={<LegacyAccessRedirect />} />
          <Route path="audit" element={<AuditRoute />} />
          <Route path="settings" element={<AppSettingsRoute />} />
        </Routes>
        </main>
      </div>
    </div>
  );
}
