import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
} from "@oh-my-pi/pi-agent-core/compaction";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Pins fix #1 of the compaction effort-override bug. Before this fix,
// `generateHandoff` (and the three other compaction summarizers) hardcoded
// `reasoning: Effort.High`, ignoring the user's `/model` thinking selection.
// On a model with `compat.supportsReasoningEffort: false` (xai-oauth/grok-build),
// this produced "Compaction failed: Thinking effort high is not supported by
// xai-oauth/grok-build" — but the underlying defect (silent user-intent
// override) was present on every model, just invisible because most models
// silently accept the override.
//
// `resolveCompactionEffort` is the per-call resolver:
// - `Off`              → `undefined` (user said no thinking; honored)
// - `undefined`/`Inherit` → `Effort.High` default → clamped per model
// - explicit Effort    → respect it → clamped per model
//
// `generateHandoff` is chosen as the test vehicle because it issues exactly
// one LLM call per invocation (simpler to assert than `compact()` which fans
// out into summary + short-summary + turn-prefix). The contract under test
// (`resolveCompactionEffort`) is shared across all four call sites in
// `packages/agent/src/compaction/compaction.ts`.

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getAnthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

function getGrokBuildModel(): Model {
	const model = getBundledModel("xai-oauth", "grok-build");
	if (!model) throw new Error("Expected built-in xai-oauth/grok-build to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "start work", timestamp: 1 },
	createAssistantMessage([{ type: "text", text: "started" }]),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction thinking-level resolution (regression)", () => {
	test("undefined thinkingLevel on Anthropic → reasoning=high (historical default preserved)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			// thinkingLevel omitted — must default to high
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.High);
	});

	test("ThinkingLevel.Off on Anthropic → reasoning=undefined (user intent honored)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Off,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		// Codex-caught defect: Off MUST NOT be silently coerced to High.
		expect(call[2]?.reasoning).toBeUndefined();
	});

	test("ThinkingLevel.Low on Anthropic → reasoning=low (explicit user choice)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Low,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.Low);
	});

	test("ThinkingLevel.High on xai-oauth/grok-build → reasoning=undefined (clamp)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getGrokBuildModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.High,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		// clampThinkingLevelForModel(grokBuild, High) === undefined because
		// supportsReasoningEffort: false ⇒ getSupportedEfforts returns [] ⇒
		// no clamp target. The omitReasoningEffort gate at the wire layer is
		// the actual strip; this just ensures the upstream throw doesn't fire.
		expect(call[2]?.reasoning).toBeUndefined();
	});

	test("ThinkingLevel.Inherit on Anthropic → reasoning=high (Inherit folds to historical default)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "handoff" }]));
		await generateHandoff(messages, getAnthropicModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			thinkingLevel: ThinkingLevel.Inherit,
		});
		const call = spy.mock.calls[0];
		if (!call) throw new Error("expected completeSimple call");
		expect(call[2]?.reasoning).toBe(ai.Effort.High);
	});
});

// ============================================================================
// compact() end-to-end regression coverage.
//
// The handoff tests above were the test vehicle e07b47ee4 used because handoff
// issues exactly one LLM call. They prove `resolveCompactionEffort` works at
// each call site in isolation. They do NOT prove `compact()` forwards
// `options.thinkingLevel` into the fan-out struct (`summaryOptions`) that
// reaches generateSummary / generateTurnPrefixSummary / generateShortSummary.
// That gap is what dropped the field at compaction.ts:963 and 1056 — every
// downstream summarizer saw `undefined` and fell back to Effort.High.
//
// These tests drive compact() with `isSplitTurn: true` so all three
// summarizers fire, then assert the captured `reasoning` on each
// `completeSimple` call. The contract is: every fan-out call receives the
// SAME resolved effort as a single handoff call would.
// ============================================================================

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			makeUserMessage("history msg"),
			createAssistantMessage([{ type: "text", text: "history reply" }]),
		],
		turnPrefixMessages: [makeUserMessage("turn prefix msg")],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		...overrides,
	};
}

describe("compact() propagates thinkingLevel to all three summarizers (regression)", () => {
	test("ThinkingLevel.Off → every fan-out call gets reasoning=undefined", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getAnthropicModel(), "test-key", undefined, undefined, {
			thinkingLevel: ThinkingLevel.Off,
		});

		// Split-turn preparation fans out into history + turn-prefix + short.
		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			expect(opts?.reasoning).toBeUndefined();
		}
	});

	test("ThinkingLevel.Low → every fan-out call gets reasoning=low", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getAnthropicModel(), "test-key", undefined, undefined, {
			thinkingLevel: ThinkingLevel.Low,
		});

		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			expect(opts?.reasoning).toBe(ai.Effort.Low);
		}
	});

	test("undefined thinkingLevel → every fan-out call still gets reasoning=high (historical default)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getAnthropicModel(), "test-key", undefined, undefined);

		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			expect(opts?.reasoning).toBe(ai.Effort.High);
		}
	});

	test("xai-oauth/grok-build + ThinkingLevel.High → every fan-out call gets reasoning=undefined (clamp)", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage([{ type: "text", text: "summary" }]));

		await compact(makePreparation(), getGrokBuildModel(), "test-key", undefined, undefined, {
			thinkingLevel: ThinkingLevel.High,
		});

		expect(spy).toHaveBeenCalledTimes(3);
		for (const [, , opts] of spy.mock.calls) {
			// Without the propagation fix at compaction.ts:971 / 1061, the
			// three summarizers would see undefined → fall back to High and
			// trip requireSupportedEffort. The fix + the wire-side strip in
			// fix #2 keep this clean.
			expect(opts?.reasoning).toBeUndefined();
		}
	});
});
