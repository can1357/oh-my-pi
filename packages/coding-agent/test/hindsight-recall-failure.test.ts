import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createHindsightClient,
	HindsightApi,
	type HindsightClientApi,
	HindsightError,
	type RecallOptions,
	type RecallResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import {
	type HindsightConfig,
	isHindsightConfigured,
	loadHindsightConfig,
} from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HINDSIGHT_NOTICE_SOURCE, HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const config = {
	hindsightApiUrl: "http://localhost:8888",
	hindsightApiToken: null,
	bankId: null,
	bankIdPrefix: "",
	scoping: "global",
	globalScope: false,
	bankMission: "",
	retainMission: null,
	autoRecall: true,
	autoRetain: true,
	retainMode: "full-session",
	retainEveryNTurns: 3,
	retainOverlapTurns: 2,
	retainContext: "omp",
	recallBudget: "mid",
	recallMaxTokens: 1024,
	recallTypes: [],
	recallContextTurns: 1,
	recallMaxQueryChars: 800,
	recallPromptPreamble: "preamble",
	recallCooldownMs: 60_000,
	debug: false,
	requestTimeoutMs: 30_000,
	reflectTimeoutMs: 30_000,
	recallTimeoutMs: 30_000,
	retainTimeoutMs: 30_000,
	mentalModelsEnabled: false,
	mentalModelAutoSeed: false,
	mentalModelMaxRenderChars: 16_000,
} satisfies HindsightConfig;

interface Notice {
	level: string;
	message: string;
	source?: string;
}

/** Recall that fails with `error` once `fail()` is called, or rejects as soon as its signal aborts. */
class FailingRecallApi extends HindsightApi {
	#failures: (() => void)[] = [];

	constructor(readonly error: Error) {
		super({ baseUrl: "http://localhost" });
	}

	override recall(_bankId: string, _query: string, options?: RecallOptions): Promise<never> {
		const { promise, reject } = Promise.withResolvers<never>();
		options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
		this.#failures.push(() => reject(this.error));
		return promise;
	}

	fail(): void {
		for (const fail of this.#failures.splice(0)) fail();
	}
}

/** What a test made; removed after it. */
const dirs: TempDir[] = [];
const managers: SessionManager[] = [];
const states: HindsightSessionState[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
	setSystemTime();
	vi.restoreAllMocks();
	for (const state of states.splice(0)) state.dispose();
	for (const server of servers.splice(0)) await server.stop(true);
	for (const manager of managers.splice(0)) await manager.close();
	for (const dir of dirs.splice(0)) await dir.remove();
});

function newSessionManager(): SessionManager {
	const dir = TempDir.createSync("@hindsight-recall-failure-");
	dirs.push(dir);
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	managers.push(manager);
	return manager;
}

/** A session over `sessionManager`; its notices land in `notices`. */
function noticeSession(sessionManager: SessionManager) {
	const notices: Notice[] = [];
	const session = {
		sessionId: sessionManager.getSessionId(),
		sessionManager,
		emitNotice: (level: string, message: string, source?: string) => notices.push({ level, message, source }),
	} as object as AgentSession;
	return { session, notices };
}

/** One process: a Hindsight state over `sessionManager`; its notices land in `notices`. */
function start(sessionManager: SessionManager, client: HindsightClientApi, stateConfig: HindsightConfig = config) {
	const { session, notices } = noticeSession(sessionManager);
	const state = new HindsightSessionState({
		sessionId: session.sessionId,
		client,
		bankId: "b",
		config: stateConfig,
		session,
		banksSet: new Set(),
	});
	states.push(state);
	return { state, notices };
}

/** A subagent's state, built from `primary` as the Hindsight backend builds it; its notices land in its own list. */
function startAlias(primary: HindsightSessionState) {
	const { session, notices } = noticeSession(newSessionManager());
	const state = new HindsightSessionState({
		sessionId: session.sessionId,
		client: primary.client,
		bankId: primary.bankId,
		retainTags: primary.retainTags,
		recallTags: primary.recallTags,
		recallTagsMatch: primary.recallTagsMatch,
		config: primary.config,
		session,
		banksSet: primary.banksSet,
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: true,
		aliasOf: primary,
	});
	states.push(state);
	return { state, notices };
}

function setup(error: Error = new HindsightError("recall request timed out after 30s")) {
	const client = new FailingRecallApi(error);
	return { client, ...start(newSessionManager(), client) };
}

describe("Hindsight recall failure notice", () => {
	it("warns once with server text stripped of terminal controls and bounded to one line", async () => {
		const { notices, client, state } = setup(
			new HindsightError(`recall failed: \x1b[2Jboom\nline two\t${"x".repeat(5000)}`, 500),
		);
		const outcome = state.recallForContext("query");
		client.fail();

		const result = await outcome;
		expect(result).toMatchObject({ context: null, ok: false });
		expect(notices).toHaveLength(1);
		const [notice] = notices;
		expect(notice.level).toBe("warning");
		expect(notice.source).toBe(HINDSIGHT_NOTICE_SOURCE);
		expect(notice.message.startsWith("Memory recall failed: recall failed: boom line two x")).toBe(true);
		expect(notice.message).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(notice.message.length).toBeLessThan(250);
	});

	it("stays silent when a superseded compaction aborts its recall", async () => {
		const { notices, state } = setup();
		const controller = new AbortController();
		const outcome = state.recallForCompaction([{ role: "user", content: "what did we decide?" }], controller.signal);
		controller.abort();

		expect(await outcome).toBeUndefined();
		expect(notices).toEqual([]);
	});

	it("stays silent when the failure lands after a conversation reset", async () => {
		const { notices, client, state } = setup();
		const outcome = state.recallForContext("query");
		state.resetConversationTracking();
		client.fail();

		expect((await outcome).ok).toBe(false);
		expect(notices).toEqual([]);
	});
});

const PROMPT = "Where is the deploy host?";
/** How long a first failed automatic recall holds off the next one. */
const COOLDOWN_MS = config.recallCooldownMs;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

async function failWithBoom(): Promise<RecallResponse> {
	throw new HindsightError("recall request failed: boom");
}

function answerWith(text: string): () => Promise<RecallResponse> {
	return async () => ({ results: [{ id: "m", text }] });
}

/** The first pause with the shipped settings: the default of `hindsight.recallCooldownMs`. */
const SHIPPED_FIRST_PAUSE_MS = 60_000;

/**
 * The config of a user who sets only the server and automatic recall: each pause setting keeps its default.
 * `overrides` replaces or adds settings.
 */
function shippedConfig(overrides: Record<string, unknown> = {}): HindsightConfig {
	return loadHindsightConfig(
		Settings.isolated({
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.autoRecall": true,
			"hindsight.autoRetain": false,
			"hindsight.mentalModelsEnabled": false,
			...overrides,
		}),
	);
}

/** Counts its recalls; each one does what `answer` does, by default fail at once with "boom". */
class CountingRecallApi extends HindsightApi {
	calls = 0;
	answer: (options?: RecallOptions) => Promise<RecallResponse> = failWithBoom;

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override recall(_bankId: string, _query: string, options?: RecallOptions): Promise<RecallResponse> {
		this.calls++;
		return this.answer(options);
	}
}

describe("Hindsight automatic recall after a failure", () => {
	function promptAt(state: HindsightSessionState, time: number) {
		setSystemTime(time);
		return state.beforeAgentStartPrompt(PROMPT);
	}

	function compactAt(state: HindsightSessionState, time: number) {
		setSystemTime(time);
		return state.recallForCompaction([{ role: "user", content: "what did we decide?" }]);
	}

	/**
	 * Prompts one second before `end`, when a pause must end, and one second after it.
	 * Returns whether the first prompt sent no recall and the second prompt sent one.
	 */
	async function promptAroundEnd(state: HindsightSessionState, client: CountingRecallApi, end: number) {
		const before = client.calls;
		await promptAt(state, end - 1_000);
		const skipped = client.calls === before;
		const after = client.calls;
		await promptAt(state, end + 1_000);
		return { skipped, recalled: client.calls > after };
	}

	/** A primary state with the shipped settings and a subagent's state built from it; every recall times out. */
	function startWithAlias() {
		const client = new CountingRecallApi();
		client.answer = async () => {
			throw new HindsightError("recall request timed out after 1s");
		};
		const primary = start(newSessionManager(), client, shippedConfig());
		return { client, primary, alias: startAlias(primary.state) };
	}

	/** Persists the turn the session sent, which puts the transcript on disk; returns its file. */
	async function writeTurn(sessionManager: SessionManager): Promise<string> {
		sessionManager.appendMessage({ role: "user", content: PROMPT, timestamp: Date.now() });
		sessionManager.appendMessage(createAssistantMessage("alpha-7"));
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("session was not persisted");
		return sessionFile;
	}

	it("makes one recall request across two prompts after a first-turn recall times out", async () => {
		let recallRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// The recall must run into the client's own deadline, not the server's idle cutoff.
			idleTimeout: 0,
			fetch(request) {
				if (!new URL(request.url).pathname.endsWith("/memories/recall")) return Response.json({});
				recallRequests++;
				return new Promise<Response>(() => {});
			},
		});
		servers.push(server);
		const shipped = shippedConfig({ "hindsight.apiUrl": server.url.origin, "hindsight.recallTimeoutMs": 1_000 });
		if (!isHindsightConfigured(shipped)) throw new Error("hindsight.apiUrl did not resolve");
		const { state } = start(newSessionManager(), createHindsightClient(shipped), shipped);

		const first = await state.beforeAgentStartPrompt(PROMPT);
		const second = await state.beforeAgentStartPrompt("And the staging host?");

		// Printed so that a run on older code shows how many requests it made.
		console.log(JSON.stringify({ recallRequests }));
		expect(first).toBeUndefined();
		expect(second).toBeUndefined();
		expect(recallRequests).toBe(1);
	}, 10_000);

	it("logs a failed recall once with its cause and a skipped recall once", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const client = new CountingRecallApi();
		const { state, notices } = start(newSessionManager(), client);
		setSystemTime(T0);
		for (const prompt of [PROMPT, "And the staging host?", "And the backup host?"]) {
			expect(await state.beforeAgentStartPrompt(prompt)).toBeUndefined();
		}
		const failureLines = warn.mock.calls.filter(([message]) => message === "Hindsight: recall failed");
		const skipLines = warn.mock.calls.filter(
			([message]) => message === "Hindsight: recall skipped after a recent failure",
		);

		expect(failureLines).toHaveLength(1);
		expect(String(failureLines[0][1]?.error)).toContain("boom");
		expect(skipLines).toHaveLength(1);
		expect(skipLines[0][1]).toMatchObject({ bankId: "b", failures: 1 });
		expect(String(skipLines[0][1]?.error)).toContain("boom");
		// Both lines name the retry time of the one stored failure.
		expect(failureLines[0][1]?.retryAfter).toBe(skipLines[0][1]?.retryAfter);
		expect(notices).toHaveLength(2);
		const [failure, skip] = notices;
		expect(failure).toEqual({
			level: "warning",
			message: "Memory recall failed: recall request failed: boom",
			source: HINDSIGHT_NOTICE_SOURCE,
		});
		expect(skip).toMatchObject({ level: "warning", source: HINDSIGHT_NOTICE_SOURCE });
		expect(skip.message).toContain("boom");
		expect(skip.message).not.toBe(failure.message);
		expect(client.calls).toBe(1);
	});

	it("an answer after a pause starts the next pause again at the first length", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, shippedConfig());
		await promptAt(state, T0);
		expect(client.calls).toBe(1);

		const recovered = T0 + SHIPPED_FIRST_PAUSE_MS + 1_000;
		client.answer = answerWith("The deploy host is alpha-7.");
		// Left uncommitted, as when the turn never goes out: the next prompt recalls again.
		const answered = await promptAt(state, recovered);
		expect(client.calls).toBe(2);
		expect(answered?.context).toContain("alpha-7");
		client.answer = failWithBoom;
		await promptAt(state, recovered);
		expect(client.calls).toBe(3);

		await promptAt(state, recovered + SHIPPED_FIRST_PAUSE_MS - 1_000);
		expect(client.calls).toBe(3);
		await promptAt(state, recovered + SHIPPED_FIRST_PAUSE_MS + 1_000);
		expect(client.calls).toBe(4);
	});

	it("an answer with no memories also starts the next pause again at the first length", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, shippedConfig());
		await promptAt(state, T0);
		expect(client.calls).toBe(1);

		const recovered = T0 + SHIPPED_FIRST_PAUSE_MS + 1_000;
		// A bank with nothing to recall answers with no results; the server is up all the same.
		client.answer = async () => ({ results: [] });
		const answered = await promptAt(state, recovered);
		expect(answered).toBeDefined();
		expect(answered?.context).toBeUndefined();
		client.answer = failWithBoom;
		await promptAt(state, recovered);
		expect(client.calls).toBe(3);

		expect(await promptAroundEnd(state, client, recovered + SHIPPED_FIRST_PAUSE_MS)).toEqual({
			skipped: true,
			recalled: true,
		});
	});

	it("the first skip after each new failure is logged and shown once", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const client = new CountingRecallApi();
		const { state, notices } = start(newSessionManager(), client, shippedConfig());
		const secondFailure = T0 + SHIPPED_FIRST_PAUSE_MS + 1_000;
		for (const failedAt of [T0, secondFailure]) {
			for (const offset of [0, 1_000, 2_000]) await promptAt(state, failedAt + offset);
		}
		const skipLines = warn.mock.calls.filter(
			([message]) => message === "Hindsight: recall skipped after a recent failure",
		);

		expect(client.calls).toBe(2);
		expect(skipLines.map(([, fields]) => fields?.failures)).toEqual([1, 2]);
		expect(notices.map(notice => (notice.message.startsWith("Memory recall failed:") ? "failed" : "paused"))).toEqual(
			["failed", "paused", "failed", "paused"],
		);
	});

	it("the pause doubles up to 30 minutes", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, shippedConfig());
		await promptAt(state, T0);
		// Each recall after a pause fails again, so each pause comes after one more failure in a row.
		const pauseMinutes = [1, 2, 4, 8, 16, 30, 30];
		const observed: { minutes: number; skipped: boolean; recalled: boolean }[] = [];
		let failedAt = T0;
		for (const minutes of pauseMinutes) {
			const end = failedAt + minutes * 60_000;
			observed.push({ minutes, ...(await promptAroundEnd(state, client, end)) });
			failedAt = end + 1_000;
		}

		expect(observed).toEqual(pauseMinutes.map(minutes => ({ minutes, skipped: true, recalled: true })));
		expect(client.calls).toBe(pauseMinutes.length + 1);
	});

	it("a setting above 30 minutes pauses that long every time", async () => {
		const pauseMs = 2 * 60 * 60_000;
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, { ...config, recallCooldownMs: pauseMs });
		await promptAt(state, T0);
		const first = await promptAroundEnd(state, client, T0 + pauseMs);
		const secondFailure = T0 + pauseMs + 1_000;
		const second = await promptAroundEnd(state, client, secondFailure + pauseMs);

		expect([first, second]).toEqual([
			{ skipped: true, recalled: true },
			{ skipped: true, recalled: true },
		]);
	});

	it("an automatic recall that answers ends a running pause", async () => {
		setSystemTime(T0);
		const client = new CountingRecallApi();
		const { state, notices } = start(newSessionManager(), client, shippedConfig());
		const called = Promise.withResolvers<void>();
		const compactionAnswer = Promise.withResolvers<RecallResponse>();
		client.answer = () => {
			called.resolve();
			return compactionAnswer.promise;
		};
		const compaction = state.recallForCompaction([{ role: "user", content: "what did we decide?" }]);
		await called.promise;

		client.answer = failWithBoom;
		expect(await state.beforeAgentStartPrompt(PROMPT)).toBeUndefined();
		expect(notices[0]).toEqual({
			level: "warning",
			message: "Memory recall failed: recall request failed: boom",
			source: HINDSIGHT_NOTICE_SOURCE,
		});
		expect(await state.beforeAgentStartPrompt(PROMPT)).toBeUndefined();
		expect(client.calls).toBe(2);

		compactionAnswer.resolve({ results: [{ id: "m", text: "We chose alpha-7." }] });
		expect(await compaction).toContain("alpha-7");
		await state.beforeAgentStartPrompt(PROMPT);
		expect(client.calls).toBe(3);
	});

	it("the pause holds through a conversation reset", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, shippedConfig());
		await promptAt(state, T0);
		state.resetConversationTracking();
		await promptAt(state, T0 + 1_000);

		expect(client.calls).toBe(1);
	});

	it("a fresh process does not inherit a pause", async () => {
		const shipped = shippedConfig();
		setSystemTime(T0);
		const firstManager = newSessionManager();
		const first = start(firstManager, new CountingRecallApi(), shipped);
		expect(await first.state.beforeAgentStartPrompt(PROMPT)).toBeUndefined();
		const sessionFile = await writeTurn(firstManager);
		await firstManager.close();

		// Still inside the pause that the first process started.
		setSystemTime(T0 + 10_000);
		const resumedManager = await SessionManager.open(sessionFile);
		managers.push(resumedManager);
		const client = new CountingRecallApi();
		client.answer = answerWith("The deploy host is beta-9.");
		const resumed = start(resumedManager, client, shipped);
		const preparation = await resumed.state.beforeAgentStartPrompt(PROMPT);

		expect(client.calls).toBe(1);
		expect(preparation?.context).toContain("beta-9");
	});

	it("an aborted recall starts no pause", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client);
		const called = Promise.withResolvers<void>();
		client.answer = options => {
			called.resolve();
			const { promise, reject } = Promise.withResolvers<RecallResponse>();
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			return promise;
		};
		const controller = new AbortController();
		const aborted = state.beforeAgentStartPrompt(PROMPT, controller.signal);
		await called.promise;
		controller.abort();
		expect(await aborted).toBeUndefined();

		client.answer = failWithBoom;
		await state.beforeAgentStartPrompt(PROMPT);
		expect(client.calls).toBe(2);
	});

	it("a failure after a conversation reset starts no pause", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client);
		const called = Promise.withResolvers<void>();
		const pendingRecall = Promise.withResolvers<RecallResponse>();
		client.answer = () => {
			called.resolve();
			return pendingRecall.promise;
		};
		const stale = state.beforeAgentStartPrompt(PROMPT);
		await called.promise;
		state.resetConversationTracking();
		pendingRecall.reject(new HindsightError("recall request failed: boom"));
		expect(await stale).toBeUndefined();

		client.answer = failWithBoom;
		await state.beforeAgentStartPrompt(PROMPT);
		expect(client.calls).toBe(2);
	});

	it("the compaction recall waits out the pause, and its failure starts one", async () => {
		const messages = [{ role: "user", content: "what did we decide?" }];
		const afterPrompt = new CountingRecallApi();
		const prompted = start(newSessionManager(), afterPrompt).state;
		await promptAt(prompted, T0);
		setSystemTime(T0 + COOLDOWN_MS - 1_000);
		expect(await prompted.recallForCompaction(messages)).toBeUndefined();
		expect(afterPrompt.calls).toBe(1);

		const afterCompaction = new CountingRecallApi();
		const compacted = start(newSessionManager(), afterCompaction).state;
		setSystemTime(T0);
		expect(await compacted.recallForCompaction(messages)).toBeUndefined();
		expect(afterCompaction.calls).toBe(1);
		expect(await promptAt(compacted, T0 + COOLDOWN_MS - 1_000)).toBeUndefined();
		expect(afterCompaction.calls).toBe(1);
	});

	it("a pause longer than a date can hold still holds off the next recall and keeps the failure visible", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const client = new CountingRecallApi();
		// The largest integer the setting holds exactly, as a user sets it to mean "never recall again".
		const { state, notices } = start(newSessionManager(), client, {
			...config,
			recallCooldownMs: Number.MAX_SAFE_INTEGER,
		});

		await expect(promptAt(state, T0)).resolves.toBeUndefined();
		await expect(promptAt(state, T0 + 60_000)).resolves.toBeUndefined();

		expect(client.calls).toBe(1);
		const failureLines = warn.mock.calls.filter(([message]) => message === "Hindsight: recall failed");
		expect(failureLines).toHaveLength(1);
		expect(String(failureLines[0][1]?.error)).toContain("boom");
		const skipLines = warn.mock.calls.filter(
			([message]) => message === "Hindsight: recall skipped after a recent failure",
		);
		expect(skipLines).toHaveLength(1);
		expect(notices).toHaveLength(2);
		expect(notices[0]).toEqual({
			level: "warning",
			message: "Memory recall failed: recall request failed: boom",
			source: HINDSIGHT_NOTICE_SOURCE,
		});
		expect(notices[1].message).toContain("boom");
	});

	it("a recall in flight that fails during the pause does not lengthen it", async () => {
		setSystemTime(T0);
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, shippedConfig());
		const firstTurnCalled = Promise.withResolvers<void>();
		const firstTurnAnswer = Promise.withResolvers<RecallResponse>();
		client.answer = () => {
			firstTurnCalled.resolve();
			return firstTurnAnswer.promise;
		};
		const firstTurn = state.beforeAgentStartPrompt(PROMPT);
		await firstTurnCalled.promise;
		const compactionCalled = Promise.withResolvers<void>();
		const compactionAnswer = Promise.withResolvers<RecallResponse>();
		client.answer = () => {
			compactionCalled.resolve();
			return compactionAnswer.promise;
		};
		const compaction = state.recallForCompaction([{ role: "user", content: "what did we decide?" }]);
		await compactionCalled.promise;

		// The first-turn recall fails and starts the pause; the compaction recall, sent before
		// the pause began, fails inside it.
		firstTurnAnswer.reject(new HindsightError("recall request failed: boom"));
		expect(await firstTurn).toBeUndefined();
		setSystemTime(T0 + 30_000);
		compactionAnswer.reject(new HindsightError("recall request failed: boom"));
		expect(await compaction).toBeUndefined();

		client.answer = failWithBoom;
		expect(await promptAroundEnd(state, client, T0 + SHIPPED_FIRST_PAUSE_MS)).toEqual({
			skipped: true,
			recalled: true,
		});
	});

	it("a clock set back before the failure ends the pause", async () => {
		const client = new CountingRecallApi();
		const { state } = start(newSessionManager(), client, shippedConfig());
		await promptAt(state, T0);
		await promptAt(state, T0 - 60 * 60_000);

		expect(client.calls).toBe(2);
	});

	it("an alias's compaction recall waits out the primary's pause", async () => {
		const { client, primary, alias } = startWithAlias();
		expect(await promptAt(primary.state, T0)).toBeUndefined();
		expect(client.calls).toBe(1);

		expect(await compactAt(alias.state, T0 + 30_000)).toBeUndefined();
		expect(client.calls).toBe(1);
	});

	it("an alias's failure after the primary's pause counts as one more failure in a row", async () => {
		const { client, primary, alias } = startWithAlias();
		await promptAt(primary.state, T0);
		const aliasFailedAt = T0 + SHIPPED_FIRST_PAUSE_MS + 1_000;
		expect(await compactAt(alias.state, aliasFailedAt)).toBeUndefined();
		expect(client.calls).toBe(2);

		// The second failure in a row pauses for two minutes, not one.
		expect(await promptAroundEnd(primary.state, client, aliasFailedAt + 2 * SHIPPED_FIRST_PAUSE_MS)).toEqual({
			skipped: true,
			recalled: true,
		});
	});

	it("each session shows its first skip once", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { client, primary, alias } = startWithAlias();
		await promptAt(primary.state, T0);
		expect(primary.notices).toHaveLength(1);

		expect(await compactAt(alias.state, T0 + 10_000)).toBeUndefined();
		expect(client.calls).toBe(1);
		expect(alias.notices).toHaveLength(1);
		expect(alias.notices[0].message).toStartWith("Memory recall paused until ");

		// The subagent's skip notice lands in its own session; the primary's user still sees one.
		const beforePrimarySkip = warn.mock.calls.length;
		expect(await promptAt(primary.state, T0 + 20_000)).toBeUndefined();
		expect(client.calls).toBe(1);
		const primarySkipLines = warn.mock.calls
			.slice(beforePrimarySkip)
			.filter(([message]) => message === "Hindsight: recall skipped after a recent failure");
		expect(primarySkipLines).toHaveLength(1);
		expect(primary.notices).toHaveLength(2);
		expect(primary.notices[1].message).toStartWith("Memory recall paused until ");

		expect(await compactAt(alias.state, T0 + 30_000)).toBeUndefined();
		expect(alias.notices).toHaveLength(1);
	});

	it("an alias's failure starts the primary's pause", async () => {
		const { client, primary, alias } = startWithAlias();
		expect(await compactAt(alias.state, T0)).toBeUndefined();
		expect(client.calls).toBe(1);

		expect(await promptAt(primary.state, T0 + 1_000)).toBeUndefined();
		expect(client.calls).toBe(1);
	});
});
