/**
 * Capability: chat — the conversational SRE assistant.
 *
 * The only streaming capability. The engine builds the agent (model + tools +
 * instructions); SSE framing, scratchpad stripping, chart-data events and
 * thread persistence stay in the route, which is genuinely chat-specific.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import { PERMISSIONS } from "../../../rbac/schema/base";
import {
  discoverSkills,
  createLoadSkillTool,
  type SkillMetadata,
} from "../../agentSkills";
import { coreTools, chartTools, requireToolContext } from "../toolsets";
import { runStructuredCapability } from "../engine";
import { optimizeQueryCapability } from "./optimizeQuery";
import type { AgentRunContext, StreamCapability } from "../types";

const CHAT_SKILL_DIR = "../skills/ai-chat";

function buildSystemPrompt(skills: SkillMetadata[]): string {
  const skillsList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `
You are an expert ClickHouse assistant embedded inside CHouse UI.
You operate in STRICT TOOL-FIRST MODE.

## SKILLS
You have an arsenal of complex operating instructions saved as skills on the filesystem.
You MUST use the \`load_skill\` tool to retrieve these instructions BEFORE performing complex tasks!

Available skills:
${skillsList}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORE OPERATING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. NEVER guess database names, table names, columns, or data.
2. NEVER fabricate results.
3. NEVER answer schema/data questions without calling tools first.
4. DO NOT DESCRIBE CHARTS IN TEXT. YOU MUST USE THE \`render_chart\` TOOL TO SHOW THEM IN THE UI!
5. NEVER output markdown tables when a chart is requested. Call \`render_chart\` instead.
6. When the user wants to validate or check a query without running it → use \`validate_sql\`.
7. When the user wants to export, download, or get data as CSV/JSON → use \`export_query_result\`.

## DECISION FRAMEWORK: WHEN TO LOAD SKILLS
You MUST call \`load_skill\` depending on the user's intent BEFORE taking action:
- Intent: User wants to know what databases/tables exist, or wants to explore the schema → call \`load_skill\` with "data-exploration"
- Intent: User wants you to write or execute a SQL query → call \`load_skill\` with "sql-generation"
- Intent: User wants a chart, plot, graph, or visual distribution → call \`load_skill\` with "data-visualization"
- Intent: User asks about query performance, EXPLAIN, or wants to optimize a query → call \`load_skill\` with "query-optimization"
- Intent: User wants to know about server health, running queries, slow/heavy queries (historical or current), or system issues → call \`load_skill\` with "system-troubleshooting" (use \`get_slow_queries\` for historical slow queries, \`get_running_queries\` for currently running).

Other tools (use when appropriate without requiring a skill): For database-level overview (table count, total size), use \`get_database_info\`. For syntax-only validation use \`validate_sql\`; for export use \`export_query_result\`.

ONLY produce the final text answer after all required tool calls (and skill loads) are complete.
Base your final answer strictly on tool results.
If access is denied, explain clearly.
If a tool fails, surface the error clearly.

You have READ-ONLY access.
Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN queries are allowed.
Never attempt INSERT, UPDATE, DELETE, CREATE, ALTER, DROP.

## SQL FORMATTING RULE
NEVER append a FORMAT clause (e.g. FORMAT JSON, FORMAT CSV, FORMAT TabSeparated) to any SQL query.
The application handles output formatting internally. A FORMAT clause will break query execution.
`;
}

/** Chat-only tools: NL→SQL guidance + delegating optimizer. */
function createChatSpecificTools(ctx: AgentRunContext): ToolSet {
  return {
    generate_query: tool({
      description:
        "Generate a SQL query based on a natural language description. Use this after gathering schema information from other tools. After calling this, you MUST output the generated query in a ```sql code block. If the user wants the query executed, call run_select_query with that SQL.",
      inputSchema: zodSchema(
        z.object({
          description: z.string().describe("Natural language description of what the query should do"),
          context: z.string().describe("Relevant schema information gathered from other tools"),
        }),
      ),
      execute: async ({ description, context }: { description: string; context: string }) => ({
        note: "Generate the SQL query based on the description and schema context. Present it in a ```sql code block. If the user asked to run or execute the query, call run_select_query with that SQL.",
        description,
        schemaContext: context,
      }),
    }),
    optimize_query: tool({
      description: "Get AI-powered optimization suggestions for a SQL query.",
      inputSchema: zodSchema(z.object({ sql: z.string().describe("The SQL query to optimize") })),
      execute: async ({ sql }: { sql: string }) => {
        try {
          const result = await runStructuredCapability(optimizeQueryCapability, { query: sql }, ctx);
          return {
            optimizedQuery: result.optimizedQuery,
            explanation: result.explanation,
            summary: result.summary,
            tips: result.tips,
          };
        } catch (error: unknown) {
          return { error: error instanceof Error ? error.message : "Failed to optimize query" };
        }
      },
    }),
  } as ToolSet;
}

export interface ChatInput {
  /** Conversation history is supplied to the engine as ModelMessage[] by the route. */
  threadId?: string;
}

export const chatCapability: StreamCapability<ChatInput> = {
  id: "chat",
  delivery: "stream",
  permission: PERMISSIONS.AI_CHAT,
  inputSchema: z.object({ threadId: z.string().optional() }),
  tuning: { stopAtSteps: 30, temperature: 0 },

  async tools(ctx): Promise<ToolSet> {
    // Validate a live session exists (chat needs core/chart tools).
    requireToolContext(ctx);
    const skills = await discoverSkills([CHAT_SKILL_DIR]);
    return {
      load_skill: createLoadSkillTool(skills),
      ...coreTools(ctx),
      ...chartTools(ctx),
      ...createChatSpecificTools(ctx),
    } as ToolSet;
  },

  async instructions(): Promise<string> {
    const skills = await discoverSkills([CHAT_SKILL_DIR]);
    return buildSystemPrompt(skills);
  },
};
