import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Navigate,
  useMatch,
  useParams,
  useNavigate,
  useLocation,
  Link,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bug,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Gauge,
  LayoutGrid,
  MessageSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plane,
  Plug,
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
  CopyableCodeAction,
  CopyableCodeRoot,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuTrigger,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  SidebarGroupLabel,
  SidebarItem,
  SidebarRoot,
  useTheme,
} from "raft-ui";
import { appRouteMessage } from "./lib/appRouteMessages";
import { legalMessage } from "./lib/legalMessages";
import { AppRouteBoundary } from "./components/AppRouteBoundary";
import { AppsList } from "./pages/AppsList";
import { AppChannels, AppDetail, AppSettings, AppStoreReviewPanel } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Integrations } from "./pages/Integrations";
import { Settings } from "./pages/Settings";
import { Builds } from "./pages/Builds";
import { Testflight } from "./pages/Testflight";
import { Releases } from "./pages/Releases";
import { AppShares } from "./pages/Shares";
import { AppFeedback, FeedbackTicketPage } from "./pages/Feedback";
import { AppCrashes } from "./pages/Crashes";
import { AppErrors } from "./pages/Errors";
import { isOrgSettingsTab, OrgSettings } from "./pages/OrgSettings";
import { AcceptInvite } from "./pages/AcceptInvite";
import { AppAccess } from "./pages/AppAccess";
import { HandsAdmin } from "./pages/HandsAdmin";
import { OrgSwitcher, useClearOrgCache } from "./components/OrgSwitcher";
import { consoleRootAuthState, dashboardHref, defaultAppResolverState } from "./lib/authNavigation";
import {
  ApiError,
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

/** One sidebar navigation row. RUI `SidebarItem` owns the per-theme geometry
 *  (brutal: hard 2px black borders + offset shadow on hover/active; elegant:
 *  soft rounded rows), so the row only supplies structure and content. */
function SidebarNavItem({
  to,
  end,
  collapsed,
  label,
  icon: Icon,
  ...rest
}: {
  to: string;
  end: boolean;
  collapsed: boolean;
  label: string;
  icon: LucideIcon;
} & React.HTMLAttributes<HTMLElement>) {
  const match = useMatch({ path: to, end });
  return (
    <SidebarItem
      active={match !== null}
      render={<NavLink to={to} end={end} aria-label={label} />}
      className={
        collapsed
          ? "flex-col gap-0.5 px-1 py-1 text-[11px] leading-none"
          : undefined
      }
      {...rest}
    >
      <Icon className="h-4 w-4 flex-none" aria-hidden="true" />
      {!collapsed && <span className="hidden md:inline">{label}</span>}
    </SidebarItem>
  );
}

/** Appearance presets offered from the account menu (same vocabulary as the
 *  Settings page picker). */
const APPEARANCE_OPTIONS: Array<{
  id: string;
  label: string;
  isActive: (theme: string, mode: string) => boolean;
  apply: (setTheme: ReturnType<typeof useTheme>["setTheme"]) => void;
}> = [
  {
    id: "brutal",
    label: "Brutal",
    isActive: (theme) => theme === "brutal",
    apply: (setTheme) => setTheme("brutal"),
  },
  {
    id: "elegant-light",
    label: "Elegant Light",
    isActive: (theme, mode) => theme === "elegant" && mode === "light",
    apply: (setTheme) => setTheme("elegant", { mode: "light" }),
  },
  {
    id: "elegant-dark",
    label: "Elegant Dark",
    isActive: (theme, mode) => theme === "elegant" && mode === "dark",
    apply: (setTheme) => setTheme("elegant", { mode: "dark" }),
  },
  {
    id: "elegant-system",
    label: "System",
    isActive: (theme, mode) => theme === "elegant" && mode === "system",
    apply: (setTheme) => setTheme("elegant", { mode: "system" }),
  },
];

function Header({ account }: { account: AuthAccount }) {
  const { theme, mode, setTheme } = useTheme();
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

  return (
    <SidebarRoot
      className={`sticky top-0 z-30 hidden h-screen flex-none flex-col border-r border-line-muted pt-2 pb-1.5 transition-[width] duration-150 theme-brutal:border-r-2 theme-brutal:border-black md:flex ${
        collapsed ? "w-16 items-center" : "w-16 items-stretch md:w-60"
      }`}
    >
      <div className={`mb-2 flex h-9 items-center theme-brutal:mb-2 theme-brutal:h-10 theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:pb-2 ${collapsed ? "justify-center" : "justify-between px-3"}`}>
        <Link to="/" aria-label="Hands" className="flex min-w-0 items-center gap-2">
          <QuiverMark className="h-9 w-9 flex-none" />
          {!collapsed && <span className="hidden truncate text-sm font-semibold text-foreground-strong md:inline">Hands</span>}
        </Link>
        {!collapsed && (
          <button
            type="button"
            className="relative z-10 hidden h-10 w-10 flex-none touch-manipulation items-center justify-center rounded-md text-foreground-muted outline-hidden hover:bg-fill-muted hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-primary-400 md:flex"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="flex min-h-0 w-full flex-1 flex-col items-stretch gap-1 px-3">
        {appId && appBase && (
          <>
            <div className="relative w-full border-t border-line-hairline pt-2 theme-brutal:border-t-2 theme-brutal:border-black">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarItem
                      active={false}
                      title={collapsed ? currentApp?.name ?? "Switch app" : undefined}
                      aria-label="Switch app"
                      render={<button type="button" />}
                      className={
                        collapsed
                          ? "flex-col gap-0.5 px-1 py-1 text-[11px] leading-none"
                          : undefined
                      }
                    >
                      <Avatar size="sm" type="human" className="border border-line-muted">
                        <AvatarFallback>
                          {(currentApp?.name ?? "A").slice(0, 1).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {!collapsed && (
                        <>
                          <span className="hidden min-w-0 flex-1 text-left md:block">
                            <span className="block truncate font-medium text-foreground-strong">
                              {currentApp?.name ?? appRouteMessage(apps.isPending ? "loading" : "unavailable")}
                            </span>
                            <span className="block truncate text-xs font-mono text-foreground-hint">
                              {currentApp?.slug}
                            </span>
                          </span>
                          <ChevronsUpDown className="hidden h-4 w-4 text-foreground-hint md:block" aria-hidden="true" />
                        </>
                      )}
                    </SidebarItem>
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
                      <Badge variant="information" className="ml-auto">{app.platform}</Badge>
                    </DropdownMenuItem>
                  ))}
                  {otherApps.length === 0 && (
                    <div className="px-3 py-2 text-xs text-foreground-hint">No other apps</div>
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
            <div className="mt-1 flex-1 overflow-y-auto overflow-x-hidden sidebar-scroll">
              {APP_NAV_SECTIONS.map((section) => (
                <div key={section.label} className="mb-1">
                  {!collapsed && (
                    <SidebarGroupLabel className="hidden md:block">
                      {section.label}
                    </SidebarGroupLabel>
                  )}
                  <div>
                    {section.items
                      .filter(
                        (item) =>
                          !item.platform || item.platform === currentApp?.platform,
                      )
                      .map((item) => {
                      const link = (
                        <SidebarNavItem
                          key={item.label}
                          to={item.to ? `${appBase}/${item.to}` : (appBase ?? "/apps")}
                          end={item.end ?? false}
                          collapsed={collapsed}
                          label={item.label}
                          icon={item.icon}
                        />
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
      <div className="relative mt-auto flex w-full flex-col px-3">
        {collapsed && (
          <button
            type="button"
            className="relative z-10 mb-2 hidden h-10 w-full touch-manipulation items-center justify-center rounded-md text-foreground-muted outline-hidden hover:bg-fill-muted hover:text-foreground-strong focus-visible:ring-2 focus-visible:ring-primary-400 md:flex"
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
              <SidebarItem
                title={`${account.display_name} · ${account.server_slug || account.server_id}`}
                aria-label={account.display_name}
                render={<button type="button" />}
                className={
                  collapsed ? "justify-center px-1 py-1" : undefined
                }
              >
                <Avatar
                  size="sm"
                  type={account.principal_type === "agent" ? "agent" : "human"}
                  className="border border-line-muted"
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
                    <span className="block truncate text-sm font-medium text-foreground-strong">
                      {account.display_name}
                    </span>
                    <span className="block truncate text-xs text-foreground-hint">
                      {account.server_slug || account.server_id}
                    </span>
                  </span>
                )}
                {!collapsed && (
                  <ChevronsUpDown
                    className="hidden h-4 w-4 text-foreground-hint md:block"
                    aria-hidden="true"
                  />
                )}
              </SidebarItem>
            }
          />
          <DropdownMenuContent side="right" align="end" className="w-64">
            <DropdownMenuLabel>
              <div className="font-medium text-foreground-strong flex items-center gap-1">
                {account.display_name}
                {account.principal_type === "agent" && (
                  <Badge variant="accent" title="Raft agent principal">agent</Badge>
                )}
              </div>
              <div className="text-xs text-foreground-muted">
                {account.server_slug || account.server_id}
              </div>
              <div className="mt-1 text-xs text-foreground-muted">
                {account.principal_type === "agent" ? "Raft agent" : "Raft user"}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuSubmenu>
              <DropdownMenuSubmenuTrigger>Switch organization</DropdownMenuSubmenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-72">
                <OrgSwitcher
                  currentOrgId={account.org_id ?? null}
                  buttonLabel="Switch organization"
                  onSwitch={(org) => {
                    switchOrg(org);
                    window.location.assign("/apps");
                  }}
                />
              </DropdownMenuContent>
            </DropdownMenuSubmenu>
            <DropdownMenuSeparator />
            <DropdownMenuSubmenu>
              <DropdownMenuSubmenuTrigger>Appearance</DropdownMenuSubmenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-44">
                {APPEARANCE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.id}
                    closeOnClick={false}
                    onClick={() => option.apply(setTheme)}
                  >
                    <Check
                      className={`size-3.5 ${option.isActive(theme, mode) ? "opacity-100" : "opacity-0"}`}
                      aria-hidden="true"
                    />
                    <span>{option.label}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenuSubmenu>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/settings" />}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem className="text-danger" onClick={onLogout}>
              <span>Logout</span>
              <span aria-hidden="true">↗</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SidebarRoot>
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
        ? "bg-fill-muted font-medium text-foreground-strong"
        : "text-foreground-muted hover:bg-fill-muted hover:text-foreground-strong"
    }`;

  return (
    <header className="sticky top-0 z-20 flex flex-col gap-2 border-b border-line-muted bg-layer-canvas-muted px-3 py-2 md:hidden">
      <div className="flex items-center gap-2">
        <Link to="/" aria-label="Hands" className="flex flex-none items-center">
          <QuiverMark className="h-8 w-8" />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-fill-muted"
                aria-label={`Organization ${currentOrg?.name ?? account.server_slug ?? account.server_id}`}
              >
                <Avatar size="xs" type="human" className="border border-line-muted">
                  <AvatarFallback>
                    {(currentOrg?.name ?? account.server_slug ?? "O").slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-sm font-medium text-foreground-strong">
                  {currentOrg?.name ?? account.server_slug ?? "Organization"}
                </span>
                <ChevronDown className="h-4 w-4 flex-none text-foreground-hint" aria-hidden="true" />
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
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-fill-muted"
                  aria-label="Switch app"
                >
                  <Avatar size="xs" type="human" className="border border-line-muted">
                    <AvatarFallback>
                      {(currentApp?.name ?? "A").slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-sm font-medium text-foreground-strong">
                    {currentApp?.name ?? appRouteMessage(apps.isPending ? "loading" : "unavailable")}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 flex-none text-foreground-hint" aria-hidden="true" />
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
                  <Badge variant="information" className="ml-auto">{app.platform}</Badge>
                </DropdownMenuItem>
              ))}
              {otherApps.length === 0 && (
                <div className="px-3 py-2 text-xs text-foreground-hint">No other apps</div>
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
                  className="flex items-center rounded-md p-1 hover:bg-fill-muted"
                  title={`${account.display_name} · ${account.server_slug || account.server_id}`}
                >
                  <Avatar
                    size="sm"
                    type={account.principal_type === "agent" ? "agent" : "human"}
                    className="border border-line-muted"
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
                <div className="font-medium text-foreground-strong flex items-center gap-1">
                  {account.display_name}
                  {account.principal_type === "agent" && (
                    <Badge variant="accent" title="Raft agent principal">agent</Badge>
                  )}
                </div>
                <div className="text-xs text-foreground-muted">
                  {account.server_slug || account.server_id}
                </div>
                <div className="mt-1 text-xs text-foreground-muted">
                  {account.principal_type === "agent" ? "Raft agent" : "Raft user"}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem render={<Link to="/settings" />}>
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger" onClick={onLogout}>
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
        ) : null}
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
function AppErrorsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AppErrors key={appId} appId={appId} />;
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
        <p className="text-sm text-foreground-muted">
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

function IntegrationsRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Integrations key={appId} appId={appId} />;
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
      <div className="min-h-screen flex items-center justify-center bg-layer-canvas">
        <div className="text-sm text-foreground-muted">Checking Raft session...</div>
      </div>
    );
  }

  const consoleState = consoleRootAuthState({
    location: window.location,
    account: me.data?.account,
    isPending: me.isLoading,
    errorStatus: me.error instanceof ApiError ? me.error.status : undefined,
  });
  if (consoleState.kind === "redirect") {
    if (consoleState.href.startsWith("/api/")) return <BrowserReplace to={consoleState.href} />;
    return <Navigate to={consoleState.href} replace />;
  }
  if (consoleState.kind === "error") {
    return <AuthError onRetry={() => void me.refetch()} />;
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

function AuthError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-layer-canvas-muted px-4">
      <section role="alert" className="w-full max-w-md rounded-md border border-danger/30 bg-layer-panel p-6 shadow-xs">
        <h1 className="text-lg font-semibold text-foreground-strong">Unable to check your Raft session</h1>
        <p className="mt-2 text-sm text-foreground-muted">
          Hands could not reach the authentication service. Check your connection and try again.
        </p>
        <Button className="mt-4" onClick={onRetry}>Retry</Button>
      </section>
    </main>
  );
}

function BrowserReplace({ to }: { to: string }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);
  return (
    <div className="min-h-screen flex items-center justify-center bg-layer-canvas-muted">
      <div className="text-sm text-foreground-muted">Opening Hands console...</div>
    </div>
  );
}

function CliCallback({ token }: { token: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-layer-canvas-muted px-4">
      <section className="w-full max-w-xl rounded-md border border-line-muted bg-layer-panel p-6 shadow-xs">
        <div className="mb-5 flex items-center gap-3">
          <QuiverMark className="h-9 w-9" />
          <div>
            <h1 className="text-lg font-semibold text-foreground-strong">Hands CLI login</h1>
            <p className="text-sm text-foreground-muted">Signed in with Raft</p>
          </div>
        </div>
        <CopyableCodeRoot className="w-full">
          <CopyableCode truncate className="font-mono text-xs text-foreground-strong">
            {token}
          </CopyableCode>
          <CopyableCodeAction aria-label="Copy JWT" />
        </CopyableCodeRoot>
      </section>
    </main>
  );
}

function PublicLanding({ account }: { account?: AuthAccount }) {
  useEffect(() => {
    document.title = "Hands - Agent-native platform for client apps";
  }, []);

  return (
    <div className="min-h-screen bg-layer-canvas-muted text-foreground-strong">
      <header className="border-b border-line-muted bg-layer-panel">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <a href="/" className="inline-flex items-center gap-2 font-medium">
            <QuiverMark className="h-9 w-9 flex-none" />
            <span className="text-xl leading-none">Hands</span>
          </a>
          <nav className="flex items-center gap-2 text-sm">
            <a
              href="/docs"
              className="hidden h-10 items-center rounded-md px-3 text-foreground-muted hover:bg-fill-muted hover:text-foreground-strong sm:inline-flex"
            >
              Docs
            </a>
            <a
              href="/api-docs"
              className="hidden h-10 items-center rounded-md px-3 text-foreground-muted hover:bg-fill-muted hover:text-foreground-strong sm:inline-flex"
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
        <section className="border-b border-line-muted bg-layer-panel">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-7 pb-14 md:grid-cols-[1.1fr_0.9fr] md:items-center md:pt-10 md:pb-20">
            <div className="max-w-2xl">
              <Badge className="mb-4">
                The agent-native platform for Raft-built client apps.
              </Badge>
              <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
                Ship it, roll it out, hear it break, fix it.
              </h1>
              <p className="mt-5 text-lg leading-8 text-foreground-muted">
                Hands runs the whole release loop: builds land as drafts,
                humans and agents review and publish with bilingual
                changelogs, staged rollouts meter exposure, and in-app
                feedback and crash reports come back as tickets — grouped,
                deobfuscated, and actionable from the console, CLI, and API.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-foreground-muted">
                  Client stacks:
                </span>
                {["Android", "iOS", "HarmonyOS", "Electron", "Tauri"].map((p) => (
                  <span
                    key={p}
                    className="inline-flex items-center rounded-full border border-line-muted bg-layer-panel px-3 py-1 text-sm font-medium text-foreground-muted"
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

        <section id="features" className="mx-auto grid max-w-6xl gap-4 px-4 py-8 sm:grid-cols-2 lg:grid-cols-4">
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

        <section id="integrations" className="border-t border-line-muted bg-layer-panel">
          <div className="mx-auto max-w-6xl px-4 py-10">
            <div className="max-w-2xl">
              <h2 className="text-xl font-semibold">Choose an integration path.</h2>
              <p className="mt-2 text-sm leading-6 text-foreground-muted">
                Start with the stack you ship, then use the CLI and Console
                guides to automate draft-first delivery and operate releases.
              </p>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <LandingIntegrationCard
                title="Native mobile SDKs"
                body="Updates, feedback, crash capture, and device context inside mobile apps."
                links={[
                  { label: "Android", detail: "Updates, rollout, feedback, crashes", href: "/docs/android-sdk/" },
                  { label: "iOS", detail: "Feedback and crash reporting", href: "/docs/ios-sdk/" },
                  { label: "HarmonyOS", detail: "Feedback and crash reporting", href: "/docs/ohos-sdk/" },
                ]}
              />
              <LandingIntegrationCard
                title="Web & desktop integrations"
                body="Embed feedback conversations, host updater artifacts, and add native desktop crash capture."
                links={[
                  { label: "React Feedback", detail: "Inbox, conversations, replies", href: "/docs/feedback-react/" },
                  { label: "Electron SDK", detail: "Crashpad crash reporting", href: "/docs/electron-sdk/" },
                  { label: "Electron Updater", detail: "Generic-provider release files", href: "/docs/cli-reference/#publish-electron-generic-provider" },
                  { label: "Tauri Updater", detail: "Signed Tauri v2 updater bundles", href: "/docs/tauri-updater/" },
                ]}
              />
              <LandingIntegrationCard
                title="Publishing & operations"
                body="Build release automation and inspect every public contract."
                links={[
                  { label: "CLI Reference", detail: "Publish from CI or Raft agents", href: "/docs/cli-reference/" },
                  { label: "Admin Guide", detail: "Operate apps and releases", href: "/docs/admin-user-guide/" },
                  { label: "API Explorer", detail: "Try the HTTP API", href: "/api-docs" },
                ]}
              />
            </div>
          </div>
        </section>
      </main>
      <footer className="bg-layer-hud text-layer-hud-foreground">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="grid grid-cols-2 gap-8 lg:grid-cols-[2fr_repeat(4,1fr)]">
            <div className="col-span-2 lg:col-span-1">
              <a href="/" className="inline-flex items-center gap-2 text-xl font-medium">
                <QuiverMark className="h-9 w-9 flex-none" />Hands
              </a>
              <p className="mt-4 max-w-xs text-sm leading-6 text-layer-hud-foreground/70">{legalMessage("tagline")}</p>
            </div>
            {[
              { title: legalMessage("product"), links: [
                { label: legalMessage("features"), href: "/#features" },
                { label: legalMessage("integrations"), href: "/#integrations" },
              ] },
              { title: legalMessage("resources"), links: [
                { label: legalMessage("docs"), href: "/docs/" },
                { label: legalMessage("cli"), href: "/docs/cli-reference/" },
                { label: legalMessage("api"), href: "/api-docs" },
              ] },
              { title: legalMessage("sdks"), links: [
                { label: "Android", href: "/docs/android-sdk/" },
                { label: "iOS", href: "/docs/ios-sdk/" },
                { label: "HarmonyOS", href: "/docs/ohos-sdk/" },
                { label: "Electron", href: "/docs/electron-sdk/" },
              ] },
              { title: legalMessage("company"), links: [
                { label: "Botiverse", href: "https://botiverse.dev/" },
                { label: legalMessage("contact"), href: "mailto:contact@raft.build" },
                { label: legalMessage("privacy"), href: "/privacy/" },
                { label: legalMessage("terms"), href: "/terms/" },
              ] },
            ].map((group) => (
              <nav key={group.title} aria-label={group.title}>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-layer-hud-foreground/70">{group.title}</h2>
                <ul className="mt-4 space-y-3 text-sm">
                  {group.links.map((link) => (
                    <li key={link.href}><a href={link.href} className="hover:text-sky-300">{link.label}</a></li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
          <div className="mt-8 border-t border-layer-hud-foreground/15 pt-6 text-xs text-layer-hud-foreground/70">
            © {new Date().getFullYear()} Botiverse, Inc. {legalMessage("copyright")}
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
  // Status accents on the fixed dark pane keep literal hues (theme-independent
  // decoration, same policy as chart categorical colors — gzj, b529da37).
  const toneClass = (tone?: TerminalLine["tone"]) =>
    tone === "ok"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "muted"
          ? "text-layer-hud-foreground/50"
          : "text-layer-hud-foreground";
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-line-muted bg-layer-hud p-5 text-sm text-layer-hud-foreground shadow-xs">
      <div className="mb-4 flex items-center justify-between border-b border-layer-hud-foreground/20 pb-3">
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
                  : "text-layer-hud-foreground/70 hover:bg-layer-hud-foreground/10 hover:text-layer-hud-foreground"
              }
            >
              {d.label}
            </Button>
          ))}
        </div>
        {/* Accent chip on the dark pane: hue stays literal by the same policy. */}
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
    <div className="rounded-lg border border-line-muted bg-layer-panel p-4 shadow-xs">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-foreground-muted">{body}</p>
    </div>
  );
}

function LandingIntegrationCard({
  title,
  body,
  links,
}: {
  title: string;
  body: string;
  links: Array<{ label: string; detail: string; href: string }>;
}) {
  return (
    <div className="rounded-xl border border-line-muted bg-layer-canvas-muted p-5">
      <h3 className="text-sm font-semibold text-foreground-strong">{title}</h3>
      <p className="mt-2 min-h-12 text-sm leading-6 text-foreground-muted">{body}</p>
      <div className="mt-4 divide-y divide-line-muted border-y border-line-muted">
        {links.map((link) => (
          <a
            key={link.href}
            className="group flex items-center justify-between gap-3 py-3 text-sm hover:text-info-strong"
            href={link.href}
          >
            <span className="min-w-0">
              <span className="block font-medium text-foreground-strong group-hover:text-info-strong">
                {link.label}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-foreground-muted">
                {link.detail}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="flex-none text-base text-foreground-hint transition-transform group-hover:translate-x-0.5 group-hover:text-info-strong"
            >
              →
            </span>
          </a>
        ))}
      </div>
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
        <Route path="/admin" element={<HandsAdmin />} />
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
          <Route path="errors" element={<AppErrorsRoute />} />
          <Route path="feedback/:ticketId" element={<FeedbackTicketRoute />} />
          <Route path="access" element={<LegacyAccessRedirect />} />
          <Route path="audit" element={<AuditRoute />} />
          <Route path="integrations" element={<IntegrationsRoute />} />
          <Route path="settings" element={<AppSettingsRoute />} />
        </Route>
        <Route
          path="*"
          element={
            <div className="max-w-5xl mx-auto px-4 py-8">
              <p className="text-foreground-muted">404 - not found</p>
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

  // The default route is a resolver, not an Apps landing page. Keep the
  // shell empty while the app list loads so the removed nav/page does not
  // flash before the last (or first) active app is known.
  if (!showAll && !openNew) {
    let last: string | null = null;
    try {
      last = window.localStorage.getItem(LAST_APP_KEY);
    } catch {
      // storage disabled — use the first active app
    }
    const resolver = defaultAppResolverState({
      apps: apps.data?.apps,
      lastAppId: last,
      isPending: apps.isPending,
      isError: apps.isError,
    });
    if (resolver.kind === "loading") return null;
    if (resolver.kind === "redirect") return <Navigate to={resolver.href} replace />;
    if (resolver.kind === "error") {
      return (
        <StandardPageShell>
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-4 text-sm text-danger-strong">
            <p className="font-medium">Could not load apps</p>
            <p className="mt-1 text-danger-strong">Check your connection and try again.</p>
            <Button className="mt-3" variant="outline" onClick={() => void apps.refetch()}>
              Retry
            </Button>
          </div>
        </StandardPageShell>
      );
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
      { to: "errors", label: "Errors", icon: AlertTriangle },
      { to: "integrations", label: "Integrations", icon: Plug },
      { to: "audit", label: "Audit", icon: ScrollText },
      { to: "settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

const LAST_APP_KEY = "quiver:last-app-id";

function AppShell() {
  const { appId } = useParams();
  if (!appId) return null;
  return (
    <AppRouteBoundary appId={appId}>
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
          <Route path="errors" element={<AppErrorsRoute />} />
          <Route path="feedback/:ticketId" element={<FeedbackTicketRoute />} />
          <Route path="access" element={<LegacyAccessRedirect />} />
          <Route path="audit" element={<AuditRoute />} />
          <Route path="integrations" element={<IntegrationsRoute />} />
          <Route path="settings" element={<AppSettingsRoute />} />
        </Routes>
        </main>
      </div>
    </div>
    </AppRouteBoundary>
  );
}
