import { useQuery } from "@tanstack/react-query";
import { ApiError, getHandsAdminOverview } from "../lib/api";

const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

function Table({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 divide-y divide-slate-100 text-sm">
        {rows.map(([label, count]) => (
          <div className="flex justify-between py-2" key={label}><span>{label}</span><strong>{count}</strong></div>
        ))}
      </div>
    </section>
  );
}

export function HandsAdmin() {
  const overview = useQuery({ queryKey: ["hands-admin", "overview"], queryFn: getHandsAdminOverview, retry: false });
  if (overview.isPending) return <main className="p-8 text-sm text-slate-500">Loading observability…</main>;
  if (overview.error instanceof ApiError && overview.error.status === 401) {
    return <main className="p-8"><h1 className="text-xl font-semibold">Sign in again</h1><p className="mt-2 text-sm text-slate-600">Your session has expired or you're signed out. Sign in to continue.</p><a className="mt-4 inline-block text-sky-700" href="/api/auth/login?return=%2Fadmin">Continue with Raft</a></main>;
  }
  if (overview.error instanceof ApiError && overview.error.status === 403) {
    return <main className="p-8"><h1 className="text-xl font-semibold">Administrator access required</h1><p className="mt-2 text-sm text-slate-600">This page is limited to administrators of an approved Raft server.</p></main>;
  }
  if (!overview.data) return <main className="p-8 text-sm text-red-700">Could not load observability.</main>;
  const data = overview.data;
  const cards: Array<[string, string | number]> = [
    ["Users", data.summary.users], ["Organizations", data.summary.organizations], ["Projects", data.summary.apps],
    ["Active projects", data.summary.active_apps], ["Builds", data.summary.builds], ["Releases", data.summary.releases],
    ["R2 storage", formatBytes(data.storage.r2.size_bytes)], ["R2 objects", data.storage.r2.object_count],
  ];
  return (
    <main className="mx-auto w-full max-w-7xl p-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Hands admin</p>
      <h1 className="mt-1 text-3xl font-semibold">Observability</h1>
      <p className="mt-2 text-sm text-slate-500">Global, read-only product and storage inventory.</p>
      <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label, value]) => <div className="rounded-xl border border-slate-200 bg-white p-5" key={label}><div className="text-sm text-slate-500">{label}</div><div className="mt-2 text-3xl font-semibold">{value}</div></div>)}</div>
      <p className="mt-5 text-xs text-slate-500">{data.storage.note} Measured {new Date(data.measured_at).toISOString()}.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Table title="Users by type" rows={data.users_by_type.map((row) => [row.type, row.count])} />
        <Table title="Projects by platform" rows={data.apps_by_platform.map((row) => [row.type, row.count])} />
        <Table title="Builds by product type" rows={data.builds_by_product_type.map((row) => [row.type, row.count])} />
        <Table title="Releases by status" rows={data.releases_by_status.map((row) => [row.status, row.count])} />
      </div>
    </main>
  );
}
