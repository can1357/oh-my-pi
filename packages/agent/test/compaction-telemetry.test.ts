/**
 * Tests for OpenTelemetry instrumentation around oneshot LLM calls:
 * compaction summaries, handoff document, branch summary.
 *
 * Uses a per-test InMemorySpanExporter and explicit tracer. Spies on
 * `completeSimple` to avoid real HTTP traffic
 * while exercising the chat-span lifecycle (`startChatSpan` →
 * `runInActiveSpan` → `finishChatSpan` / `failChatSpan`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateBranchSummary,
	generateHandoff,
	generateSummary,
} from "@oh-my-pi/pi-agent-core/compaction";
import {
	type AgentTelemetryConfig,
	GenAIAttr,
	GenAIOperation,
	PiGenAIAttr,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core/telemetry";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
});

afterEach(async () => {
	exporter.reset();
	await provider.shutdown();
	vi.restoreAllMocks();
});

function makeTelemetryConfig(): AgentTelemetryConfig {
	return { conversationId: "conv-compaction", tracer: provider.getTracer("compaction-telemetry-test") };
}

function makeUsage(input = 120, output = 80, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(text: string, usage: Usage = makeUsage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function chatSpans(spans: ReadableSpan[]): ReadableSpan[] {
	return spans.filter(s => s.attributes[GenAIAttr.OperationName] === GenAIOperation.Chat);
}

function spansByOneshotKind(spans: ReadableSpan[], kind: string): ReadableSpan[] {
	return spans.filter(s => s.attributes[PiGenAIAttr.OneshotKind] === kind);
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	const messagesToSummarize: AgentMessage[] = [makeUserMessage("Hello"), makeAssistantMessage("Hi back")];
	const recentMessages: AgentMessage[] = [makeUserMessage("Next question")];
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize,
		turnPrefixMessages: [],
		recentMessages,
		isSplitTurn: false,
		tokensBefore: 12345,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEnabled: false },
		...overrides,
	};
}

describe("compaction oneshot telemetry", () => {
	it("tags compact() chat spans with compaction_summary + compaction_short_summary", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(makeAssistantMessage("history summary text", makeUsage(200, 90, 10, 5)))
			.mockResolvedValueOnce(makeAssistantMessage("short summary text"));

		const telemetry = resolveTelemetry(makeTelemetryConfig(), "session-1");
		await compact(makePreparation(), MODEL, "test-api-key", undefined, undefined, { telemetry });

		expect(spy).toHaveBeenCalledTimes(2);
		const chats = chatSpans(exporter.getFinishedSpans());
		expect(chats).toHaveLength(2);

		const historySpan = spansByOneshotKind(chats, "compaction_summary")[0];
		const shortSpan = spansByOneshotKind(chats, "compaction_short_summary")[0];
		expect(historySpan).toBeDefined();
		expect(shortSpan).toBeDefined();
		expect(historySpan?.name).toBe("chat mock-model");
		expect(historySpan?.attributes[GenAIAttr.ConversationId]).toBe("conv-compaction");
		expect(historySpan?.attributes[GenAIAttr.RequestModel]).toBe("mock-model");
		expect(historySpan?.attributes[GenAIAttr.UsageInputTokens]).toBe(215); // input + cacheRead + cacheWrite
		expect(historySpan?.attributes[GenAIAttr.UsageOutputTokens]).toBe(90);
		expect(historySpan?.attributes[PiGenAIAttr.AgentStepNumber]).toBe(-1);
		expect(historySpan?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	it("emits three chat spans for split-turn preparation (history + turn-prefix + short)", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantMessage("ok"));

		const telemetry = resolveTelemetry(makeTelemetryConfig(), "session-split");
		const preparation = makePreparation({
			isSplitTurn: true,
			turnPrefixMessages: [makeUserMessage("Inline mid-turn instruction")],
		});
		await compact(preparation, MODEL, "test-api-key", undefined, undefined, { telemetry });

		expect(spy).toHaveBeenCalledTimes(3);
		const chats = chatSpans(exporter.getFinishedSpans());
		expect(chats).toHaveLength(3);
		expect(spansByOneshotKind(chats, "compaction_summary")).toHaveLength(1);
		expect(spansByOneshotKind(chats, "compaction_turn_prefix")).toHaveLength(1);
		expect(spansByOneshotKind(chats, "compaction_short_summary")).toHaveLength(1);
	});

	it("emits no spans when telemetry is undefined", async () => {
		vi.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(makeAssistantMessage("history"))
			.mockResolvedValueOnce(makeAssistantMessage("short"));

		await compact(makePreparation(), MODEL, "test-api-key", undefined, undefined);

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("records ERROR on the chat span when completeSimple throws", async () => {
		vi.spyOn(ai, "completeSimple").mockRejectedValueOnce(new Error("provider rejected request"));

		const telemetry = resolveTelemetry(makeTelemetryConfig(), "session-fail");
		let caught: unknown;
		try {
			await generateSummary(
				[makeUserMessage("Hi"), makeAssistantMessage("Hi back")],
				MODEL,
				4096,
				"test-api-key",
				undefined,
				undefined,
				undefined,
				{ telemetry },
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe("provider rejected request");

		const chats = chatSpans(exporter.getFinishedSpans());
		expect(chats).toHaveLength(1);
		const span = chats[0];
		expect(span?.attributes[PiGenAIAttr.OneshotKind]).toBe("compaction_summary");
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		// finishChatSpan-only attributes must NOT be set on the failure path.
		expect(span?.attributes[GenAIAttr.ResponseModel]).toBeUndefined();
		expect(span?.attributes[GenAIAttr.UsageInputTokens]).toBeUndefined();
	});
});

describe("handoff oneshot telemetry", () => {
	it("tags generateHandoff with pi.gen_ai.oneshot.kind = handoff and toolChoice = none", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(makeAssistantMessage("## Goal\nContinue"));

		const telemetry = resolveTelemetry(makeTelemetryConfig(), "session-handoff");
		const messages: AgentMessage[] = [makeUserMessage("start"), makeAssistantMessage("starting")];

		const document = await generateHandoff(messages, MODEL, "test-api-key", {
			systemPrompt: ["Live system prompt"],
			tools: [],
			initiatorOverride: "agent",
			telemetry,
		});

		expect(document).toContain("Goal");
		expect(spy).toHaveBeenCalledTimes(1);

		const chats = chatSpans(exporter.getFinishedSpans());
		expect(chats).toHaveLength(1);
		const span = chats[0];
		expect(span?.attributes[PiGenAIAttr.OneshotKind]).toBe("handoff");
		expect(span?.attributes[PiGenAIAttr.RequestToolChoice]).toBe("none");
	});
});

describe("branch summary oneshot telemetry", () => {
	it("tags generateBranchSummary with pi.gen_ai.oneshot.kind = branch_summary", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(makeAssistantMessage("branch summary text", makeUsage(50, 30)));

		const telemetry = resolveTelemetry(makeTelemetryConfig(), "session-branch");
		const entries = [
			{
				type: "message" as const,
				id: "e1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: makeUserMessage("first"),
			},
			{
				type: "message" as const,
				id: "e2",
				parentId: "e1",
				timestamp: new Date().toISOString(),
				message: makeAssistantMessage("response"),
			},
		];

		const result = await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "test-api-key",
			signal: new AbortController().signal,
			telemetry,
		});

		expect(result.summary).toContain("branch summary text");
		expect(spy).toHaveBeenCalledTimes(1);

		const chats = chatSpans(exporter.getFinishedSpans());
		expect(chats).toHaveLength(1);
		const span = chats[0];
		expect(span?.attributes[PiGenAIAttr.OneshotKind]).toBe("branch_summary");
		expect(span?.attributes[GenAIAttr.UsageInputTokens]).toBe(50);
		expect(span?.attributes[GenAIAttr.UsageOutputTokens]).toBe(30);
	});
});
