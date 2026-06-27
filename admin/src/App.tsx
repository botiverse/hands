import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useParams,
  useNavigate,
  Link,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AppsList } from "./pages/AppsList";
import { AppDetail } from "./pages/AppDetail";
import { AuditLog } from "./pages/AuditLog";
import { Settings } from "./pages/Settings";
import { Publishing } from "./pages/Publishing";
import { getAuthMe, loginUrl, logout, type AuthAccount } from "./lib/api";

function Header({ account }: { account: AuthAccount }) {
  const onLogout = async () => {
    await logout();
    window.location.assign(loginUrl("/"));
  };
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
            <div className="font-medium">{account.display_name}</div>
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
          to={base}
          end
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Versions
        </NavLink>
        <NavLink
          to={`${base}/publish`}
          className={({ isActive }) =>
            `px-3 py-1 rounded-md text-sm ${
              isActive ? "bg-slate-100 font-medium" : "hover:bg-slate-100"
            }`
          }
        >
          Publish
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
      onShowPublish={() => navigate(`/apps/${appId}/publish`)}
    />
  );
}

function AuditRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <AuditLog appId={appId} />;
}

function PublishingRoute() {
  const { appId } = useParams();
  if (!appId) return null;
  return <Publishing appId={appId} />;
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
          <button
            className="w-full rounded-md bg-slate-900 text-white px-4 py-2 font-medium hover:bg-slate-700"
            onClick={() => window.location.assign(loginUrl(window.location.pathname))}
          >
            Login with Raft
          </button>
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
        <Route path="/apps/:appId" element={<AppShell />}>
          <Route index element={<AppDetailRoute />} />
          <Route path="publish" element={<PublishingRoute />} />
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
        <div className="max-w-5xl mx-auto px-4 text-xs text-slate-500">
          quiver admin - Login with Raft
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
          <Route path="publish" element={<PublishingRoute />} />
          <Route path="audit" element={<AuditRoute />} />
        </Routes>
      </main>
    </>
  );
}
