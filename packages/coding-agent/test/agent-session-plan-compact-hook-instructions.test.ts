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
import * as snapcompact from "@oh-my-pi/snapcompact";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { SessionBeforeCompactEvent } from "../src/extensibility/shared-events";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import type { CompactionMethod } from "../src/session/compaction-methods";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	beforeCompactEvents: SessionBeforeCompactEvent[];
	summarizerCalls: Array<{ customInstructions: string | undefined }>;
	snapcompactCalls: Array<{ firstKeptEntryId: string }>;
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

	async function createHarness(
		methodOrder: CompactionMethod[] = ["soft"],
		vision: "vision" | "text-only" = "vision",
	): Promise<Harness> {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model = vision === "vision" ? bundled : { ...bundled, input: ["text" as const] };

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": methodOrder,
			// Aggressive keep-recent budget so the small seeded conversation still
			// yields a non-empty messagesToSummarize window (prepareCompaction
			// otherwise short-circuits with "Nothing to compact").
			"compaction.keepRecentTokens": 1,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

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

		// Snapcompact renders real bitmap frames; stub it so the test asserts
		// method selection rather than the renderer.
		const snapcompactCalls: Array<{ firstKeptEntryId: string }> = [];
		vi.spyOn(snapcompact, "compact").mockImplementation(async preparation => {
			snapcompactCalls.push({ firstKeptEntryId: preparation.firstKeptEntryId });
			return {
				summary: "archived onto frames",
				shortSummary: "archived",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				preserveData: { snapcompact: { frames: [], totalChars: 0, truncatedChars: 0 } },
			};
		});

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
		const session = new AgentSession({
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
		return { session, sessionManager, beforeCompactEvents, summarizerCalls, snapcompactCalls };
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

	it("lets a vision model snapcompact the plan-mode transcript instead of summarizing it", async () => {
		// Compact-before-execute rides the plan distillation prompt through
		// `internalGuidance`. That is advice for a summary that may not run, not
		// a demand that one run: on a model that reads frames back, snapcompact
		// keeps the discussion verbatim and the approved plan is re-injected from
		// its pinned reference path. Treating the guidance as focus disqualified
		// snapcompact on every compact-and-execute, silently downgrading a
		// vision-to-vision transition to a lossy soft summary.
		const harness = await createHarness(["snapcompact", "soft"]);
		const planGuidance = "Preparing to execute the approved plan. You MUST distill the plan-mode discussion.";

		await harness.session.compact(undefined, { internalGuidance: planGuidance });

		expect(harness.snapcompactCalls.length).toBe(1);
		expect(harness.summarizerCalls.length).toBe(0);
		// The #4359 contract holds on this path too: guidance stays off the hook.
		expect(harness.beforeCompactEvents.length).toBe(1);
		expect(harness.beforeCompactEvents[0]?.customInstructions).toBeUndefined();
	});

	it("still skips snapcompact when the user supplied a focus the archive cannot honor", async () => {
		// The branch partner: user focus is a demand the operator would notice
		// being dropped, so it must keep falling through to the summarizer even
		// when snapcompact leads the order and the model could read frames.
		const harness = await createHarness(["snapcompact", "soft"]);
		const userFocus = "focus on the auth refactor";

		await harness.session.compact(userFocus);

		expect(harness.snapcompactCalls.length).toBe(0);
		expect(harness.summarizerCalls.length).toBe(1);
		expect(harness.summarizerCalls[0]?.customInstructions).toBe(userFocus);
	});

	it("still summarizes for a text-only model, which cannot read the archive back", async () => {
		// End-to-end contract, not a guard on one term: dropping the guidance
		// check must not leave a text-only model with an unreadable archive
		// instead of a summary. Two mechanisms can enforce it — the vision term
		// in the selection gate and the downstream renderability preflight — and
		// this pins the observable result either way. A mutation that removes
		// only the selection term stays green here, because the preflight then
		// blocks snapcompact and the run falls through to the summarizer.
		const harness = await createHarness(["snapcompact", "soft"], "text-only");
		const planGuidance = "Preparing to execute the approved plan.";

		await harness.session.compact(undefined, { internalGuidance: planGuidance });

		expect(harness.snapcompactCalls.length).toBe(0);
		expect(harness.summarizerCalls.length).toBe(1);
		expect(harness.summarizerCalls[0]?.customInstructions).toBe(planGuidance);
	});
});
