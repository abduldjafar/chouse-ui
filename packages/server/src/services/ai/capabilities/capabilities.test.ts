/**
 * Capability wiring tests — the deterministic parts (registry integrity, input
 * validation, finalize mapping, soft-fail / parse-failure behavior). The agent
 * loop itself needs a live model and is exercised via integration, not here.
 */

import { describe, it, expect } from "bun:test";
import { CAPABILITIES, CAPABILITY_IDS, getCapability } from "./index";
import { optimizeQueryCapability } from "./optimizeQuery";
import { debugQueryCapability } from "./debugQuery";
import { checkOptimizeCapability } from "./checkOptimize";
import { diagnoseErrorCapability, diagnosePartsCapability } from "./diagnose";
import { fleetScanCapability } from "./fleetScan";
import {
  buildOptimizationPrompt,
  buildDebugPrompt,
  stripFormatClause,
} from "./optimizerShared";
import { AppError } from "../../../types";

const META = { raw: "x", steps: [], modelLabel: "test-model" };

describe("capability registry", () => {
  it("keys match capability ids", () => {
    for (const [key, cap] of Object.entries(CAPABILITIES)) {
      expect(cap.id).toBe(key);
    }
  });

  it("every capability declares a permission + input schema", () => {
    for (const cap of Object.values(CAPABILITIES)) {
      expect(typeof cap.permission).toBe("string");
      expect(cap.inputSchema).toBeDefined();
      expect(cap.delivery === "structured" || cap.delivery === "stream").toBe(true);
    }
  });

  it("getCapability resolves known ids and rejects unknown", () => {
    expect(getCapability("optimize-query")).toBe(optimizeQueryCapability);
    expect(getCapability("nope")).toBeUndefined();
  });

  it("exposes all 9 capabilities", () => {
    expect(CAPABILITY_IDS).toHaveLength(9);
  });
});

describe("input validation", () => {
  it("optimize-query requires a non-empty query", () => {
    expect(optimizeQueryCapability.inputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(optimizeQueryCapability.inputSchema.safeParse({ query: "SELECT 1" }).success).toBe(true);
  });

  it("debug-query requires query + error", () => {
    expect(debugQueryCapability.inputSchema.safeParse({ query: "SELECT 1" }).success).toBe(false);
    expect(
      debugQueryCapability.inputSchema.safeParse({ query: "SELECT 1", error: "boom" }).success,
    ).toBe(true);
  });

  it("diagnose-error requires a name", () => {
    expect(diagnoseErrorCapability.inputSchema.safeParse({}).success).toBe(false);
    expect(diagnoseErrorCapability.inputSchema.safeParse({ name: "TOO_MANY_PARTS" }).success).toBe(true);
  });
});

describe("optimize-query finalize", () => {
  it("strips fences + trailing FORMAT and carries original query + warnings", () => {
    const prepared = { query: "SELECT 1", additionalPrompt: undefined, warnings: ["w"] };
    const parsed = {
      optimizedQuery: "```sql\nSELECT 1 FORMAT JSON\n```",
      explanation: "e",
      summary: "s",
      tips: ["t"],
    };
    const out = optimizeQueryCapability.finalize(parsed, prepared, {}, META);
    expect(out.optimizedQuery).toBe("SELECT 1");
    expect(out.originalQuery).toBe("SELECT 1");
    expect(out.warnings).toEqual(["w"]);
  });
});

describe("diagnose finalize naming", () => {
  it("parts diagnosis names db.table", () => {
    const parsed = { summary: "s", cause: "c", impact: "i", solutions: ["x"] };
    const out = diagnosePartsCapability.finalize(
      parsed,
      { node: { id: "1", name: "n" }, input: { database: "db", table: "t" } },
      {},
      META,
    );
    expect(out.name).toBe("db.t");
  });
});

describe("check-optimize soft fail", () => {
  it("returns canOptimize:false with the AppError message", () => {
    const out = checkOptimizeCapability.softFail!(AppError.badRequest("no model"));
    expect(out.canOptimize).toBe(false);
    expect(out.reason).toBe("no model");
  });

  it("returns a generic reason for non-AppErrors", () => {
    const out = checkOptimizeCapability.softFail!(new Error("weird"));
    expect(out).toEqual({ canOptimize: false, reason: "Analysis failed" });
  });
});

describe("optimizer prompt builders", () => {
  it("optimization prompt includes the query and optional instructions", () => {
    const base = buildOptimizationPrompt("SELECT 1");
    expect(base).toContain("SELECT 1");
    expect(base).not.toContain("Additional instructions");
    expect(buildOptimizationPrompt("SELECT 1", "go fast")).toContain("Additional instructions");
  });

  it("debug prompt includes query + error", () => {
    const p = buildDebugPrompt("SELECT 1", "Syntax error");
    expect(p).toContain("SELECT 1");
    expect(p).toContain("Syntax error");
  });

  it("stripFormatClause removes trailing FORMAT + semicolon", () => {
    expect(stripFormatClause("SELECT 1 FORMAT JSON")).toBe("SELECT 1");
    expect(stripFormatClause("SELECT 1;")).toBe("SELECT 1");
  });
});

describe("fleet-scan parse failure", () => {
  it("returns a report with null analysis instead of throwing", () => {
    const prepared = {
      nodes: [{ id: "1", name: "n" }],
      hours: 6,
      overview: [{ id: "1", name: "n", summary: null }],
      instructions: "x",
      startedAt: Date.now(),
    };
    const report = fleetScanCapability.onParseFailure!(prepared, {}, META);
    expect(report).toMatchObject({ analysis: null, nodes: 1, hours: 6, model: "test-model" });
    expect(report.vitals).toHaveLength(1);
  });
});
