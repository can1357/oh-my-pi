/**
 * Contract: when auto-compaction fires at a turn boundary while the operator's
 * newest request is still on the agent queue, the next provider call carries
 * that request on top of the compacted history. A generic resume prompt in its
 * place would send the model back to the pre-compaction plan and lose the
 * request outright, which reads as a silently dropped instruction.
 *
 * Sibling coverage in `agent-session-auto-compaction-queue.test.ts` stops at
 * "a continuation was scheduled"; these cases observe what the model receives.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { Context, Message } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

const NEWEST_REQUEST = "NEWEST-REQUEST: switch to the staging endpoint and report the port";
const SUMMARY = "SUMMARY-OF-EARLIER-WORK";
const PRE_COMPACTION = "the superseded plan from before compaction";

function messageText(message: Message): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

function requestTexts(context: Context): string[] {
	return context.messages.map(messageText);
}

describe("AgentSession compaction with a queued request", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-compaction-queued-request-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/**
	 * Drive a real threshold auto-compaction with `NEWEST_REQUEST` already queued,
	 * and return every context the provider was called with.
	 */
	async function runQueuedCompaction(autoContinue: boolean): Promise<{
		contexts: Context[];
		hasQueuedMessages: boolean;
	}> {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				// Deterministic summary: the summarizer model is not under test.
				pi.on("session_before_compact", async event => ({
					compaction: {
						summary: SUMMARY,
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			`compaction-queued-request-${autoContinue}`,
		);

		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		// The threshold math below is tuned to a 200k/64k budget.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		const { promise: providerCalled, resolve: onProviderCalled } = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: () => {
				onProviderCalled();
				return { content: ["ack"] };
			},
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			// The CLI installs this converter; the agent default drops compaction
			// summaries, so without it the request under assertion is not the real one.
			convertToLlm,
			streamFn: mock.stream,
		});

		sessionManager.appendMessage({ role: "user", content: PRE_COMPACTION, timestamp: Date.now() });

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.autoContinue": autoContinue, "todo.reminders": false }),
			modelRegistry,
			extensionRunner,
		});

		const { promise: compacted, resolve: onCompacted } = Promise.withResolvers<void>();
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "auto_compaction_end") onCompacted();
		});

		// Lands while the previous turn is still settling, exactly as a CLI
		// steer/follow-up typed during streaming does.
		agent.followUp({
			role: "user",
			content: [{ type: "text", text: NEWEST_REQUEST }],
			timestamp: Date.now(),
		});
		expect(agent.hasQueuedMessages()).toBe(true);

		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty text: an empty `stop` turn trips the empty-stop guard before
			// the compaction check runs.
			content: [{ type: "text" as const, text: "Earlier answer." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compacted;
		// The continuation is scheduled behind a short delay; await the call it makes.
		await withTimeout(providerCalled, 10_000, "provider was never called after compaction");
		await session.waitForIdle();

		return {
			contexts: mock.calls.map(call => call.context),
			hasQueuedMessages: agent.hasQueuedMessages(),
		};
	}

	it("sends the queued request, not the pre-compaction history", async () => {
		const { contexts, hasQueuedMessages } = await runQueuedCompaction(true);

		expect(contexts).toHaveLength(1);
		const texts = requestTexts(contexts[0]!);
		// The newest request is what the model is asked to act on.
		expect(texts.at(-1)).toBe(NEWEST_REQUEST);
		expect(texts.filter(text => text.includes(NEWEST_REQUEST))).toHaveLength(1);
		// Carried on top of the compacted history, not the superseded plan.
		expect(texts.some(text => text.includes(SUMMARY))).toBe(true);
		expect(texts.some(text => text.includes(PRE_COMPACTION))).toBe(false);
		expect(hasQueuedMessages).toBe(false);
	});

	it("sends the queued request even with compaction auto-continue disabled", async () => {
		const { contexts, hasQueuedMessages } = await runQueuedCompaction(false);

		expect(contexts).toHaveLength(1);
		const texts = requestTexts(contexts[0]!);
		expect(texts.at(-1)).toBe(NEWEST_REQUEST);
		expect(texts.some(text => text.includes(SUMMARY))).toBe(true);
		expect(hasQueuedMessages).toBe(false);
	});
});
