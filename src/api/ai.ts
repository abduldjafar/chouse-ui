/**
 * Unified AI client.
 *
 * All structured AI features go through a single endpoint: POST /ai/invoke with
 * { capability, input, modelId }. The backend capability registry is the single
 * source of truth; this module is the single source of truth on the frontend.
 *
 * Streaming chat keeps its dedicated client (api/ai-chat.ts) — it's SSE + thread
 * history, a genuinely different surface — but shares the same backend engine.
 */

import { api } from "./client";

/** Structured AI capabilities exposed via /ai/invoke. */
export type AiCapabilityId =
  | "optimize-query"
  | "debug-query"
  | "check-optimize"
  | "optimize-log"
  | "diagnose-error"
  | "diagnose-parts"
  | "diagnose-schema";

export interface InvokeOptions {
  modelId?: string;
  signal?: AbortSignal;
}

/**
 * Invoke a structured AI capability. The backend validates input, enforces the
 * capability's permission, and runs it through the shared agent engine.
 */
export async function invokeAI<TOutput>(
  capability: AiCapabilityId,
  input: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<TOutput> {
  return api.post<TOutput>(
    "/ai/invoke",
    { capability, input, modelId: opts?.modelId },
    { signal: opts?.signal },
  );
}

/** AI model option for the picker (unified across all AI features). */
export interface AiModelOption {
  id: string;
  label: string;
  model: string;
  provider: string;
  isDefault: boolean;
}

/** Active AI deployments for the model picker. Unifies the old per-feature lists. */
export async function fetchAiModels(): Promise<AiModelOption[]> {
  return api.get<AiModelOption[]>("/ai/models");
}

/** Capability availability for the current user (drives showing/hiding AI buttons). */
export interface AiCapabilityInfo {
  id: string;
  permission: string;
  delivery: "structured" | "stream";
  allowed: boolean;
}

export async function fetchAiCapabilities(): Promise<AiCapabilityInfo[]> {
  return api.get<AiCapabilityInfo[]>("/ai/capabilities");
}
