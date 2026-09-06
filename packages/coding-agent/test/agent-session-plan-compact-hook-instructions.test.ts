/**
 * Regression test for issue #4359: "Keep plan compaction guidance out of hook
 * custom instructions".
 *
 * The plan-approval compaction path used to route the internal
 * `plan-mode-compact-instructions` prompt through the public
 * `customInstructions` argument of {@link AgentSession.compact}, and from there
 * into the `session_before_compact` extension hook. Extensions that treat that
 * field as "user focus" — e.g. to bias a query-focused summary — would then
 * see plan-mode boilerplate instead of the operator's intent and produce
 * query-biased compactions.
 *
 * Contract:
 * - Plan-mode compaction MUST call {@link AgentSession.compact} with
 *   `customInstructions: undefined` and pass the guidance via
 *   `CompactOptions.internalGuidance` instead.
 * - The `session_before_compact` hook event MUST see
 *   `customInstructions: undefined` for internal-guidance compactions.
 * - The native summarizer (invoked via `@oh-my-pi/pi-agent-core/compaction`)
 *   MUST still receive the plan guidance so the summary is directed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { SessionBeforeCompactEvent } from "../src/extensibility/shared-events";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	beforeCompactEvents: SessionBeforeCompactEvent[];
	summarizerCalls: Array<{ customInstructions: string | undefined }>;
};

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

describe("AgentSession plan-mode compaction hook contract (issue #4359)", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-session-plan-compact-hook-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			// Aggressive keep-recent budget so the small seeded conversation still
			// yields a non-empty messagesToSummarize window (prepareCompaction
			// otherwise short-circuits with "Nothing to compact").
			"compaction.keepRecentTokens": 1,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: () => {
				const response = createAssistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});

		// Stub the underlying LLM summary so compaction completes without a network
		// call, and capture what customInstructions the native summarizer received.
		const summarizerCalls: Array<{ customInstructions: string | undefined }> = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, _model, _resolver, customInstructions) => {
				summarizerCalls.push({ customInstructions });
				return {
					summary: "compacted",
					shortSummary: undefined,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			},
		);

		// Minimal ExtensionRunner shim: AgentSession only calls hasHandlers() +
		// emit() on it. Casting keeps the test focused on the hook payload.
		const beforeCompactEvents: SessionBeforeCompactEvent[] = [];
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string } & Record<string, unknown>) => {
				if (event.type === "session_before_compact") {
					beforeCompactEvents.push(event as unknown as SessionBeforeCompactEvent);
				}
				return undefined;
			},
			// AgentSession.#promptWithMessage always awaits this before agent_start
			// when an extensionRunner is present; the shim mirrors the no-op path.
			emitBeforeAgentStart: async () => undefined,
		};
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});

		// Seed enough conversation so prepareCompaction has something to summarize.
		await session.prompt("plan out the change");
		await session.prompt("here is the discovery I did while planning");

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, sessionManager, beforeCompactEvents, summarizerCalls };
	}

	it("routes internalGuidance to the summarizer without exposing it to session_before_compact", async () => {
		const { session, beforeCompactEvents, summarizerCalls } = await createHarness();
		const planGuidance = "Preparing to execute the approved plan. You MUST distill the plan-mode discussion.";

		await session.compact(undefined, { internalGuidance: planGuidance });

		// Public hook channel: never carries internal plan guidance.
		expect(beforeCompactEvents.length).toBe(1);
		expect(beforeCompactEvents[0]?.customInstructions).toBeUndefined();

		// Native summarizer still receives the guidance so the summary is directed.
		expect(summarizerCalls.length).toBe(1);
		expect(summarizerCalls[0]?.customInstructions).toBe(planGuidance);
	});

	it("still forwards a user /compact focus verbatim to the hook", async () => {
		const { session, beforeCompactEvents, summarizerCalls } = await createHarness();
		const userFocus = "focus on the auth refactor";

		await session.compact(userFocus);

		// User focus is public: extensions see it (they may interpret it as
		// intent).
		expect(beforeCompactEvents.length).toBe(1);
		expect(beforeCompactEvents[0]?.customInstructions).toBe(userFocus);
		expect(summarizerCalls[0]?.customInstructions).toBe(userFocus);
	});

	it("prefers internalGuidance over customInstructions in the summarizer when both are set", async () => {
		// Belt-and-suspenders: internal guidance always wins for the summary so a
		// caller cannot accidentally leak the plan prompt by also passing a user
		// focus string, and hook visibility is unchanged.
		const { session, beforeCompactEvents, summarizerCalls } = await createHarness();
		const userFocus = "focus on the auth refactor";
		const planGuidance = "distill the plan-mode discussion";

		await session.compact(userFocus, { internalGuidance: planGuidance });

		expect(beforeCompactEvents[0]?.customInstructions).toBe(userFocus);
		expect(summarizerCalls[0]?.customInstructions).toBe(planGuidance);
	});
});
