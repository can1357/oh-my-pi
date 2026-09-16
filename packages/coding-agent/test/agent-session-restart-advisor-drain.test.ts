/**
 * Contract: with advisors enabled at the default `advisor.syncBacklog: "off"`,
 * the turn that requests a restart queues its OWN advisor review as it settles
 * — after the restart has latched but before the primary agent goes idle. That
 * review outlives the primary turn, so the recycle's quiescence predicate sees
 * it through `hasActiveReviews` and would refuse the restart as busy forever (a
 * retry only queues another). The barrier must DRAIN that review — let it
 * complete with its note preserved — before the final quiescence check, so the
 * restart proceeds while the note survives the recycle.
 *
 * The distinction from a genuinely user-initiated review is purely timing: a
 * review already in flight when `requestRestart()` is CALLED is caught by the
 * pre-latch busy check and still blocks, so the drain only ever settles the
 * recycle's own turn.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RequestRestartResult } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

const ADVISOR_TYPE = "advisor";
const ADVISOR_NOTE = "Fixture verdict confirmed";

/**
 * Drain the event loop to quiescence. Every step of the restart barrier is a
 * promise continuation or a file-I/O callback, never a timer, so a bounded run
 * of timer turns deterministically settles the barrier as far as its gates
 * allow — load-independent, unlike a wall-clock poll.
 */
async function drainEventLoop(turns = 400): Promise<void> {
	for (let turn = 0; turn < turns; turn++) {
		await Bun.sleep(0);
	}
}

interface AdvisorRestartHarness {
	session: AgentSession;
	restartCalls: number;
	persisted: string[];
	turnStarted: Promise<void>;
	releaseTurn: () => void;
	advisorStarted: Promise<void>;
	releaseAdvisor: () => void;
}

describe("AgentSession restart drains its own advisor review", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let releaseTurn: (() => void) | undefined;
	let releaseAdvisor: (() => void) | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-restart-advisor-");
	});

	afterEach(async () => {
		// Open any parked gate so a failed assertion cannot wedge dispose.
		releaseTurn?.();
		releaseAdvisor?.();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
		session = undefined;
		authStorage = undefined;
		releaseTurn = undefined;
		releaseAdvisor = undefined;
	});

	/**
	 * File-backed session with a live advisor at the default `syncBacklog: "off"`.
	 * The primary turn parks on `releaseTurn`; the advisor review parks on
	 * `releaseAdvisor`, so a review can be held genuinely in flight while the
	 * restart barrier runs.
	 */
	async function buildAdvisorRestartSession(): Promise<AdvisorRestartHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");

		const turnStarted = Promise.withResolvers<void>();
		const turnGate = Promise.withResolvers<void>();
		const primaryMock = createMockModel({
			handler: async () => {
				turnStarted.resolve();
				await turnGate.promise;
				return { content: ["done"], stopReason: "stop" };
			},
		});

		const advisorStarted = Promise.withResolvers<void>();
		const advisorGate = Promise.withResolvers<void>();
		const advisorMock = createMockModel({
			responses: (async function* () {
				advisorStarted.resolve();
				await advisorGate.promise;
				yield {
					content: [{ type: "toolCall", name: "advise", arguments: { note: ADVISOR_NOTE, severity: "concern" } }],
				};
				yield { content: [], stopReason: "stop" };
			})(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: primaryMock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		const persisted: string[] = [];
		sessionManager.onEntryAppended = (entry: SessionEntry) => {
			if (entry.type === "custom_message" && entry.customType === ADVISOR_TYPE) {
				persisted.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		let restartCalls = 0;
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
			onRestartRequested: () => {
				restartCalls++;
			},
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		releaseTurn = turnGate.resolve;
		releaseAdvisor = advisorGate.resolve;
		return {
			session,
			get restartCalls() {
				return restartCalls;
			},
			persisted,
			turnStarted: turnStarted.promise,
			releaseTurn: turnGate.resolve,
			advisorStarted: advisorStarted.promise,
			releaseAdvisor: advisorGate.resolve,
		};
	}

	// The recycle's own turn queues the review that blocks it. Requesting the
	// restart mid-turn passes the pre-latch check (no review yet); the turn then
	// ends inside the barrier's quiescence wait and queues the review. Without
	// the drain the final quiescence check refuses `busy` forever; with it the
	// review completes, its note is preserved, and the restart succeeds.
	it("succeeds by draining the restart turn's own review, preserving its note", async () => {
		const h = await buildAdvisorRestartSession();

		const turn = h.session.prompt("do work");
		await h.turnStarted;

		// Pre-latch check passes: the turn has not ended, so no review exists yet.
		const restart: Promise<RequestRestartResult> = h.session.requestRestart();
		await drainEventLoop();

		// End the turn: onPrimaryTurnEnd queues the review, which starts and parks.
		h.releaseTurn();
		await h.advisorStarted;
		// The barrier reaches its drain (fix) or its busy refusal (ablation) while
		// the review is genuinely in flight.
		await drainEventLoop();

		// Let the held review complete; the drain waits for it and preserves the note.
		h.releaseAdvisor();

		expect(await restart).toEqual({ ok: true });
		expect(h.restartCalls).toBe(1);
		// Waited, not aborted: the review ran to completion and its note survived
		// the recycle as a persisted card.
		expect(h.persisted.some(note => note.includes(ADVISOR_NOTE))).toBe(true);
		await turn;
	});

	// The pre-latch busy check still holds the invariant: a review already in
	// flight when requestRestart() is CALLED — a genuinely user-initiated one
	// from an earlier turn — blocks the recycle rather than being drained under.
	it("still refuses busy while a review requested before the restart is active", async () => {
		const h = await buildAdvisorRestartSession();

		// Run the turn to completion FIRST: at syncBacklog "off" its review is
		// queued and left in flight (parked on the advisor gate) after the turn.
		h.releaseTurn();
		await h.session.prompt("do work");
		await h.advisorStarted;

		// The review predates this call, so the pre-latch check sees it and refuses.
		await expect(h.session.requestRestart()).resolves.toEqual({ ok: false, reason: "busy" });
		expect(h.restartCalls).toBe(0);

		h.releaseAdvisor();
		await drainEventLoop();
	});
});
