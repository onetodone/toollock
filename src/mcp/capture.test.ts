import assert from "node:assert/strict";
import { test } from "node:test";
import { capture } from "./capture.js";
import { connect, killTransport, npxServerSpec } from "./connect.js";

// Real servers, no mocks — matching this project's own "verified against
// real servers, not assumed" approach (Phase 0). Both were confirmed
// clean on stdio in Phase 0 spike 1.

test("capture: server without prompts capability", { timeout: 60_000 }, async () => {
  const server = await connect(npxServerSpec("@modelcontextprotocol/server-memory"));
  try {
    assert.equal(server.capabilities.prompts, undefined);

    const result = await capture(server);

    assert.ok(result.tools.length > 0, "expected at least one tool");
    assert.equal(result.prompts, null, "server has no prompts capability");
    assert.equal(result.wireTools.crossCheckOk, true, result.wireTools.reason ?? "");
    assert.ok(Array.isArray(result.wireTools.raw));
    assert.equal(result.wireTools.raw?.length, result.tools.length);
  } finally {
    killTransport(server.transport);
  }
});

test("capture: server with prompts capability", { timeout: 60_000 }, async () => {
  const server = await connect(npxServerSpec("@modelcontextprotocol/server-everything"));
  try {
    assert.ok(server.capabilities.prompts, "expected server to declare prompts capability");

    const result = await capture(server);

    assert.ok(result.tools.length > 0, "expected at least one tool");
    assert.ok(Array.isArray(result.prompts), "expected a prompts array, not null");
    assert.ok((result.prompts?.length ?? 0) > 0, "expected at least one prompt");
    assert.equal(result.wireTools.crossCheckOk, true, result.wireTools.reason ?? "");
  } finally {
    killTransport(server.transport);
  }
});
