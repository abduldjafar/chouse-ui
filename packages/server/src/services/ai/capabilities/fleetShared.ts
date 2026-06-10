/**
 * Shared helpers for the fleet/connection-based capabilities
 * (diagnose-error, diagnose-parts, diagnose-schema, optimize-log, fleet-scan).
 *
 * These investigate a node's `system.*` tables read-only via the `query_node`
 * tool and prove rewrites with EXPLAIN ESTIMATE — distinct from the
 * session/service-based core tools used by the SQL-editor capabilities.
 *
 * Moved here (the canonical home) from chouseDoctor.ts.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { AppError } from "../../../types";
import { logger } from "../../../utils/logger";
import { buildFleetConfig } from "../../fleetMetrics";
import { ClientManager } from "../../clientManager";
import { listConnections } from "../../../rbac/services/connections";

export interface FleetNode {
  id: string;
  name: string;
}

/**
 * Single source of truth for the system.* schema, shared by every fleet prompt
 * so the agent never guesses a column name (e.g. system.errors has
 * last_error_time, NOT event_time).
 */
export const SYSTEM_TABLE_REFERENCE = `ClickHouse system.* column reference — use these EXACT column names; a wrong guess wastes a full round-trip and fails:
- system.processes (queries running NOW): query_id, user, query, elapsed (Float64 SECONDS — NOT elapsed_ms / elapsed_seconds), memory_usage, peak_memory_usage, read_rows, read_bytes, total_rows_approx, query_kind, is_cancelled.
- system.query_log (FINISHED queries): event_time, query_start_time, query_duration_ms (UInt64 ms — there is NO "elapsed"), type ('QueryFinish' / 'ExceptionWhileProcessing' / …), query, query_id, user, memory_usage (peak), read_rows, read_bytes, result_rows, exception, exception_code, normalized_query_hash. Filter type = 'QueryFinish' for completed queries.
- system.errors (server error counters since start): name, code, value (the hit COUNT), last_error_time, last_error_message, last_error_trace, remote. There is NO event_time / event_date / count column — order by last_error_time or value, and filter by code or name.
- system.merges (in-progress merges): database, table, elapsed, progress (0..1), num_parts, result_part_name, total_size_bytes_compressed, is_mutation, merge_type, rows_read, rows_written. EVERY row is already a currently-running merge — do NOT add a WHERE is_current / is_running / is_active filter (no such column); just SELECT … FROM system.merges. There is NO type / reason / status / total_size_memory / bytes_in_source_parts / is_current.
- system.mutations: database, table, mutation_id, command, create_time, parts_to_do (remaining), is_done, latest_failed_part, latest_fail_time, latest_fail_reason. There is NO parts_done / fail_count — use is_done + parts_to_do, and latest_fail_reason for failures.
- system.replicas: database, table, is_readonly, is_session_expired, absolute_delay (lag in SECONDS), queue_size, inserts_in_queue, merges_in_queue, total_replicas, active_replicas, zookeeper_path. There is NO partitions_total / parts_active.
- system.disks (free space): name, path, free_space, total_space, unreserved_space, keep_free_space.
- Current metric VALUES: query system.metrics or system.asynchronous_metrics — both LONG format (columns: metric, value, description). system.metric_log is WIDE (one column per metric: CurrentMetric_*, ProfileEvent_*) — do NOT SELECT metric, value FROM system.metric_log.
- system.parts (on-disk parts): database, table, partition, active, rows, bytes_on_disk, data_compressed_bytes, modification_time, level. GROUP BY partition to see partition sizes + part counts (scanning every partition = no pruning; many parts = merge pressure).
- system.tables (one row per table): database, table, engine, total_rows, total_bytes, partition_key, sorting_key, primary_key, engine_full, and \`as_select\` + \`create_table_query\` (the SELECT/DDL for a view). Engine tells the kind: a MergeTree-family engine = real stored data; \`View\` = NO data of its own; \`MaterializedView\` = data in a hidden inner table.
- system.columns (one row per column): database, table, name, type, data_compressed_bytes, data_uncompressed_bytes, marks_bytes. Filter by database+table; ORDER BY data_compressed_bytes DESC to find the heaviest columns + types that should be narrower / LowCardinality.
- system.query_log also has \`tables\` Array(String) + \`columns\` Array(String) (what a query touched) and ProfileEvents Map(String,UInt64). Use \`tables\` to learn which tables a heavy query read instead of parsing SQL.
system.processes, system.merges and system.replicas contain ONLY live rows — NEVER filter them by a made-up boolean like is_current / is_running / is_active; to list current activity just SELECT … FROM the table with no such WHERE. Prefer "SELECT * FROM system.<table> LIMIT 5" to discover the real columns before filtering.
If a query errors with "Unknown expression identifier", re-read this list — do NOT retry random column-name variants.`;

/** Resolve one active connection into a node {id,name}. Throws if not found. */
export async function resolveNode(connectionId: string): Promise<FleetNode> {
  const { connections } = await listConnections({ activeOnly: true });
  const conn = connections.find((c) => c.id === connectionId);
  if (!conn) throw AppError.badRequest("Connection not found or inactive");
  return { id: conn.id, name: conn.name };
}

/** Resolve the active node set, optionally scoped to a subset of ids. */
export async function resolveNodes(connectionIds?: string[]): Promise<FleetNode[]> {
  const { connections } = await listConnections({ activeOnly: true });
  if (connections.length === 0) throw AppError.badRequest("No active connections to scan");
  let nodes = connections.map((c) => ({ id: c.id, name: c.name }));
  if (connectionIds && connectionIds.length > 0) {
    const want = new Set(connectionIds);
    nodes = nodes.filter((n) => want.has(n.id));
    if (nodes.length === 0) throw AppError.badRequest("None of the selected nodes are active");
  }
  return nodes;
}

/** Validate a tool SQL is a single read-only SELECT against system.* tables. */
function assertReadOnlySql(raw: string): string {
  const s = raw.trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new Error("Only a single statement is allowed");
  if (!/^(select|with)\b/i.test(s)) throw new Error("Only SELECT / WITH queries are allowed");
  if (/\b(insert|update|delete|drop|alter|truncate|attach|detach|optimize|create|rename|grant|revoke|kill)\b/i.test(s)) {
    throw new Error("Query contains a forbidden (write/DDL/KILL) keyword");
  }
  if (!/\bsystem\./i.test(s)) throw new Error("Chouse AI may only read system.* tables");
  return s;
}

/** The read-only `query_node` investigation tool, bound to a node set. */
export function queryNodeTool(connections: FleetNode[]) {
  const nameById = new Map(connections.map((c) => [c.id, c.name]));
  return {
    query_node: tool({
      description:
        "Run ONE read-only SQL SELECT against a node's system.* tables to investigate (processes, replicas, merges, mutations, query_log, parts, asynchronous_metrics, …). Read-only: writes/DDL/KILL are rejected. Returns up to 100 rows.",
      inputSchema: zodSchema(
        z.object({
          connectionId: z.string().describe("the node id from the overview"),
          sql: z.string().describe("a single read-only SELECT querying system.* tables"),
        }),
      ),
      execute: async ({ connectionId, sql }: { connectionId: string; sql: string }) => {
        if (!nameById.has(connectionId)) return { error: "Unknown connectionId" };
        let safe: string;
        try {
          safe = assertReadOnlySql(sql);
        } catch (e) {
          return { error: e instanceof Error ? e.message : "Rejected query" };
        }
        try {
          const config = await buildFleetConfig(connectionId);
          const client = ClientManager.getInstance().getClient(config);
          const result = await client.query({
            query: safe,
            format: "JSON",
            clickhouse_settings: {
              readonly: "1",
              max_execution_time: 8,
              max_result_rows: "200",
              result_overflow_mode: "break",
            },
          });
          const json = (await result.json()) as { data?: Record<string, unknown>[] };
          return { node: nameById.get(connectionId), rows: (json.data ?? []).slice(0, 100) };
        } catch (e) {
          return { error: e instanceof Error ? e.message.slice(0, 300) : "Query failed" };
        }
      },
    }),
  };
}

/** Clamp a requested window to a sane integer hour range (1h … 31 days). */
export function clampHours(hours: number | undefined): number {
  return Math.max(1, Math.min(744, Math.round(hours ?? 6)));
}

/** Strip SQL comments + trailing semicolon so the AI and EXPLAIN see clean SQL. */
export function cleanQueryForOptimize(q: string): string {
  return q
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .replace(/;\s*$/, "")
    .trim();
}

/** Fetch the full query text (+ peak memory, user) for a query_id from system.query_log. */
export async function fetchQueryById(
  connectionId: string,
  queryId: string,
): Promise<{ query: string; peakMemory?: string; user?: string } | null> {
  try {
    const config = await buildFleetConfig(connectionId);
    const client = ClientManager.getInstance().getClient(config);
    const result = await client.query({
      query: `SELECT query, user, round(memory_usage / 1e9, 2) AS peak_gb
              FROM system.query_log
              WHERE query_id = {qid:String}
                AND query != ''
              ORDER BY length(query) DESC, memory_usage DESC
              LIMIT 1`,
      query_params: { qid: queryId },
      format: "JSON",
      clickhouse_settings: { readonly: "1", max_execution_time: 15 },
    });
    const json = (await result.json()) as {
      data?: { query?: string; user?: string; peak_gb?: number }[];
    };
    const row = json.data?.[0];
    if (!row?.query) return null;
    return {
      query: String(row.query),
      user: row.user ? String(row.user) : undefined,
      peakMemory: row.peak_gb != null ? `${row.peak_gb} GB` : undefined,
    };
  } catch {
    return null;
  }
}

/** Top query SHAPES by memory over the last N hours (system.query_log) — read-only. */
function recentHeavyQueriesSql(hours: number): string {
  const h = clampHours(hours); // integer-clamped → safe to interpolate
  return `
  SELECT
    any(substring(query, 1, 8000)) AS sample_query,
    any(user) AS user,
    count() AS runs,
    round(max(memory_usage) / 1e9, 2) AS peak_gb,
    round(avg(memory_usage) / 1e9, 2) AS avg_gb,
    formatDateTime(max(event_time), '%Y-%m-%d %H:%i:%S') AS last_seen,
    max(trim(extract(query, 'Username:\\\\s*([^,]+)'))) AS redash_user,
    max(extract(query, 'query_id:\\\\s*(\\\\d+)')) AS redash_query_id
  FROM system.query_log
  WHERE event_time >= now() - INTERVAL ${h} HOUR
    AND type = 'QueryFinish'
    AND memory_usage > 0
    AND query NOT LIKE '%FLEET_POLLER_MARKER%'
  GROUP BY normalized_query_hash
  ORDER BY peak_gb DESC
  LIMIT 5`;
}

/** Heaviest query shapes by memory over the window (sanitized SQL + Redash attribution). */
export async function recentHeavyQueries(
  connectionId: string,
  hours: number,
): Promise<Record<string, unknown>[]> {
  try {
    const config = await buildFleetConfig(connectionId);
    const client = ClientManager.getInstance().getClient(config);
    const result = await client.query({
      query: recentHeavyQueriesSql(hours),
      format: "JSON",
      clickhouse_settings: { readonly: "1", max_execution_time: 20, max_result_rows: "50" },
    });
    const json = (await result.json()) as { data?: Record<string, unknown>[] };
    return (json.data ?? []).map((r) => {
      const out = { ...r };
      if (typeof out.sample_query === "string") {
        out.sample_query = out.sample_query
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/--[^\n]*/g, " ")
          .replace(/[ \t]+/g, " ")
          .replace(/\n{2,}/g, "\n")
          .trim()
          .slice(0, 8000);
      }
      if (!out.redash_user) delete out.redash_user;
      if (!out.redash_query_id) delete out.redash_query_id;
      return out;
    });
  } catch {
    return [];
  }
}

export interface EstimateFigures {
  rows: number;
  parts: number;
  marks: number;
}

/**
 * Run EXPLAIN ESTIMATE for a query (read-only — it PLANS, never executes) and
 * sum rows/parts/marks across the tables it would read. Returns null on any
 * failure (truncated/invalid SQL, rewrite with placeholders, unknown table, …).
 */
export async function explainEstimate(
  connectionId: string,
  rawSql: string,
): Promise<EstimateFigures | null> {
  const sql = rawSql
    .replace(/;\s*$/, "")
    .replace(/\bformat\s+\w+\s*$/i, "")
    .replace(/\bsettings\s+\w+\s*=[\s\S]*$/i, "")
    .trim();
  if (!sql || !/^(select|with)\b/i.test(sql)) return null;
  try {
    const config = await buildFleetConfig(connectionId);
    const client = ClientManager.getInstance().getClient(config);
    const result = await client.query({
      query: `EXPLAIN ESTIMATE ${sql}`,
      format: "JSON",
      clickhouse_settings: { readonly: "1", max_execution_time: 10 },
    });
    const json = (await result.json()) as {
      data?: { rows?: unknown; parts?: unknown; marks?: unknown }[];
    };
    const data = json.data ?? [];
    if (data.length === 0) return null;
    let rows = 0;
    let parts = 0;
    let marks = 0;
    for (const r of data) {
      rows += Number(r.rows) || 0;
      parts += Number(r.parts) || 0;
      marks += Number(r.marks) || 0;
    }
    return { rows, parts, marks };
  } catch (e) {
    logger.info(
      {
        module: "AI:fleetShared",
        err: e instanceof Error ? e.message.slice(0, 240) : String(e),
        sql: sql.slice(0, 140),
      },
      "EXPLAIN ESTIMATE failed",
    );
    return null;
  }
}

/** Standard diagnosis output shape shared by error/parts/schema capabilities. */
export const ErrorDiagnosisSchema = z.object({
  summary: z.string(),
  cause: z.string(),
  impact: z.string(),
  solutions: z.array(z.string()),
});

export type ParsedDiagnosis = z.infer<typeof ErrorDiagnosisSchema>;

export interface ErrorDiagnosis {
  code?: number;
  name: string;
  summary: string;
  cause: string;
  impact: string;
  solutions: string[];
}
