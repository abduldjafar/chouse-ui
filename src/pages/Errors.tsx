import { useEffect, useMemo, useState } from "react";
import { Search, AlertTriangle, CheckCircle2, Bug, Skull, ShieldAlert } from "lucide-react";

import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/common/Skeletons";
import { PaginationBar } from "@/components/monitoring/PaginationBar";
import { AiDiagnoseButton } from "@/components/monitoring/AiDiagnoseButton";
import {
  useServerErrors,
  useCrashLog,
  SERVER_ERRORS_LOOKUP_DAYS,
  type ServerErrorRow,
  type CrashLogRow,
  type ServerErrorsLookupDays,
} from "@/hooks/useMonitoringTimeline";
import { diagnoseServerError } from "@/api/query";
import { cn } from "@/lib/utils";

type ErrorsView = "errors" | "crashes";

interface ErrorsPageProps {
  embedded?: boolean;
  refreshKey?: number;
  autoRefresh?: boolean;
  onRefreshChange?: (isRefreshing: boolean) => void;
}

const COPY: Record<ErrorsView, { title: string; hint: string; rationale: string }> = {
  errors: {
    title: "Errors",
    hint: "system.errors",
    rationale:
      "system.errors counts every error code the server has hit since start, with the last occurrence and message. A fast-climbing count — especially MEMORY_LIMIT_EXCEEDED, TIMEOUT_EXCEEDED, or TOO_MANY_PARTS — is the earliest signal something is wrong before it shows up as failed queries.",
  },
  crashes: {
    title: "Crashes",
    hint: "system.crash_log",
    rationale:
      "system.crash_log records server crashes (signal, thread, query, stack). This table is normally empty — any row here is serious and worth correlating with the query_id and version. Absent on builds without crash logging.",
  },
};

// Common POSIX signals seen in crash_log.
const SIGNALS: Record<number, string> = {
  4: "SIGILL",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  11: "SIGSEGV",
  15: "SIGTERM",
};

export default function ErrorsPage({
  embedded = false,
  refreshKey = 0,
  autoRefresh = false,
  onRefreshChange,
}: ErrorsPageProps) {
  const [view, setView] = useState<ErrorsView>("errors");
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  // User-attribution lookup window. 1d is fast and matches "right now"; 7d
  // catches errors that fired earlier in the week so they're not all "—".
  const [lookupDays, setLookupDays] = useState<ServerErrorsLookupDays>(1);
  const pageSize = 50;

  const errors = useServerErrors(lookupDays, { enabled: view === "errors" });
  const crashes = useCrashLog({ enabled: view === "crashes" });
  const active = view === "errors" ? errors : crashes;
  const { isLoading, isFetching, error, refetch } = active;

  useEffect(() => {
    onRefreshChange?.(isFetching);
  }, [isFetching, onRefreshChange]);

  useEffect(() => {
    if (refreshKey > 0) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => refetch(), 15_000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  useEffect(() => {
    setCurrentPage(0);
  }, [view, searchTerm]);

  const rows = useMemo(() => {
    const data = (active.data ?? []) as Array<ServerErrorRow | CrashLogRow>;
    const term = searchTerm.trim().toLowerCase();
    if (!term) return data;
    return data.filter((r) => JSON.stringify(r).toLowerCase().includes(term));
  }, [active.data, searchTerm]);

  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(currentPage, totalPages - 1);
  const startIndex = safePage * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRows);
  const paginatedRows = useMemo(
    () => rows.slice(startIndex, endIndex),
    [rows, startIndex, endIndex]
  );

  // Header counters
  const distinctErrors = (errors.data ?? []).length;
  const totalErrorHits = (errors.data ?? []).reduce((acc, e) => acc + e.count, 0);
  const crashCount = (crashes.data ?? []).length;

  return (
    <div className="h-full overflow-hidden">
      <div className={cn("flex h-full flex-col gap-4", embedded ? "p-4" : "p-6")}>
        {/* Sub-tabs */}
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-500">
          {(Object.keys(COPY) as ErrorsView[]).map((id) => {
            const tab = COPY[id];
            const activeTab = view === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                className={cn(
                  "group relative flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
                  activeTab ? "text-paper" : "text-paper-muted hover:text-paper"
                )}
              >
                <span>{tab.title}</span>
                <span className="font-mono text-[9px] tracking-[0.14em] text-paper-faint">
                  · {tab.hint}
                </span>
                {activeTab && (
                  <span className="absolute -bottom-px left-0 right-0 h-px bg-brand" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        {/* Rationale strip */}
        <div className="flex items-start gap-3 rounded-xs border border-ink-500 bg-ink-100 px-4 py-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper-muted">
            {view === "errors" ? (
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Skull className="h-3.5 w-3.5" aria-hidden />
            )}
          </span>
          <p className="text-[12px] leading-[1.6] text-paper-muted">{COPY[view].rationale}</p>
        </div>

        {/* Filter + summary strip */}
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-ink-500 bg-ink-100 p-3">
          <div className="flex w-full items-center gap-2 md:w-[320px]">
            <Search className="h-4 w-4 text-paper-dim" />
            <Input
              placeholder={
                view === "errors"
                  ? "Search error name, code, message…"
                  : "Search signal, query id, version…"
              }
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-9 rounded-xs border-ink-500 bg-ink-200 font-mono text-[12px] text-paper placeholder:text-paper-faint focus-visible:border-brand focus-visible:ring-0"
            />
          </div>

          <div className="ml-auto flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
            {view === "errors" ? (
              <>
                {/* Lookup window picker — controls how far back the user
                    attribution CTE scans system.query_log. Wider window =
                    more codes get a user, but the scan costs more. */}
                <div className="flex items-center gap-1.5">
                  <span className="text-paper-dim">User lookup</span>
                  <div
                    role="radiogroup"
                    aria-label="User-attribution lookup window"
                    className="inline-flex overflow-hidden rounded-xs border border-ink-500"
                  >
                    {SERVER_ERRORS_LOOKUP_DAYS.map((d, idx) => {
                      const active = lookupDays === d;
                      return (
                        <button
                          key={d}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setLookupDays(d)}
                          className={cn(
                            "h-6 px-2 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
                            idx > 0 && "border-l border-ink-500",
                            active
                              ? "bg-brand text-ink-50"
                              : "bg-ink-100 text-paper-muted hover:bg-ink-200 hover:text-paper",
                          )}
                          title={`Look up users from the last ${d} ${d === 1 ? "day" : "days"}`}
                        >
                          {d}d
                        </button>
                      );
                    })}
                  </div>
                </div>
                <span>
                  Codes · <span className="text-paper">{distinctErrors.toLocaleString()}</span>
                </span>
                <span>
                  Total hits · <span className="text-paper">{totalErrorHits.toLocaleString()}</span>
                </span>
              </>
            ) : crashCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-red-300">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {crashCount.toLocaleString()} crashes
              </span>
            ) : (
              <span>No crashes</span>
            )}
          </div>
        </div>

        {/* Table card */}
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border border-ink-500 bg-ink-100">
          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <table className="w-full">
                <tbody>
                  <SkeletonRows count={8} cols={view === "errors" ? 5 : 5} />
                </tbody>
              </table>
            ) : error ? (
              <ErrorState message={error.message} />
            ) : totalRows === 0 ? (
              <EmptyState view={view} hasSearch={!!searchTerm} />
            ) : view === "errors" ? (
              <ErrorsTable rows={paginatedRows as ServerErrorRow[]} lookupDays={lookupDays} />
            ) : (
              <CrashesTable rows={paginatedRows as CrashLogRow[]} />
            )}
          </div>

          {totalRows > 0 && (
            <PaginationBar
              page={safePage}
              totalPages={totalPages}
              startIndex={startIndex}
              endIndex={endIndex}
              totalRows={totalRows}
              rowLabel={view === "errors" ? "codes" : "crashes"}
              onPrev={() => setCurrentPage((p) => Math.max(0, p - 1))}
              onNext={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              onFirst={() => setCurrentPage(0)}
              onLast={() => setCurrentPage(totalPages - 1)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-xs border border-red-900/60 bg-red-950/30 text-red-300">
        <AlertTriangle className="h-5 w-5" aria-hidden />
      </span>
      <span className="text-[13px] text-paper">Couldn't load errors</span>
      <span className="text-[12px] text-paper-muted">{message}</span>
    </div>
  );
}

function EmptyState({ view, hasSearch }: { view: ErrorsView; hasSearch: boolean }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-xs border border-emerald-500/30 bg-emerald-950/20 text-emerald-300">
        <CheckCircle2 className="h-5 w-5" aria-hidden />
      </span>
      <span className="text-[13px] text-paper">
        {view === "errors" ? "No errors recorded" : "No crashes — server stable"}
      </span>
      <span className="text-[12px] text-paper-muted">
        {hasSearch
          ? "Adjust the search filter."
          : view === "errors"
            ? "system.errors is empty since the last server start."
            : "system.crash_log has no entries (or isn't enabled on this build)."}
      </span>
    </div>
  );
}

function ErrorsTable({ rows, lookupDays }: { rows: ServerErrorRow[]; lookupDays: number }) {
  // Column index 2 ("Count") is right-aligned; everything else is left.
  const COLS: { label: string; align: "left" | "right" }[] = [
    { label: "Code", align: "left" },
    { label: "Error", align: "left" },
    { label: "Count", align: "right" },
    { label: "Last seen", align: "left" },
    { label: "User", align: "left" },
    { label: "Last message", align: "left" },
    { label: "", align: "left" },
  ];
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 z-10 bg-ink-200/90 backdrop-blur">
        <tr className="border-b border-ink-500">
          {COLS.map((c, i) => (
            <th
              key={c.label || `col-${i}`}
              className={cn(
                "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint",
                c.align === "right" ? "text-right" : "text-left",
              )}
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((e, i) => (
          <tr
            key={`${e.code}-${i}`}
            className="border-b border-ink-500/60 transition-colors hover:bg-ink-200/60"
          >
            <td className="px-3 py-1.5 font-mono text-paper-muted tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <Bug className="h-3 w-3 text-paper-dim" aria-hidden />
                {e.code}
              </span>
            </td>
            <td className="px-3 py-1.5 font-mono text-paper">
              {e.name}
              {e.remote === 1 && (
                <span className="ml-2 rounded-xs border border-ink-500 bg-ink-200 px-1 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-paper-faint">
                  remote
                </span>
              )}
              {e.source === "query_log" && (
                <span
                  className="ml-2 rounded-xs border border-brand/50 bg-brand/10 px-1 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-brand"
                  title={
                    `system.errors doesn't track this code on this CH build (often the case for NETWORK_ERROR / soft errors). ` +
                    `Count below is hits in the last ${lookupDays}d from system.query_log.`
                  }
                >
                  from query_log
                </span>
              )}
            </td>
            <td
              className="px-3 py-1.5 text-right font-mono tabular-nums text-paper"
              title={
                e.source === "query_log"
                  ? `Hits in the last ${lookupDays} day${lookupDays === 1 ? "" : "s"}`
                  : "Cumulative hits since server restart"
              }
            >
              {e.count.toLocaleString()}
            </td>
            <td className="px-3 py-1.5 font-mono text-paper-muted whitespace-nowrap">
              {e.last_error_time || "—"}
            </td>
            <td
              className="px-3 py-1.5 font-mono text-paper-muted whitespace-nowrap"
              title={
                e.last_user
                  ? `Most recent in the last 24h${e.affected_users > 1 ? ` · ${e.affected_users} distinct users hit this code` : ""}`
                  : "No matching query_log row in the last 24h"
              }
            >
              {e.last_user ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-paper">{e.last_user}</span>
                  {e.affected_users > 1 && (
                    <span className="rounded-xs border border-ink-500 bg-ink-200 px-1 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-paper-faint">
                      +{e.affected_users - 1}
                    </span>
                  )}
                </span>
              ) : (
                "—"
              )}
            </td>
            <td
              className="max-w-[460px] truncate px-3 py-1.5 font-mono text-paper-muted"
              title={e.last_error_message}
            >
              {e.last_error_message || "—"}
            </td>
            <td className="px-3 py-1.5 text-right">
              <AiDiagnoseButton
                label="Fix"
                title="Diagnose with Chouse AI"
                badge={`${e.code} · ${e.name}`}
                runLabel="Diagnose & fix"
                runDiagnosis={(modelId) =>
                  diagnoseServerError(e.name, e.code, e.last_error_message, modelId)
                }
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CrashesTable({ rows }: { rows: CrashLogRow[] }) {
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 z-10 bg-ink-200/90 backdrop-blur">
        <tr className="border-b border-ink-500">
          {["Time", "Signal", "Thread", "Query ID", "Version", "Trace"].map((h) => (
            <th
              key={h}
              className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((c, i) => (
          <tr
            key={`${c.query_id}-${i}`}
            className="border-b border-ink-500/60 transition-colors hover:bg-ink-200/60"
          >
            <td className="px-3 py-1.5 font-mono text-paper-muted whitespace-nowrap">
              {c.event_time}
            </td>
            <td className="px-3 py-1.5">
              <span className="rounded-xs border border-red-500/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-300">
                {SIGNALS[c.signal] ?? `sig ${c.signal}`}
              </span>
            </td>
            <td className="px-3 py-1.5 font-mono text-paper-muted tabular-nums">{c.thread_id}</td>
            <td className="px-3 py-1.5 font-mono text-paper-faint" title={c.query_id}>
              {c.query_id ? `${c.query_id.substring(0, 8)}…` : "—"}
            </td>
            <td className="px-3 py-1.5 font-mono text-paper-muted whitespace-nowrap">{c.version}</td>
            <td
              className="max-w-[360px] truncate px-3 py-1.5 font-mono text-red-300"
              title={c.trace}
            >
              {c.trace ? c.trace.split("\n")[0] : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
