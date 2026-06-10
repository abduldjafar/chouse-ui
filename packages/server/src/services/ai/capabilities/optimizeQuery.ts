/**
 * Capability: optimize-query — the SQL editor "Optimize" button.
 * Session/service-based agent; validates table access, loads the optimizer
 * skill, fetches DDL + EXPLAIN, returns a structured optimization.
 */

import { z } from "zod";
import type { ModelMessage, ToolSet } from "ai";
import { AppError } from "../../../types";
import { PERMISSIONS } from "../../../rbac/schema/base";
import { validateQueryAccess } from "../../../middleware/dataAccess";
import { coreTools } from "../toolsets";
import type { StructuredCapability } from "../types";
import {
  OptimizationOutputSchema,
  OPTIMIZER_INSTRUCTIONS,
  buildOptimizationPrompt,
  loadSkillTool,
  stripFormatClause,
  unfence,
} from "./optimizerShared";

export interface OptimizeQueryInput {
  query: string;
  additionalPrompt?: string;
  database?: string;
}

export interface OptimizationResult {
  optimizedQuery: string;
  originalQuery: string;
  explanation: string;
  summary: string;
  tips: string[];
  warnings?: string[];
}

interface Prepared {
  query: string;
  additionalPrompt?: string;
  warnings?: string[];
}

type Parsed = z.infer<typeof OptimizationOutputSchema>;

export const optimizeQueryCapability: StructuredCapability<
  OptimizeQueryInput,
  Prepared,
  Parsed,
  OptimizationResult
> = {
  id: "optimize-query",
  delivery: "structured",
  permission: PERMISSIONS.AI_OPTIMIZE,
  inputSchema: z.object({
    query: z.string().min(1, "Query is required"),
    additionalPrompt: z.string().optional(),
    database: z.string().optional(),
  }),
  outputSchema: OptimizationOutputSchema,
  tuning: { stopAtSteps: 10, temperature: 0 },

  async prepare(input, ctx) {
    const trimmed = input.query.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
      throw AppError.badRequest(
        "AI optimizer only supports SELECT and WITH queries (read-only operations)",
      );
    }
    const access = await validateQueryAccess(
      ctx.userId,
      ctx.isAdmin,
      ctx.permissions,
      input.query,
      input.database ?? ctx.defaultDatabase,
      ctx.connectionId,
    );
    if (!access.allowed) {
      throw AppError.forbidden(access.reason || "Access denied to one or more tables in query");
    }
    return { query: input.query, additionalPrompt: input.additionalPrompt, warnings: access.warnings };
  },

  async tools(_prepared, ctx): Promise<ToolSet> {
    return { ...(await loadSkillTool()), ...coreTools(ctx) };
  },

  instructions() {
    return OPTIMIZER_INSTRUCTIONS;
  },

  messages(prepared): ModelMessage[] {
    return [{ role: "user", content: buildOptimizationPrompt(prepared.query, prepared.additionalPrompt) }];
  },

  finalize(parsed, prepared) {
    return {
      originalQuery: prepared.query,
      optimizedQuery: stripFormatClause(unfence(parsed.optimizedQuery)),
      explanation: parsed.explanation,
      summary: parsed.summary,
      tips: parsed.tips,
      warnings: prepared.warnings,
    };
  },
};
