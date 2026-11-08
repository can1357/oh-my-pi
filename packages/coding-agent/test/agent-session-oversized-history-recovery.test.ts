import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// Text-classified overflow; the window is pinned so the classifier input is stable.
const CONTEXT_WINDOW = 200_000;
const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum";
// Well over the 16 KiB argument cap and the 100 KB retry budget, yet small enough that local
// token estimates of both calls together stay below the auto-compaction threshold.
const HUGE = "A".repeat(150_000);
const HUGE_AFTER_RESET = "B".repeat(150_000);
const RESULT = "R".repeat(262_145); // one byte over 256 KiB: only the forced retry shrinks it
const SUMMARY = "SUMMARY-OF-OLDER-TURNS";
const PROMPT = "continue the task";

function omissionMarker(value: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12);
	return `[omitted ${Buffer.byteLength(value)} bytes, sha256=${hash}; full value kept in the session file]`;
}

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface SentRequest {
	json: string;
	messages: Message[];
}

describe("AgentSession oversized-history overflow recovery", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
	});
	afterAll(() => authStorage.close());

	/**
	 * Older completed turns give compaction something to summarize; the current
	 * prompt's huge tool call is emitted by the scripted provider and executed.
	 */
	async function run(responses: MockHandler[]) {
		const mock = createMockModel({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			contextWindow: CONTEXT_WINDOW,
			responses,
		});
		const sessionManager = SessionManager.inMemory();
		const now = Date.now();
		const seeded: AgentMessage[] = [];
		for (let turn = 0; turn < 3; turn++) {
			seeded.push(
				{ role: "user", content: `older request ${turn}`, timestamp: now - 100 + turn * 2 } as AgentMessage,
				{
					role: "assistant",
					content: [{ type: "text", text: `older answer ${turn}` }],
					api: mock.api,
					provider: mock.provider,
					model: mock.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: now - 99 + turn * 2,
				} as AgentMessage,
			);
		}
		for (const message of seeded) {
			if (message.role === "user" || message.role === "assistant") sessionManager.appendMessage(message);
		}
		const executedArgs: string[] = [];
		const stashParams = type({ data: "string" });
		const stash: AgentTool = {
			name: "stash",
			label: "Stash",
			description: "Stores one value",
			parameters: stashParams,
			execute: async (_id, params) => {
				const { data } = stashParams.assert(params);
				executedArgs.push(data);
				return { content: [{ type: "text", text: data === HUGE ? RESULT : "stored" }] };
			},
		};

		let compactions = 0;
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: {
				type: string;
				preparation?: CompactionPreparation;
				branchEntries?: Array<{ id: string; type: string; message?: { role: string } }>;
			}) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				compactions++;
				// Keep the whole current user turn so the post-compaction request still carries its huge call.
				const currentUser = event.branchEntries?.findLast(
					entry => entry.type === "message" && entry.message?.role === "user",
				);
				return {
					compaction: {
						summary: SUMMARY,
						shortSummary: undefined,
						firstKeptEntryId: currentUser?.id ?? event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};

		// Snapshot each outgoing request when it is sent, not via later object references.
		const sent: SentRequest[] = [];
		const agent = new Agent({
			initialState: { model: mock, systemPrompt: ["Test"], tools: [stash], messages: seeded },
			// Same composition as the SDK main-agent converter.
			convertToLlm: messages => convertToLlm(session?.prepareToolHistoryForProvider(messages) ?? messages),
			streamFn: (model, context, options) => {
				sent.push({ json: JSON.stringify(context.messages), messages: structuredClone(context.messages) });
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"contextPromotion.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
			toolRegistry: new Map([[stash.name, stash]]),
			extensionRunner: extensionRunner as never,
		});
		// Keep real scheduler waits: an instant mock dispatches the retry before compaction's
		// finally clears isCompacting, so the continuation safety gate correctly skips it.
		await session.prompt(PROMPT);
		await session.waitForIdle();
		const persistedArgs = (id: string) =>
			sessionManager
				.getEntries()
				.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
				.flatMap(message => message.content)
				.find(block => block.type === "toolCall" && block.id === id);
		return { mock, sent, compactions, executedArgs, persistedArgs, session };
	}

	const hugeToolCall = (id: string, data: string): MockHandler => ({
		content: [{ type: "toolCall", id, name: "stash", arguments: { data } }],
	});

	function toolCallData(messages: Message[], id: string): unknown {
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall" && block.id === id) return block.arguments.data;
			}
		}
		return undefined;
	}

	function pairedResult(messages: Message[], id: string): boolean {
		const callIndex = messages.findIndex(
			message =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "toolCall" && block.id === id && block.name === "stash"),
		);
		const resultIndex = messages.findIndex(
			message => message.role === "toolResult" && message.toolCallId === id && message.toolName === "stash",
		);
		return callIndex >= 0 && resultIndex > callIndex;
	}

	function resultText(messages: Message[], id: string): string {
		const result = messages.find(message => message.role === "toolResult" && message.toolCallId === id);
		if (result?.role !== "toolResult") throw new Error(`Expected a tool result for ${id}`);
		return result.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}

	it("compacts once, sends one shrunk current-turn retry, then surfaces the third overflow", async () => {
		let overflowAttempts = 0;
		const overflow: MockHandler = () => {
			overflowAttempts++;
			return { throw: OVERFLOW };
		};
		const result = await run([hugeToolCall("call-huge", HUGE), overflow, overflow, overflow]);

		// Initial tool turn, then exactly three overflow attempts; no fifth request.
		expect(result.sent).toHaveLength(4);
		expect(overflowAttempts).toBe(3);
		expect(result.compactions).toBe(1);
		expect(result.executedArgs).toEqual([HUGE]);

		const [initial, firstOverflow, postCompaction, shrunkRetry] = result.sent;
		expect(initial.json).not.toContain(HUGE);

		// First overflow: the executed call's completed arguments are shrunk; its result stays full.
		expect(toolCallData(firstOverflow.messages, "call-huge")).toBe(omissionMarker(HUGE));
		expect(resultText(firstOverflow.messages, "call-huge")).toBe(RESULT);
		expect(firstOverflow.json).not.toContain(SUMMARY);

		// Post-compaction: summary replaced older turns; the current turn keeps its result full.
		expect(postCompaction.json).toContain(SUMMARY);
		expect(postCompaction.json).not.toContain("older request 0");
		expect(postCompaction.json).toContain(PROMPT);
		expect(toolCallData(postCompaction.messages, "call-huge")).toBe(omissionMarker(HUGE));
		expect(resultText(postCompaction.messages, "call-huge")).toBe(RESULT);
		expect(pairedResult(postCompaction.messages, "call-huge")).toBe(true);

		// Single forced retry: the current result is cut to head and tail; pairing intact.
		expect(shrunkRetry.json.length).toBeLessThan(100_000);
		expect(toolCallData(shrunkRetry.messages, "call-huge")).toBe(omissionMarker(HUGE));
		expect(resultText(shrunkRetry.messages, "call-huge")).toMatch(
			/^R{8192}\n\[omitted \d+ bytes, sha256=[0-9a-f]{12}; full value kept in the session file\]\nR{8192}$/,
		);
		expect(pairedResult(shrunkRetry.messages, "call-huge")).toBe(true);
		expect(shrunkRetry.json).toContain(PROMPT);

		expect(result.persistedArgs("call-huge")).toMatchObject({ arguments: { data: HUGE } });
		expect(result.session.getLastAssistantMessage()?.errorMessage).toBe(OVERFLOW);
	});

	it("keeps whole-context shrinking for later tool-loop requests after the shrunk retry succeeds", async () => {
		const overflow: MockHandler = { throw: OVERFLOW };
		const result = await run([
			hugeToolCall("call-huge", HUGE),
			overflow,
			overflow,
			// The shrunk retry succeeds by emitting another huge current-turn tool call.
			hugeToolCall("call-huge-2", HUGE_AFTER_RESET),
			{ content: ["recovered"] },
		]);

		expect(result.sent).toHaveLength(5);
		expect(result.compactions).toBe(1);
		expect(result.executedArgs).toEqual([HUGE, HUGE_AFTER_RESET]);

		const shrunkRetry = result.sent[3];
		expect(toolCallData(shrunkRetry.messages, "call-huge")).toBe(omissionMarker(HUGE));

		// Follow-on request after success: the oversized result is still in history, so it stays shrunk.
		const followOn = result.sent[4];
		expect(resultText(followOn.messages, "call-huge")).toMatch(
			/^R{8192}\n\[omitted \d+ bytes, sha256=[0-9a-f]{12}; full value kept in the session file\]\nR{8192}$/,
		);
		expect(toolCallData(followOn.messages, "call-huge")).toBe(omissionMarker(HUGE));
		expect(toolCallData(followOn.messages, "call-huge-2")).toBe(omissionMarker(HUGE_AFTER_RESET));
		expect(pairedResult(followOn.messages, "call-huge-2")).toBe(true);

		expect(result.persistedArgs("call-huge")).toMatchObject({ arguments: { data: HUGE } });
		expect(result.persistedArgs("call-huge-2")).toMatchObject({ arguments: { data: HUGE_AFTER_RESET } });
		expect(result.session.getLastAssistantMessage()?.stopReason).toBe("stop");
	});
});
