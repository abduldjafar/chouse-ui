/**
 * Scheduled health report — periodic AI-enriched fleet check delivered to the
 * configured alert channels (Slack / Google Chat / Email).
 *
 * Distinct from `fleetAlerter`'s breach + auto-RCA path:
 *   - Breach RCA is reactive  — fires when a threshold trips.
 *   - Scheduled report is proactive — fires on a clock (every 15m / 1h / etc).
 *
 * Architecture:
 *   1. DATA layer (pure SQL, always-works): scan the last N minutes of
 *      system.query_log / system.errors / system.asynchronous_metrics on
 *      every active connection. Cheap, deterministic, no AI cost.
 *   2. ENRICHMENT layer (optional AI): feed the structured data into the
 *      Chouse AI model with a tight prompt → human-readable suggestions.
 *      If AI is unavailable / errors / over budget, we still ship a report
 *      with empty suggestions — never silent.
 *   3. DELIVERY layer: pretty Slack Block Kit + Google Chat cardsV2 + HTML
 *      email rendered from the same structured payload.
 *
 * Trigger: fleet poller calls processScheduledReportTick() once per poll;
 * we check (lastRunAt + intervalMinutes < now) for each enabled connection
 * and fan out the report jobs in the background.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { logger } from "../utils/logger";
import { ClientManager } from "./clientManager";
import { buildFleetConfig } from "./fleetMetrics";
import type { AlertConfig } from "./fleetAlerter";

const CONFIG_PATH = process.env.ALERT_CONFIG_FILE || "/app/data/alert-config.json";

/** Where the scheduler bookkeeping lives — separate from user-edited config so
 *  PUT /alert-config from the UI doesn't blow away "lastRunAt" / "runsToday". */
const STATE_PATH =
  process.env.SCHEDULED_REPORT_STATE_FILE || "/app/data/scheduled-report-state.json";

/** Interval choices exposed in the UI; backend validates against this list. */
export const SCHEDULED_REPORT_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;
export type ScheduledInterval = (typeof SCHEDULED_REPORT_INTERVALS)[number];

export interface ScheduledReportConfig {
  /** Master toggle — false means the scheduler skips even if other fields are valid. */
  enabled: boolean;
  /** Bucket size + window length. The window IS the interval — "every 1h, scan last 1h". */
  intervalMinutes: ScheduledInterval;
  /** Skip the report when the window had fewer queries than this — prevents empty
   *  reports for idle clusters and saves AI cost. 0 = no gate. */
  minQueries: number;
  /** Hard daily cap as runaway-cost protection. 0 = no cap. */
  maxRunsPerDay: number;
  /** AI provider id used for the suggestions section. Undefined → default model. */
  aiModelId?: string;
}

/** Per-connection scheduler state — kept on disk so restarts don't double-fire. */
interface SchedulerState {
  [connectionId: string]: {
    lastRunAt: number; // unix ms
    runsToday: number;
    runsTodayDate: string; // YYYY-MM-DD in UTC
  };
}

// ============================================================
// Report payload — the structured shape every channel renders.
// ============================================================

export interface ServerSnapshot {
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  cpuPercent: number;
  activeQueries: number;
  longRunningQueries: number;
  replicaLagSeconds: number;
  uptimeSeconds: number;
  version: string;
}

export interface ProblematicQuery {
  queryId: string;
  /** CH-side user (often the technical Redash / ETL service account). */
  user: string;
  /** Human owner — parsed from a Redash leading-comment `Username: …` when
   *  present, else same as `user`. This is what an operator should *read*. */
  realUser: string;
  /** Redash query_id from `query_id: NNNN` in the leading comment, when this
   *  came from Redash. Lets the operator jump to the Redash query directly. */
  redashQueryId: string | null;
  occurredAt: string; // 'HH:MM:SS' for window display
  occurredAtFull: string; // 'YYYY-MM-DD HH:MM:SS' for tooltips/email
  durationMs: number;
  memoryBytes: number;
  coresUsed: number;
  runCount: number; // executions of same normalized shape in window
  /** Cleaned SQL (leading /* ... */ comments stripped + whitespace collapsed)
   *  so the preview shows the actual query, not just the Redash header. */
  queryPreview: string;
  flag: "memory" | "duration" | "cores" | "mixed";
  exceptionCode: number; // 0 = no exception
}

export interface ErrorRollup {
  code: number;
  name: string;
  count: number;
  firstSeen: string; // 'HH:MM:SS'
  lastSeen: string;
  lastMessage: string;
  topUser: string;
  affectedUsers: number;
}

export interface ScheduledReportPayload {
  /** Generated id; lets the UI deep-link to a saved report page later. */
  id: string;
  connectionId: string;
  connectionName: string;
  windowMinutes: number;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  generatedAt: number; // unix ms
  generatedDurationMs: number;

  totalQueries: number;
  totalErrors: number;

  server: ServerSnapshot;
  topQueries: ProblematicQuery[]; // up to 5
  errors: ErrorRollup[]; // up to 10
  suggestions: string[]; // AI-generated, 3-5 typically. Empty array if AI failed/disabled.
  aiModel: string | null; // null when suggestions came from the rule-based fallback
}

// ============================================================
// Config + state I/O
// ============================================================

export function loadScheduledReportConfig(alertCfg: AlertConfig | null): ScheduledReportConfig | null {
  if (!alertCfg) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
  const raw = parsed.scheduledReport as Record<string, unknown> | undefined;
  if (!raw || raw.enabled !== true) return null;

  const intervalCandidate = Number(raw.intervalMinutes);
  const interval = (SCHEDULED_REPORT_INTERVALS as readonly number[]).includes(intervalCandidate)
    ? (intervalCandidate as ScheduledInterval)
    : 60;
  const minQ = Number(raw.minQueries);
  const cap = Number(raw.maxRunsPerDay);

  return {
    enabled: true,
    intervalMinutes: interval,
    minQueries: Number.isFinite(minQ) && minQ >= 0 ? Math.floor(minQ) : 10,
    maxRunsPerDay: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : 50,
    aiModelId: typeof raw.aiModelId === "string" && raw.aiModelId ? raw.aiModelId : undefined,
  };
}

function loadState(): SchedulerState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return (parsed && typeof parsed === "object" ? parsed : {}) as SchedulerState;
  } catch {
    return {};
  }
}

function saveState(state: SchedulerState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    logger.warn(
      { module: "ScheduledReporter", err: err instanceof Error ? err.message : String(err) },
      "Failed to persist scheduler state",
    );
  }
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Decide whether a connection's scheduled report is due RIGHT NOW. Mutates the
 * state with the bookkeeping (lastRunAt / runsToday) if we're about to fire,
 * so concurrent ticks can't double-fire. Returns the reason for skipping when
 * we're not firing, useful for logs.
 */
function shouldFire(
  state: SchedulerState,
  connectionId: string,
  cfg: ScheduledReportConfig,
  now: number,
): { fire: true } | { fire: false; reason: string } {
  const entry = state[connectionId] ?? { lastRunAt: 0, runsToday: 0, runsTodayDate: todayUTC() };
  // Roll over the daily counter at UTC midnight.
  const today = todayUTC();
  if (entry.runsTodayDate !== today) {
    entry.runsToday = 0;
    entry.runsTodayDate = today;
  }
  if (cfg.maxRunsPerDay > 0 && entry.runsToday >= cfg.maxRunsPerDay) {
    state[connectionId] = entry;
    return { fire: false, reason: `daily cap reached (${entry.runsToday}/${cfg.maxRunsPerDay})` };
  }
  const dueAt = entry.lastRunAt + cfg.intervalMinutes * 60_000;
  if (now < dueAt) {
    state[connectionId] = entry;
    const minsLeft = Math.ceil((dueAt - now) / 60_000);
    return { fire: false, reason: `not due yet (${minsLeft}m remaining)` };
  }
  // Reserve the slot BEFORE the slow scan so re-entrant ticks don't double-fire.
  entry.lastRunAt = now;
  entry.runsToday += 1;
  state[connectionId] = entry;
  return { fire: true };
}

// ============================================================
// SQL data gathering — one round-trip per section, cheap.
// ============================================================

interface CHClient {
  query: (opts: { query: string; format: string }) => Promise<{ json: () => Promise<unknown> }>;
}

async function getClient(connectionId: string): Promise<CHClient> {
  const config = await buildFleetConfig(connectionId);
  return ClientManager.getInstance().getClient(config) as unknown as CHClient;
}

async function fetchServerSnapshot(client: CHClient): Promise<ServerSnapshot> {
  const sql = `
    SELECT
      coalesce((SELECT value FROM system.asynchronous_metrics WHERE metric = 'MemoryResident' LIMIT 1), 0) AS mem_used,
      coalesce(
        (SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSMemoryTotal' LIMIT 1),
        (SELECT value FROM system.asynchronous_metrics WHERE metric = 'CGroupMemoryTotal' AND value > 0 AND value < pow(2, 50) LIMIT 1),
        (SELECT toFloat64(toUInt64OrZero(value)) FROM system.server_settings WHERE name = 'max_server_memory_usage' AND toUInt64OrZero(value) > 0 AND toUInt64OrZero(value) < pow(2, 50) LIMIT 1),
        0
      ) AS mem_total,
      least(100, greatest(0, round((
          coalesce((SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSUserTimeNormalized'   LIMIT 1), 0)
        + coalesce((SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSSystemTimeNormalized' LIMIT 1), 0)
        + coalesce((SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSNiceTimeNormalized'   LIMIT 1), 0)
      ) * 100, 2))) AS cpu_pct,
      (SELECT count() FROM system.processes) AS active_q,
      (SELECT count() FROM system.processes WHERE elapsed > 60) AS long_q,
      (SELECT coalesce(toFloat64(max(absolute_delay)), 0) FROM system.replicas) AS lag,
      uptime() AS up,
      version() AS ver
  `;
  const res = await client.query({ query: sql, format: "JSON" });
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  const r = json.data?.[0] ?? {};
  const used = Number(r.mem_used) || 0;
  const total = Number(r.mem_total) || 0;
  return {
    memoryUsedBytes: used,
    memoryTotalBytes: total,
    memoryPercent: total > 0 ? Math.round((used / total) * 100) : 0,
    cpuPercent: Number(r.cpu_pct) || 0,
    activeQueries: Number(r.active_q) || 0,
    longRunningQueries: Number(r.long_q) || 0,
    replicaLagSeconds: Number(r.lag) || 0,
    uptimeSeconds: Number(r.up) || 0,
    version: String(r.ver ?? ""),
  };
}

/**
 * Top 5 problematic queries in the window. The "problematic" score blends
 * memory, duration, and CPU cores so a query that's heavy on any one axis
 * surfaces — instead of picking 5 by memory and missing the slow scan that
 * ate 30 cores. Tie-break by occurred-at DESC (most recent first) keeps the
 * report relevant to operators reading it right after the window.
 */
/**
 * Strip leading SQL comments (one or more /* … *\/ or `--` lines) and collapse
 * whitespace, so a Redash-wrapped query's preview shows the ACTUAL SQL
 * instead of the technical-metadata header. We keep enough characters that
 * a multi-CTE query's first interesting bit still surfaces.
 */
function cleanSqlPreview(raw: string): string {
  let s = raw;
  // Strip one or more leading block comments (Redash wraps in one block).
  for (let i = 0; i < 4; i++) {
    const trimmed = s.trimStart();
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end < 0) break;
      s = trimmed.slice(end + 2);
      continue;
    }
    if (trimmed.startsWith("--")) {
      const eol = trimmed.indexOf("\n");
      s = eol < 0 ? "" : trimmed.slice(eol + 1);
      continue;
    }
    break;
  }
  return s.replace(/\s+/g, " ").trim().slice(0, 280);
}

/** Pull the human owner from a Redash leading-comment when the CH-side user
 *  is a service account. r_redash is the canonical Paysera flavour; any
 *  `r_*` / `*_etl` pattern likely shares the same comment shape so this is
 *  conservative (only triggers when we actually find the comment). */
function extractRedashUser(rawQuery: string, chUser: string): { realUser: string; redashQueryId: string | null } {
  const userMatch = rawQuery.match(/Username:\s*([^,\n*]+)/i);
  const qidMatch = rawQuery.match(/query_id:\s*([^,\n*]+)/i);
  const realUser = userMatch?.[1]?.trim() || chUser;
  const redashQueryId = qidMatch?.[1]?.trim() || null;
  return { realUser, redashQueryId };
}

async function fetchTopQueries(client: CHClient, windowMinutes: number): Promise<ProblematicQuery[]> {
  // Per-shape rollup: argMax(field, score) within the shape group picks the
  // single worst execution as the representative — so the top 5 are 5
  // DISTINCT shapes, not 5 runs of the same Redash query. run_count comes
  // from count(*) over the same group. Score normalises memory / duration /
  // cores against sensible ceilings (10 GB / 60s / 32 cores) so no single
  // axis can dominate purely by magnitude. Format strings use %i for
  // minutes — %M is "month name" in ClickHouse and would render "10:June:09".
  const sql = `
    WITH scored AS (
      SELECT
        query_id,
        user,
        event_time,
        query_duration_ms,
        memory_usage,
        ProfileEvents['OSCPUVirtualTimeMicroseconds'] / 1000.0 / nullIf(query_duration_ms, 0) AS cores_used,
        substring(query, 1, 1200) AS query_full,
        normalizedQueryHash(query) AS shape_hash,
        exception_code,
        least(memory_usage / 1e10, 1) * 100
        + least(query_duration_ms / 60_000.0, 1) * 100
        + least(coalesce(ProfileEvents['OSCPUVirtualTimeMicroseconds'] / 1000.0 / nullIf(query_duration_ms, 0), 0) / 32.0, 1) * 100 AS score
      FROM system.query_log
      WHERE event_time >= now() - INTERVAL ${windowMinutes} MINUTE
        AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart')
        AND user != ''
        AND query != ''
    )
    SELECT
      argMax(query_id, score) AS query_id,
      argMax(user, score) AS user,
      formatDateTime(argMax(event_time, score), '%H:%i:%S') AS occurred_at,
      formatDateTime(argMax(event_time, score), '%Y-%m-%d %H:%i:%S') AS occurred_at_full,
      argMax(query_duration_ms, score) AS query_duration_ms,
      argMax(memory_usage, score) AS memory_usage,
      coalesce(argMax(cores_used, score), 0) AS cores_used,
      count() AS run_count,
      argMax(query_full, score) AS query_full,
      argMax(exception_code, score) AS exception_code,
      max(score) AS top_score
    FROM scored
    GROUP BY shape_hash
    ORDER BY top_score DESC
    LIMIT 5
  `;
  const res = await client.query({ query: sql, format: "JSON" });
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  return (json.data ?? []).map((r) => {
    const memBytes = Number(r.memory_usage) || 0;
    const durMs = Number(r.query_duration_ms) || 0;
    const cores = Number(r.cores_used) || 0;
    const memScore = Math.min(memBytes / 1e10, 1);
    const durScore = Math.min(durMs / 60_000, 1);
    const coresScore = Math.min(cores / 32, 1);
    const hot = [memScore, durScore, coresScore].filter((s) => s > 0.4).length;
    let flag: ProblematicQuery["flag"] = "mixed";
    if (hot <= 1) {
      const top = Math.max(memScore, durScore, coresScore);
      flag = top === memScore ? "memory" : top === durScore ? "duration" : "cores";
    }
    const rawSql = String(r.query_full ?? "");
    const chUser = String(r.user ?? "");
    const { realUser, redashQueryId } = extractRedashUser(rawSql, chUser);
    return {
      queryId: String(r.query_id ?? ""),
      user: chUser,
      realUser,
      redashQueryId,
      occurredAt: String(r.occurred_at ?? ""),
      occurredAtFull: String(r.occurred_at_full ?? ""),
      durationMs: durMs,
      memoryBytes: memBytes,
      coresUsed: cores,
      runCount: Number(r.run_count) || 1,
      queryPreview: cleanSqlPreview(rawSql),
      flag,
      exceptionCode: Number(r.exception_code) || 0,
    };
  });
}

/**
 * Top 10 error codes that fired in the window. Mirrors the Errors tab's "user
 * attribution via query_log.exception_code" pattern, but bounded to the
 * scheduler's window instead of a fixed 24h lookback.
 */
async function fetchErrorRollup(client: CHClient, windowMinutes: number): Promise<ErrorRollup[]> {
  // %i for minutes (NOT %M which is the full month name in CH formatDateTime).
  const sql = `
    SELECT
      exception_code AS code,
      anyLast(extract(exception, '^([A-Z_]+)')) AS name,
      count() AS hits,
      formatDateTime(min(event_time), '%H:%i:%S') AS first_seen,
      formatDateTime(max(event_time), '%H:%i:%S') AS last_seen,
      substring(argMax(exception, event_time), 1, 400) AS last_message,
      argMax(user, event_time) AS top_user,
      uniqExact(user) AS affected_users
    FROM system.query_log
    WHERE event_time >= now() - INTERVAL ${windowMinutes} MINUTE
      AND type IN ('ExceptionWhileProcessing', 'ExceptionBeforeStart')
      AND exception_code != 0
    GROUP BY code
    ORDER BY hits DESC
    LIMIT 10
  `;
  const res = await client.query({ query: sql, format: "JSON" });
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  return (json.data ?? []).map((r) => ({
    code: Number(r.code) || 0,
    name: String(r.name ?? "").trim() || `code_${r.code}`,
    count: Number(r.hits) || 0,
    firstSeen: String(r.first_seen ?? ""),
    lastSeen: String(r.last_seen ?? ""),
    lastMessage: String(r.last_message ?? "").replace(/\s+/g, " ").trim(),
    topUser: String(r.top_user ?? ""),
    affectedUsers: Number(r.affected_users) || 0,
  }));
}

async function fetchWindowTotals(client: CHClient, windowMinutes: number): Promise<{ totalQueries: number; totalErrors: number }> {
  const sql = `
    SELECT
      count() AS total_q,
      countIf(exception_code != 0) AS total_e
    FROM system.query_log
    WHERE event_time >= now() - INTERVAL ${windowMinutes} MINUTE
      AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart')
  `;
  const res = await client.query({ query: sql, format: "JSON" });
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  const r = json.data?.[0] ?? {};
  return { totalQueries: Number(r.total_q) || 0, totalErrors: Number(r.total_e) || 0 };
}

// ============================================================
// Suggestions — rule-based first, AI-enriched if available.
// ============================================================

/** Always-on rule-based suggestions so the report never has an empty section.
 *  AI enrichment runs ON TOP of these if configured + available. */
function ruleBasedSuggestions(p: Omit<ScheduledReportPayload, "suggestions" | "aiModel">): string[] {
  const out: string[] = [];
  if (p.server.memoryPercent >= 85) {
    out.push(
      `Server memory at ${p.server.memoryPercent}% — cluster is one big query away from OOM. Consider reducing max_threads or per-query memory caps.`,
    );
  }
  if (p.server.replicaLagSeconds > 30) {
    out.push(
      `Replica lag is ${p.server.replicaLagSeconds.toFixed(1)}s — check the slowest replica's merge queue and ZooKeeper health.`,
    );
  }
  if (p.server.longRunningQueries > 0) {
    out.push(
      `${p.server.longRunningQueries} long-running ${p.server.longRunningQueries === 1 ? "query is" : "queries are"} still executing (>60s) — review for runaway scans.`,
    );
  }
  // Per-user repeat offenders (use realUser so "via r_redash" gets attributed
  // to the human owner, not the technical service account).
  const userCount = new Map<string, number>();
  for (const q of p.topQueries) userCount.set(q.realUser, (userCount.get(q.realUser) ?? 0) + 1);
  for (const [user, n] of userCount) {
    if (n >= 3) {
      out.push(`${user} owns ${n} of the top-5 problematic queries — worth a direct conversation.`);
    }
  }
  // Memory hogs
  const heavyMem = p.topQueries.find((q) => q.memoryBytes >= 10 * 1e9);
  if (heavyMem) {
    out.push(
      `${heavyMem.realUser}'s query (${(heavyMem.memoryBytes / 1e9).toFixed(1)} GB peak${heavyMem.redashQueryId ? `, redash#${heavyMem.redashQueryId}` : ""}) is a candidate for a pre-aggregated MaterializedView or projection.`,
    );
  }
  // Long durations without proper batching
  const slow = p.topQueries.find((q) => q.durationMs > 60_000 && q.queryPreview.toLowerCase().startsWith("insert"));
  if (slow) {
    out.push(
      `${slow.realUser}'s slow INSERT (${Math.round(slow.durationMs / 1000)}s) — check batching: ClickHouse wants ≥10k rows per statement, not one-row-per-insert.`,
    );
  }
  // High-cardinality / hot errors
  const memErr = p.errors.find((e) => e.name === "MEMORY_LIMIT_EXCEEDED");
  if (memErr) {
    out.push(
      `\`MEMORY_LIMIT_EXCEEDED\` fired ${memErr.count}× — the underlying queries are exceeding their per-query budget. Lower max_memory_usage or refactor the heaviest shape.`,
    );
  }
  const partsErr = p.errors.find((e) => e.name === "TOO_MANY_PARTS");
  if (partsErr) {
    out.push(
      `\`TOO_MANY_PARTS\` fired ${partsErr.count}× — merges are falling behind ingest. Batch inserts coarser, or coarsen PARTITION BY.`,
    );
  }
  return out.slice(0, 5);
}

interface AiEnrichInput {
  payload: Omit<ScheduledReportPayload, "suggestions" | "aiModel">;
  modelId?: string;
}

/** Optional AI enrichment — returns suggestions + model id, or null on failure.
 *  Wrapped in try/catch so a broken AI config never blocks the report. */
async function aiSuggestions(input: AiEnrichInput): Promise<{ suggestions: string[]; model: string } | null> {
  try {
    const { generateObject } = await import("ai");
    const { z } = await import("zod");
    const { getConfiguration, validateConfiguration, initializeAIModel } = await import("./aiConfig");

    const config = await getConfiguration(input.modelId);
    const validation = validateConfiguration(config);
    if (!validation.valid || !config) return null;

    const model = initializeAIModel(config);
    const schema = z.object({
      suggestions: z
        .array(z.string().min(8).max(360))
        .min(2)
        .max(5)
        .describe(
          "Operator-friendly, action-oriented suggestions based on the gathered data. Reference specific users / query_ids / error codes from the input where appropriate. Avoid generic advice.",
        ),
    });

    // Compact JSON so we don't waste tokens on whitespace; the model gets the
    // full structured data and is told to reason from it, not invent.
    const compact = {
      window_minutes: input.payload.windowMinutes,
      server: input.payload.server,
      totals: { queries: input.payload.totalQueries, errors: input.payload.totalErrors },
      top_queries: input.payload.topQueries.map((q) => ({
        query_id: q.queryId,
        // real_user is the human owner (parsed from Redash leading comment
        // when present); ch_user is the technical service account that
        // actually ran the query. Reference real_user when telling the
        // operator who to talk to.
        real_user: q.realUser,
        ch_user: q.user,
        redash_query_id: q.redashQueryId,
        at: q.occurredAt,
        ms: q.durationMs,
        mem_bytes: q.memoryBytes,
        cores: Number(q.coresUsed.toFixed(2)),
        runs: q.runCount,
        flag: q.flag,
        preview: q.queryPreview,
      })),
      errors: input.payload.errors.map((e) => ({
        code: e.code,
        name: e.name,
        count: e.count,
        first: e.firstSeen,
        last: e.lastSeen,
        users_affected: e.affectedUsers,
        msg: e.lastMessage,
      })),
    };

    const result = await generateObject({
      model,
      schema,
      maxOutputTokens: 1200,
      messages: [
        {
          role: "system",
          content: [
            "You are an experienced ClickHouse SRE. Read the structured fleet snapshot below and write 3 to 5 concrete, actionable suggestions for the operator.",
            "Rules:",
            "1) Reference specific users, query_ids, error codes, and timestamps from the input — never invent.",
            "2) Each suggestion is one sentence. Action-oriented (start with a verb).",
            "3) Skip the obvious. If nothing is wrong, say one calm 'all clear' line plus any optimisation opportunities.",
            "4) Mention concrete ClickHouse mechanisms (MaterializedView, projection, max_threads, batching, PARTITION BY granularity, MergeTree codec, etc) when relevant.",
            "5) No filler — operators read these mid-incident.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Fleet snapshot:\n\`\`\`json\n${JSON.stringify(compact, null, 2)}\n\`\`\``,
        },
      ],
    });
    return { suggestions: result.object.suggestions, model: config.model.modelId };
  } catch (err) {
    logger.warn(
      { module: "ScheduledReporter", err: err instanceof Error ? err.message : String(err) },
      "AI enrichment failed — falling back to rule-based suggestions only",
    );
    return null;
  }
}

// ============================================================
// Delivery — Slack / Google Chat / Email renderers.
// ============================================================

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtCores(c: number): string {
  if (!Number.isFinite(c) || c <= 0) return "—";
  if (c < 1) return `${c.toFixed(2)}×`;
  if (c < 10) return `${c.toFixed(1)}×`;
  return `${Math.round(c)}×`;
}

function fmtUptime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "—";
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}h`;
  return `${Math.floor(s / 60)}m`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) + "…" : id;
}

const FLAG_EMOJI: Record<ProblematicQuery["flag"], string> = {
  memory: "💾",
  duration: "⏱️",
  cores: "🔥",
  mixed: "⚠️",
};

function memStatus(percent: number): { emoji: string; color: string; label: string } {
  if (percent >= 90) return { emoji: "🔴", color: "#dc2626", label: "critical" };
  if (percent >= 70) return { emoji: "🟠", color: "#d97706", label: "warning" };
  if (percent >= 40) return { emoji: "🟡", color: "#ca8a04", label: "elevated" };
  return { emoji: "🟢", color: "#16a34a", label: "healthy" };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}

// -- Slack -----------------------------------------------------------------

async function deliverSlack(p: ScheduledReportPayload, webhookUrl: string): Promise<void> {
  const m = memStatus(p.server.memoryPercent);
  const memLine = p.server.memoryTotalBytes > 0
    ? `${fmtBytes(p.server.memoryUsedBytes)} / ${fmtBytes(p.server.memoryTotalBytes)} (${p.server.memoryPercent}%)`
    : `${fmtBytes(p.server.memoryUsedBytes)} used (no ceiling exposed)`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📊 Scheduled health report — ${p.connectionName}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Window: last *${p.windowMinutes}m* (${p.windowStart.slice(11, 19)} – ${p.windowEnd.slice(11, 19)} UTC) · ${p.totalQueries.toLocaleString()} queries · ${p.totalErrors.toLocaleString()} errors`,
        },
      ],
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*${m.emoji} Memory*\n${memLine}` },
        { type: "mrkdwn", text: `*🖥 CPU*\n${p.server.cpuPercent.toFixed(0)}%` },
        { type: "mrkdwn", text: `*⏳ Active queries*\n${p.server.activeQueries}${p.server.longRunningQueries > 0 ? ` (${p.server.longRunningQueries} long-running)` : ""}` },
        { type: "mrkdwn", text: `*🔄 Replica lag*\n${p.server.replicaLagSeconds.toFixed(1)}s` },
      ],
    },
  ];

  if (p.topQueries.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Top ${p.topQueries.length} problematic queries*` },
    });
    for (const q of p.topQueries) {
      const meta = [
        `${FLAG_EMOJI[q.flag]} \`${q.flag.toUpperCase()}\``,
        `mem ${fmtBytes(q.memoryBytes)}`,
        `dur ${fmtDuration(q.durationMs)}`,
        `cores ${fmtCores(q.coresUsed)}`,
        `at ${q.occurredAt}`,
      ];
      // Surface the human owner (parsed from Redash leading-comment when
      // available); show the technical CH user secondary so operators can
      // still cross-reference the role grant. Redash query_id is the most
      // actionable identifier when present — it's the saved-query handle.
      const ownerBits: string[] = [`*${q.realUser || "(unknown)"}*`];
      if (q.realUser !== q.user && q.user) ownerBits.push(`\`via ${q.user}\``);
      ownerBits.push(`ran ${q.runCount}×`);
      if (q.redashQueryId) ownerBits.push(`redash#${q.redashQueryId}`);
      ownerBits.push(`query_id \`${shortId(q.queryId)}\``);
      const sqlText = q.queryPreview || "(query body unavailable — only the leading comment was captured)";
      const sqlBlock = "```\n" + sqlText.slice(0, 320) + "\n```";
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${meta.join(" · ")}\n${ownerBits.join(" · ")}\n${sqlBlock}` },
      });
    }
  }

  if (p.errors.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*Errors in window*" },
    });
    const errLines = p.errors.slice(0, 6).map((e) => {
      const userBit = e.topUser
        ? ` · top \`${e.topUser}\`${e.affectedUsers > 1 ? ` +${e.affectedUsers - 1}` : ""}`
        : "";
      return `▸ *${e.name}* (${e.code}) ×${e.count} · ${e.firstSeen}–${e.lastSeen}${userBit}`;
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: errLines.join("\n").slice(0, 2900) } });
  }

  if (p.suggestions.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*💡 Suggestions*\n${p.suggestions.map((s) => `• ${s}`).join("\n")}`.slice(0, 2900),
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `chouse-fleet · scheduled report · ${p.aiModel ?? "rule-based"} · ${new Date(p.generatedAt).toUTCString()}`,
      },
    ],
  });

  const payload = {
    text: `📊 Scheduled health report — ${p.connectionName} (${p.windowMinutes}m window)`,
    attachments: [{ color: m.color, blocks }],
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Slack webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// -- Google Chat -----------------------------------------------------------

async function deliverGoogleChat(p: ScheduledReportPayload, webhookUrl: string): Promise<void> {
  const m = memStatus(p.server.memoryPercent);
  const memLine = p.server.memoryTotalBytes > 0
    ? `${fmtBytes(p.server.memoryUsedBytes)} / ${fmtBytes(p.server.memoryTotalBytes)} (${p.server.memoryPercent}%)`
    : `${fmtBytes(p.server.memoryUsedBytes)} used`;

  // Section 1: server snapshot grid
  const serverWidgets: unknown[] = [
    { decoratedText: { topLabel: `${m.emoji} Memory`, text: memLine } },
    { decoratedText: { topLabel: "🖥 CPU", text: `${p.server.cpuPercent.toFixed(0)}%` } },
    {
      decoratedText: {
        topLabel: "⏳ Active queries",
        text: `${p.server.activeQueries}${p.server.longRunningQueries > 0 ? ` (${p.server.longRunningQueries} long-running)` : ""}`,
      },
    },
    { decoratedText: { topLabel: "🔄 Replica lag", text: `${p.server.replicaLagSeconds.toFixed(1)}s` } },
  ];

  const sections: unknown[] = [
    {
      header: `Window: last ${p.windowMinutes}m (${p.windowStart.slice(11, 19)}–${p.windowEnd.slice(11, 19)} UTC)`,
      widgets: [
        {
          textParagraph: {
            text: `<b>${p.totalQueries.toLocaleString()}</b> queries · <b>${p.totalErrors.toLocaleString()}</b> errors`,
          },
        },
        ...serverWidgets,
      ],
    },
  ];

  if (p.topQueries.length > 0) {
    const qWidgets = p.topQueries.flatMap((q, i) => {
      // Build the owner line: real user prominent, technical CH user only
      // when it actually differs (the Redash case). Redash query_id surfaces
      // the saved-query handle right next to the CH query_id.
      const ownerBits: string[] = [`<b>${escapeHtml(q.realUser || "(unknown)")}</b>`];
      if (q.realUser !== q.user && q.user) ownerBits.push(`via ${escapeHtml(q.user)}`);
      ownerBits.push(`ran ${q.runCount}×`);
      if (q.redashQueryId) ownerBits.push(`redash#${escapeHtml(q.redashQueryId)}`);
      ownerBits.push(`query_id ${escapeHtml(shortId(q.queryId))}`);
      const sqlText = q.queryPreview || "(query body unavailable — only the leading comment was captured)";
      return [
        {
          textParagraph: {
            text:
              `<b>${i + 1}. ${FLAG_EMOJI[q.flag]} ${q.flag.toUpperCase()}</b> · ` +
              `<font color="#6b7280">mem ${escapeHtml(fmtBytes(q.memoryBytes))} · ` +
              `dur ${escapeHtml(fmtDuration(q.durationMs))} · ` +
              `cores ${escapeHtml(fmtCores(q.coresUsed))} · ` +
              `at ${escapeHtml(q.occurredAt)}</font>`,
          },
        },
        {
          decoratedText: {
            topLabel: ownerBits.join(" · "),
            text: `<font face="monospace">${escapeHtml(sqlText.slice(0, 240))}</font>`,
          },
        },
      ];
    });
    sections.push({
      header: `Top ${p.topQueries.length} problematic queries`,
      widgets: qWidgets,
    });
  }

  if (p.errors.length > 0) {
    const errText = p.errors
      .slice(0, 6)
      .map((e) => {
        const userBit = e.topUser
          ? ` · top <b>${escapeHtml(e.topUser)}</b>${e.affectedUsers > 1 ? ` +${e.affectedUsers - 1}` : ""}`
          : "";
        return `▸ <b>${escapeHtml(e.name)}</b> (${e.code}) ×${e.count} · ${escapeHtml(e.firstSeen)}–${escapeHtml(e.lastSeen)}${userBit}`;
      })
      .join("<br>");
    sections.push({
      header: "Errors in window",
      widgets: [{ textParagraph: { text: errText } }],
    });
  }

  if (p.suggestions.length > 0) {
    sections.push({
      header: "💡 Suggestions",
      widgets: [
        {
          textParagraph: {
            text: p.suggestions.map((s) => `• ${escapeHtml(s)}`).join("<br>"),
          },
        },
      ],
    });
  }

  sections.push({
    widgets: [
      {
        textParagraph: {
          text: `<font color="#9ca3af">chouse-fleet · ${escapeHtml(p.aiModel ?? "rule-based")} · ${new Date(p.generatedAt).toUTCString()}</font>`,
        },
      },
    ],
  });

  const payload = {
    text: `📊 Scheduled health report — ${p.connectionName} (${p.windowMinutes}m)`,
    cardsV2: [
      {
        cardId: `scheduled-report-${p.id}`,
        card: {
          header: {
            title: `📊 Scheduled health report — ${p.connectionName}`,
            subtitle: `${m.label.toUpperCase()} · ${p.windowMinutes}m window`,
          },
          sections,
        },
      },
    ],
  };
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Google Chat webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// -- Email -----------------------------------------------------------------

async function deliverEmail(p: ScheduledReportPayload, email: {
  host: string; port: number; secure: boolean; user: string; password: string; to: string; from: string;
}): Promise<void> {
  const nodemailer = (await import("nodemailer")).default;
  const transport = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.secure,
    auth: { user: email.user, pass: email.password },
  });
  const m = memStatus(p.server.memoryPercent);
  const memLine = p.server.memoryTotalBytes > 0
    ? `${escapeHtml(fmtBytes(p.server.memoryUsedBytes))} / ${escapeHtml(fmtBytes(p.server.memoryTotalBytes))} (${p.server.memoryPercent}%)`
    : `${escapeHtml(fmtBytes(p.server.memoryUsedBytes))} used`;

  const serverGrid = `
    <table style="width:100%;border-collapse:collapse;margin-top:8px">
      <tr>
        <td style="padding:8px 12px;border:1px solid #e5e7eb;border-radius:6px"><div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.06em">${m.emoji} Memory</div><div style="font-weight:600;color:#111827;margin-top:2px">${memLine}</div></td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb"><div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.06em">🖥 CPU</div><div style="font-weight:600;color:#111827;margin-top:2px">${p.server.cpuPercent.toFixed(0)}%</div></td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e5e7eb"><div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.06em">⏳ Active queries</div><div style="font-weight:600;color:#111827;margin-top:2px">${p.server.activeQueries}${p.server.longRunningQueries > 0 ? ` <span style="color:#d97706">(${p.server.longRunningQueries} long-running)</span>` : ""}</div></td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb"><div style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.06em">🔄 Replica lag</div><div style="font-weight:600;color:#111827;margin-top:2px">${p.server.replicaLagSeconds.toFixed(1)}s</div></td>
      </tr>
    </table>`;

  const qHtml = p.topQueries.length > 0
    ? `<h3 style="margin:18px 0 8px;font-size:14px;color:#111827">Top ${p.topQueries.length} problematic queries</h3>` +
      p.topQueries
        .map((q, i) => {
          const ownerSecondary = q.realUser !== q.user && q.user
            ? ` <span style="color:#9ca3af">via ${escapeHtml(q.user)}</span>`
            : "";
          const redashBit = q.redashQueryId
            ? ` · redash#${escapeHtml(q.redashQueryId)}`
            : "";
          const sqlText = q.queryPreview || "(query body unavailable — only the leading comment was captured)";
          return `
        <div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;margin-top:8px">
          <div style="font-size:13px;color:#111827"><strong>${i + 1}. ${FLAG_EMOJI[q.flag]} ${q.flag.toUpperCase()}</strong> <span style="color:#6b7280">· mem ${escapeHtml(fmtBytes(q.memoryBytes))} · dur ${escapeHtml(fmtDuration(q.durationMs))} · cores ${escapeHtml(fmtCores(q.coresUsed))} · at ${escapeHtml(q.occurredAt)}</span></div>
          <div style="font-size:12px;color:#374151;margin-top:4px"><strong>${escapeHtml(q.realUser || "(unknown)")}</strong>${ownerSecondary} · ran ${q.runCount}×${redashBit} · query_id <code style="font-family:ui-monospace,monospace;color:#6b7280">${escapeHtml(q.queryId)}</code></div>
          <pre style="margin:6px 0 0;padding:8px 10px;background:#f9fafb;border-radius:4px;font-family:ui-monospace,monospace;font-size:11px;color:#374151;white-space:pre-wrap;word-break:break-word">${escapeHtml(sqlText.slice(0, 320))}</pre>
        </div>`;
        })
        .join("")
    : "";

  const eHtml = p.errors.length > 0
    ? `<h3 style="margin:18px 0 8px;font-size:14px;color:#111827">Errors in window</h3><ul style="margin:0;padding-left:18px;color:#374151;font-size:13px">${p.errors
        .slice(0, 8)
        .map(
          (e) => {
            const userBit = e.topUser
              ? ` · top <strong>${escapeHtml(e.topUser)}</strong>${e.affectedUsers > 1 ? ` +${e.affectedUsers - 1}` : ""}`
              : "";
            return `<li style="margin-top:4px"><strong>${escapeHtml(e.name)}</strong> (${e.code}) ×${e.count} · ${escapeHtml(e.firstSeen)}–${escapeHtml(e.lastSeen)}${userBit}<div style="color:#9ca3af;font-size:11px">${escapeHtml(e.lastMessage.slice(0, 200))}</div></li>`;
          },
        )
        .join("")}</ul>`
    : "";

  const sHtml = p.suggestions.length > 0
    ? `<h3 style="margin:18px 0 8px;font-size:14px;color:#111827">💡 Suggestions</h3><ul style="margin:0;padding-left:18px;color:#374151;font-size:13px">${p.suggestions
        .map((s) => `<li style="margin-top:4px">${escapeHtml(s)}</li>`)
        .join("")}</ul>`
    : "";

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:680px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#fff">
    <div style="background:${m.color};color:#fff;padding:14px 18px;font-weight:600;font-size:15px">📊 Scheduled health report — ${escapeHtml(p.connectionName)}</div>
    <div style="padding:18px">
      <div style="color:#6b7280;font-size:12px">Window: last ${p.windowMinutes}m (${escapeHtml(p.windowStart.slice(11, 19))}–${escapeHtml(p.windowEnd.slice(11, 19))} UTC) · ${p.totalQueries.toLocaleString()} queries · ${p.totalErrors.toLocaleString()} errors</div>
      ${serverGrid}
      ${qHtml}
      ${eHtml}
      ${sHtml}
      <div style="margin-top:16px;color:#9ca3af;font-size:11px">chouse-fleet · scheduled report · ${escapeHtml(p.aiModel ?? "rule-based")} · ${new Date(p.generatedAt).toUTCString()}</div>
    </div>
  </div>`;

  await transport.sendMail({
    from: email.from,
    to: email.to,
    subject: `📊 ${p.connectionName} — scheduled report (${p.windowMinutes}m, ${m.label})`,
    text: `Scheduled health report for ${p.connectionName} — see HTML body.`,
    html,
  });
}

// ============================================================
// Orchestration
// ============================================================

/** Build the full payload — pure data gathering, no delivery. Exposed for the
 *  "Send now" test endpoint and for unit testing the renderers. */
export async function gatherScheduledReport(opts: {
  connectionId: string;
  connectionName: string;
  windowMinutes: number;
  aiModelId?: string;
}): Promise<ScheduledReportPayload> {
  const startedAt = Date.now();
  const client = await getClient(opts.connectionId);
  // Run the 4 fetches in parallel — each hits a different system table, no contention.
  const [server, topQueries, errors, totals] = await Promise.all([
    fetchServerSnapshot(client),
    fetchTopQueries(client, opts.windowMinutes),
    fetchErrorRollup(client, opts.windowMinutes),
    fetchWindowTotals(client, opts.windowMinutes),
  ]);

  const base: Omit<ScheduledReportPayload, "suggestions" | "aiModel"> = {
    id: `sr-${startedAt}-${opts.connectionId.slice(0, 8)}`,
    connectionId: opts.connectionId,
    connectionName: opts.connectionName,
    windowMinutes: opts.windowMinutes,
    windowStart: new Date(startedAt - opts.windowMinutes * 60_000).toISOString(),
    windowEnd: new Date(startedAt).toISOString(),
    generatedAt: startedAt,
    generatedDurationMs: 0, // filled below
    totalQueries: totals.totalQueries,
    totalErrors: totals.totalErrors,
    server,
    topQueries,
    errors,
  };

  // Suggestions: AI first, fall back to rule-based if AI fails or returns
  // fewer than 2 lines. Always merge with rule-based hints so the report is
  // never empty even when AI is rate-limited.
  const ruleBased = ruleBasedSuggestions(base);
  const ai = await aiSuggestions({ payload: base, modelId: opts.aiModelId });
  const suggestions = ai && ai.suggestions.length >= 2 ? ai.suggestions : ruleBased;
  const aiModel = ai && ai.suggestions.length >= 2 ? ai.model : null;

  return {
    ...base,
    generatedDurationMs: Date.now() - startedAt,
    suggestions,
    aiModel,
  };
}

/** Deliver a generated payload to whichever of Slack / Google Chat / Email is
 *  configured. Used by both the scheduled tick and the manual "Send now". */
export async function deliverScheduledReport(payload: ScheduledReportPayload, alertCfg: AlertConfig): Promise<{ slack: boolean; googleChat: boolean; email: boolean }> {
  const tasks: Promise<unknown>[] = [];
  const result = { slack: false, googleChat: false, email: false };
  if (alertCfg.slack) {
    tasks.push(
      deliverSlack(payload, alertCfg.slack.webhookUrl)
        .then(() => { result.slack = true; })
        .catch((err) =>
          logger.error({ module: "ScheduledReporter", channel: "slack", err: String(err) }, "Slack delivery failed"),
        ),
    );
  }
  if (alertCfg.googleChat) {
    tasks.push(
      deliverGoogleChat(payload, alertCfg.googleChat.webhookUrl)
        .then(() => { result.googleChat = true; })
        .catch((err) =>
          logger.error({ module: "ScheduledReporter", channel: "google_chat", err: String(err) }, "Google Chat delivery failed"),
        ),
    );
  }
  if (alertCfg.email) {
    tasks.push(
      deliverEmail(payload, alertCfg.email)
        .then(() => { result.email = true; })
        .catch((err) =>
          logger.error({ module: "ScheduledReporter", channel: "email", err: String(err) }, "Email delivery failed"),
        ),
    );
  }
  await Promise.allSettled(tasks);
  return result;
}

/** Called by the fleet poller after each tick. Cheap when nothing's due. */
export async function processScheduledReportTick(
  alertCfg: AlertConfig | null,
  connections: { id: string; name: string }[],
): Promise<void> {
  const cfg = loadScheduledReportConfig(alertCfg);
  if (!cfg || !alertCfg) return;
  const state = loadState();
  const now = Date.now();

  for (const conn of connections) {
    const decision = shouldFire(state, conn.id, cfg, now);
    if (!decision.fire) continue;
    // Fire and forget — the report can take 10-30s with AI enrichment, we
    // don't want to block the poll loop. The state was already mutated to
    // mark this slot as taken, so re-entrant ticks are safe.
    void runOne(conn, cfg, alertCfg).catch((err) =>
      logger.error(
        { module: "ScheduledReporter", connId: conn.id, err: err instanceof Error ? err.message : String(err) },
        "Scheduled report job failed",
      ),
    );
  }
  saveState(state);
}

async function runOne(
  conn: { id: string; name: string },
  cfg: ScheduledReportConfig,
  alertCfg: AlertConfig,
): Promise<void> {
  logger.info(
    { module: "ScheduledReporter", conn: conn.name, window: cfg.intervalMinutes, model: cfg.aiModelId ?? "default" },
    "Generating scheduled report",
  );
  const payload = await gatherScheduledReport({
    connectionId: conn.id,
    connectionName: conn.name,
    windowMinutes: cfg.intervalMinutes,
    aiModelId: cfg.aiModelId,
  });
  // Activity gate — skip delivery if the window was too quiet to be interesting.
  if (cfg.minQueries > 0 && payload.totalQueries < cfg.minQueries) {
    logger.info(
      {
        module: "ScheduledReporter",
        conn: conn.name,
        totalQueries: payload.totalQueries,
        minQueries: cfg.minQueries,
      },
      "Skipping delivery — below activity gate",
    );
    return;
  }
  const delivered = await deliverScheduledReport(payload, alertCfg);
  logger.info(
    {
      module: "ScheduledReporter",
      conn: conn.name,
      durationMs: payload.generatedDurationMs,
      totalQueries: payload.totalQueries,
      totalErrors: payload.totalErrors,
      delivered,
    },
    "Scheduled report delivered",
  );
}
