import type { LockedServer, LockedTool } from "./schema.js";

/**
 * `toollock budget` — the context-tax table. Built from `wireTokens`,
 * not `canonicalTokens`: what a real MCP client's context window is
 * actually billed for on every call is the raw wire-format tool array
 * (DECISIONS.md #5/#6), so that is the number the pitch has to be honest
 * about. `canonicalTokens` is shown alongside for contrast — a large gap
 * between the two is the `schemaReuseRatio` story (a server shipping its
 * shared `$defs` dictionary to every tool).
 *
 * Pure formatting over a `LockedServer`; the command layer decides
 * whether that server came from a fresh capture (`toollock budget
 * <pkg>`) or from `tools.lock` (`toollock budget` with no args).
 */

const NAME_COL_MAX = 44;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function truncate(name: string, width: number): string {
  return name.length <= width ? name : `${name.slice(0, width - 1)}…`;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** What a caller pays per tool: `wireTokens` when the wire tee was trustworthy, else the canonical count as a labelled fallback. */
function payFor(tool: LockedTool): number {
  return tool.wireTokens ?? tool.canonicalTokens;
}

interface Row {
  label: string;
  cells: string[];
  /** A horizontal rule is drawn immediately before this row. */
  ruleBefore?: boolean;
}

interface Column {
  header: string;
  cell: (tool: LockedTool) => string;
  /** Value for the `(framing)` pseudo-row; `"–"` when the column doesn't apply to it. */
  frame: string;
  total: string;
}

function renderTable(tools: LockedTool[], columns: Column[], frameRow: boolean): string {
  const rows: Row[] = [
    { label: "TOOL", cells: columns.map((c) => c.header) },
    ...tools.map((t) => ({ label: truncate(t.name, NAME_COL_MAX), cells: columns.map((c) => c.cell(t)) })),
  ];
  if (frameRow) rows.push({ label: "(framing)", cells: columns.map((c) => c.frame), ruleBefore: true });
  rows.push({ label: "TOTAL", cells: columns.map((c) => c.total), ruleBefore: !frameRow });

  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  const colWidths = columns.map((_, i) => Math.max(...rows.map((r) => r.cells[i].length)));
  const fullWidth = 2 + labelWidth + colWidths.reduce((a, w) => a + 2 + w, 0);

  let out = "";
  for (const row of rows) {
    if (row.ruleBefore) out += `  ${"─".repeat(fullWidth - 2)}\n`;
    out += `  ${padRight(row.label, labelWidth)}${row.cells.map((cell, i) => `  ${padLeft(cell, colWidths[i])}`).join("")}\n`;
  }
  return out;
}

export function formatBudget(server: LockedServer): string {
  const tools = [...server.tools].sort((a, b) => payFor(b) - payFor(a) || a.name.localeCompare(b.name));

  const versionBits = [
    server.serverName ? `${server.serverName}${server.serverVersion ? ` v${server.serverVersion}` : ""}` : null,
    server.observedVersion ? `observed npm ${server.observedVersion}` : null,
  ].filter(Boolean);

  let out = `${server.id}\n`;
  if (versionBits.length > 0) out += `${versionBits.join(" · ")}\n`;

  if (tools.length === 0) {
    out += `${server.tools.length} tools, ${server.prompts.length} prompts — nothing to budget.\n`;
    return out;
  }

  const toolWord = server.tools.length === 1 ? "tool" : "tools";
  const promptWord = server.prompts.length === 1 ? "prompt" : "prompts";
  const wireAvailable = server.wireTokens !== null && server.contextBudget !== null;
  const sumCanonical = tools.reduce((a, t) => a + t.canonicalTokens, 0);
  const frameRow = server.frameTokens !== null && server.frameTokens !== 0;

  if (wireAvailable) {
    out += `${server.tools.length} ${toolWord}, ${server.prompts.length} ${promptWord} · ${fmt(server.contextBudget ?? 0)} context tokens (billed on every call)\n\n`;
    out += renderTable(
      tools,
      [
        { header: "WIRE", cell: (t) => fmt(payFor(t)), frame: fmt(server.frameTokens ?? 0), total: fmt(server.contextBudget ?? 0) },
        { header: "SHARE", cell: (t) => pct(payFor(t), server.contextBudget ?? 0), frame: pct(server.frameTokens ?? 0, server.contextBudget ?? 0), total: "100.0%" },
        { header: "CANONICAL", cell: (t) => fmt(t.canonicalTokens), frame: "–", total: fmt(sumCanonical) },
      ],
      frameRow,
    );
  } else {
    out += `${server.tools.length} ${toolWord}, ${server.prompts.length} ${promptWord} · ${fmt(sumCanonical)} canonical tokens\n`;
    out += `  wire-token measurement unavailable (tee/Client cross-check failed) — showing canonicalTokens only, DECISIONS.md #5.\n\n`;
    out += renderTable(
      tools,
      [
        { header: "CANONICAL", cell: (t) => fmt(t.canonicalTokens), frame: "–", total: fmt(sumCanonical) },
        { header: "SHARE", cell: (t) => pct(t.canonicalTokens, sumCanonical), frame: "–", total: "100.0%" },
      ],
      false,
    );
  }

  if (server.refCount > 0 && server.schemaReuseRatio !== null) {
    out += `\n  schemaReuseRatio ${server.schemaReuseRatio.toFixed(2)} · ${fmt(server.refCount)} $ref occurrences — the wire\n`;
    out += `  cost is ${server.schemaReuseRatio.toFixed(1)}x the hash-coupled schema size: this server ships its shared\n`;
    out += `  $defs to every tool regardless of what each one references (DECISIONS.md #5).\n`;
  }

  return out;
}

/** No-arg `toollock budget`: one table per locked server, then a roll-up across all of them. */
export function formatBudgetForAll(servers: LockedServer[]): string {
  if (servers.length === 0) {
    return 'tools.lock has no servers. Run "toollock init <pkg>" first, or "toollock budget <pkg>" for an ad-hoc estimate.\n';
  }

  const ranked = [...servers].sort((a, b) => (b.contextBudget ?? 0) - (a.contextBudget ?? 0) || a.id.localeCompare(b.id));
  let out = ranked.map(formatBudget).join("\n");

  if (ranked.length > 1) {
    const totalBudget = ranked.reduce((a, s) => a + (s.contextBudget ?? 0), 0);
    const totalTools = ranked.reduce((a, s) => a + s.tools.length, 0);
    const rows = [
      { label: "SERVER", tools: "TOOLS", tokens: "CONTEXT TOKENS" },
      ...ranked.map((s) => ({ label: truncate(s.id, 48), tools: fmt(s.tools.length), tokens: s.contextBudget === null ? "n/a" : fmt(s.contextBudget) })),
      { label: "TOTAL", tools: fmt(totalTools), tokens: fmt(totalBudget) },
    ];
    const lw = Math.max(...rows.map((r) => r.label.length));
    const tw = Math.max(...rows.map((r) => r.tools.length));
    const kw = Math.max(...rows.map((r) => r.tokens.length));

    out += `\n\nALL LOCKED SERVERS\n\n`;
    rows.forEach((r, i) => {
      if (i === rows.length - 1) out += `  ${"─".repeat(lw + 2 + tw + 2 + kw)}\n`;
      out += `  ${padRight(r.label, lw)}  ${padLeft(r.tools, tw)}  ${padLeft(r.tokens, kw)}\n`;
    });
  }

  return out;
}
