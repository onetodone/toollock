import { toCanonicalString, type JsonValue } from "../schema/canonicalize.js";
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

function propertyEnum(prop: JsonValue): JsonValue[] | null {
  return isObject(prop) && Array.isArray(prop.enum) ? prop.enum : null;
}

/**
 * `enum` membership drift for one property present on both sides. Both
 * lock snapshots store the canonicalized schema (`enum[]` already sorted
 * — canonicalize.ts), so a set comparison is order-independent by
 * construction. Removing an allowed value breaks any caller relying on
 * it (schema-breaking); adding one is backward-compatible
 * (schema-additive). Without this, an enum-only change falls through to
 * `classifyToolSchemaChange`'s deliberate schema-breaking default — right
 * severity for a narrowing, wrong for a widening.
 */
function classifyEnumChange(name: string, propName: string, oldProp: JsonValue, newProp: JsonValue): DriftFinding[] {
  const oldEnum = propertyEnum(oldProp);
  const newEnum = propertyEnum(newProp);
  if (!oldEnum && !newEnum) return [];

  const oldVals = (oldEnum ?? []).map((v) => JSON.stringify(v));
  const newVals = (newEnum ?? []).map((v) => JSON.stringify(v));
  const removed = oldVals.filter((v) => !newVals.includes(v));
  const added = newVals.filter((v) => !oldVals.includes(v));

  if (removed.length > 0) {
    return [finding("schema-breaking", "tool", name, `property "${propName}" enum value(s) removed: ${removed.join(", ")}`)];
  }
  if (added.length > 0) {
    return [finding("schema-additive", "tool", name, `property "${propName}" enum value(s) added: ${added.join(", ")}`)];
  }
  return [];
}

/**
 * Structural diff of one tool's `inputSchema`, called only when
 * `schemaHash` already differs. Covers exactly decision #7's named
 * cases (property removed, new required/optional property, type
 * changed, required widened/narrowed) plus `enum` widening/narrowing
 * (Phase 4) and tool-level removal/addition/rename handled by the
 * caller. Anything that moves `schemaHash` without matching one of
 * these checks (a deeper nested change, a `$defs`-only change
 * post-inlining, etc.) falls through to a deliberate schema-breaking
 * default — PLAN.md's Phase 4 owns hardening these edge cases; until
 * then, an unrecognized structural change fails loud rather than
 * passing silently (the same "silence is the wrong default" stance
 * decision #7 takes for prompt-drift).
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

    const oldProp = oldShape.properties[propName];
    const newProp = newShape.properties[propName];

    const oldType = propertyType(oldProp);
    const newType = propertyType(newProp);
    if (JSON.stringify(oldType) !== JSON.stringify(newType)) {
      findings.push(
        finding("schema-breaking", "tool", name, `property "${propName}" type changed (${JSON.stringify(oldType)} -> ${JSON.stringify(newType)})`),
      );
    }

    findings.push(...classifyEnumChange(name, propName, oldProp, newProp));

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
        "inputSchema changed in a way not covered by property/required/type/enum checks (Phase 4 edge case) — defaulting to schema-breaking rather than passing silently",
      ),
    );
  }
  return findings;
}

function propertyDescription(prop: JsonValue): string | null {
  return isObject(prop) && typeof prop.description === "string" ? prop.description : null;
}

/**
 * Names the annotation keys whose values actually differ, so the
 * `verify` line says *what* changed rather than just *that* it did —
 * `readOnlyHint` flipping is a different fact from `title` being
 * rephrased.
 */
function describeAnnotationChange(oldAnn: JsonValue | null, newAnn: JsonValue | null): string {
  const o = isObject(oldAnn) ? oldAnn : {};
  const n = isObject(newAnn) ? newAnn : {};
  const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])].sort();
  const changed = keys.filter((k) => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
  return changed.length > 0 ? changed.join(", ") : "structure changed";
}

/**
 * `annotations` are hint fields (`readOnlyHint`, `destructiveHint`,
 * `title`, …) — DECISIONS.md #4 assigns them to `promptHash`'s
 * behavioral bucket, not the structural one, so a change here is
 * `prompt-drift` (fail): a server flipping `readOnlyHint` from `true`
 * to `false` alters how a client treats the tool exactly the way a
 * rewritten description does. Compared via JCS so key-order noise
 * doesn't register as drift.
 */
function classifyAnnotationDrift(oldTool: LockedTool, newTool: LockedTool): DriftFinding[] {
  const oldStr = oldTool.annotations === null ? null : toCanonicalString(oldTool.annotations);
  const newStr = newTool.annotations === null ? null : toCanonicalString(newTool.annotations);
  if (oldStr === newStr) return [];
  return [finding("prompt-drift", "tool", newTool.name, `annotations changed (${describeAnnotationChange(oldTool.annotations, newTool.annotations)})`)];
}

/**
 * Text-drift check, deliberately not driven by `promptHash` equality:
 * `promptHash`'s payload covers every property's description, including
 * ones that only exist on one side of the comparison, so a brand-new
 * optional property (schema-additive, which necessarily introduces a
 * new description too) would move `promptHash` and get double-counted
 * as prompt-drift as well. Comparing stored text directly, and only for
 * properties present on both sides, isolates "this description's text
 * actually changed" from "a description exists now that didn't before."
 */
function classifyToolTextDrift(oldTool: LockedTool, newTool: LockedTool): DriftFinding[] {
  const findings: DriftFinding[] = [];
  if ((oldTool.description ?? null) !== (newTool.description ?? null)) {
    findings.push(finding("prompt-drift", "tool", newTool.name, "description text changed"));
  }
  findings.push(...classifyAnnotationDrift(oldTool, newTool));

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

function costDriftForTool(oldTool: LockedTool, newTool: LockedTool): DriftFinding[] {
  if (oldTool.canonicalTokens <= 0) return [];
  const growth = (newTool.canonicalTokens - oldTool.canonicalTokens) / oldTool.canonicalTokens;
  if (growth <= COST_DRIFT_TOOL_THRESHOLD) return [];
  return [
    finding(
      "cost-drift",
      "tool",
      newTool.name,
      `canonicalTokens grew ${(growth * 100).toFixed(1)}% (${oldTool.canonicalTokens} -> ${newTool.canonicalTokens})`,
    ),
  ];
}

function classifyToolPair(oldTool: LockedTool, newTool: LockedTool): DriftFinding[] {
  const findings: DriftFinding[] = [...classifyToolTextDrift(oldTool, newTool)];
  if (oldTool.schemaHash !== newTool.schemaHash) {
    findings.push(...classifyToolSchemaChange(newTool.name, oldTool.inputSchema, newTool.inputSchema));
  }
  findings.push(...costDriftForTool(oldTool, newTool));
  return findings;
}

/**
 * Pairs a disappeared entry with a new one carrying an identical
 * `schemaHash` and calls it a rename rather than an unrelated
 * removal + addition. A 256-bit structural-hash collision between a
 * removed and an added entry of the same server is not a coincidence
 * worth guarding against, and the severity is `fail` either way (a
 * removal and a rename both break callers of the old name), so a wrong
 * guess costs a clearer message, never a wrong CI outcome. Matching is
 * deterministic: removed and added are both walked in name order, first
 * unclaimed hash match wins.
 */
function pairRenames<T extends { name: string; schemaHash: string }>(
  removed: T[],
  added: T[],
): { renames: Array<[T, T]>; removedLeft: T[]; addedLeft: T[] } {
  const renames: Array<[T, T]> = [];
  const addedPool = [...added].sort((a, b) => a.name.localeCompare(b.name));
  const claimed = new Set<T>();
  const removedLeft: T[] = [];

  for (const r of [...removed].sort((a, b) => a.name.localeCompare(b.name))) {
    const match = addedPool.find((a) => !claimed.has(a) && a.schemaHash === r.schemaHash);
    if (match) {
      renames.push([r, match]);
      claimed.add(match);
    } else {
      removedLeft.push(r);
    }
  }
  return { renames, removedLeft, addedLeft: addedPool.filter((a) => !claimed.has(a)) };
}

function classifyTools(oldTools: LockedTool[], newTools: LockedTool[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const oldByName = new Map(oldTools.map((t) => [t.name, t]));
  const newByName = new Map(newTools.map((t) => [t.name, t]));

  for (const [name, oldTool] of oldByName) {
    const newTool = newByName.get(name);
    if (newTool) findings.push(...classifyToolPair(oldTool, newTool));
  }

  const removed = [...oldByName.values()].filter((t) => !newByName.has(t.name));
  const added = [...newByName.values()].filter((t) => !oldByName.has(t.name));
  const { renames, removedLeft, addedLeft } = pairRenames(removed, added);

  for (const [oldTool, newTool] of renames) {
    findings.push(
      finding(
        "schema-breaking",
        "tool",
        newTool.name,
        `tool renamed from "${oldTool.name}" (identical inputSchema structure — callers using the old name break)`,
      ),
    );
    // A rename can also carry a description/annotation rewrite; report
    // that as its own prompt-drift finding rather than folding it in.
    findings.push(...classifyToolTextDrift(oldTool, newTool));
    findings.push(...costDriftForTool(oldTool, newTool));
  }
  for (const t of removedLeft) findings.push(finding("schema-breaking", "tool", t.name, "tool removed"));
  for (const t of addedLeft) findings.push(finding("schema-additive", "tool", t.name, "new tool"));

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

function classifyPromptArgShape(oldPrompt: LockedPrompt, newPrompt: LockedPrompt): DriftFinding[] {
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

  return structural.length > 0
    ? structural
    : [finding("schema-breaking", "prompt", newPrompt.name, "argument shape changed in a way not covered by the checks above — defaulting to schema-breaking")];
}

function classifyPromptPair(oldPrompt: LockedPrompt, newPrompt: LockedPrompt): DriftFinding[] {
  const findings: DriftFinding[] = [...classifyPromptTextDrift(oldPrompt, newPrompt)];
  if (oldPrompt.schemaHash !== newPrompt.schemaHash) {
    findings.push(...classifyPromptArgShape(oldPrompt, newPrompt));
  }
  return findings;
}

function classifyPrompts(oldPrompts: LockedPrompt[], newPrompts: LockedPrompt[]): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const oldByName = new Map(oldPrompts.map((p) => [p.name, p]));
  const newByName = new Map(newPrompts.map((p) => [p.name, p]));

  for (const [name, oldPrompt] of oldByName) {
    const newPrompt = newByName.get(name);
    if (newPrompt) findings.push(...classifyPromptPair(oldPrompt, newPrompt));
  }

  const removed = [...oldByName.values()].filter((p) => !newByName.has(p.name));
  const added = [...newByName.values()].filter((p) => !oldByName.has(p.name));
  const { renames, removedLeft, addedLeft } = pairRenames(removed, added);

  for (const [oldPrompt, newPrompt] of renames) {
    findings.push(
      finding("schema-breaking", "prompt", newPrompt.name, `prompt renamed from "${oldPrompt.name}" (identical argument structure)`),
    );
    findings.push(...classifyPromptTextDrift(oldPrompt, newPrompt));
  }
  for (const p of removedLeft) findings.push(finding("schema-breaking", "prompt", p.name, "prompt removed"));
  for (const p of addedLeft) findings.push(finding("schema-additive", "prompt", p.name, "new prompt"));

  return findings;
}

/** Compares two captures of the same server id and returns every drift finding — empty means no drift at all. */
export function classifyServerDrift(oldServer: LockedServer, newServer: LockedServer): DriftFinding[] {
  const findings: DriftFinding[] = [
    ...classifyTools(oldServer.tools, newServer.tools),
    ...classifyPrompts(oldServer.prompts, newServer.prompts),
  ];

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
