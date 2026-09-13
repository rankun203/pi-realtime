import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUpdateResponseEvent, backendUpdateItemEvent } from "../../.pi/extensions/pi-realtime/providers/openai/responses";
import { providerInteractionFor } from "../../.pi/extensions/pi-realtime/domain/interaction-modes";
import { aggregateUsage, emptyUsageBreakdown, formatUsageCost, estimateUsageCost } from "../../.pi/extensions/pi-realtime/usage";
import { statusText } from "../../.pi/extensions/pi-realtime/view";
import { createService } from "../../.pi/extensions/pi-realtime/service";

const update = (text: string, index: number): any => ({ text, mode: "request_spoken_response", updateKind: "text", source: "pi_model_tool", rendering: { mode: "verbatim", envelope: "json_task" }, chunk: { index, count: 2, originalTextLength: 1200 } });

test("each agent speech chunk has only its own explicit input, never shared conversation context", () => {
 const chunks = [update("First chunk unique content.", 1), update("Second chunk separate content.", 2)];
 for (const [i, chunk] of chunks.entries()) {
  const event: any = backendUpdateResponseEvent(chunk, providerInteractionFor("agent"), ["audio"]);
  assert.equal(event.response.conversation, "none");
  assert.equal(event.response.input.length, 1);
  assert.equal(JSON.parse(event.response.input[0].content[0].text).text, chunk.text);
  assert.ok(!JSON.stringify(event.response).includes(chunks[1 - i].text));
  assert.deepEqual(event.response.tools, []);
  assert.equal(event.response.tool_choice, "none");
  assert.deepEqual(event.response.output_modalities, ["audio"]);
  assert.equal((backendUpdateItemEvent(chunk) as any).type, "conversation.item.create");
 }
 // The user's native agent turn retains tools and conversation semantics.
 assert.equal(providerInteractionFor("agent").toolChoice, "auto");
 assert.equal(providerInteractionFor("agent").transcriptHandling.response, "native");
 const single = { ...chunks[0], chunk: undefined };
 assert.equal((backendUpdateResponseEvent(single, providerInteractionFor("agent"), ["audio"]) as any).response.conversation, undefined);
 assert.equal((backendUpdateResponseEvent(single, providerInteractionFor("eco"), ["audio"]) as any).response.conversation, "none");
});

test("Azure Global Standard mini pricing and historical repricing", () => {
 const observation: any = { provider: "openai", model: "gpt-realtime-2.1-mini", source: "response", input: { ...emptyUsageBreakdown(), textTokens: 1_000_000, cachedTextTokens: 500_000 }, output: { ...emptyUsageBreakdown(), textTokens: 1_000_000 }, at: 1, totalTokens: 2_000_000, estimatedCostUsd: 0, costExcludedReason: "No local pricing table for model gpt-realtime-2.1-mini." };
 assert.equal(estimateUsageCost(observation), 2.73);
 const summary = aggregateUsage([observation]);
 assert.equal(summary.estimatedCostUsd, 2.73);
 assert.equal(summary.excludedCostCount, 0);
 assert.equal(observation.estimatedCostUsd, 0); // Immutable historical evidence.
 assert.equal(estimateUsageCost({ ...observation, input: { ...emptyUsageBreakdown(), audioTokens: 1_000_000, cachedAudioTokens: 1_000_000 }, output: { ...emptyUsageBreakdown(), audioTokens: 1_000_000 } }), 20.3);
});

const row = (unknown: boolean): any => ({ at: 1, providerSessionId: "voice", source: "response", totalTokens: 100, input: emptyUsageBreakdown(), output: emptyUsageBreakdown(), estimatedCostUsd: unknown ? 0 : 0.012, costExcludedReason: unknown ? "No pricing for deployment" : undefined });

test("realtime footer never reports unknown pricing as zero dollars", () => {
 assert.equal(formatUsageCost(aggregateUsage([row(true)])), "cost unknown");
 assert.match(formatUsageCost(aggregateUsage([row(false)])), /\$0\.012000 est\./);
 assert.match(formatUsageCost(aggregateUsage([row(false), row(true)])), /partial/);
 const state: any = { sessions: new Map(), usage: [row(true)], usageResets: [] };
 assert.equal(statusText(state), "pi-realtime: idle · 100 voice tokens · cost unknown");
 state.usageResets = [{ at: 2 }];
 assert.equal(statusText(state), "pi-realtime: idle");
});

test("provider usage refreshes realtime UI through callback, stored as extension events", async () => {
 const events: any[] = [];
 let refreshed = 0;
 const service: any = createService({ append(event: any) { events.push(event); } } as any, {} as any, () => { refreshed++; });
 service.traceProviderEvent = () => {};
 service.notifyProviderEvent = () => {};
 await service.handleProviderEvent({ type: "usage", providerSessionId: "voice", observation: row(true) });
 assert.equal(refreshed, 1);
 assert.equal(events.length, 2);
});
