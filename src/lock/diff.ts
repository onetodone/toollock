import type { JsonValue } from "../schema/canonicalize.js";
import type { LockedPrompt, LockedServer, LockedTool } from "./schema.js";

export type DriftClass = "schema-breaking" | "schema-additive" | "prompt-drift" | "cost-drift";
export type DriftSeverity = "fail" | "warn";
export type DriftScope = "tool" | "prompt" | "server";

export interface DriftFinding {
  class: DriftClass;
  severity: DriftSeverity;
  scope: DriftScope;
  /** Tool/prompt name, or the server `id` for scope `"server"`. */
  name: string;
  message: string;
}

/** DECISIONS.md #7: fail on schema-breaking/prompt-drift, warn on schema-additive/cost-drift. */
const SEVERITY: Record<DriftClass, DriftSeverity> = {
  "schema-breaking": "fail",
  "schema-additive": "warn",
  "prompt-drift": "fail",
  "cost-drift": "warn",
};

/** DECISIONS.md #16's stub thresholds — explicitly flagged TBD-pending-real-data from Phase 5, applied here as-is rather than left unimplemented. */
export const COST_DRIFT_TOOL_THRESHOLD = 0.15;
export const COST_DRIFT_BUDGET_THRESHOLD = 0.1;

function finding(cls: DriftClass, scope: DriftScope, name: string, message: string): DriftFinding {
  return { class: cls, severity: SEVERITY[cls], scope, name, message };
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractShape(schema: JsonValue): { properties: Record<string, JsonValue>; required: Set<string> } {
  const obj = isObject(schema) ? schema : {};
  const properties = isObject(obj.properties) ? obj.properties : {};
  const required = new Set(Array.isArray(obj.required) ? obj.required.filter((r): r is string => typeof r === "string") : []);
  return { properties, required };
}

function propertyType(prop: JsonValue): JsonValue {
  return isObject(prop) ? (prop.type ?? null) : null;
}

/**
 * Structural diff of one tool's `inputSchema`, called only when
 * `schemaHash` already differs. Covers exactly decision #7's named
 * cases (property removed, new required/optional property, type
 * changed, required widened/narrowed) plus tool-level removal/addition
 * handled by the caller. Anything that moves `schemaHash` without
 * matching one of these checks (a deeper nested change, a `$defs`-only
 * change post-inlining, etc.) falls through to a deliberate
 * schema-breaking default — PLAN.md's Phase 4 owns hardening these
 * edge cases; until then, an unrecognized structural change fails
 * loud rather than passing silently (the same "silence is the wrong
 * default" stance decision #7 takes for prompt-drift).
 */
function classifyToolSchemaChange(name: string, oldSchema: JsonValue, newSchema: JsonValue): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const oldShape = extractShape(oldSchema);
  const newShape = extractShape(newSchema);

  for (const propName of Object.keys(oldShape.properties)) {
    if (!(propName in newShape.properties)) {
      findings.push(finding("schema-breaking", "tool", name, `property "${propName}" removed`));
    }
  }

  for (const propName of Object.keys(newShape.properties)) {
    if (!(propName in oldShape.properties)) {
      findings.push(
        newShape.required.has(propName)
          ? finding("schema-breaking", "tool", name, `new required property "${propName}"`)
          : finding("schema-additive", "tool", name, `new optional property "${propName}"`),
      );
      continue;
    }

    const oldType = propertyType(oldShape.properties[propName]);
    const newType = propertyType(newShape.properties[propName]);
    if (JSON.stringify(oldType) !== JSON.stringify(newType)) {
      findings.push(
        finding("schema-breaking", "tool", name, `property "${propName}" type changed (${JSON.stringify(oldType)} -> ${JSON.stringify(newType)})`),
      );
    }

    const wasRequired = oldShape.required.has(propName);
    const isRequired = newShape.required.has(propName);
    if (!wasRequired && isRequired) {
      findings.push(finding("schema-breaking", "tool", name, `property "${propName}" became required`));
    } else if (wasRequired && !isRequired) {
      findings.push(finding("schema-additive", "tool", name, `property "${propName}" no longer required`));
    }
  }

  if (findings.length === 0) {
    findings.push(
      finding(
        "schema-breaking",
        "tool",
        name,
        "inputSchema changed in a way not covered by property/required/type checks (Phase 4 edge case) — defaulting to schema-breaking rather than passing silently",
      ),
    );
  }
  return findings;
}

function propertyDescription(prop: JsonValue): string | null {
  return isObject(prop) && typeof prop.description === "string" ? prop.description : null;
}

/**
 * Text-drift check, deliberately not driven by `promptHash` equality:
 * `promptHash` covers every property's description, including ones that
 * only exist on one side of the comparison, so a brand-new optional
 * property (schema-additive, which necessarily introduces a new
 * description too) would move `promptHash` and get double-counted as
 * prompt-drift as well. Comparing stored text directly, and only for
 * properties present on both sides, isolates "this description's text
 * actually changed" from "a description exists now that didn't before."
 */
function classifyToolTextDrift(oldTool: LockedTool, newTool: LockedTool): DriftFinding[] {
  const findings: DriftFinding[] = [];
  if ((oldTool.description ?? null) !== (newTool.description ?? null)) {
    findings.push(finding("prompt-drift", "tool", newTool.name, "description text changed"));
  }

  const oldProps = extractShape(oldTool.inputSchema).properties;
  const newProps = extractShape(newTool.inputSchema).properties;
  for (const propName of Object.keys(oldProps)) {
    if (!(propName in newProps)) continue;
    const oldDesc = propertyDescription(oldProps[propName]);
    const newDesc = propertyDescription(newProps[propName]);
    if (oldDesc !== newDesc) {
      findings.push(finding("prompt-drift", "tool", newTool.name, `property "${propName}" description changed`));
    }
  }
  return findings;
}

function classifyToolPair(oldTool: LockedTool, newTool: LockedTool): DriftFinding[] {
  const findings: DriftFinding[] = [...classifyToolTextDrift(oldTool, newTool)];
  if (oldTool.schemaHash !== newTool.schemaHash) {
    findings.push(...classifyToolSchemaChange(newTool.name, oldTool.inputSchema, newTool.inputSchema));
  }
  if (oldTool.canonicalTokens > 0) {
    const growth = (newTool.canonicalTokens - oldTool.canonicalTokens) / oldTool.canonicalTokens;
    if (growth > COST_DRIFT_TOOL_THRESHOLD) {
      findings.push(
        finding(
          "cost-drift",
          "tool",
          newTool.name,
          `canonicalTokens grew ${(growth * 100).toFixed(1)}% (${oldTool.canonicalTokens} -> ${newTool.canonicalTokens})`,
        ),
      );
    }
  }
  return findings;
}

/** Mirrors classifyToolTextDrift's reasoning: promptHash covers every argument's description including ones only present on one side, so it can't be used directly without double-counting a new/removed argument's description as its own drift event. */
function classifyPromptTextDrift(oldPrompt: LockedPrompt, newPrompt: LockedPrompt): DriftFinding[] {
  const findings: DriftFinding[] = [];
  if ((oldPrompt.description ?? null) !== (newPrompt.description ?? null)) {
    findings.push(finding("prompt-drift", "prompt", newPrompt.name, "description text changed"));
  }
  const oldArgs = new Map(oldPrompt.arguments.map((a) => [a.name, a]));
  const newArgs = new Map(newPrompt.arguments.map((a) => [a.name, a]));
  for (const [name, oldArg] of oldArgs) {
    const newArg = newArgs.get(name);
    if (newArg && (oldArg.description ?? null) !== (newArg.description ?? null)) {
      findings.push(finding("prompt-drift", "prompt", newPrompt.name, `argument "${name}" description changed`));
    }
  }
  return findings;
}

function classifyPromptPair(oldPrompt: LockedPrompt, newPrompt: LockedPrompt): DriftFinding[] {
  const findings: DriftFinding[] = [...classifyPromptTextDrift(oldPrompt, newPrompt)];
  if (oldPrompt.schemaHash === newPrompt.schemaHash) {
    return findings;
  }

  const oldArgs = new Map(oldPrompt.arguments.map((a) => [a.name, a]));
  const newArgs = new Map(newPrompt.arguments.map((a) => [a.name, a]));
  const structural: DriftFinding[] = [];

  for (const name of oldArgs.keys()) {
    if (!newArgs.has(name)) {
      structural.push(finding("schema-breaking", "prompt", newPrompt.name, `argument "${name}" removed`));
    }
  }
  for (const [name, newArg] of newArgs) {
    const oldArg = oldArgs.get(name);
    if (!oldArg) {
      structural.push(
        newArg.required
          ? finding("schema-breaking", "prompt", newPrompt.name, `new required argument "${name}"`)
          : finding("schema-additive", "prompt", newPrompt.name, `new optional argument "${name}"`),
      );
      continue;
    }
    if (!oldArg.required && newArg.required) {
      structural.push(finding("schema-breaking", "prompt", newPrompt.name, `argument "${name}" became required`));
    } else if (oldArg.required && !newArg.required) {
      structural.push(finding("schema-additive", "prompt", newPrompt.name, `argument "${name}" no longer required`));
    }
  }

  findings.push(
    ...(structural.length > 0
      ? structural
      : [finding("schema-breaking", "prompt", newPrompt.name, "argument shape changed in a way not covered by the checks above — defaulting to schema-breaking")]),
  );
  return findings;
}

/** Compares two captures of the same server id and returns every drift finding — empty means no drift at all. */
export function classifyServerDrift(oldServer: LockedServer, newServer: LockedServer): DriftFinding[] {
  const findings: DriftFinding[] = [];

  const oldTools = new Map(oldServer.tools.map((t) => [t.name, t]));
  const newTools = new Map(newServer.tools.map((t) => [t.name, t]));
  for (const [name, oldTool] of oldTools) {
    const newTool = newTools.get(name);
    if (!newTool) {
      findings.push(finding("schema-breaking", "tool", name, "tool removed"));
      continue;
    }
    findings.push(...classifyToolPair(oldTool, newTool));
  }
  for (const name of newTools.keys()) {
    if (!oldTools.has(name)) {
      findings.push(finding("schema-additive", "tool", name, "new tool"));
    }
  }

  const oldPrompts = new Map(oldServer.prompts.map((p) => [p.name, p]));
  const newPrompts = new Map(newServer.prompts.map((p) => [p.name, p]));
  for (const [name, oldPrompt] of oldPrompts) {
    const newPrompt = newPrompts.get(name);
    if (!newPrompt) {
      findings.push(finding("schema-breaking", "prompt", name, "prompt removed"));
      continue;
    }
    findings.push(...classifyPromptPair(oldPrompt, newPrompt));
  }
  for (const name of newPrompts.keys()) {
    if (!oldPrompts.has(name)) {
      findings.push(finding("schema-additive", "prompt", name, "new prompt"));
    }
  }

  if (oldServer.contextBudget !== null && newServer.contextBudget !== null && oldServer.contextBudget > 0) {
    const growth = (newServer.contextBudget - oldServer.contextBudget) / oldServer.contextBudget;
    if (growth > COST_DRIFT_BUDGET_THRESHOLD) {
      findings.push(
        finding(
          "cost-drift",
          "server",
          newServer.id,
          `contextBudget grew ${(growth * 100).toFixed(1)}% (${oldServer.contextBudget} -> ${newServer.contextBudget})`,
        ),
      );
    }
  }

  return findings;
}

export function hasFailingDrift(findings: DriftFinding[]): boolean {
  return findings.some((f) => f.severity === "fail");
}
