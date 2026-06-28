import test from "node:test";
import assert from "node:assert/strict";
import { appendEvent, normalizeEvent, summarizePayload } from "./server.js";

test("normalizes visualizer events", () => {
  const event = normalizeEvent({
    type: "api_request",
    source: "restored-src",
    timestamp: "2026-06-27T00:00:00.000Z",
    handleId: "handle-1",
    querySource: "agent:reviewer",
    payload: {
      model: "claude-test",
      metadata: {
        user_id: JSON.stringify({ session_id: "session-1" })
      }
    }
  });
  assert.equal(event.type, "api_request");
  assert.equal(event.source, "restored-src");
  assert.equal(event.sessionId, "session-1");
  assert.equal(event.agentId, "reviewer");
  assert.equal(event.handleId, "handle-1");
  assert.equal(event.payload.model, "claude-test");
  assert.ok(event.id);
});

test("summarizes request payload shape", () => {
  const summary = summarizePayload({
    model: "claude-test",
    max_tokens: 123,
    system: [{ type: "text" }],
    messages: [{ role: "user", content: [] }],
    tools: [{ name: "Read" }],
    betas: ["beta"],
    thinking: { type: "enabled" },
    output_config: { format: { type: "json_schema" } },
    metadata: { user_id: "u" }
  });
  assert.deepEqual(summary, {
    model: "claude-test",
    maxTokens: 123,
    stream: undefined,
    systemBlocks: 1,
    messages: 1,
    tools: 1,
    betas: 1,
    thinking: "enabled",
    outputConfig: true,
    metadataKeys: 1
  });
});

test("appends events with a summary", () => {
  const event = appendEvent({
    type: "api_request",
    payload: { model: "claude-test", messages: [], system: [], tools: [] }
  });
  assert.equal(event.summary.model, "claude-test");
});
