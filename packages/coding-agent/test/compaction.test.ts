import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionSettings,
	calculateContextTokens,
	compact,
	compactionContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	getLastAssistantUsage,
	hasContextTokenUsage,
	prepareCompaction,
	resolveThresholdTokens,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction/compaction";
import * as ai from "@oh-my-pi/pi-ai";
import { encodeTextSignatureV1 } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model, ProviderPayload, Usage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type {
	CompactionEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { migrateSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { mockFetch } from "./helpers/fetch-mock";
import { e2eApiKey } from "./utilities";

const tokenizer = new Tokenizer();

// ============================================================================
// Test fixtures
// ============================================================================

async function loadLargeSessionEntries(): Promise<SessionEntry[]> {
	const sessionPath = path.join(import.meta.dirname, "fixtures/large-session.jsonl");
	const content = await Bun.file(sessionPath).text();
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createOpenAiAssistantMessage(
	text: string,
	model: Model,
	usage?: Usage,
	encryptedReasoning: string = "encrypted-reasoning",
	providerPayload?: ProviderPayload,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "Reasoning summary",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					encrypted_content: encryptedReasoning,
					summary: [{ type: "summary_text", text: "Reasoning summary" }],
				}),
			},
			{ type: "text", text },
		],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		providerPayload,
		timestamp: Date.now(),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		model: `${provider}/${modelId}`,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});

	it("prefers positive provider context occupancy without accepting an explicit zero", () => {
		const usage = { ...createMockUsage(0, 0, 0, 0), contextTokens: 120_000 };
		expect(calculateContextTokens(usage)).toBe(120_000);
		expect(hasContextTokenUsage(usage)).toBe(true);
		expect(hasContextTokenUsage({ ...usage, contextTokens: 0 })).toBe(false);
	});

	it("preserves total-only provider context without accepting response-only totals", () => {
		const responseOnly = createMockUsage(0, 29, 0, 0);
		expect(hasContextTokenUsage(responseOnly)).toBe(false);
		expect(hasContextTokenUsage({ ...responseOnly, totalTokens: 120_000 })).toBe(true);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		// default mode uses legacy reserve behavior:
		// effective reserve = max(floor(100000 * 0.15), 10000) = 15000, threshold = 85000
		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(86000, 100000, settings)).toBe(true);
		expect(shouldCompact(84000, 100000, settings)).toBe(false);
	});

	it("uses proportional reserve when the DEFAULTED reserve nearly consumes a small window", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			// reserveTokens deliberately unset: provenance, not value equality,
			// is what allows the proportional fallback.
			keepRecentTokens: 20_000,
		};

		// 16,385-token GPT-3.5 windows should keep the same 15% reserve behavior
		// used by smaller windows instead of collapsing the threshold to one token.
		expect(shouldCompact(10_000, 16_385, settings)).toBe(false);
		expect(shouldCompact(13_929, 16_385, settings)).toBe(true);
	});

	it("honors an EXPLICIT reserve equal to the old default on a small window", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
		};

		// The user chose 16,384 on purpose; it must not be mistaken for the
		// defaulted reserve and silently replaced with the proportional one.
		expect(resolveThresholdTokens(16_385, settings)).toBe(1);
		expect(shouldCompact(2, 16_385, settings)).toBe(true);
	});

	it("respects a large valid configured reserve", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 90_000,
			keepRecentTokens: 20_000,
		};

		expect(resolveThresholdTokens(100_000, settings)).toBe(10_000);
		expect(shouldCompact(10_000, 100_000, settings)).toBe(false);
		expect(shouldCompact(10_001, 100_000, settings)).toBe(true);
	});

	it("should use configured threshold percent", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: 90,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(89_000, 100_000, settings)).toBe(false);
		expect(shouldCompact(90_001, 100_000, settings)).toBe(true);
	});

	it("should use legacy reserve behavior when threshold is set to default sentinel", () => {
		const settings: CompactionSettings = {
			enabled: true,
			thresholdPercent: -1,
			reserveTokens: 30_000,
			keepRecentTokens: 20_000,
		};

		// effective reserve = max(15000, 30000) = 30000, threshold = 70000
		expect(shouldCompact(70_000, 100_000, settings)).toBe(false);
		expect(shouldCompact(70_001, 100_000, settings)).toBe(true);
	});

	it("should return false when strategy is off", () => {
		const settings: CompactionSettings = {
			enabled: true,
			strategy: "off",
			thresholdPercent: 1,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(99_000, 100_000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("compactionContextTokens", () => {
	it("floors deflated provider usage by the stored-conversation estimate", () => {
		// A before_provider_request compression extension (e.g. Headroom) shrinks the
		// request, so the provider reports far fewer prompt tokens than the real
		// stored conversation. The compaction decision must use the larger value.
		expect(compactionContextTokens(20_000, 90_000)).toBe(90_000);
	});

	it("keeps provider usage when it already exceeds the local estimate", () => {
		// Without compression the provider count is ground truth and typically >= the
		// cl100k local estimate; the floor must never lower it.
		expect(compactionContextTokens(85_000, 80_000)).toBe(85_000);
	});

	it("clamps negative inputs to zero", () => {
		expect(compactionContextTokens(-5, -10)).toBe(0);
		expect(compactionContextTokens(-5, 100)).toBe(100);
	});

	it("lets a deflated provider count still trigger compaction via the floor", () => {
		const settings: CompactionSettings = { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 };
		// Post-compression provider count is under threshold — raw, it would NOT compact.
		expect(shouldCompact(20_000, 100_000, settings)).toBe(false);
		// Floored by the real stored-conversation estimate (95k) it correctly compacts.
		expect(shouldCompact(compactionContextTokens(20_000, 95_000), 100_000, settings)).toBe(true);
	});
});

describe("Tokenizer.countMessage excludeEncryptedReasoning (compaction floor)", () => {
	it("drops encrypted reasoning from the floor estimate but counts it by default", () => {
		const blob = "blob ".repeat(8_000); // large opaque encrypted-reasoning payload
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "short", thinkingSignature: blob },
				{ type: "text", text: "done" },
			],
			usage: createMockUsage(0, 0),
			stopReason: "stop",
			timestamp: Date.now(),
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.5",
		};
		const withBlob = tokenizer.countMessage(msg);
		const flooredEstimate = tokenizer.countMessage(msg, { excludeEncryptedReasoning: true });
		// Default counts the blob (providers bill it on replay); the floor excludes it,
		// so a thinking-heavy turn can't falsely trip compaction on local byte size.
		expect(withBlob).toBeGreaterThan(flooredEstimate + 1_000);
		expect(flooredEstimate).toBeLessThan(50); // just "short" + "done"
	});

	it("still counts tool-result text (the content on-wire compression shrinks)", () => {
		const big = "alpha beta gamma ".repeat(2_000);
		const toolMsg = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: big }],
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		// Even with the floor option, tool-result content is fully counted — that is
		// exactly what a before_provider_request compressor (e.g. Headroom) shrinks,
		// so the floor must still see its real size.
		expect(tokenizer.countMessage(toolMsg, { excludeEncryptedReasoning: true })).toBeGreaterThan(1_000);
	});
});

describe("bigint tool arguments", () => {
	it("preserves exact values through local compaction estimation and summary rendering", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const toolCallMessage: AssistantMessage = {
			...createAssistantMessage("", createMockUsage(1_000, 100)),
			content: [
				{
					type: "toolCall",
					id: "call_bigint",
					name: "lookup",
					arguments: { rowId: 9_007_199_254_740_993n },
				},
			],
			stopReason: "toolUse",
		};
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Look up the row")),
			createMessageEntry(toolCallMessage),
			createMessageEntry({
				role: "toolResult",
				toolCallId: "call_bigint",
				toolName: "lookup",
				content: [{ type: "text", text: "found" }],
				isError: false,
				timestamp: Date.now(),
			}),
			createMessageEntry(createUserMessage("Continue")),
			createMessageEntry(createAssistantMessage("Done", createMockUsage(2_000, 100))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: false,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const completeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		const result = await compact(preparation, model, "test-api-key");

		let renderedPrompts = "";
		for (const call of completeSpy.mock.calls) {
			for (const message of call[1].messages) {
				if (typeof message.content === "string") {
					renderedPrompts += message.content;
					continue;
				}
				for (const block of message.content) {
					if (block.type === "text") renderedPrompts += block.text;
				}
			}
		}
		expect(renderedPrompts).toContain('"9007199254740993"');
		expect(result.summary).toContain("summary");
	});
});

describe("remote compaction setting", () => {
	it("forwards an explicit initiator override to local summarization requests", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 2000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 5000, 0))),
			createMessageEntry(createUserMessage("Turn 3")),
			createMessageEntry(createAssistantMessage("Answer 3", createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: false,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy
			.mockResolvedValueOnce(createAssistantMessage("History summary"))
			.mockResolvedValueOnce(createAssistantMessage("Turn prefix summary"))
			.mockResolvedValueOnce(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key", undefined, undefined, {
			initiatorOverride: "agent",
		});

		expect(completeSimpleSpy).toHaveBeenCalledTimes(3);
		for (const call of completeSimpleSpy.mock.calls) {
			const options = call[2] as { initiatorOverride?: string } | undefined;
			expect(options?.initiatorOverride).toBe("agent");
		}
	});

	it("uses local summarization when remote compaction is disabled", async () => {
		const model = getBundledModel("openai", "gpt-4o");
		if (!model) {
			throw new Error("Expected openai/gpt-4o model to exist");
		}

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 2000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 5000, 0))),
			createMessageEntry(createUserMessage("Turn 3")),
			createMessageEntry(createAssistantMessage("Answer 3", createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: false,
			remoteEndpoint: "https://compaction.example.test/summarize",
		});
		if (!preparation) {
			throw new Error("Expected compaction preparation");
		}

		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ summary: "remote summary" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		const completeSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(createAssistantMessage("Local history summary"))
			.mockResolvedValueOnce(createAssistantMessage("Local turn summary"))
			.mockResolvedValueOnce(createAssistantMessage("Local short summary"));

		const result = await compact(preparation, model, "test-api-key", undefined, undefined, {
			fetch: fetchSpy,
		});

		expect(fetchHandler).not.toHaveBeenCalled();
		expect(completeSpy).toHaveBeenCalledTimes(3);
		expect(result.summary).toContain("Local history summary");
		expect(result.shortSummary).toBe("Local short summary");
	});

	it("preserves prior compaction items and encrypted reasoning for OpenAI remote compaction", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) {
			throw new Error("Expected openai/gpt-5.1 model to exist");
		}

		const oldUser = createMessageEntry(createUserMessage("Older turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Older answer"));
		const previousCompaction = createCompactionEntry("Previous summary", oldAssistant.id);
		previousCompaction.preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Previous preserved user" }] },
					{ type: "compaction", encrypted_content: "prior_encrypted" },
				],
				compactionItem: { type: "compaction", encrypted_content: "prior_encrypted" },
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(
				createOpenAiAssistantMessage(
					"Answer 1",
					model,
					createMockUsage(0, 100, 4000, 0),
					"encrypted_reasoning_turn_1",
				),
			),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(
				createOpenAiAssistantMessage(
					"Answer 2",
					model,
					createMockUsage(0, 100, 9000, 0),
					"encrypted_reasoning_turn_2",
				),
			),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: true,
		});
		if (!preparation) {
			throw new Error("Expected compaction preparation");
		}

		const remoteOutput = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Compacted retained user" }] },
			{ type: "compaction", encrypted_content: "new_encrypted" },
		];
		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ output: remoteOutput }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");

		const result = await compact(preparation, model, "test-api-key", undefined, undefined, {
			fetch: fetchSpy,
		});
		const requestBody = JSON.parse(String(fetchHandler.mock.calls[0]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};

		expect(fetchHandler).toHaveBeenCalledTimes(1);
		expect(requestBody.input[0]).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "Previous preserved user" }],
		});
		expect(requestBody.input[1]).toEqual({ type: "compaction", encrypted_content: "prior_encrypted" });
		expect(
			requestBody.input.some(
				item => item.type === "reasoning" && item.encrypted_content === "encrypted_reasoning_turn_1",
			),
		).toBe(true);
		// V1 now matches V2: the provider-native replay is preserved and local
		// summarization is skipped (no redundant LLM round), leaving the placeholder.
		expect(result.summary).toContain("Remote compaction preserved provider-native history");
		expect(completeSimpleSpy).not.toHaveBeenCalled();
		expect(result.preserveData).toEqual({
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: remoteOutput,
				compactionItem: { type: "compaction", encrypted_content: "new_encrypted" },
			},
		});
	});
	it("prefers persisted assistant native history snapshots for OpenAI remote compaction", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const assistantHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Canonical user" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Canonical assistant" }] },
		];
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("generic user that should be replaced")),
			createMessageEntry(
				createOpenAiAssistantMessage(
					"generic assistant that should be replaced",
					model,
					createMockUsage(0, 100, 9000, 0),
					"encrypted_reasoning_turn_1",
					{ type: "openaiResponsesHistory", provider: "openai", items: assistantHistory },
				),
			),
			createMessageEntry(createUserMessage("follow-up user")),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key", undefined, undefined, { fetch: fetchSpy });
		const requestBody = JSON.parse(String(fetchHandler.mock.calls[0]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};

		expect(requestBody.input).toEqual([
			...assistantHistory,
			{ type: "message", role: "user", content: [{ type: "input_text", text: "follow-up user" }] },
		]);
	});

	it("uses the ChatGPT Codex compact endpoint for openai-codex models", async () => {
		const baseModel = getBundledModel("openai", "gpt-5.1");
		if (!baseModel) throw new Error("Expected openai/gpt-5.1 model to exist");

		const model: Model = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key", undefined, undefined, { fetch: fetchSpy });

		expect(fetchHandler).toHaveBeenCalledTimes(1);
		expect(fetchHandler.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
	});

	it("preserves codex assistant text signature metadata in remote compaction history", async () => {
		const baseModel = getBundledModel("openai", "gpt-5.1");
		if (!baseModel) throw new Error("Expected openai/gpt-5.1 model to exist");

		const model: Model = {
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Answer 1",
					textSignature: encodeTextSignatureV1("msg_original", "commentary"),
				},
			],
			usage: createMockUsage(0, 100, 9000, 0),
			stopReason: "stop",
			timestamp: Date.now(),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};

		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Turn 1")), createMessageEntry(assistant)];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "new_encrypted" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		await compact(preparation, model, "test-api-key", undefined, undefined, { fetch: fetchSpy });
		const requestBody = JSON.parse(String(fetchHandler.mock.calls[0]?.[1]?.body)) as {
			input: Array<Record<string, unknown>>;
		};
		const assistantItem = requestBody.input.find(item => item.type === "message" && item.role === "assistant");

		expect(assistantItem).toMatchObject({
			type: "message",
			role: "assistant",
			id: "msg_original",
			phase: "commentary",
		});
	});

	it("filters remote compact output and uses explicit remote instructions", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 9000, 0))),
		];
		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const remoteOutput = [
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "stale developer" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Real preserved user" }] },
			{ type: "reasoning", encrypted_content: "secret" },
			{ type: "function_call_output", call_id: "call_1", output: "ignored" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Kept assistant" }] },
			{ type: "compaction", encrypted_content: "new_encrypted" },
		];
		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ output: remoteOutput }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("Short summary"));

		const result = await compact(preparation, model, "test-api-key", undefined, undefined, {
			remoteSystemPrompt: ["BASE INSTRUCTIONS"],
			fetch: fetchSpy,
		});
		const requestBody = JSON.parse(String(fetchHandler.mock.calls[0]?.[1]?.body)) as {
			instructions: string;
		};

		expect(requestBody.instructions).toBe("BASE INSTRUCTIONS");
		expect(result.preserveData).toEqual({
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "Real preserved user" }] },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Kept assistant" }] },
					{ type: "compaction", encrypted_content: "new_encrypted" },
				],
				compactionItem: { type: "compaction", encrypted_content: "new_encrypted" },
			},
		});
	});

	it("clears stale OpenAI remote preserve data when local compaction runs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const oldUser = createMessageEntry(createUserMessage("Older turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Older answer"));
		const previousCompaction = createCompactionEntry("Previous summary", oldAssistant.id);
		previousCompaction.preserveData = {
			otherState: "keep-me",
			openaiRemoteCompaction: {
				replacementHistory: [{ type: "compaction", encrypted_content: "stale_encrypted" }],
				compactionItem: { type: "compaction", encrypted_content: "stale_encrypted" },
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 4000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 9000, 0))),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const completeSimpleSpy = vi.spyOn(ai, "completeSimple");
		completeSimpleSpy
			.mockResolvedValueOnce(createAssistantMessage("History summary"))
			.mockResolvedValueOnce(createAssistantMessage("Turn prefix summary"))
			.mockResolvedValueOnce(createAssistantMessage("Short summary"));

		const result = await compact(preparation, model, "test-api-key");

		expect(result.preserveData).toEqual({ otherState: "keep-me" });
	});

	it("summarizes snapcompact archive text locally and stops carrying frames", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const oldUser = createMessageEntry(createUserMessage("Archived turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Archived answer"));
		const previousCompaction = createCompactionEntry("Snapcompact frame summary", oldAssistant.id);
		previousCompaction.preserveData = {
			otherState: "keep-me",
			snapcompact: {
				frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 }],
				totalChars: 31,
				truncatedChars: 0,
				text: "Archived snapcompact source",
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 4000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 9000, 0))),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(createAssistantMessage("History summary"));

		const result = await compact(preparation, model, "test-api-key");
		const promptText = completeSimpleSpy.mock.calls
			.map(call => {
				const context = call[1] as { messages?: Array<{ content?: Array<{ text?: string }> }> };
				return context.messages?.[0]?.content?.[0]?.text ?? "";
			})
			.join("\n");

		expect(promptText).toContain("Archived snapcompact source");
		expect(result.preserveData).toEqual({ otherState: "keep-me" });
	});

	it("keeps snapcompact archive text when only split-turn prefix is summarized", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const oldUser = createMessageEntry(createUserMessage("Archived turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Archived answer"));
		const previousCompaction = createCompactionEntry("Split snapcompact frame summary", oldAssistant.id);
		previousCompaction.preserveData = {
			otherState: "keep-me",
			snapcompact: {
				frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 }],
				totalChars: 34,
				truncatedChars: 0,
				text: "Archived split snapcompact source",
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn after archive")),
			createMessageEntry(createAssistantMessage("Prefix answer")),
			createMessageEntry(createAssistantMessage("Kept answer")),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");
		expect(preparation.isSplitTurn).toBe(true);
		expect(preparation.messagesToSummarize).toHaveLength(0);
		expect(preparation.turnPrefixMessages.length).toBeGreaterThan(0);

		const completeSimpleSpy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce(createAssistantMessage("Archived history summary"))
			.mockResolvedValueOnce(createAssistantMessage("Turn prefix summary"))
			.mockResolvedValueOnce(createAssistantMessage("Short summary"));

		const result = await compact(preparation, model, "test-api-key");
		const promptText = completeSimpleSpy.mock.calls
			.map(call => {
				const context = call[1] as { messages?: Array<{ content?: Array<{ text?: string }> }> };
				return context.messages?.[0]?.content?.[0]?.text ?? "";
			})
			.join("\n");

		expect(promptText).toContain("Archived split snapcompact source");
		expect(result.summary).toContain("Archived history summary");
		expect(result.summary).toContain("Turn prefix summary");
		expect(result.summary).not.toContain("Archived split snapcompact source");
		expect(result.summary).not.toContain("No prior history.");
		expect(result.preserveData).toEqual({ otherState: "keep-me" });
	});

	it("strips legacy frame-only snapcompact archives during local compaction", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5 model to exist");

		const oldUser = createMessageEntry(createUserMessage("Archived turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Archived answer"));
		const previousCompaction = createCompactionEntry("Legacy snapcompact frame summary", oldAssistant.id);
		previousCompaction.preserveData = {
			otherState: "keep-me",
			snapcompact: {
				frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 }],
				totalChars: 4,
				truncatedChars: 0,
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("Answer 1", createMockUsage(0, 100, 4000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createAssistantMessage("Answer 2", createMockUsage(0, 100, 9000, 0))),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("History summary"));

		const result = await compact(preparation, model, "test-api-key");

		expect(result.preserveData).toEqual({ otherState: "keep-me" });
	});

	it("sends snapcompact archive text to OpenAI remote compaction and strips frames", async () => {
		const model = getBundledModel("openai", "gpt-5.1");
		if (!model) throw new Error("Expected openai/gpt-5.1 model to exist");

		const oldUser = createMessageEntry(createUserMessage("Archived turn"));
		const oldAssistant = createMessageEntry(createAssistantMessage("Archived answer"));
		const previousCompaction = createCompactionEntry("Snapcompact frame summary", oldAssistant.id);
		previousCompaction.preserveData = {
			otherState: "keep-me",
			snapcompact: {
				frames: [{ data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 }],
				totalChars: 38,
				truncatedChars: 0,
				text: "Archived remote snapcompact source",
			},
		};

		const entries: SessionEntry[] = [
			oldUser,
			oldAssistant,
			previousCompaction,
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createOpenAiAssistantMessage("Answer 1", model, createMockUsage(0, 100, 4000, 0))),
			createMessageEntry(createUserMessage("Turn 2")),
			createMessageEntry(createOpenAiAssistantMessage("Answer 2", model, createMockUsage(0, 100, 9000, 0))),
		];

		const preparation = prepareCompaction(entries, {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 1000,
			remoteEnabled: true,
		});
		if (!preparation) throw new Error("Expected compaction preparation");

		const remoteOutput = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Compacted retained user" }] },
			{ type: "compaction", encrypted_content: "new_encrypted" },
		];
		const fetchHandler = vi.fn(
			async (_input, _init) =>
				new Response(JSON.stringify({ output: remoteOutput }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const fetchSpy = mockFetch(fetchHandler);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("History summary"));

		const result = await compact(preparation, model, "test-api-key", undefined, undefined, { fetch: fetchSpy });
		const requestBody = JSON.parse(String(fetchHandler.mock.calls[0]?.[1]?.body)) as {
			input: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string }> }>;
		};
		const archiveMessage = requestBody.input.find(
			item =>
				item.type === "message" &&
				item.role === "user" &&
				item.content?.some(
					block =>
						block.type === "input_text" &&
						typeof block.text === "string" &&
						block.text.includes("Archived remote snapcompact source"),
				),
		);

		expect(archiveMessage).toBeDefined();
		expect(result.preserveData).toEqual({
			otherState: "keep-me",
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: remoteOutput,
				compactionItem: { type: "compaction", encrypted_content: "new_encrypted" },
			},
		});
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, tokenizer, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, tokenizer, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, tokenizer, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, tokenizer, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.models.default).toBe("anthropic/claude-sonnet-4-5");
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0].role).toBe("compactionSummary");
		expect((loaded.messages[0] as any).summary).toContain("Summary of 1,a,2,b");
	});

	it("re-attaches snapcompact frames from preserveData as compaction summary images", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const frame = { data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 };
		const compaction: CompactionEntry = {
			...createCompactionEntry("Filmed summary", u2.id),
			preserveData: { snapcompact: { frames: [frame], totalChars: 4, truncatedChars: 0 } },
		};
		const u3 = createMessageEntry(createUserMessage("3"));

		const loaded = buildSessionContext([u1, a1, u2, compaction, u3]);
		const summaryMessage = loaded.messages[0] as { role: string; images?: unknown };
		expect(summaryMessage.role).toBe("compactionSummary");
		expect(summaryMessage.images).toEqual([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]);
	});

	it("transcript option keeps full history with every compaction inline at its position", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		const u2 = createMessageEntry(createUserMessage("2"));
		const frame = { data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 };
		const compact2: CompactionEntry = {
			...createCompactionEntry("Second summary", u2.id),
			preserveData: { snapcompact: { frames: [frame], totalChars: 4, truncatedChars: 0 } },
		};
		const u3 = createMessageEntry(createUserMessage("3"));
		const entries: SessionEntry[] = [u1, a1, compact1, u2, compact2, u3];

		const transcript = buildSessionContext(entries, undefined, undefined, { transcript: true });
		// Nothing dropped positionally: every message survives, compactions sit
		// where they fired. Superseded compaction summaries are elided in the
		// forward transcript; only the active (latest) compaction keeps its text.
		expect(transcript.messages.map(m => m.role)).toEqual([
			"user",
			"assistant",
			"compactionSummary",
			"user",
			"compactionSummary",
			"user",
		]);
		const first = transcript.messages[2] as { summary: string };
		const second = transcript.messages[4] as { summary: string; images?: unknown };
		expect(first.summary).toContain("Superseded compaction summary elided");
		expect(first.summary).not.toContain("First summary");
		expect(second.summary).toContain("Second summary");
		// Snapcompact frames ride along in the transcript too.
		expect(second.images).toEqual([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]);

		// LLM context is untouched by the option: latest compaction replaces history.
		const llm = buildSessionContext(entries);
		expect(llm.messages.map(m => m.role)).toEqual(["compactionSummary", "user", "user"]);
	});

	it("transcript collapse option elides compacted display history", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		const u2 = createMessageEntry(createUserMessage("2"));
		const compact2 = createCompactionEntry("Second summary", u2.id);
		const u3 = createMessageEntry(createUserMessage("3"));
		const entries: SessionEntry[] = [u1, a1, compact1, u2, compact2, u3];

		const transcript = buildSessionContext(entries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		expect(transcript.messages.map(m => m.role)).toEqual(["user", "compactionSummary", "user"]);
		const summaryMsg = transcript.messages[1];
		if (summaryMsg?.role !== "compactionSummary") throw new Error("Expected compaction summary at index 1");
		expect(summaryMsg.summary).toContain("Second summary");
		expect(transcript.cacheMissExplainedAt).toEqual([false, false, false]);
	});

	it("keeps kept turns visible when collapsing a remote (OpenAI) compaction", () => {
		const uOld = createMessageEntry(createUserMessage("old-before-keep"));
		const uKept = createMessageEntry(createUserMessage("kept-user"));
		const aKept = createMessageEntry(createAssistantMessage("kept-assistant"));
		const compaction = createCompactionEntry("Remote summary", uKept.id);
		compaction.preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "preserved" }] },
					{ type: "compaction", encrypted_content: "enc" },
				],
				compactionItem: { type: "compaction", encrypted_content: "enc" },
			},
		};
		const uAfter = createMessageEntry(createUserMessage("after-compact"));
		const entries: SessionEntry[] = [uOld, uKept, aKept, compaction, uAfter];

		const transcript = buildSessionContext(entries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		// The provider payload is attached to the summary for LLM replay only; the
		// collapsed display must still emit the kept SessionEntry rows so a
		// remotely-compacted session keeps its recent turns visible.
		expect(transcript.messages.map(m => m.role)).toEqual(["user", "assistant", "compactionSummary", "user"]);
		const dump = JSON.stringify(transcript.messages);
		expect(dump).toContain("kept-user");
		expect(dump).toContain("kept-assistant");
		expect(dump).toContain("after-compact");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// Issue #849: explicit model_change wins over assistant-message inference.
		expect(loaded.models.default).toBe("openai/gpt-4");
		expect(loaded.thinkingLevel).toBe("high");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should find cut point in large session", async () => {
		const entries = await loadLargeSessionEntries();
		const result = findCutPoint(entries, tokenizer, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("LLM summarization", () => {
	it("should produce valid session after compaction", async () => {
		const entries = await loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);

		const compactionResult = await compact(preparation!, model, e2eApiKey("ANTHROPIC_API_KEY")!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});
