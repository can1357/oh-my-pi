/**
 * Regression test for issue #1246: "Approved plan file invisible to executor
 * after compaction".
 *
 * After a plan is approved, the executor session delivers the plan reference
 * (`plan-mode-reference`) exactly once, then marks `#planReferenceSent = true`.
 * When auto-compaction later fires, it replaces the conversation history —
 * dropping the delivered reference — but never clears that flag, so
 * `#buildPlanReferenceMessage()` short-circuits to `null` forever and the
 * executor permanently loses the plan it was working on.
 *
 * Contract: the auto-continuation turn that runs immediately after compaction
 * MUST carry the approved plan reference again (re-read from disk).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import * as compactionModule from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import type { TextContent } from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

const CONTINUE_MARKER = "Resume work on the user's most recent intent";

type ObservedPromptCall = { messageTexts: string[] };

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	observedCalls: ObservedPromptCall[];
	waitForCall: (predicate: (call: ObservedPromptCall) => boolean) => Promise<ObservedPromptCall>;
};

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(isTextContentBlock)
		.map(content => content.text)
		.join("\n");
}

function createAssistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** Short-circuit the LLM summary so compaction completes without a network call. */
function stubCompaction(): void {
	vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
		summary: "compacted",
		shortSummary: undefined,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: {},
	}));
}

/** Emit a high-usage assistant turn to drive threshold auto-compaction. */
function emitHighUsageTurn(session: AgentSession): void {
	const assistantMsg = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Done." }],
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
	session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
}

describe("AgentSession approved-plan reference re-injection after compaction (issue #1246)", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-plan-ref-compaction-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(strategy: "context-full" | "snapcompact" = "context-full"): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedPromptCall) => boolean;
			resolve: (call: ObservedPromptCall) => void;
		}> = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.autoContinue": true,
			"compaction.strategy": strategy,
			"task.eager": "default",
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context) => {
				observedCalls.push({ messageTexts: context.messages.map(message => getMessageText(message)) });
				const call = observedCalls[observedCalls.length - 1];
				for (let i = waiters.length - 1; i >= 0; i--) {
					const waiter = waiters[i];
					if (waiter?.predicate(call)) {
						waiter.resolve(call);
						waiters.splice(i, 1);
					}
				}
				const response = createAssistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		const waitForCall = (predicate: (call: ObservedPromptCall) => boolean) => {
			const existing = observedCalls.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<ObservedPromptCall>();
			waiters.push({ predicate, resolve });
			return promise;
		};

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, sessionManager, observedCalls, waitForCall };
	}

	/** Write a plan file to the session-scoped local root the executor reads from. */
	function writePlanFile(sessionManager: SessionManager, url: string, content: string): void {
		const resolved = resolveLocalUrlToPath(url, {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		});
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, content);
	}

	it("re-injects the approved plan reference on the auto-continuation turn", async () => {
		const { session, sessionManager, observedCalls, waitForCall } = await createHarness();

		const planUrl = "local://approved-plan.md";
		const planMarker = "PHASE-6-ARCHITECTURE-PLAN-MARKER";
		writePlanFile(sessionManager, planUrl, `# Approved Plan\n\n${planMarker}\n`);

		// Simulate the executor: plan mode is already exited and the plan reference
		// has already been delivered once (the in-history copy that compaction drops).
		session.setPlanReferencePath(planUrl);
		session.markPlanReferenceSent();

		stubCompaction();

		// First executor turn: reference already sent, so it is NOT re-delivered here.
		await session.prompt("continue executing the approved plan");
		const firstCall = observedCalls[0];
		expect(firstCall).toBeDefined();
		expect(firstCall.messageTexts.some(text => text.includes(planMarker))).toBe(false);

		// Auto-compaction fires, replacing history (dropping the delivered reference),
		// then schedules the auto-continuation turn.
		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.messageTexts.some(text => text.includes(CONTINUE_MARKER)));

		// The post-compaction continuation MUST carry the plan reference again.
		expect(continuation.messageTexts.some(text => text.includes(planMarker))).toBe(true);
		expect(continuation.messageTexts.some(text => text.includes(`<plan path="${planUrl}">`))).toBe(true);
	});

	it("re-injects the approved plan reference after snapcompact auto-compaction", async () => {
		const { session, sessionManager, observedCalls, waitForCall } = await createHarness("snapcompact");

		const planUrl = "local://approved-snapcompact-plan.md";
		const planMarker = "SNAPCOMPACT-PLAN-REINJECTION-MARKER";
		writePlanFile(sessionManager, planUrl, `# Approved Snapcompact Plan\n\n${planMarker}\n`);

		session.setPlanReferencePath(planUrl);
		session.markPlanReferenceSent();

		await session.prompt("continue executing the approved snapcompact plan");
		const firstCall = observedCalls[0];
		expect(firstCall).toBeDefined();
		expect(firstCall.messageTexts.some(text => text.includes(planMarker))).toBe(false);

		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.messageTexts.some(text => text.includes(CONTINUE_MARKER)));

		expect(continuation.messageTexts.some(text => text.includes(planMarker))).toBe(true);
		expect(continuation.messageTexts.some(text => text.includes(`<plan path="${planUrl}">`))).toBe(true);
	});

	// Blast-radius guard: clearing the flag on every compaction must NOT start
	// injecting a plan reference into ordinary (non-plan) sessions, where the
	// default `local://PLAN.md` path has no file on disk.
	it("does not inject a plan reference after compaction when no plan file exists", async () => {
		const { session, waitForCall } = await createHarness();
		stubCompaction();

		await session.prompt("do some ordinary work");
		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.messageTexts.some(text => text.includes(CONTINUE_MARKER)));

		expect(continuation.messageTexts.some(text => text.includes("## Existing Plan"))).toBe(false);
	});
});
