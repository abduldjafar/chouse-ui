/**
 * Shared bits for the SQL-editor optimizer capabilities (optimize-query,
 * debug-query, check-optimize). These use the session/service-based core tools
 * + the `load_skill` tool to pull detailed instructions from
 * src/skills/ai-optimizer/* at run time.
 */

import { z } from "zod";
import { discoverSkills, createLoadSkillTool } from "../../agentSkills";
import type { ToolSet } from "ai";

/** Skill directory for the optimizer/debugger/evaluator SKILL.md files. */
export const OPTIMIZER_SKILL_DIR = "../skills/ai-optimizer";

/** Build the `load_skill` tool over the optimizer skill set. */
export async function loadSkillTool(): Promise<ToolSet> {
  const skills = await discoverSkills([OPTIMIZER_SKILL_DIR]);
  return { load_skill: createLoadSkillTool(skills) } as ToolSet;
}

/**
 * Remove any trailing FORMAT clause the AI may have appended — the app passes
 * FORMAT to ClickHouse itself, so a FORMAT in the text causes a duplicate-format
 * error at execution time.
 */
export function stripFormatClause(sql: string): string {
  return sql
    .replace(/\s*;\s*$/, "")
    .replace(/\s+FORMAT\s+\w+\s*$/i, "")
    .trimEnd();
}

/** Strip a leading ```sql fence the model sometimes wraps the query in. */
export function unfence(sql: string): string {
  let q = sql.trim();
  if (q.startsWith("```")) {
    q = q.replace(/^```(?:sql)?\s*/i, "").replace(/\s*```$/, "");
  }
  return q;
}

export const OptimizationOutputSchema = z.object({
  optimizedQuery: z.string().describe("The full optimized SQL query with explanatory comments"),
  explanation: z
    .string()
    .describe("A detailed markdown explanation of the changes made and why they improve performance."),
  summary: z
    .string()
    .describe("A one-line summary of the main improvement (e.g., 'Replaced WHERE with PREWHERE')."),
  tips: z
    .array(z.string())
    .describe("A list of general performance tips relevant to this specific query pattern."),
});

export const DebugOutputSchema = z.object({
  fixedQuery: z.string().describe("The fully corrected SQL query"),
  errorAnalysis: z.string().describe("Concise explanation of the error cause"),
  explanation: z.string().describe("Detailed markdown explanation of the fix"),
  summary: z.string().describe("One-line summary of the fix"),
});

export const EvaluatorOutputSchema = z.object({
  canOptimize: z.boolean().describe("Whether significant optimization is possible"),
  reason: z.string().describe("Brief reason for the decision"),
});

export function buildOptimizationPrompt(query: string, additionalPrompt?: string): string {
  let prompt = `Optimize this ClickHouse SQL query:

\`\`\`sql
${query.trim()}
\`\`\`

Use your tools to:
1. Load the \`query-optimizer\` skill for detailed instructions.
2. Fetch the DDL for all tables referenced in the query using \`get_table_ddl\`.
3. Run \`explain_query\` to understand the current execution plan.
4. Produce the optimized query as a JSON response matching the exact schema specified in the optimizer skill.`;
  if (additionalPrompt?.trim()) {
    prompt += `\n\nAdditional instructions from the user:\n${additionalPrompt.trim()}`;
  }
  return prompt;
}

export function buildDebugPrompt(query: string, error: string, additionalPrompt?: string): string {
  let prompt = `Debug this failed ClickHouse SQL query:

\`\`\`sql
${query.trim()}
\`\`\`

Error:
\`\`\`
${error.trim()}
\`\`\`

Use your tools to:
1. Load the \`query-debugger\` skill for detailed instructions.
2. Fetch the DDL for tables referenced in the query using \`get_table_ddl\`.
3. Validate the corrected query with \`validate_sql\`.
4. Produce the fixed query as a JSON response matching the exact schema specified in the debugger skill.`;
  if (additionalPrompt?.trim()) {
    prompt += `\n\nAdditional instructions from the user:\n${additionalPrompt.trim()}`;
  }
  return prompt;
}

export const OPTIMIZER_INSTRUCTIONS = `You are an expert ClickHouse Query Optimizer agent.
Your job is to analyze and optimize SQL queries using the available tools.

WORKFLOW (follow this order strictly):
1. Call \`load_skill\` with name "query-optimizer" to load your detailed instructions.
2. Use \`get_table_ddl\` for every table referenced in the query.
3. Use \`explain_query\` to understand the current execution plan.
4. Produce ONLY a JSON object (no markdown, no extra text) matching this exact schema:
   {
     "optimizedQuery": "<full optimized SQL>",
     "explanation": "<detailed markdown explanation>",
     "summary": "<one-line summary of improvement>",
     "tips": ["<tip1>", "<tip2>"]
   }`;

export const DEBUGGER_INSTRUCTIONS = `You are an expert ClickHouse Query Debugger agent.
Your job is to diagnose and fix failed SQL queries using the available tools.

WORKFLOW (follow this order strictly):
1. Call \`load_skill\` with name "query-debugger" to load your detailed instructions.
2. Use \`get_table_ddl\` or \`get_table_schema\` for tables referenced in the query.
3. Use \`validate_sql\` to verify the corrected query is syntactically valid.
4. Produce ONLY a JSON object (no markdown, no extra text) matching this exact schema:
   {
     "fixedQuery": "<fully corrected SQL>",
     "errorAnalysis": "<concise cause of error>",
     "explanation": "<detailed markdown explanation of the fix>",
     "summary": "<one-line summary of the fix>"
   }`;

export const EVALUATOR_INSTRUCTIONS = `You are a ClickHouse query evaluator performing a rapid pre-screening check.
Load the "query-evaluator" skill for detailed instructions, then evaluate the query.
Produce ONLY a JSON object (no markdown, no extra text):
{ "canOptimize": true|false, "reason": "<one sentence>" }`;
