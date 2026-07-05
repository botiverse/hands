/**
 * Trend charts for the Feedback page: tickets/day stacked by kind (30 days)
 * and crash counts by version. Inline SVG, no chart library.
 *
 * Colors are the validated categorical slots (blue/aqua/yellow, adjacent CVD
 * ΔE 47); aqua and yellow sit under 3:1 on the surface, so the relief rule
 * applies — a table view toggle carries every value, and tooltips + the
 * legend cover identity. Marks: ≤24px bars, 2px surface gaps between stacked
 * segments and bars, 4px rounded data-end on the top segment only.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getFeedbackStats } from "../lib/api";

const KINDS = ["feedback", "bug", "crash"] as const;
const KIND_COLOR: Record<(typeof KINDS)[number], string> = {
  feedback: "#2a78d6",
  bug: "#1baf7a",
  crash: "#eda100",
};
const SURFACE = "#ffffff"; // card surface — used for the 2px spacers

export function FeedbackTrends({ appId }: { appId: string }) {
  const stats = useQuery({
    queryKey: ["feedback-stats", appId],
    queryFn: () => getFeedbackStats(appId),
  });
  const [showTable, setShowTable] = useState(false);

  const days = useMemo(() => {
    const byDay = new Map<string, Record<string, number>>();
    for (const row of stats.data?.daily ?? []) {
      const entry = byDay.get(row.day) ?? {};
      entry[row.kind] = row.n;
      byDay.set(row.day, entry);
    }
    // Dense 30-day window so quiet days render as gaps in the story, not
    // missing columns.
    const out: Array<{ day: string; label: string } & Record<string, number | string>> = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      const counts = byDay.get(key) ?? {};
      out.push({
        day: key,
        label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
        feedback: counts["feedback"] ?? 0,
        bug: counts["bug"] ?? 0,
        crash: counts["crash"] ?? 0,
      });
    }
    return out;
  }, [stats.data]);

  const total = days.reduce(
    (sum, d) => sum + (d.feedback as number) + (d.bug as number) + (d.crash as number),
    0,
  );

  if (stats.isLoading) return null;
  if (!stats.data) return null;
  if (total === 0) return null;

  return (
    <div className="card !p-4 mb-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h3 className="text-sm font-semibold">Last 30 days</h3>
          <p className="text-xs text-slate-500">
            {total} ticket{total === 1 ? "" : "s"} · hover for daily detail
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Legend — identity channel for the three kinds */}
          <div className="hidden sm:flex items-center gap-3 text-xs text-slate-600">
            {KINDS.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: KIND_COLOR[k] }}
                />
                {k}
              </span>
            ))}
          </div>
          <button
            className="btn-secondary !py-0.5 !px-2 !text-xs"
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Chart" : "Table"}
          </button>
        </div>
      </div>

      {showTable ? (
        <TrendTable days={days} />
      ) : (
        <StackedDaily days={days} />
      )}
    </div>
  );
}

function StackedDaily({
  days,
}: {
  days: Array<{ day: string; label: string } & Record<string, number | string>>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 120;
  const PAD_BOTTOM = 16;
  const plotH = H - PAD_BOTTOM;
  const band = W / days.length;
  const barW = Math.min(24, Math.max(6, band - 6));
  const max = Math.max(1, ...days.map((d) => (d.feedback as number) + (d.bug as number) + (d.crash as number)));
  const yTop = Math.ceil(max / 5) * 5 || 5;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tickets per day, stacked by kind">
        {/* recessive hairline gridlines at 0 and the top tick */}
        <line x1={0} y1={plotH} x2={W} y2={plotH} stroke="#e2e8f0" strokeWidth={1} />
        <line x1={0} y1={plotH - (plotH - 8)} x2={W} y2={plotH - (plotH - 8)} stroke="#f1f5f9" strokeWidth={1} />
        <text x={0} y={10} className="fill-slate-400" fontSize={9}>
          {yTop}
        </text>
        {days.map((d, i) => {
          const x = i * band + (band - barW) / 2;
          const segs = KINDS.map((k) => ({ kind: k, n: d[k] as number })).filter((s) => s.n > 0);
          let y = plotH;
          const rects = segs.map((seg, si) => {
            const h = ((plotH - 8) * seg.n) / yTop;
            y -= h;
            const isTop = si === segs.length - 1;
            return (
              <rect
                key={seg.kind}
                x={x}
                y={y + (si > 0 ? 1 : 0)}
                width={barW}
                height={Math.max(0, h - (si > 0 ? 1 : 0))}
                rx={isTop ? 2 : 0}
                fill={KIND_COLOR[seg.kind]}
                // 2px surface gap between stacked segments
                stroke={SURFACE}
                strokeWidth={si > 0 ? 1 : 0}
              />
            );
          });
          return (
            <g
              key={d.day}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {/* full-band hit target, larger than the mark */}
              <rect x={i * band} y={0} width={band} height={plotH} fill="transparent" />
              {rects}
              {hover === i && (
                <rect x={x - 1} y={0} width={barW + 2} height={plotH} fill="#0f172a" opacity={0.04} />
              )}
              {(i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) && (
                <text x={i * band + band / 2} y={H - 4} textAnchor="middle" className="fill-slate-400" fontSize={9}>
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -top-2 z-10 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm"
          style={{ left: `${Math.min(85, (hover / days.length) * 100)}%` }}
        >
          <div className="font-medium text-slate-800">{days[hover]!.day}</div>
          {KINDS.map((k) => (
            <div key={k} className="flex items-center gap-1.5 text-slate-600">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: KIND_COLOR[k] }} />
              {k}: {days[hover]![k] as number}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CrashByVersion({
  rows,
}: {
  rows: Array<{ version_name: string; version_code: number | null; n: number }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-slate-400">
        No crashes recorded
      </div>
    );
  }
  const max = Math.max(...rows.map((r) => r.n));
  return (
    <div>
      <h4 className="text-xs font-medium text-slate-600 mb-2">Crashes by version</h4>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={`${r.version_name}-${r.version_code}`} className="flex items-center gap-2 text-xs">
            <span className="w-20 truncate text-slate-600" title={`${r.version_name} (${r.version_code ?? "?"})`}>
              {r.version_name}
            </span>
            <div className="flex-1 h-3.5">
              <div
                className="h-full rounded-r-[4px]"
                style={{ width: `${(r.n / max) * 100}%`, background: "#2a78d6", minWidth: 2 }}
              />
            </div>
            {/* value at the bar tip, in text ink */}
            <span className="w-8 text-right tabular-nums text-slate-700">{r.n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendTable({
  days,
}: {
  days: Array<{ day: string; label: string } & Record<string, number | string>>;
}) {
  const nonEmpty = days.filter(
    (d) => (d.feedback as number) + (d.bug as number) + (d.crash as number) > 0,
  );
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1 font-medium">Day</th>
          {KINDS.map((k) => (
            <th key={k} className="py-1 font-medium capitalize">{k}</th>
          ))}
          <th className="py-1 font-medium">Total</th>
        </tr>
      </thead>
      <tbody>
        {nonEmpty.map((d) => (
          <tr key={d.day} className="border-t border-slate-100">
            <td className="py-1 text-slate-700">{d.day}</td>
            {KINDS.map((k) => (
              <td key={k} className="py-1 tabular-nums text-slate-600">{d[k] as number}</td>
            ))}
            <td className="py-1 tabular-nums font-medium text-slate-800">
              {(d.feedback as number) + (d.bug as number) + (d.crash as number)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
