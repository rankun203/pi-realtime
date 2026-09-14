import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usageFromOpenAIResponseDone } from "../../.pi/extensions/pi-realtime/providers/openai/usage";
import {
	backendUpdateResponseEvent,
	backendUpdateItemEvent,
} from "../../.pi/extensions/pi-realtime/providers/openai/responses";
import { providerInteractionFor } from "../../.pi/extensions/pi-realtime/domain/interaction-modes";
import {
	aggregateUsage,
	emptyUsageBreakdown,
	formatUsageCost,
	estimateUsageCost,
} from "../../.pi/extensions/pi-realtime/usage";
import { statusText } from "../../.pi/extensions/pi-realtime/view";
import { createService } from "../../.pi/extensions/pi-realtime/service";

const update = (text: string, index: number): any => ({
	text,
	mode: "request_spoken_response",
	updateKind: "text",
	source: "pi_model_tool",
	rendering: { mode: "verbatim", envelope: "json_task" },
	chunk: { index, count: 2, originalTextLength: 1200 },
});

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
	assert.equal(
		(backendUpdateResponseEvent(single, providerInteractionFor("agent"), ["audio"]) as any).response.conversation,
		undefined,
	);
	assert.equal(
		(backendUpdateResponseEvent(single, providerInteractionFor("eco"), ["audio"]) as any).response.conversation,
		"none",
	);
});

test("Azure Global Standard mini pricing and historical repricing", () => {
	const observation: any = {
		provider: "openai",
		model: "gpt-realtime-2.1-mini",
		source: "response",
		input: { ...emptyUsageBreakdown(), textTokens: 1_000_000, cachedTextTokens: 500_000 },
		output: { ...emptyUsageBreakdown(), textTokens: 1_000_000 },
		at: 1,
		totalTokens: 2_000_000,
		estimatedCostUsd: 0,
		costExcludedReason: "No local pricing table for model gpt-realtime-2.1-mini.",
	};
	assert.equal(estimateUsageCost(observation), 2.73);
	const summary = aggregateUsage([observation]);
	assert.equal(summary.estimatedCostUsd, 2.73);
	assert.equal(summary.excludedCostCount, 0);
	assert.equal(observation.estimatedCostUsd, 0); // Immutable historical evidence.
	assert.equal(
		estimateUsageCost({
			...observation,
			input: { ...emptyUsageBreakdown(), audioTokens: 1_000_000, cachedAudioTokens: 1_000_000 },
			output: { ...emptyUsageBreakdown(), audioTokens: 1_000_000 },
		}),
		20.3,
	);
});

test("2.1 estimates match all eight published Azure Global Standard meters", () => {
	const evidence = JSON.parse(readFileSync(join(__dirname, "azure-realtime-2.1-pricing.json"), "utf8"));
	assert.equal(evidence.meters.length, 8);
	for (const meter of evidence.meters) {
		assert.equal(meter.currencyCode, "USD");
		assert.equal(meter.unitOfMeasure, "1M");
		const match = /^gpt-realtime-2.1 (Text|Audio|Image) (inp|cd inp|opt) Gl 1M Tokens$/.exec(meter.meterName)!;
		assert.ok(match);
		const modality = match[1].toLowerCase();
		const input: any = emptyUsageBreakdown(),
			output: any = emptyUsageBreakdown();
		(match[2] === "opt" ? output : input)[`${modality}Tokens`] = 1_000_000;
		if (match[2] === "cd inp") input[`cached${match[1]}Tokens`] = 1_000_000;
		assert.equal(
			estimateUsageCost({ provider: "openai", model: "gpt-realtime-2.1", source: "response", input, output }),
			meter.retailPrice,
		);
	}
});

const azureResponse = (): any => ({
	response: {
		id: "pricing-fixture",
		usage: {
			input_tokens: 3500,
			output_tokens: 300,
			total_tokens: 3800,
			input_token_details: {
				text_tokens: 1000,
				audio_tokens: 2000,
				image_tokens: 500,
				cached_tokens: 2200,
				cached_tokens_details: { text_tokens: 600, audio_tokens: 1500, image_tokens: 100 },
			},
			output_token_details: { text_tokens: 100, audio_tokens: 200, reasoning_tokens: 50 },
		},
	},
});
const normalizeAzure = (event: any) =>
	usageFromOpenAIResponseDone(event, { providerSessionId: "voice", model: "gpt-realtime-2.1", at: 1 })!;

test("2.1 pricing uses returned modalities and cache reads without double counting; old unknown observations reprice", () => {
	const observation = normalizeAzure(azureResponse());
	assert.equal(observation.costExcludedReason, undefined);
	assert.ok(Math.abs(observation.estimatedCostUsd - 0.03569) < 1e-12);
	assert.equal(formatUsageCost(aggregateUsage([observation])), "$0.0357 (api)");
	const old = {
		...observation,
		estimatedCostUsd: 0,
		costExcludedReason: "No local pricing table for model gpt-realtime-2.1.",
	};
	assert.ok(Math.abs(aggregateUsage([old]).estimatedCostUsd - 0.03569) < 1e-12);
	assert.equal(old.estimatedCostUsd, 0);
});

test("missing or inconsistent returned usage is unknown, never a falsely precise zero", () => {
	for (const change of [
		(event: any) => {
			delete event.response.usage.input_token_details.cached_tokens_details;
		},
		(event: any) => {
			delete event.response.usage.output_token_details;
		},
		(event: any) => {
			event.response.usage.total_tokens = 4000;
		},
		(event: any) => {
			event.response.usage.input_token_details.cached_tokens_details.audio_tokens = 2500;
		},
	]) {
		const event = azureResponse();
		change(event);
		const observation = normalizeAzure(event);
		assert.match(observation.costExcludedReason!, /Incomplete or inconsistent/);
		assert.equal(formatUsageCost(aggregateUsage([observation])), "cost unknown");
		assert.match(formatUsageCost(aggregateUsage([observation, normalizeAzure(azureResponse())])), /partial/);
	}
});

const row = (unknown: boolean): any => ({
	at: 1,
	providerSessionId: "voice",
	source: "response",
	totalTokens: 100,
	input: emptyUsageBreakdown(),
	output: emptyUsageBreakdown(),
	estimatedCostUsd: unknown ? 0 : 0.012,
	costExcludedReason: unknown ? "No pricing for deployment" : undefined,
});

test("realtime footer never reports unknown pricing as zero dollars", () => {
	assert.equal(formatUsageCost(aggregateUsage([row(true)])), "cost unknown");
	assert.match(formatUsageCost(aggregateUsage([row(false)])), /\$0\.0120 \(api\)/);
	assert.match(formatUsageCost(aggregateUsage([row(false), row(true)])), /partial/);
	const state: any = {
		sessions: new Map([["voice", { status: "active", model: "test-model" }]]),
		usage: [row(true)],
		usageResets: [],
	};
	assert.equal(statusText(state), "pi-realtime: ↑0 ↓0 · cost unknown · test-model");
	state.usageResets = [{ at: 2 }];
	assert.equal(statusText(state), "pi-realtime: 1 active · test-model");
});

test("voice cost display rounds to four decimals without changing accounting precision", () => {
	const summary = aggregateUsage([{ ...row(false), estimatedCostUsd: 0.002677 }]);
	assert.equal(formatUsageCost(summary), "$0.0027 (api)");
	assert.equal(summary.estimatedCostUsd, 0.002677);
});

test("provider usage refreshes realtime UI through callback, stored as extension events", async () => {
	const events: any[] = [];
	let refreshed = 0;
	const service: any = createService(
		{
			append(event: any) {
				events.push(event);
			},
		} as any,
		{} as any,
		() => {
			refreshed++;
		},
	);
	service.traceProviderEvent = () => {};
	service.notifyProviderEvent = () => {};
	await service.handleProviderEvent({ type: "usage", providerSessionId: "voice", observation: row(true) });
	assert.equal(refreshed, 1);
	assert.equal(events.length, 2);
});
