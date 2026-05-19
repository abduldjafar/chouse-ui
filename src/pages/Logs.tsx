import React, { useState, useMemo, useEffect, useCallback } from "react";
import {
  FileText,
  Search,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  User,
  Shield,
  X,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryLogs, usePaginationPreference, useLogsPreferences } from "@/hooks";
import { useRbacStore, RBAC_PERMISSIONS } from "@/stores";
import { cn } from "@/lib/utils";
import { DataControls } from "@/components/common/DataControls";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useQuery } from "@tanstack/react-query";
import { rbacUsersApi, rbacRolesApi } from "@/api/rbac";
import { SkeletonRows } from "@/components/common/Skeletons";
import { QueryTimelineChart } from "@/components/monitoring/QueryTimelineChart";
import type { TimelineBucket } from "@/hooks/useMonitoringTimeline";

interface LogEntry {
  type: string;
  event_date: string;
  event_time: string;
  query_id: string;
  query: string;
  query_duration_ms: number;
  read_rows: number;
  read_bytes: number;
  memory_usage: number;
  user: string;
  rbacUser?: string | null;
  rbacUserId?: string | null;
  connectionId?: string | null;
  connectionName?: string;
  exception?: string;
}

interface LogFilterParams {
  searchTerm: string;
  logType: string;
  selectedRoleId: string;
  usersByRoleData?: { users: Array<{ id: string }> } | null;
}

interface ProcessedLogsResult {
  logs: LogEntry[];
  exceptionQueryIds: Set<string>;
}

/**
 * Filter + dedup logs by query_id. ExceptionWhileProcessing > QueryStart-with-exception
 * > QueryFinish > QueryStart. Returns the full sorted list (paging happens in
 * the render layer) plus the set of query_ids that ever carried an exception.
 */
function processLogs(
  logs: LogEntry[],
  filters: LogFilterParams
): ProcessedLogsResult {
  const { searchTerm, logType, selectedRoleId, usersByRoleData } = filters;

  const hasRoleFilter = selectedRoleId !== "all";
  const roleUserIds =
    hasRoleFilter && usersByRoleData?.users && usersByRoleData.users.length > 0
      ? new Set(usersByRoleData.users.map((u) => u.id))
      : null;

  const finalStateQueryIds = new Set<string>();
  const exceptionQueryIds = new Set<string>();
  logs.forEach((log) => {
    const hasException = log.exception && log.exception.trim().length > 0;
    if (
      log.type === "QueryFinish" ||
      log.type === "ExceptionWhileProcessing" ||
      log.type === "ExceptionBeforeStart" ||
      (log.type === "QueryStart" && hasException)
    ) {
      finalStateQueryIds.add(log.query_id);
    }
    if (log.type === "ExceptionWhileProcessing" || log.type === "ExceptionBeforeStart") {
      exceptionQueryIds.add(log.query_id);
    }
  });

  const searchByQueryId = searchTerm && searchTerm.trim().length > 0;
  const matchingQueryIds = new Set<string>();
  if (searchByQueryId) {
    const searchLower = searchTerm.toLowerCase().trim();
    logs.forEach((log) => {
      if (log.query_id) {
        const idLower = log.query_id.toLowerCase();
        if (idLower === searchLower || idLower.includes(searchLower)) {
          matchingQueryIds.add(log.query_id);
        }
      }
    });
  }

  const filtered = logs.filter((log) => {
    const matchesIdSearch = searchByQueryId && matchingQueryIds.has(log.query_id);
    const matchesSearch =
      matchesIdSearch ||
      !searchTerm ||
      log.query?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.query_id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.user?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.rbacUser?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = logType === "all" || log.type === logType;

    let matchesRole = true;
    if (hasRoleFilter) {
      if (roleUserIds && roleUserIds.size > 0) {
        matchesRole = log.rbacUserId ? roleUserIds.has(log.rbacUserId) : false;
      } else {
        matchesRole = false;
      }
    }

    return matchesSearch && matchesType && matchesRole;
  });

  const queryMap = new Map<string, LogEntry>();
  for (const log of filtered) {
    if (logType === "QueryStart" && finalStateQueryIds.has(log.query_id)) continue;

    const existing = queryMap.get(log.query_id);
    if (!existing) {
      queryMap.set(log.query_id, log);
      continue;
    }

    const priority = (e: LogEntry): number => {
      if (e.type === "ExceptionWhileProcessing" || e.type === "ExceptionBeforeStart") return 4;
      const hasEx = e.exception && e.exception.trim().length > 0;
      const hasExEntry = exceptionQueryIds.has(e.query_id);
      if (e.type === "QueryStart" && (hasEx || hasExEntry)) return 3;
      if (e.type === "QueryFinish") return 2;
      if (e.type === "QueryStart") return 1;
      return 0;
    };

    const ep = priority(existing);
    const cp = priority(log);
    if (cp > ep) {
      queryMap.set(log.query_id, log);
    } else if (cp === ep && cp > 0) {
      if (log.event_date > existing.event_date) {
        queryMap.set(log.query_id, log);
      } else if (log.event_date === existing.event_date && log.event_time > existing.event_time) {
        queryMap.set(log.query_id, log);
      }
    }
  }

  const deduplicated = Array.from(queryMap.values()).sort((a, b) => {
    if (b.event_date !== a.event_date) return b.event_date.localeCompare(a.event_date);
    return b.event_time.localeCompare(a.event_time);
  });

  return { logs: deduplicated, exceptionQueryIds };
}

const RANGE_OPTIONS: Array<{ label: string; hours: number }> = [
  { label: "15m", hours: 0.25 },
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
];

function bucketFor(hours: number): TimelineBucket {
  return hours > 12 ? "hour" : "minute";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

interface LogsPageProps {
  embedded?: boolean;
  refreshKey?: number;
  autoRefresh?: boolean;
  onRefreshChange?: (isRefreshing: boolean) => void;
}

export default function LogsPage({
  embedded = false,
  refreshKey = 0,
  autoRefresh: externalAutoRefresh = false,
  onRefreshChange,
}: LogsPageProps) {
  const { isSuperAdmin, user, hasPermission } = useRbacStore();
  const canViewAllLogs = isSuperAdmin() || hasPermission(RBAC_PERMISSIONS.QUERY_HISTORY_VIEW_ALL);
  const { pageSize: defaultLimit, setPageSize: setLimitPreference } =
    usePaginationPreference("logs");
  const { preferences: logsPrefs, updatePreferences: updateLogsPrefs } = useLogsPreferences();

  const [pageSize, setPageSize] = useState(defaultLimit);
  useEffect(() => setPageSize(defaultLimit), [defaultLimit]);

  const [searchTerm, setSearchTerm] = useState(logsPrefs.defaultSearchQuery || "");
  const [logType, setLogType] = useState<string>(logsPrefs.defaultLogType || "all");
  const [internalAutoRefresh, setInternalAutoRefresh] = useState(logsPrefs.autoRefresh || false);

  const autoRefresh = embedded ? externalAutoRefresh : internalAutoRefresh;
  const setAutoRefresh = embedded ? () => {} : setInternalAutoRefresh;
  const [selectedUserId, setSelectedUserId] = useState<string>(
    logsPrefs.defaultSelectedUserId || "all"
  );
  const [selectedRoleId, setSelectedRoleId] = useState<string>(
    logsPrefs.defaultSelectedRoleId || "all"
  );
  const [timeRangeHours, setTimeRangeHours] = useState<number>(6);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);

  const bucket = bucketFor(timeRangeHours);

  useEffect(() => {
    const id = setTimeout(() => {
      updateLogsPrefs({
        defaultLogType: logType,
        autoRefresh,
        defaultSelectedUserId: selectedUserId,
        defaultSelectedRoleId: selectedRoleId,
      });
    }, 500);
    return () => clearTimeout(id);
  }, [logType, autoRefresh, selectedUserId, selectedRoleId, updateLogsPrefs]);

  useEffect(() => {
    const id = setTimeout(() => setLimitPreference(pageSize), 500);
    return () => clearTimeout(id);
  }, [pageSize, setLimitPreference]);

  const clearFilters = () => {
    setSearchTerm("");
    setLogType("all");
    setSelectedUserId("all");
    setSelectedRoleId("all");
  };

  const hasActiveFilters =
    searchTerm.trim().length > 0 ||
    logType !== "all" ||
    selectedUserId !== "all" ||
    selectedRoleId !== "all";

  const { data: usersData } = useQuery({
    queryKey: ["rbac-users-list"],
    queryFn: () => rbacUsersApi.list({ limit: 1000, isActive: true }),
    enabled: canViewAllLogs,
    staleTime: 5 * 60 * 1000,
  });

  const { data: rolesData } = useQuery({
    queryKey: ["rbac-roles-list"],
    queryFn: () => rbacRolesApi.list(),
    enabled: canViewAllLogs,
    staleTime: 5 * 60 * 1000,
  });

  const { data: usersByRoleData } = useQuery({
    queryKey: ["rbac-users-by-role", selectedRoleId],
    queryFn: () =>
      rbacUsersApi.list({ limit: 1000, isActive: true, roleId: selectedRoleId }),
    enabled: canViewAllLogs && selectedRoleId !== "all",
    staleTime: 5 * 60 * 1000,
  });

  const rbacUserIdFilter = canViewAllLogs
    ? selectedUserId !== "all"
      ? selectedUserId
      : undefined
    : user?.id;

  // Over-fetch so that client-side dedup + pagination has enough material per page.
  // The cap (5k unfiltered / 20k filtered) is the upper bound a single fetch will
  // pull; beyond that the user needs to narrow the time range or filters.
  const fetchLimit = hasActiveFilters ? Math.max(pageSize * 20, 5000) : Math.max(pageSize * 5, 1000);
  const {
    data: logs = [],
    isLoading,
    isFetching,
    refetch,
    error,
    dataUpdatedAt,
  } = useQueryLogs(fetchLimit, undefined, rbacUserIdFilter, timeRangeHours);

  const isAnyLoading = isLoading || isFetching;

  useEffect(() => {
    onRefreshChange?.(isAnyLoading);
  }, [isAnyLoading, onRefreshChange]);

  useEffect(() => {
    if (refreshKey) refetch();
  }, [refreshKey, refetch]);

  React.useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => refetch(), 5000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  const processed = useMemo(
    () =>
      processLogs(logs, {
        searchTerm,
        logType,
        selectedRoleId,
        usersByRoleData: usersByRoleData || null,
      }),
    [logs, searchTerm, logType, selectedRoleId, usersByRoleData]
  );

  const filteredLogs = processed.logs;
  const exceptionQueryIds = processed.exceptionQueryIds;

  const totalRows = filteredLogs.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(currentPage, totalPages - 1);
  const startIndex = safePage * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalRows);
  const paginatedRows = useMemo(
    () => filteredLogs.slice(startIndex, endIndex),
    [filteredLogs, startIndex, endIndex]
  );

  // Reset to the first page when the filter set, time range, or page size changes.
  useEffect(() => {
    setCurrentPage(0);
  }, [searchTerm, logType, selectedUserId, selectedRoleId, timeRangeHours, pageSize]);

  const isFailedLog = useCallback(
    (log: LogEntry): boolean => {
      if (log.type === "ExceptionWhileProcessing" || log.type === "ExceptionBeforeStart")
        return true;
      if (log.type === "QueryStart") {
        const hasEx = log.exception && log.exception.trim().length > 0;
        return Boolean(hasEx) || exceptionQueryIds.has(log.query_id);
      }
      return false;
    },
    [exceptionQueryIds]
  );

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : "--:--:--";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Standalone page header */}
      {!embedded && (
        <div className="flex flex-col gap-4 border-b border-ink-500 px-6 pb-4 pt-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xs border border-ink-500 bg-ink-100 text-paper-muted">
              <FileText className="h-4 w-4" aria-hidden />
            </span>
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-faint">
                Observability
              </span>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight text-paper">Query logs</h1>
                {!canViewAllLogs && user && (
                  <span className="inline-flex items-center gap-1 rounded-xs border border-ink-500 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-muted">
                    <User className="h-3 w-3" />
                    Your queries only
                  </span>
                )}
              </div>
            </div>
          </div>

          <DataControls
            lastUpdated={lastUpdated}
            isRefreshing={isFetching}
            onRefresh={() => refetch()}
            autoRefresh={autoRefresh}
            onAutoRefreshChange={setAutoRefresh}
          />
        </div>
      )}

      {/* Top strip — filters + time range + counter */}
      <div className={cn("border-b border-ink-500 bg-ink-100", embedded ? "px-4" : "px-6")}>
        <div className="flex flex-wrap items-center gap-3 py-2.5">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-paper-dim" />
            <Input
              placeholder="Search query, user, ID…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 w-[260px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[11px] text-paper placeholder:text-paper-faint focus-visible:border-brand focus-visible:ring-0"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-paper-dim" />
            <Select value={logType} onValueChange={setLogType}>
              <SelectTrigger className="h-8 w-[120px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[11px] text-paper">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="QueryFinish">Success</SelectItem>
                <SelectItem value="ExceptionWhileProcessing">Failed</SelectItem>
                <SelectItem value="ExceptionBeforeStart">Failed (before start)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {canViewAllLogs && (
            <>
              <Select
                value={selectedUserId}
                onValueChange={(v) => {
                  setSelectedUserId(v);
                  if (v !== "all") setSelectedRoleId("all");
                }}
              >
                <SelectTrigger className="h-8 w-[160px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[11px] text-paper [&>span]:truncate">
                  <User className="h-3.5 w-3.5 text-paper-dim" />
                  <SelectValue placeholder="All users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {usersData?.users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.displayName || u.username || u.email || u.id.substring(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedRoleId}
                onValueChange={(v) => {
                  setSelectedRoleId(v);
                  if (v !== "all") setSelectedUserId("all");
                }}
              >
                <SelectTrigger className="h-8 w-[140px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[11px] text-paper [&>span]:truncate">
                  <Shield className="h-3.5 w-3.5 text-paper-dim" />
                  <SelectValue placeholder="All roles" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {rolesData?.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.displayName || role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}

          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              const n = Number(v);
              if (!isNaN(n) && n > 0) setPageSize(n);
            }}
          >
            <SelectTrigger className="h-8 w-[110px] rounded-xs border-ink-500 bg-ink-200 font-mono text-[11px] text-paper">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50 / page</SelectItem>
              <SelectItem value="100">100 / page</SelectItem>
              <SelectItem value="500">500 / page</SelectItem>
              <SelectItem value="1000">1000 / page</SelectItem>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearFilters}
              className="h-8 gap-1.5 rounded-xs border-ink-500 bg-ink-200 px-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-muted hover:border-ink-700 hover:bg-ink-300 hover:text-paper"
            >
              <X className="h-3 w-3" />
              Clear
            </Button>
          )}

          {/* Spacer */}
          <div className="ml-auto flex items-center gap-3">
            {/* Time range chips */}
            <div
              role="radiogroup"
              aria-label="Time range"
              className="flex items-center gap-0.5 rounded-xs border border-ink-500 bg-ink-200 p-0.5"
            >
              {RANGE_OPTIONS.map((opt) => {
                const active = timeRangeHours === opt.hours;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTimeRangeHours(opt.hours)}
                    className={cn(
                      "rounded-xs px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
                      active
                        ? "bg-brand text-ink-50"
                        : "text-paper-muted hover:bg-ink-300 hover:text-paper"
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
              Bucket · {bucket}
            </span>

            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
              Total · {totalRows.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      {/* Body — chart on top, table below */}
      <div className={cn("flex flex-1 min-h-0 flex-col gap-4 overflow-hidden", embedded ? "p-4" : "p-6")}>
        {/* Chart card */}
        <QueryTimelineChart
          hoursBack={timeRangeHours}
          bucket={bucket}
          refreshKey={refreshKey}
        />

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-3 rounded-xs border border-red-900/60 bg-red-950/40 p-3">
            <AlertTriangle className="h-4 w-4 text-red-300" />
            <p className="text-[13px] text-red-200">{error.message}</p>
          </div>
        )}

        {/* Table card */}
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border border-ink-500 bg-ink-100">
          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="p-4">
                <SkeletonRows count={10} cols={7} />
              </div>
            ) : totalRows === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 px-4 text-center">
                <span className="grid h-12 w-12 place-items-center rounded-xs border border-ink-500 bg-ink-200 text-paper-dim">
                  <FileText className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-[13px] text-paper">No queries match</span>
                <span className="text-[12px] text-paper-muted">
                  {hasActiveFilters
                    ? "Adjust filters or widen the time range."
                    : `Nothing logged in the last ${timeRangeHours < 1 ? `${Math.round(timeRangeHours * 60)}m` : `${timeRangeHours}h`}.`}
                </span>
              </div>
            ) : (
              <LogsTable
                rows={paginatedRows}
                expanded={expandedLog}
                onToggle={(id) => setExpandedLog((cur) => (cur === id ? null : id))}
                isFailed={isFailedLog}
              />
            )}
          </div>

          {totalRows > 0 && (
            <PaginationBar
              page={safePage}
              totalPages={totalPages}
              startIndex={startIndex}
              endIndex={endIndex}
              totalRows={totalRows}
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

interface PaginationBarProps {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  totalRows: number;
  onPrev: () => void;
  onNext: () => void;
  onFirst: () => void;
  onLast: () => void;
}

function PaginationBar({
  page,
  totalPages,
  startIndex,
  endIndex,
  totalRows,
  onPrev,
  onNext,
  onFirst,
  onLast,
}: PaginationBarProps) {
  const atStart = page === 0;
  const atEnd = page >= totalPages - 1;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-500 bg-ink-200/50 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
        {(startIndex + 1).toLocaleString()}–{endIndex.toLocaleString()} of{" "}
        {totalRows.toLocaleString()}
      </span>

      <div className="flex items-center gap-1">
        <PageBtn onClick={onFirst} disabled={atStart} label="First page">
          <ChevronsLeft className="h-3.5 w-3.5" />
        </PageBtn>
        <PageBtn onClick={onPrev} disabled={atStart} label="Previous page">
          <ChevronLeft className="h-3.5 w-3.5" />
        </PageBtn>
        <span className="px-2 font-mono text-[11px] text-paper">
          {(page + 1).toLocaleString()} / {totalPages.toLocaleString()}
        </span>
        <PageBtn onClick={onNext} disabled={atEnd} label="Next page">
          <ChevronRight className="h-3.5 w-3.5" />
        </PageBtn>
        <PageBtn onClick={onLast} disabled={atEnd} label="Last page">
          <ChevronsRight className="h-3.5 w-3.5" />
        </PageBtn>
      </div>
    </div>
  );
}

function PageBtn({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-xs border border-ink-500 bg-ink-100 text-paper-muted transition-colors",
        disabled
          ? "cursor-not-allowed opacity-40"
          : "hover:border-ink-700 hover:bg-ink-300 hover:text-paper"
      )}
    >
      {children}
    </button>
  );
}

/* ============================================================
   Compact logs table — QueryDog-style dense layout
   ============================================================ */

interface LogsTableProps {
  rows: LogEntry[];
  expanded: string | null;
  onToggle: (id: string) => void;
  isFailed: (log: LogEntry) => boolean;
}

const COLUMN_HEADERS = [
  { label: "Time", align: "left" as const, w: "w-[88px]" },
  { label: "", align: "left" as const, w: "w-[28px]" },
  { label: "Query", align: "left" as const },
  { label: "User", align: "left" as const, w: "w-[140px]" },
  { label: "Duration", align: "right" as const, w: "w-[88px]" },
  { label: "Read rows", align: "right" as const, w: "w-[96px]" },
  { label: "Read bytes", align: "right" as const, w: "w-[96px]" },
  { label: "Memory", align: "right" as const, w: "w-[96px]" },
  { label: "Query ID", align: "left" as const, w: "w-[110px]" },
];

function LogsTable({ rows, expanded, onToggle, isFailed }: LogsTableProps) {
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 z-10 bg-ink-200/90 backdrop-blur">
        <tr className="border-b border-ink-500">
          {COLUMN_HEADERS.map((h, i) => (
            <th
              key={`${h.label}-${i}`}
              className={cn(
                "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint",
                h.align === "right" ? "text-right" : "text-left",
                h.w
              )}
            >
              {h.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((log, i) => (
          <LogRow
            key={`${log.query_id}-${i}`}
            log={log}
            isExpanded={expanded === log.query_id}
            onToggle={() => onToggle(log.query_id)}
            failed={isFailed(log)}
          />
        ))}
      </tbody>
    </table>
  );
}

interface LogRowProps {
  log: LogEntry;
  isExpanded: boolean;
  onToggle: () => void;
  failed: boolean;
}

function LogRow({ log, isExpanded, onToggle, failed }: LogRowProps) {
  const isFinish = log.type === "QueryFinish";
  const StatusIcon = isFinish ? CheckCircle2 : failed ? XCircle : Zap;
  const statusColor = isFinish
    ? "text-emerald-400"
    : failed
      ? "text-red-400"
      : "text-amber-400";

  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "cursor-pointer border-b border-ink-500/60 transition-colors",
          isExpanded ? "bg-ink-200" : "hover:bg-ink-200/60"
        )}
      >
        <td className="px-3 py-1.5 font-mono text-paper-muted whitespace-nowrap">
          {log.event_time}
        </td>
        <td className="px-3 py-1.5">
          <StatusIcon className={cn("h-3.5 w-3.5", statusColor)} aria-hidden />
        </td>
        <td className="px-3 py-1.5">
          <span className="font-mono text-paper line-clamp-1" title={log.query}>
            {log.query}
          </span>
        </td>
        <td className="px-3 py-1.5 text-paper truncate">
          {log.rbacUser ? (
            <span title={`RBAC: ${log.rbacUser}\nClickHouse: ${log.user}`}>
              {log.rbacUser}
            </span>
          ) : (
            <span title={`ClickHouse user: ${log.user}`}>{log.user}</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-paper">
          {formatDuration(log.query_duration_ms)}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-paper-muted">
          {log.read_rows.toLocaleString()}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-paper-muted">
          {formatBytes(log.read_bytes)}
        </td>
        <td className="px-3 py-1.5 text-right font-mono text-paper-muted">
          {formatBytes(log.memory_usage)}
        </td>
        <td
          className="px-3 py-1.5 font-mono text-paper-faint truncate"
          title={log.query_id}
        >
          {log.query_id.substring(0, 8)}…
        </td>
      </tr>

      {isExpanded && (
        <tr className="bg-ink-200/40">
          <td colSpan={COLUMN_HEADERS.length} className="p-4">
            <LogDetail log={log} failed={failed} onClose={onToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

interface LogDetailProps {
  log: LogEntry;
  failed: boolean;
  onClose: () => void;
}

function LogDetail({ log, failed, onClose }: LogDetailProps) {
  const copy = (text: string) => navigator.clipboard.writeText(text);

  return (
    <div className="flex flex-col gap-4 rounded-xs border border-ink-500 bg-ink-100 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-xs border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
              log.type === "QueryFinish"
                ? "border-emerald-500/40 text-emerald-300"
                : failed
                  ? "border-red-500/40 text-red-300"
                  : "border-amber-500/40 text-amber-300"
            )}
          >
            {log.type}
          </span>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7 rounded-xs text-paper-dim hover:bg-ink-200 hover:text-paper"
              >
                <ChevronDown className="h-3.5 w-3.5 rotate-180" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Collapse</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-faint">
            Query
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copy(log.query)}
            className="h-6 gap-1.5 rounded-xs px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-muted hover:bg-ink-200 hover:text-paper"
          >
            <Copy className="h-3 w-3" />
            Copy
          </Button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xs border border-ink-500 bg-ink-200 p-3 font-mono text-[12px] text-paper">
          {log.query}
        </pre>
      </div>

      {log.exception && (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-red-300">
            Exception
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-xs border border-red-900/60 bg-red-950/40 p-3 font-mono text-[12px] text-red-200">
            {log.exception}
          </pre>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetaCell label="Query ID" value={log.query_id} mono onCopy={() => copy(log.query_id)} />
        <MetaCell
          label="Connection"
          value={log.connectionName || log.connectionId?.substring(0, 8) || "—"}
        />
        <MetaCell label="ClickHouse user" value={log.user} />
        <MetaCell label="Event time" value={`${log.event_date} ${log.event_time}`} />
      </div>
    </div>
  );
}

interface MetaCellProps {
  label: string;
  value: string;
  mono?: boolean;
  onCopy?: () => void;
}

function MetaCell({ label, value, mono, onCopy }: MetaCellProps) {
  return (
    <div className="flex flex-col gap-1 border-l border-ink-500 pl-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-paper-faint">
          {label}
        </span>
        {onCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="text-paper-faint hover:text-paper"
            aria-label={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        )}
      </div>
      <span
        className={cn(
          "truncate text-[12px] text-paper",
          mono && "font-mono text-[11px]"
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
