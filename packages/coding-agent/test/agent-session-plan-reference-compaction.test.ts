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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

type ObservedPromptCall = { callIndex: number; messageTexts: string[] };

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
	const text: string[] = [];
	for (const content of message.content) {
		if (isTextContentBlock(content)) text.push(content.text);
	}
	return text.join("\n");
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
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-agent-session-plan-ref-compaction-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

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

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	async function createHarness(method: "soft" | "snapcompact" = "soft"): Promise<Harness> {
		const observedCalls: ObservedPromptCall[] = [];
		const waiters: Array<{
			predicate: (call: ObservedPromptCall) => boolean;
			resolve: (call: ObservedPromptCall) => void;
		}> = [];

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		// Pin the context window so the fixed 191k high-usage turn stays above the
		// compaction threshold across catalog regenerations: claude-sonnet-4-5's
		// bundled window grew to 1M, which a 191k turn no longer trips. Mirrors
		// agent-session-eager-compaction / -auto-compaction-queue.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const settings = Settings.isolated({
			"compaction.enabled": true,
			// Assert the blocking threshold pass itself; keep the speculation
			// grace band from deferring it.
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": true,
			"compaction.methodOrder": method === "snapcompact" ? ["snapcompact", "soft"] : ["soft"],
			"task.eager": "default",
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context) => {
				const call = {
					callIndex: observedCalls.length,
					messageTexts: context.messages.map(message => getMessageText(message)),
				};
				observedCalls.push(call);
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

		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		const waitForCall = (predicate: (call: ObservedPromptCall) => boolean) => {
			const existing = observedCalls.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<ObservedPromptCall>();
			waiters.push({ predicate, resolve });
			return promise;
		};

		cleanups.push(() => session.dispose());
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

	/**
	 * Post-compaction auto-continuation only runs while real work remains
	 * (#5715): a terminal text answer with no queued work or active goal no
	 * longer opens a synthetic primary turn. Give the session an active goal so
	 * the continuation — the vehicle this regression rides on — still fires.
	 */
	function activateOngoingGoal(session: AgentSession, id: string): void {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id,
				objective: "finish the ongoing work",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
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

		activateOngoingGoal(session, "plan-ref-context-full");
		stubCompaction();

		// First executor turn: reference already sent, so it is NOT re-delivered here.
		await session.prompt("continue executing the approved plan");
		const firstCall = observedCalls[0];
		expect(firstCall).toBeDefined();
		expect(firstCall.messageTexts.some(text => text.includes(planMarker))).toBe(false);

		// Auto-compaction fires, replacing history (dropping the delivered reference),
		// then schedules the auto-continuation turn.
		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.callIndex > 0);

		// The post-compaction continuation MUST carry the plan again: inlined body
		// plus the durable path as the recovery route.
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
		activateOngoingGoal(session, "plan-ref-snapcompact");
		await session.prompt("continue executing the approved snapcompact plan");
		const firstCall = observedCalls[0];
		expect(firstCall).toBeDefined();
		expect(firstCall.messageTexts.some(text => text.includes(planMarker))).toBe(false);

		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.callIndex > 0);

		expect(continuation.messageTexts.some(text => text.includes(planMarker))).toBe(true);
		expect(continuation.messageTexts.some(text => text.includes(`<plan path="${planUrl}">`))).toBe(true);
	});

	// Blast-radius guard: clearing the flag on every compaction must NOT start
	// injecting a plan reference into ordinary (non-plan) sessions, where the
	// default `local://PLAN.md` path has no file on disk.
	it("does not inject a plan reference after compaction when no plan file exists", async () => {
		const { session, waitForCall } = await createHarness();
		activateOngoingGoal(session, "plan-ref-none");
		stubCompaction();

		await session.prompt("do some ordinary work");
		emitHighUsageTurn(session);
		const continuation = await waitForCall(call => call.callIndex > 0);

		expect(continuation.messageTexts.some(text => text.includes("## Existing Plan"))).toBe(false);
	});
});
