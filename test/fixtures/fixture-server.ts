/**
 * A minimal, controllable stdio MCP server for Phase 3's end-to-end
 * drift test. Real npm packages can't be hand-mutated between two
 * captures in a reproducible test — this can, via env vars, without
 * touching npx/the network at all. Spawned directly via `node`, never
 * `npx` — there is no npm package here.
 *
 * FIXTURE_DESCRIPTION / FIXTURE_LIMIT_PARAM / FIXTURE_TOOL_NAME control
 * the one tool's shape, matching exactly the drift scenarios Phase 3's
 * DoD and the Phase 4 classifier tests exercise: a description-only
 * change (prompt-drift), a new optional property (schema-additive), and
 * a rename that leaves `inputSchema` untouched (schema-breaking, detected
 * as a rename rather than remove+add).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const description = process.env.FIXTURE_DESCRIPTION ?? "Echoes the input string";
const includeLimitParam = process.env.FIXTURE_LIMIT_PARAM === "true";
const toolName = process.env.FIXTURE_TOOL_NAME ?? "echo";

const server = new McpServer({ name: "toollock-fixture-server", version: "1.0.0" });

// Two concrete calls rather than one call with a runtime-conditional
// inputSchema — registerTool's generics can't infer a single callback
// shape from a union of two different Zod shapes at the call site.
if (includeLimitParam) {
  server.registerTool(
    toolName,
    { description, inputSchema: { message: z.string().describe("Message to echo"), limit: z.number().optional().describe("Max length") } },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
} else {
  server.registerTool(
    toolName,
    { description, inputSchema: { message: z.string().describe("Message to echo") } },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
}

await server.connect(new StdioServerTransport());
