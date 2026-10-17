/**
 * Session-owned idle maintenance (idle recap + idle compaction), driven the way a host drives it: a real
 * `AgentSession` runs real turns against a scripted provider, the owner opts in with `enableIdleMaintenance`,
 * and the observable results are model requests, journaled recaps, `idle_recap` events and idle compaction passes.
 *
 * Time is frozen with fake timers. Real async work (promises, I/O, `setImmediate`) keeps running under them, so the
 * helpers below yield the event loop instead of guessing durations; only the zero-delay timer a model request awaits is
 * released by nudging the clock, and never once the turn under test has ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRecapEnabled, cfgRecapIdleSeconds } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgCompactionIdleEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { listSessionRecaps, resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { drive, driveTurn, elapse, flush, until, wait } from "../helpers/fake-clock";
import { isolateAgentDir } from "../helpers/rpc-server-harness";

/**
 * Delays are configured explicitly rather than inherited from the setting defaults, so the boundary tests pin the
 * scheduler's timing and clamping, not whatever the defaults happen to be.
 */
const RECAP_SECONDS = 240;
const COMPACTION_SECONDS = 300;
const RECAP_DELAY_MS = RECAP_SECONDS * 1000;
const COMPACTION_DELAY_MS = COMPACTION_SECONDS * 1000;
const HOUR_MS = 3_600_000;
const RECAP = "Reworking the login flow; auth suite passes. Next: wire the focused token-refresh test.";
const JOB_OWNER = "IdleOwner";

type IdleRecapEvent = Extract<AgentSessionEvent, { type: "idle_recap" }>;

interface ScriptedModel {
	model: MockModel;
	/** Park the next provider request until `release`; `started` settles once the request has been issued. */
	hold(): { started: Promise<void>; release(response: MockResponse): void };
}

function scriptedModel(fallback: MockResponse): ScriptedModel {
	const model = createMockModel({ handler: fallback });
	return {
		model,
		hold() {
			const started = Promise.withResolvers<void>();
			const reply = Promise.withResolvers<MockResponse>();
			model.push(() => {
				started.resolve();
				return reply.promise;
			});
			return { started: started.promise, release: response => reply.resolve(response) };
		},
	};
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	events: AgentSessionEvent[];
	/** The side channel the idle recap uses; replies with {@link RECAP} unless scripted. */
	side: ScriptedModel;
	jobs: AsyncJobManager | undefined;
}

interface SessionOptions {
	settings?: Record<string, unknown>;
	passiveReplica?: boolean;
	/** Give the session an owner-scoped async job manager (for background work). */
	backgroundJobs?: boolean;
}

describe("AgentSession idle maintenance", () => {
	let restoreAgentDir: () => void;
	let root: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-idle-maintenance-"));
		fs.mkdirSync(path.join(root, "agent"), { recursive: true });
		fs.mkdirSync(path.join(root, "cwd"), { recursive: true });
		// Recaps are journaled in the process-wide history.db under the agent dir.
		restoreAgentDir = isolateAgentDir(path.join(root, "agent"));
		resetSessionIndexForTests();
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		vi.useFakeTimers();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await drive(session.dispose());
		vi.useRealTimers();
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		authStorage.close();
		resetSessionIndexForTests();
		restoreAgentDir();
		removeSyncWithRetries(root);
	});

	// ── harness ─────────────────────────────────────────────────────────────

	async function startSession(options: SessionOptions = {}): Promise<Harness> {
		const main = scriptedModel({ content: ["Work finished."], usage: { input: 5_000, output: 20 } });
		const side = scriptedModel({ content: [RECAP] });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const settings = Settings.isolated({
			"todo.reminders": false,
			"recap.idleSeconds": RECAP_SECONDS,
			"compaction.idleTimeoutSeconds": COMPACTION_SECONDS,
			...options.settings,
		});
		const jobs = options.backgroundJobs ? new AsyncJobManager({}) : undefined;
		if (jobs) AsyncJobManager.setInstance(jobs);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: main.model.stream,
			}),
			sessionManager: SessionManager.create(path.join(root, "cwd"), path.join(root, "sessions")),
			settings,
			modelRegistry,
			sideStreamFn: side.model.stream,
			passiveReplica: options.passiveReplica,
			...(jobs ? { agentId: JOB_OWNER, asyncJobManager: jobs } : {}),
		});
		sessions.push(session);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		return { session, settings, events, side, jobs };
	}

	/** The session is idle by its own authoritative barrier, and anything chained on it has run. */
	async function settle(h: Harness): Promise<void> {
		await wait(h.session.waitForIdle());
		await flush();
	}

	/** Finish a submission that is already underway: the clock stands still once its terminal `agent_end` is out. */
	async function finishTurn(h: Harness, turn: Promise<unknown>): Promise<void> {
		await driveTurn(h.session, turn);
		await settle(h);
	}

	const runTurn = (h: Harness, text = "please work"): Promise<void> => finishTurn(h, h.session.prompt(text));

	const sideCalls = (h: Harness): number => h.side.model.calls.length;
	const idleRecaps = (h: Harness): IdleRecapEvent[] =>
		h.events.filter((event): event is IdleRecapEvent => event.type === "idle_recap");
	const journal = (): string[] => listSessionRecaps().map(row => row.recap);

	function lastUserText(context: Context): string {
		const message = context.messages.findLast(candidate => candidate.role === "user");
		if (!message) return "";
		return typeof message.content === "string"
			? message.content
			: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
	}

	/** A recap request that is parked mid-flight, with the abort signal it was issued under. */
	async function startHeldRecap(h: Harness) {
		const held = h.side.hold();
		await elapse(RECAP_DELAY_MS);
		await wait(held.started);
		const signal = h.side.model.calls[0]?.options?.signal;
		expect(signal?.aborted).toBe(false);
		return { held, signal };
	}

	/** An owner-scoped background job that can still wake the session until it is acknowledged elsewhere. */
	function startBackgroundJob(h: Harness) {
		const done = Promise.withResolvers<string>();
		h.jobs?.register("bash", "background work", () => done.promise, { id: "idle-job", ownerId: JOB_OWNER });
		return {
			/** The result is consumed by someone else, so finishing delivers nothing and wakes nobody. */
			async finishWithoutWake() {
				h.jobs?.acknowledgeDeliveries(["idle-job"]);
				done.resolve("finished");
				await drive(h.session.settleAsyncWork());
				await flush();
			},
		};
	}

	// ── opt-in ──────────────────────────────────────────────────────────────

	describe("opt-in", () => {
		it("does nothing for a session that never opted in", async () => {
			const h = await startSession({
				settings: { "compaction.idleEnabled": true, "compaction.idleThresholdTokens": 1_000 },
			});
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);

			await runTurn(h);
			await elapse(2 * HOUR_MS);

			expect(sideCalls(h)).toBe(0);
			expect(compaction).not.toHaveBeenCalled();
			expect(idleRecaps(h)).toEqual([]);
		});

		it("produces one recap per idle stretch however often the owner activates it", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();
			h.session.enableIdleMaintenance();
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(RECAP_DELAY_MS);
			await until(() => sideCalls(h) >= 1, "the recap request");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toEqual([{ type: "idle_recap", recap: RECAP }]);
			expect(journal()).toEqual([RECAP]);
		});

		it("a repeated activation keeps the first probes instead of replacing them", async () => {
			const h = await startSession();
			let blocked = true;
			h.session.enableIdleMaintenance({ isBlocked: () => blocked });
			// A view re-asserting itself hands over fresh closures; they must not displace the blocker already in force.
			h.session.enableIdleMaintenance({ isBlocked: () => false });

			await runTurn(h);
			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			blocked = false;
			h.session.refreshIdleMaintenance();
			await flush();
			await elapse(RECAP_DELAY_MS);
			await until(() => sideCalls(h) >= 1, "the recap request");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("never schedules maintenance on a passive replica", async () => {
			const h = await startSession({
				passiveReplica: true,
				settings: { "compaction.idleEnabled": true, "compaction.idleThresholdTokens": 1_000 },
			});
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);

			h.session.enableIdleMaintenance();
			await runTurn(h);
			h.session.refreshIdleMaintenance();
			await flush();
			await elapse(2 * HOUR_MS);

			expect(sideCalls(h)).toBe(0);
			expect(compaction).not.toHaveBeenCalled();
			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);
		});
	});

	// ── idle recap ──────────────────────────────────────────────────────────

	describe("idle recap", () => {
		it("recaps once after the configured delay, anchored on the title and active task, journaled before it is announced", async () => {
			const h = await startSession();
			await drive(h.session.setSessionName("Fix login flow", "user"));
			h.session.setTodoPhases([{ name: "Work", tasks: [{ content: "Wire focused tests", status: "pending" }] }]);
			h.session.enableIdleMaintenance();
			let journalWhenAnnounced: string[] | undefined;
			h.session.subscribe(event => {
				if (event.type === "idle_recap") journalWhenAnnounced = journal();
			});

			await runTurn(h);
			await elapse(RECAP_DELAY_MS - 1);
			expect(sideCalls(h)).toBe(0);
			vi.advanceTimersByTime(1);
			await until(() => idleRecaps(h).length === 1, "the recap event");

			const request = h.side.model.calls[0];
			expect(sideCalls(h)).toBe(1);
			// Live title and active todo task anchor the request; the transcript alone cannot guarantee them.
			expect(lastUserText(request.context)).toContain("Fix login flow");
			expect(lastUserText(request.context)).toContain("Wire focused tests");
			expect(idleRecaps(h)).toEqual([{ type: "idle_recap", recap: RECAP }]);
			expect(journalWhenAnnounced).toEqual([RECAP]);

			// One delivery per stretch, however long the session then stays idle.
			await elapse(3 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("announces and journals the full reply, not a one-line preview", async () => {
			const h = await startSession();
			const reply = Array.from(
				{ length: 40 },
				(_, i) => `Step ${i + 1}: finished unit ${i * 17 + 3} and moved on.`,
			).join("\n");
			h.side.model.push({ content: [reply] });
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(RECAP_DELAY_MS);
			await until(() => idleRecaps(h).length === 1, "the recap event");

			expect(idleRecaps(h)).toEqual([{ type: "idle_recap", recap: reply }]);
			expect(journal()).toEqual([reply]);
		});

		it.each([
			["below the floor", 0, 1_000],
			["above the ceiling", 99_999, HOUR_MS],
		] as const)("clamps a recap delay configured %s", async (_label, configured, expectedMs) => {
			const h = await startSession({ settings: { "recap.idleSeconds": configured } });
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(expectedMs - 1);
			expect(sideCalls(h)).toBe(0);
			vi.advanceTimersByTime(1);
			await until(() => sideCalls(h) === 1, "the recap request");
		});

		it("new activity restarts the idle clock", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(200_000);
			await runTurn(h);
			// The first stretch's deadline passes during this window and must not fire.
			await elapse(RECAP_DELAY_MS - 1);
			expect(sideCalls(h)).toBe(0);
			vi.advanceTimersByTime(1);
			await until(() => sideCalls(h) === 1, "the recap request");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("suppresses a recap whose reply is blank", async () => {
			const h = await startSession();
			h.side.model.push({ content: ["  \n  "] });
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(RECAP_DELAY_MS);
			await until(() => sideCalls(h) === 1, "the recap request");
			await flush();

			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);
		});

		it("swallows a failed recap request and recaps the next stretch", async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on("unhandledRejection", onUnhandled);
			try {
				const h = await startSession();
				h.side.model.push({ throw: "provider exploded" });
				h.session.enableIdleMaintenance();

				await runTurn(h);
				await elapse(RECAP_DELAY_MS);
				await until(() => sideCalls(h) === 1, "the failing recap request");
				await flush();
				expect(idleRecaps(h)).toEqual([]);
				expect(journal()).toEqual([]);

				await runTurn(h);
				await elapse(RECAP_DELAY_MS);
				await until(() => idleRecaps(h).length === 1, "the next stretch's recap");
				await flush();

				expect(idleRecaps(h)).toEqual([{ type: "idle_recap", recap: RECAP }]);
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		});
	});

	// ── live settings ───────────────────────────────────────────────────────

	describe("live settings", () => {
		it("arms the recap when it is enabled mid-idle and never re-delivers a shown recap", async () => {
			const h = await startSession({ settings: { "recap.enabled": false, "recap.idleSeconds": 60 } });
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			cfgRecapEnabled.override(h.settings, true);
			await flush();
			await elapse(60_000);
			await until(() => sideCalls(h) === 1, "the recap request");
			await flush();
			expect(idleRecaps(h)).toHaveLength(1);

			// Same idle window: a later setting change must not schedule a second recap.
			cfgRecapIdleSeconds.override(h.settings, 90);
			await flush();
			await elapse(2 * 90_000);
			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("cancels a pending recap when recap is disabled live", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();

			await runTurn(h);
			cfgRecapEnabled.override(h.settings, false);
			await flush();
			await elapse(2 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(0);
			expect(idleRecaps(h)).toEqual([]);
		});

		it("re-arms a pending recap with the new delay when it changes live", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();

			await runTurn(h);
			cfgRecapIdleSeconds.override(h.settings, 60);
			await flush();
			await elapse(59_999);
			expect(sideCalls(h)).toBe(0);
			vi.advanceTimersByTime(1);
			await until(() => sideCalls(h) === 1, "the recap request");
		});
	});

	// ── idle compaction ─────────────────────────────────────────────────────

	describe("idle compaction", () => {
		const enabled = {
			"recap.enabled": false,
			"compaction.idleEnabled": true,
			"compaction.idleThresholdTokens": 1_000,
		};

		it("compacts once after the configured delay when context is over the threshold", async () => {
			const h = await startSession({ settings: enabled });
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(COMPACTION_DELAY_MS - 1);
			expect(compaction).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			await until(() => compaction.mock.calls.length === 1, "the idle compaction pass");
			await elapse(2 * COMPACTION_DELAY_MS);

			expect(compaction).toHaveBeenCalledTimes(1);
		});

		it.each([
			["below the floor", 5, 60_000],
			["above the ceiling", 99_999, HOUR_MS],
		] as const)("clamps a compaction delay configured %s", async (_label, configured, expectedMs) => {
			const h = await startSession({ settings: { ...enabled, "compaction.idleTimeoutSeconds": configured } });
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(expectedMs - 1);
			expect(compaction).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			await until(() => compaction.mock.calls.length === 1, "the idle compaction pass");
		});

		it("leaves a context below the threshold alone", async () => {
			const h = await startSession({ settings: { ...enabled, "compaction.idleThresholdTokens": 1_000_000 } });
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(2 * HOUR_MS);

			expect(compaction).not.toHaveBeenCalled();
		});

		it("is off unless idle compaction is enabled", async () => {
			const h = await startSession({
				settings: { "recap.enabled": false, "compaction.idleThresholdTokens": 1_000 },
			});
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await elapse(2 * HOUR_MS);

			expect(compaction).not.toHaveBeenCalled();
		});

		it("arms idle compaction when it is enabled after the turn becomes idle", async () => {
			const h = await startSession({
				settings: {
					"recap.enabled": false,
					"compaction.idleEnabled": false,
					"compaction.idleThresholdTokens": 1_000,
					"compaction.idleTimeoutSeconds": 60,
				},
			});
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			h.session.enableIdleMaintenance();

			await runTurn(h);
			cfgCompactionIdleEnabled.override(h.settings, true);
			await flush();
			await elapse(60_000);
			await until(() => compaction.mock.calls.length === 1, "the idle compaction pass");
		});

		it("cancels scheduled idle compaction when the session is disposed", async () => {
			const h = await startSession({ settings: { ...enabled, "compaction.idleTimeoutSeconds": 60 } });
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			h.session.enableIdleMaintenance();

			await runTurn(h);
			await drive(h.session.dispose());
			await elapse(HOUR_MS);

			expect(compaction).not.toHaveBeenCalled();
		});
	});

	// ── blockers owned by the host ──────────────────────────────────────────

	describe("owner blockers", () => {
		it("starts no work while the owner is blocked, and a refresh re-arms the pending recap once it is not", async () => {
			const h = await startSession();
			let blocked = true;
			h.session.enableIdleMaintenance({ isBlocked: () => blocked });

			await runTurn(h);
			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			blocked = false;
			h.session.refreshIdleMaintenance();
			await flush();
			await elapse(RECAP_DELAY_MS);
			await until(() => idleRecaps(h).length === 1, "the recap event");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("re-reads the blocker when the timer fires, and keeps the recap pending for a later refresh", async () => {
			const h = await startSession();
			let blocked = false;
			h.session.enableIdleMaintenance({ isBlocked: () => blocked });

			await runTurn(h);
			blocked = true;
			await elapse(RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			blocked = false;
			h.session.refreshIdleMaintenance();
			await flush();
			await elapse(RECAP_DELAY_MS);
			await until(() => idleRecaps(h).length === 1, "the recap event");
		});

		it("the same blocker suppresses idle compaction", async () => {
			const h = await startSession({
				settings: {
					"recap.enabled": false,
					"compaction.idleEnabled": true,
					"compaction.idleThresholdTokens": 1_000,
				},
			});
			const compaction = vi.spyOn(h.session, "runIdleCompaction").mockResolvedValue(undefined);
			let blocked = true;
			h.session.enableIdleMaintenance({ isBlocked: () => blocked });

			await runTurn(h);
			await elapse(2 * COMPACTION_DELAY_MS);
			expect(compaction).not.toHaveBeenCalled();

			blocked = false;
			h.session.refreshIdleMaintenance();
			await flush();
			await elapse(COMPACTION_DELAY_MS);
			await until(() => compaction.mock.calls.length === 1, "the idle compaction pass");
		});

		it("a refresh aborts a recap in flight once the owner has become blocked, and its late reply is dropped", async () => {
			const h = await startSession();
			let blocked = false;
			h.session.enableIdleMaintenance({ isBlocked: () => blocked });
			await runTurn(h);
			const { held, signal } = await startHeldRecap(h);

			blocked = true;
			h.session.refreshIdleMaintenance();
			await flush();
			expect(signal?.aborted).toBe(true);

			held.release({ content: ["stale recap after the blocker"] });
			await flush();
			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);
		});

		it("re-reads the blocker when the reply lands, even without a refresh", async () => {
			const h = await startSession();
			let blocked = false;
			h.session.enableIdleMaintenance({ isBlocked: () => blocked });
			await runTurn(h);
			const { held } = await startHeldRecap(h);

			blocked = true;
			held.release({ content: ["stale recap after the draft started"] });
			await flush();

			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);
		});

		it("waits out a scheduled continuation, then recaps once the owner refreshes after it is abandoned", async () => {
			const h = await startSession();
			let scheduled = true;
			h.session.enableIdleMaintenance({ scheduledTurn: () => scheduled });

			await runTurn(h);
			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			scheduled = false;
			h.session.refreshIdleMaintenance();
			await flush();
			await elapse(RECAP_DELAY_MS);
			await until(() => idleRecaps(h).length === 1, "the recap event");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
		});

		it("does not start work while maintenance is compacting", async () => {
			const h = await startSession();
			let compacting = false;
			Object.defineProperty(h.session, "isCompacting", { configurable: true, get: () => compacting });
			h.session.enableIdleMaintenance();

			await runTurn(h);
			compacting = true;
			await elapse(2 * RECAP_DELAY_MS);
			compacting = false;

			expect(sideCalls(h)).toBe(0);
		});
	});

	// ── a session that is not actually idle ─────────────────────────────────

	describe("busy session", () => {
		it("queued input prevents idle work, and the next stretch is recapped once", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();
			await runTurn(h);

			h.session.agent.followUp({
				role: "user",
				content: [{ type: "text", text: "one more thing" }],
				timestamp: Date.now(),
			});
			expect(h.session.queuedMessageCount).toBe(1);
			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			h.session.clearQueue();
			await runTurn(h);
			await elapse(RECAP_DELAY_MS);
			await until(() => sideCalls(h) >= 1, "the recap request");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("an admitted submission that has not started a turn prevents idle work", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();
			await runTurn(h);

			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
				entered.resolve();
				await release.promise;
				return images;
			});
			const submitted = h.session.prompt("a second request");
			await wait(entered.promise);
			expect(h.session.hasAdmittedSubmission).toBe(true);
			expect(h.session.isStreaming).toBe(false);

			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			release.resolve();
			await finishTurn(h, submitted);
			await elapse(RECAP_DELAY_MS);
			await until(() => sideCalls(h) >= 1, "the recap request");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
			expect(idleRecaps(h)).toHaveLength(1);
		});

		it("waits for background work that can still wake the session, then recaps once it drains without a wake", async () => {
			const h = await startSession({ backgroundJobs: true });
			h.session.enableIdleMaintenance();
			const job = startBackgroundJob(h);

			await runTurn(h);
			expect(h.session.hasPendingAsyncWork()).toBe(true);
			await elapse(2 * RECAP_DELAY_MS);
			expect(sideCalls(h)).toBe(0);

			await job.finishWithoutWake();
			expect(h.session.hasPendingAsyncWork()).toBe(false);
			await elapse(RECAP_DELAY_MS);
			await until(() => idleRecaps(h).length === 1, "the recap event");
			await flush();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(1);
		});
	});

	// ── supersession ────────────────────────────────────────────────────────

	describe("supersession", () => {
		it("new activity aborts the recap in flight and drops its late reply; the next stretch is recapped", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();
			await runTurn(h);
			const { held, signal } = await startHeldRecap(h);

			await runTurn(h);
			expect(signal?.aborted).toBe(true);

			held.release({ content: ["stale recap from before the new turn"] });
			await flush();
			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);

			await elapse(RECAP_DELAY_MS);
			await until(() => idleRecaps(h).length === 1, "the next stretch's recap");
			expect(idleRecaps(h)).toEqual([{ type: "idle_recap", recap: RECAP }]);
			expect(journal()).toEqual([RECAP]);
			expect(sideCalls(h)).toBe(2);
		});

		it("disposal aborts the recap in flight and drops its late reply", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();
			await runTurn(h);
			const { held, signal } = await startHeldRecap(h);

			const disposing = drive(h.session.dispose());
			await flush();
			expect(signal?.aborted).toBe(true);

			held.release({ content: ["stale recap after disposal"] });
			await disposing;
			await flush();
			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);
		});

		it("a session replacement drops a recap reply captured before it", async () => {
			const h = await startSession();
			h.session.enableIdleMaintenance();
			await runTurn(h);
			const { held } = await startHeldRecap(h);

			await drive(h.session.newSession());
			held.release({ content: ["stale recap for the replaced session"] });
			await flush();

			expect(idleRecaps(h)).toEqual([]);
			expect(journal()).toEqual([]);
		});

		it("a session replacement supersedes a check that was still waiting on background work", async () => {
			const h = await startSession({ backgroundJobs: true });
			h.session.enableIdleMaintenance();
			const job = startBackgroundJob(h);
			await runTurn(h);

			await drive(h.session.newSession());
			// The replacement holds a conversation now, so a stale check that armed would find something to recap.
			h.session.sessionManager.appendMessage({ role: "user", content: "carry on", timestamp: Date.now() });
			h.session.sessionManager.appendMessage(createAssistantMessage("carried on"));
			h.session.agent.replaceMessages(h.session.buildDisplaySessionContext().messages);
			await job.finishWithoutWake();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(0);
			expect(idleRecaps(h)).toEqual([]);
		});

		it("a same-session reload supersedes a check that was still waiting on background work", async () => {
			const h = await startSession({ backgroundJobs: true });
			h.session.enableIdleMaintenance();
			const job = startBackgroundJob(h);
			await runTurn(h);
			await drive(h.session.sessionManager.flush());

			// The session id never changes on a reload, so only the transition itself can supersede the check.
			await drive(h.session.reload());
			await job.finishWithoutWake();
			await elapse(3 * RECAP_DELAY_MS);

			expect(sideCalls(h)).toBe(0);
			expect(idleRecaps(h)).toEqual([]);
		});
	});
});
