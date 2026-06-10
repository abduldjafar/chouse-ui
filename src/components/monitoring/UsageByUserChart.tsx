/**
 * UsageByUserChart — stacked-bar distribution of CPU / memory / queries per
 * user over time (day / month / year buckets).
 *
 * Lives in the Logs page's "By user" sub-tab. Pivots the long-format hook
 * payload (one row per (bucket, user)) into a wide row per bucket so recharts
 * can stack it. Buckets with too many users blow up the chart (and become
 * unreadable past ~10 series), so we collapse everything below the top-N to a
 * single "Others" bar — the value is preserved, just attributed to a calmer
 * bucket.
 */
import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Users, RefreshCw } from "lucide-react";

import {
  useQueryByUser,
  type ByUserGranularity,
  type ByUserRow,
} from "@/hooks/useMonitoringTimeline";
import { SkeletonChart } from "@/components/common/Skeletons";
import { useChartColors } from "@/hooks/useChartColors";
import { cn, formatBytes, formatCompactNumber } from "@/lib/utils";

export type UsageMetric =
  | "total_cpu_seconds"
  | "peak_memory_bytes"
  | "total_memory_bytes"
  | "queries";

interface MetricSpec {
  key: UsageMetric;
  label: string;
  unit: "seconds" | "bytes" | "count";
}

const METRICS: MetricSpec[] = [
  { key: "total_cpu_seconds", label: "CPU time", unit: "seconds" },
  { key: "peak_memory_bytes", label: "Peak memory", unit: "bytes" },
  { key: "total_memory_bytes", label: "Σ memory", unit: "bytes" },
  { key: "queries", label: "Queries", unit: "count" },
];

const GRANULARITIES: { key: ByUserGranularity; label: string; days: number }[] = [
  { key: "day", label: "Daily · 30d", days: 30 },
  { key: "month", label: "Monthly · 12m", days: 365 },
  { key: "year", label: "Yearly · 5y", days: 365 * 5 },
];

const TOP_N = 8;

// Editorial palette — 8 distinct hues for top users, gray for "Others". Order
// picks brand-first then warm/cool alternation so the stack reads from bottom
// (most CPU) up without a single block dominating the eye.
const USER_PALETTE = [
  "#ffcc01", // brand amber
  "#34d399", // emerald
  "#60a5fa", // sky
  "#fb923c", // orange
  "#a855f7", // violet
  "#22d3ee", // cyan
  "#f87171", // red
  "#84cc16", // lime
];
const OTHERS_COLOR = "#94a3b8"; // slate-400

function fmtCpu(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0";
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function fmtMetric(unit: "seconds" | "bytes" | "count", v: number): string {
  if (unit === "seconds") return fmtCpu(v);
  if (unit === "bytes") return formatBytes(v) || "0";
  return formatCompactNumber(v);
}

interface UsageByUserChartProps {
  granularity: ByUserGranularity;
  onGranularityChange: (g: ByUserGranularity) => void;
  metric: UsageMetric;
  onMetricChange: (m: UsageMetric) => void;
}

interface PivotedRow {
  bucket: string;
  [user: string]: string | number; // user → value, plus the bucket label
}

/**
 * Reshape rows from long format (one per (bucket, user)) into a wide row per
 * bucket. Picks the top-N users by total of the active metric across the whole
 * window, lumps everyone else into "Others". Returns the ordered series list
 * so the chart legend / stack order matches what's rendered.
 */
function pivot(
  rows: ByUserRow[],
  metric: UsageMetric,
): { data: PivotedRow[]; series: string[] } {
  if (rows.length === 0) return { data: [], series: [] };

  // 1. Per-user totals (drives top-N selection)
  const userTotals = new Map<string, number>();
  for (const r of rows) {
    userTotals.set(r.user, (userTotals.get(r.user) ?? 0) + (r[metric] as number));
  }
  const topUsers = Array.from(userTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([u]) => u);
  const topSet = new Set(topUsers);
  const hasOthers = userTotals.size > topUsers.length;

  // 2. Pivot — one row per bucket
  const bucketMap = new Map<string, PivotedRow>();
  for (const r of rows) {
    let row = bucketMap.get(r.bucket);
    if (!row) {
      row = { bucket: r.bucket };
      for (const u of topUsers) row[u] = 0;
      if (hasOthers) row.Others = 0;
      bucketMap.set(r.bucket, row);
    }
    const v = r[metric] as number;
    if (topSet.has(r.user)) {
      row[r.user] = (row[r.user] as number) + v;
    } else {
      row.Others = (row.Others as number) + v;
    }
  }

  // 3. Sort buckets ASCENDING by date — chart reads left-to-right past→present
  const data = Array.from(bucketMap.values()).sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );

  return {
    data,
    series: hasOthers ? [...topUsers, "Others"] : topUsers,
  };
}

export function UsageByUserChart({
  granularity,
  onGranularityChange,
  metric,
  onMetricChange,
}: UsageByUserChartProps) {
  const c = useChartColors();
  const scope = GRANULARITIES.find((g) => g.key === granularity) ?? GRANULARITIES[0];
  const {
    data: rows = [],
    isLoading,
    isFetching,
    error,
  } = useQueryByUser(granularity, scope.days);

  const metricSpec = METRICS.find((m) => m.key === metric) ?? METRICS[0];

  const { data: pivoted, series } = useMemo(() => pivot(rows, metric), [rows, metric]);

  const colorFor = (user: string, idx: number) =>
    user === "Others" ? OTHERS_COLOR : USER_PALETTE[idx % USER_PALETTE.length];

  const totalForMetric = useMemo(() => {
    return rows.reduce((acc, r) => acc + ((r[metric] as number) ?? 0), 0);
  }, [rows, metric]);

  const isEmpty = !isLoading && rows.length === 0;

  return (
    <section
      aria-label="Usage by user"
      className="flex flex-col overflow-hidden rounded-md border border-ink-500 bg-ink-100"
    >
      {/* Header strip — granularity + metric selectors, total in the corner */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-500 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper-muted">
            <Users className="h-3.5 w-3.5" aria-hidden />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-faint">
              Top {TOP_N} users · {scope.label.toLowerCase()}
            </span>
            <span className="text-[13px] font-medium text-paper">
              Usage distribution
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          {/* Granularity */}
          <div
            role="radiogroup"
            aria-label="Bucket granularity"
            className="inline-flex overflow-hidden rounded-xs border border-ink-500"
          >
            {GRANULARITIES.map((g, idx) => {
              const active = granularity === g.key;
              return (
                <button
                  key={g.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onGranularityChange(g.key)}
                  className={cn(
                    "h-7 px-2.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
                    idx > 0 && "border-l border-ink-500",
                    active
                      ? "bg-brand text-ink-50"
                      : "bg-ink-100 text-paper-muted hover:bg-ink-200 hover:text-paper",
                  )}
                >
                  {g.label}
                </button>
              );
            })}
          </div>

          {/* Metric */}
          <div
            role="radiogroup"
            aria-label="Metric"
            className="inline-flex overflow-hidden rounded-xs border border-ink-500"
          >
            {METRICS.map((m, idx) => {
              const active = metric === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onMetricChange(m.key)}
                  className={cn(
                    "h-7 px-2.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
                    idx > 0 && "border-l border-ink-500",
                    active
                      ? "bg-brand text-ink-50"
                      : "bg-ink-100 text-paper-muted hover:bg-ink-200 hover:text-paper",
                  )}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <span className="font-mono uppercase tracking-[0.14em] text-paper-faint">
            Σ <span className="text-paper">{fmtMetric(metricSpec.unit, totalForMetric)}</span>
          </span>
          {isFetching && (
            <RefreshCw className="h-3.5 w-3.5 text-paper-dim motion-safe:animate-spin" aria-hidden />
          )}
        </div>
      </div>

      {/* Chart */}
      <div className="p-4">
        {isLoading ? (
          <SkeletonChart height={224} />
        ) : error ? (
          <div className="flex h-56 items-center justify-center text-[13px] text-paper-muted">
            Couldn't load usage by user — {error.message}
          </div>
        ) : isEmpty ? (
          <div className="flex h-56 flex-col items-center justify-center gap-1">
            <span className="text-[13px] text-paper">Nothing to chart</span>
            <span className="text-[12px] text-paper-muted">
              No queries logged in this window.
            </span>
          </div>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={pivoted}
                margin={{ top: 4, right: 12, left: 0, bottom: 4 }}
              >
                <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tick={{ fontSize: 10, fill: c.tick }}
                  tickLine={{ stroke: c.grid }}
                  axisLine={{ stroke: c.grid }}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: c.tick }}
                  tickLine={{ stroke: c.grid }}
                  axisLine={{ stroke: c.grid }}
                  tickFormatter={(v) => fmtMetric(metricSpec.unit, Number(v))}
                  width={64}
                />
                <Tooltip
                  cursor={{ fill: c.cursor }}
                  contentStyle={{
                    background: c.tooltipBg,
                    border: `1px solid ${c.tooltipBorder}`,
                    borderRadius: 2,
                    fontSize: 11,
                    fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  }}
                  itemStyle={{ color: c.tooltipText }}
                  labelStyle={{ color: c.tooltipLabel, fontWeight: 500 }}
                  formatter={(value: unknown, name: unknown) => [
                    fmtMetric(metricSpec.unit, Number(value)),
                    String(name),
                  ]}
                />
                {series.map((s, idx) => (
                  <Bar
                    key={s}
                    dataKey={s}
                    stackId="usage"
                    fill={colorFor(s, idx)}
                    radius={idx === series.length - 1 ? [2, 2, 0, 0] : 0}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Legend */}
        {!isLoading && !isEmpty && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-500 pt-3">
            {series.map((s, idx) => (
              <div key={s} className="flex items-center gap-2">
                <span
                  className="h-2 w-3 rounded-xs"
                  style={{ backgroundColor: colorFor(s, idx) }}
                  aria-hidden
                />
                <span
                  className={cn(
                    "font-mono text-[10px] uppercase tracking-[0.14em]",
                    s === "Others" ? "text-paper-faint" : "text-paper-muted",
                  )}
                >
                  {s}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
