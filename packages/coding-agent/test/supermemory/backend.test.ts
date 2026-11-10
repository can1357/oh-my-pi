import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { supermemoryBackend } from "@oh-my-pi/pi-coding-agent/supermemory/backend";
import { SupermemoryClient, SupermemoryHttpError } from "@oh-my-pi/pi-coding-agent/supermemory/client";
import type { SupermemorySessionState } from "@oh-my-pi/pi-coding-agent/supermemory/state";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { TempDir } from "@oh-my-pi/pi-utils";

const CONFIGURED = { "memory.backend": "supermemory" };

/** Per-test agent dir: the backend drains `<agentDir>/supermemory-outbox` on start and dispose. */
let temp: TempDir;

function makeSession(options: { settings?: Record<string, unknown>; cwd?: string } = {}) {
	const listeners = new Set<AgentSessionEventListener>();
	const entries: SessionEntry[] = [];
	const notices: string[] = [];
	let state: SupermemorySessionState | undefined;
	const cwd = options.cwd ?? "/tmp";
	const session = {
		sessionId: "s1",
		transcriptId: "t1",
		settings: Settings.isolated({ ...CONFIGURED, ...options.settings }),
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			appendCustomEntry: (customType: string, data: unknown) => {
				entries.push({
					type: "custom",
					customType,
					data,
					id: `c${entries.length}`,
					parentId: null,
					timestamp: "",
				} as never);
				return "";
			},
			getCwd: () => cwd,
			getSessionId: () => session.transcriptId,
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emitNotice: (_level: string, message: string) => notices.push(message),
		notices,
		getXdevToolEntries: () => [],
		getSupermemorySessionState: () => state,
		setSupermemorySessionState(next: SupermemorySessionState | undefined) {
			const previous = state;
			state = next;
			return previous;
		},
		addTurn(text: string) {
			const at = new Date(0).toISOString();
			entries.push({
				type: "message",
				id: `u${entries.length}`,
				parentId: null,
				timestamp: at,
				message: { role: "user", content: text, timestamp: 0 },
			} as never);
			entries.push({
				type: "message",
				id: `a${entries.length}`,
				parentId: null,
				timestamp: at,
				message: { role: "assistant", content: [{ type: "text", text: `reply to ${text}` }], timestamp: 0 },
			} as never);
		},
		/** Dispatches `agent_end` without waiting for the retention it starts. */
		emitEnd(isTerminal?: boolean) {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const listener of [...listeners]) listener({ type: "agent_end", messages: [], isTerminal } as never);
		},
		async endTurn() {
			session.emitEnd();
			await state?.flush();
		},
		listenerCount: () => listeners.size,
	};
	return session;
}

/** Retention cursors recorded in a transcript, as `[transcriptId, turn]`. */
function cursors(session: { sessionManager: { getEntries(): SessionEntry[] } }): Array<[unknown, unknown]> {
	return session.sessionManager.getEntries().flatMap(entry => {
		if (entry.type !== "custom" || entry.customType !== "supermemory_retention") return [];
		const data = entry.data;
		if (!data || typeof data !== "object" || !("transcriptId" in data) || !("turn" in data)) return [];
		return [[data.transcriptId, data.turn] as [unknown, unknown]];
	});
}

async function start(session: { settings: Settings }, taskDepth = 0) {
	await supermemoryBackend.start({
		session: session as never,
		settings: session.settings,
		modelRegistry: {} as never,
		agentDir: temp.path(),
		taskDepth,
	});
}

function spyRecall() {
	const profile = vi
		.spyOn(SupermemoryClient.prototype, "profile")
		.mockResolvedValue({ static: ["prefers <tabs>"], dynamic: [] });
	const search = vi
		.spyOn(SupermemoryClient.prototype, "search")
		.mockResolvedValue([{ id: "m1", kind: "memory", content: "uses bun" }]);
	return { profile, search };
}

const ENV = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL"] as const;
const savedEnv = new Map(ENV.map(name => [name, Bun.env[name]]));

/** Answers every request with `status`/`body` and records method, URL and JSON body. */
function serve(status: number, body: unknown) {
	const requests: Array<{ url: string; method?: string; body: unknown }> = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body ?? "null")) });
			return Response.json(body, { status });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
	return requests;
}

async function startedTools() {
	const session = makeSession();
	await start(session);
	const edit = MemoryEditTool.createIf(session as never);
	const recall = MemoryRecallTool.createIf(session as never);
	const tag = session.getSupermemorySessionState()?.containerTag;
	if (!edit || !recall || !tag) throw new Error("Supermemory tools unavailable");
	return { edit, recall, tag };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("");
}

/** Any request a test did not script is a bug: fail it instead of reaching the network. */
function denyNetwork() {
	const deny: typeof globalThis.fetch = Object.assign(
		(): Promise<Response> => {
			throw new Error("network in test");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	return vi.spyOn(globalThis, "fetch").mockImplementation(deny);
}

describe("supermemoryBackend", () => {
	beforeEach(() => {
		temp = TempDir.createSync("@supermemory-backend-test-");
		Bun.env.SUPERMEMORY_API_KEY = "sm-synthetic-key";
		Bun.env.SUPERMEMORY_BASE_URL = "http://127.0.0.1:1";
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
		await temp.remove();
	});

	it("stays inert without an API key", async () => {
		const fetchSpy = denyNetwork();
		delete Bun.env.SUPERMEMORY_API_KEY;
		const session = makeSession();
		await start(session);
		expect(session.getSupermemorySessionState()).toBeUndefined();
		expect(
			await supermemoryBackend.buildDeveloperInstructions("/tmp", "/tmp", session.settings, session as never),
		).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("stages first-turn recall, commits it once, and rejects a superseded preparation", async () => {
		const { profile } = spyRecall();
		const session = makeSession();
		await start(session);

		const stale = await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined);
		const fresh = await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined);
		expect(fresh?.context).toContain("prefers &lt;tabs&gt;");
		expect(fresh?.context).toContain("- uses bun");
		expect(stale?.commit()).toBe(false);
		expect(session.getSupermemorySessionState()?.lastRecallSnippet).toBeUndefined();
		expect(fresh?.commit()).toBe(true);
		expect(session.getSupermemorySessionState()?.lastRecallSnippet).toBe(fresh?.context);
		expect(await supermemoryBackend.beforeAgentStartPrompt!(session as never, "second", undefined)).toBeUndefined();
		expect(profile).toHaveBeenCalledTimes(2);
	});

	it("reuses a persisted recall on resume without HTTP", async () => {
		spyRecall();
		const session = makeSession();
		await start(session);
		const first = await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined);
		first?.commit();
		session.addTurn("first");

		vi.restoreAllMocks();
		const { profile, search } = spyRecall();
		// A resumed process starts a fresh state on the persisted transcript.
		await start(session);
		const resumed = await supermemoryBackend.beforeAgentStartPrompt!(session as never, "again", undefined);
		expect(resumed?.context).toBe(first?.context);
		expect(profile).not.toHaveBeenCalled();
		expect(search).not.toHaveBeenCalled();
	});

	it("a resume after /memory clear asks the server again instead of restoring the cleared recall", async () => {
		spyRecall();
		const session = makeSession();
		await start(session);
		(await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined))?.commit();
		session.addTurn("first");
		await supermemoryBackend.clear("/tmp", "/tmp", session as never);

		vi.restoreAllMocks();
		const { profile, search } = spyRecall();
		await start(session);
		await supermemoryBackend.beforeAgentStartPrompt!(session as never, "again", undefined);
		expect(profile).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalledTimes(1);
	});

	it("a transcript that exits before its first window keeps its completed turns for the next process", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 3 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		session.addTurn("two");
		await session.endTurn();
		// The process exits during turn three, before its agent_end.
		session.addTurn("three");
		await session.getSupermemorySessionState()?.dispose();

		await start(session);
		await session.endTurn();
		expect(create.mock.calls.map(call => call[0]?.metadata?.turnStart)).toEqual([0]);
	});

	it("leaves an unanswered aborted turn open so its later answer is retained", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		const entries = session.sessionManager.getEntries();
		const at = new Date(0).toISOString();
		entries.push({
			type: "message",
			id: "u-aborted",
			parentId: null,
			timestamp: at,
			message: { role: "user", content: "two", timestamp: 0 },
		} as never);
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(1);
		// A bare resume answers the same prompt without a new user entry.
		entries.push({
			type: "message",
			id: "a-resumed",
			parentId: null,
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text: "resumed answer" }], timestamp: 0 },
		} as never);
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[1]?.[0]?.content).toContain("resumed answer");
	});

	it("leaves an interrupted, partly answered turn open so /retry's answer is retained", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		const entries = session.sessionManager.getEntries();
		const at = new Date(0).toISOString();
		const message = (id: string, value: unknown) =>
			entries.push({ type: "message", id, parentId: null, timestamp: at, message: value } as never);
		message("u1", { role: "user", content: "one", timestamp: 0 });
		message("a1", {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			stopReason: "aborted",
			timestamp: 0,
		});
		await session.endTurn();
		expect(create).not.toHaveBeenCalled();
		// `/retry` continues the same prompt without a new user entry.
		message("a2", {
			role: "assistant",
			content: [{ type: "text", text: "retried answer" }],
			stopReason: "stop",
			timestamp: 0,
		});
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0]?.[0]?.content).toContain("retried answer");
	});

	it("/memory clear revokes a recall that was still being prepared", async () => {
		spyRecall();
		const session = makeSession();
		await start(session);
		const staged = await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined);
		await supermemoryBackend.clear("/tmp", "/tmp", session as never);
		expect(staged?.commit()).toBe(false);
		expect(session.getSupermemorySessionState()?.lastRecallSnippet).toBeUndefined();
	});

	it("re-upserts the last window when a manual continuation adds an answer without a new user turn", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		// `.`/`c`: a synthetic developer prompt; the transcript gains only an assistant answer.
		session.sessionManager.getEntries().push({
			type: "message",
			id: "a-cont",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "continued answer" }],
				stopReason: "stop",
				timestamp: 0,
			},
		} as never);
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[0]);
		expect(docs).toHaveLength(2);
		expect(docs[1]?.customId).toBe(docs[0]?.customId);
		expect(docs[1]?.content).toContain("continued answer");
		// A further settle with nothing new sends nothing.
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("a continuation after a cadence change updates the original window, not a new one", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 3 } });
		await start(session);
		for (const turn of ["one", "two", "three"]) {
			session.addTurn(turn);
			await session.endTurn();
		}
		await session.getSupermemorySessionState()?.dispose();
		session.settings = Settings.isolated({ ...CONFIGURED, "supermemory.retainEveryNTurns": 1 });
		await start(session);
		session.sessionManager.getEntries().push({
			type: "message",
			id: "a-cont",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "continued" }],
				stopReason: "stop",
				timestamp: 0,
			},
		} as never);
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[0]);
		expect(docs).toHaveLength(2);
		expect(docs[1]?.customId).toBe(docs[0]?.customId);
		expect(docs[1]?.content).toContain("continued");
	});

	it("tolerates one failing recall endpoint and returns nothing when both fail", async () => {
		vi.spyOn(SupermemoryClient.prototype, "profile").mockRejectedValue(
			new Error("Supermemory request failed with HTTP 500."),
		);
		const search = vi
			.spyOn(SupermemoryClient.prototype, "search")
			.mockResolvedValue([{ id: "m", kind: "memory", content: "kept" }]);
		const session = makeSession();
		await start(session);
		const partial = await supermemoryBackend.beforeAgentStartPrompt!(session as never, "q", undefined);
		expect(partial?.context).toContain("kept");
		expect(partial?.context).not.toContain("supermemory_profile");

		search.mockRejectedValue(new Error("Supermemory request timed out."));
		expect(await supermemoryBackend.beforeAgentStartPrompt!(session as never, "q", undefined)).toBeUndefined();
	});

	it("retains every N user turns with a distinct customId per window", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 2 } });
		await start(session);

		session.addTurn("turn one");
		await session.endTurn();
		expect(create).not.toHaveBeenCalled();
		session.addTurn("turn two");
		await session.endTurn();
		session.addTurn("turn three");
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(1);
		session.addTurn("turn four");
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(2);

		const [first, second] = create.mock.calls.map(call => call[0]);
		expect(first?.customId).toMatch(/^omp-[0-9a-f]{64}$/);
		expect(second?.customId).not.toBe(first?.customId);
		expect(first?.content).toContain("turn two");
		expect(first?.content).not.toContain("turn three");
		expect(second?.content).toContain("turn three");
	});

	it("never re-sends old windows across resumed processes", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		for (const text of ["one", "two", "three"]) session.addTurn(text);
		for (const turn of ["four", "five"]) {
			// Each turn runs in a fresh process: a new state starts on the persisted transcript.
			await start(session);
			session.addTurn(turn);
			await session.endTurn();
			await session.getSupermemorySessionState()?.dispose();
		}
		const docs = create.mock.calls.map(call => call[0]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([
			{ turnStart: 3, turnEnd: 4 },
			{ turnStart: 4, turnEnd: 5 },
		]);
		expect(new Set(docs.map(doc => doc?.customId)).size).toBe(2);
		expect(docs[0]?.content).toContain("four");
		expect(docs[0]?.content).not.toContain("three");
	});

	it("after an in-place transcript reset, retains only turns added since the reset", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		for (const text of ["one", "two", "three", "four"]) {
			session.addTurn(text);
			await session.endTurn();
		}
		create.mockClear();
		session.getSupermemorySessionState()?.resetConversationTracking();
		session.addTurn("after reset");
		await session.endTurn();
		expect(create.mock.calls.map(call => call[0]?.metadata)).toMatchObject([{ turnStart: 4, turnEnd: 5 }]);
		expect(create.mock.calls[0]?.[0]?.content).toContain("after reset");
		expect(create.mock.calls[0]?.[0]?.content).not.toContain("four");
	});

	it("lets the shutdown flush finish every queued due window", async () => {
		const pending = Promise.withResolvers<{ id: string; status: string }>();
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		session.addTurn("two");
		const state = session.getSupermemorySessionState();
		void session.endTurn();
		const disposed = state?.dispose();
		pending.resolve({ id: "d0", status: "queued" });
		await disposed;
		expect(create.mock.calls.map(call => call[0]?.metadata?.turnStart)).toEqual([0, 1]);
	});

	it("gives subagents tool-only state with no automatic recall or retention", async () => {
		const { profile } = spyRecall();
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "done" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session, 1);
		expect(session.getSupermemorySessionState()).toBeDefined();
		expect(await supermemoryBackend.beforeAgentStartPrompt!(session as never, "q", undefined)).toBeUndefined();
		session.addTurn("subagent turn");
		await session.endTurn();
		expect(profile).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("clear drops the cached recall but keeps the backend active, without calling the API", async () => {
		spyRecall();
		const session = makeSession();
		await start(session);
		(await supermemoryBackend.beforeAgentStartPrompt!(session as never, "q", undefined))?.commit();
		vi.restoreAllMocks();
		const fetchSpy = denyNetwork();
		const state = session.getSupermemorySessionState();
		await supermemoryBackend.clear("/tmp", "/tmp", session as never);
		expect(session.getSupermemorySessionState()).toBe(state);
		expect(state?.lastRecallSnippet).toBeUndefined();
		expect(session.listenerCount()).toBe(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps the newest part of an oversized window and records the truncation", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn(`OLDEST ${"x".repeat(70_000)} NEWEST`);
		await session.endTurn();
		const doc = create.mock.calls[0]?.[0];
		expect(doc?.content.length).toBe(60_000);
		expect(doc?.content).toContain("NEWEST");
		expect(doc?.content).not.toContain("OLDEST");
		expect(doc?.metadata).toMatchObject({ transcriptTruncated: true });
		expect(Number(doc?.metadata?.omittedChars)).toBeGreaterThan(10_000);
	});

	it("lets a resumed window upsert over an earlier /memory enqueue tail", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 2 } });
		await start(session);
		session.addTurn("one");
		await supermemoryBackend.enqueue("/tmp", "/tmp", session as never);
		await start(session);
		session.addTurn("two");
		await session.endTurn();
		const [tail, window] = create.mock.calls.map(call => call[0]);
		expect(tail?.metadata).toMatchObject({ turnStart: 0, turnEnd: 1 });
		expect(window?.metadata).toMatchObject({ turnStart: 0, turnEnd: 2 });
		expect(window?.customId).toBe(tail?.customId);
	});

	it("retries a window that failed before exit on resume, without re-sending completed ones", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		create.mockRejectedValueOnce(new Error("Supermemory request failed with HTTP 503."));
		session.addTurn("two");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		const failed = create.mock.calls[1]?.[0];
		create.mockClear();

		// A resumed process starts a fresh state on the persisted transcript.
		await start(session);
		session.addTurn("three");
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[0]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([
			{ turnStart: 1, turnEnd: 2 },
			{ turnStart: 2, turnEnd: 3 },
		]);
		expect(docs[0]?.customId).toBe(failed?.customId);
		expect(docs[0]?.content).toContain("two");
	});

	it("retries a session's very first window on resume when it failed before exit", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockRejectedValueOnce(new Error("Supermemory request failed with HTTP 503."))
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("first");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		const failed = create.mock.calls[0]?.[0];
		create.mockClear();

		await start(session);
		session.addTurn("second");
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[0]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([
			{ turnStart: 0, turnEnd: 1 },
			{ turnStart: 1, turnEnd: 2 },
		]);
		expect(docs[0]?.customId).toBe(failed?.customId);
	});

	it("skips a window the server refuses for good, keeps retaining later ones, and never retries it", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockRejectedValueOnce(new SupermemoryHttpError(422))
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("refused");
		await session.endTurn();
		session.addTurn("accepted");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		expect(create.mock.calls.map(call => call[0]?.metadata)).toMatchObject([
			{ turnStart: 0, turnEnd: 1 },
			{ turnStart: 1, turnEnd: 2 },
		]);
		expect(session.notices).toHaveLength(1);
		create.mockClear();

		await start(session);
		session.addTurn("resumed");
		await session.endTurn();
		expect(create.mock.calls.map(call => call[0]?.metadata)).toMatchObject([{ turnStart: 2, turnEnd: 3 }]);
	});

	it("redacts the API key and recognizable secrets in stored content and search queries", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const search = vi.spyOn(SupermemoryClient.prototype, "search").mockResolvedValue([]);
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123";
		const session = makeSession();
		await start(session);
		const memory = { agentDir: temp.path(), cwd: "/tmp", session: session as never };
		await supermemoryBackend.save!(memory, {
			content: `token ${secret} and key sm-synthetic-key`,
			context: `ctx ${secret} sm-synthetic-key`,
		});
		await supermemoryBackend.search!(memory, `find ${secret}`);
		const doc = create.mock.calls[0]?.[0];
		const sent = `${doc?.content} ${JSON.stringify(doc?.metadata)} ${search.mock.calls[0]?.[0]?.q}`;
		expect(sent).not.toContain(secret);
		expect(sent).not.toContain("sm-synthetic-key");
		expect(sent).toContain("[REDACTED]");
	});

	it("a branched copy of a transcript ignores the source's retention cursor", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		session.addTurn("two");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		// `/branch` at turn one: a new transcript id, the turn-two messages dropped, custom entries kept.
		const entries = session.sessionManager.getEntries();
		const two = entries.findIndex(entry => entry.type === "message" && JSON.stringify(entry).includes("two"));
		entries.splice(two, entries.length - two, ...entries.slice(two).filter(entry => entry.type === "custom"));
		session.transcriptId = "t2";
		create.mockClear();

		await start(session);
		session.addTurn("three");
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[0]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([{ sessionId: "t2", turnStart: 1, turnEnd: 2 }]);
		expect(docs[0]?.content).toContain("three");
	});

	it("a window that completes after the session moves to a new transcript records no cursor there", async () => {
		const reply = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		vi.spyOn(SupermemoryClient.prototype, "createDocument").mockImplementation(() => {
			sent.resolve();
			return reply.promise;
		});
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		const ended = session.endTurn();
		await sent.promise;
		// `/new` while the upload is still in flight (e.g. after the state was detached).
		session.transcriptId = "t2";
		reply.resolve({ id: "d", status: "queued" });
		await ended;
		expect(cursors(session).filter(([transcriptId]) => transcriptId === "t2")).toEqual([]);
	});

	it("retention queued behind a slow upload does not run after dispose times out", async () => {
		vi.useFakeTimers();
		try {
			const reply = Promise.withResolvers<{ id: string; status: string }>();
			const sent = Promise.withResolvers<void>();
			const create = vi.spyOn(SupermemoryClient.prototype, "createDocument").mockImplementation(() => {
				sent.resolve();
				return reply.promise;
			});
			const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
			await start(session);
			const state = session.getSupermemorySessionState();
			session.addTurn("one");
			session.emitEnd();
			await sent.promise;
			session.addTurn("two");
			session.emitEnd();
			const disposing = state?.dispose();
			vi.advanceTimersByTime(2_000);
			await disposing;
			// Memory switched off, then `/new`: the session manager now holds another transcript.
			session.transcriptId = "t2";
			session.addTurn("three");
			reply.resolve({ id: "d", status: "queued" });
			await state?.flush();
			expect(create).toHaveBeenCalledTimes(1);
			expect(cursors(session).filter(([transcriptId]) => transcriptId === "t2")).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a window open across a non-terminal settle so the continuation's answer is retained", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		session.emitEnd(false);
		await session.getSupermemorySessionState()?.flush();
		expect(create).not.toHaveBeenCalled();
		// The continuation adds its answer, then the terminal settle closes the window.
		session.sessionManager.getEntries().push({
			type: "message",
			id: "cont",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "continuation answer" }], timestamp: 0 },
		} as never);
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0]?.[0]?.content).toContain("continuation answer");
	});

	it("a job queued behind a slow upload retains only turns settled when it was queued", async () => {
		// Only the first upload is slow; later ones answer at once.
		const first = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		const create = vi.spyOn(SupermemoryClient.prototype, "createDocument").mockImplementation(() => {
			if (create.mock.calls.length > 1) return Promise.resolve({ id: "d", status: "queued" });
			sent.resolve();
			return first.promise;
		});
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		session.emitEnd();
		await sent.promise;
		session.addTurn("two");
		session.emitEnd();
		// Turn three has started (user message only) while turn one's upload is still pending.
		session.sessionManager.getEntries().push({
			type: "message",
			id: "u3",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "three", timestamp: 0 },
		} as never);
		first.resolve({ id: "d", status: "queued" });
		await session.getSupermemorySessionState()?.flush();
		expect(create.mock.calls.map(call => call[0]?.metadata?.turnStart)).toEqual([0, 1]);
		expect(cursors(session).at(-1)?.[1]).toBe(2);
	});

	it("a job queued before the transcript changes uploads nothing and records no cursor for the new one", async () => {
		const first = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		const create = vi.spyOn(SupermemoryClient.prototype, "createDocument").mockImplementation(() => {
			if (create.mock.calls.length > 1) return Promise.resolve({ id: "d", status: "queued" });
			sent.resolve();
			return first.promise;
		});
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		session.emitEnd();
		await sent.promise;
		session.addTurn("two");
		session.emitEnd();
		// `/new` while turn two's job waits behind turn one's upload.
		session.transcriptId = "t2";
		first.resolve({ id: "d", status: "queued" });
		await session.getSupermemorySessionState()?.flush();
		expect(create).toHaveBeenCalledTimes(1);
		expect(cursors(session).filter(([transcriptId]) => transcriptId === "t2")).toEqual([]);
	});

	it("/memory enqueue stops at a failed complete window instead of uploading the rest as one tail", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockRejectedValueOnce(new Error("Supermemory request failed with HTTP 503."))
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({
			settings: { "supermemory.retainEveryNTurns": 2, "supermemory.autoRetain": false },
		});
		await start(session);
		for (const turn of ["one", "two", "three", "four"]) session.addTurn(turn);
		await supermemoryBackend.enqueue!(temp.path(), "/tmp", session as never);
		expect(create.mock.calls.map(call => [call[0]?.metadata?.turnStart, call[0]?.metadata?.turnEnd])).toEqual([
			[0, 2],
		]);
		expect(cursors(session).map(([, turn]) => turn)).not.toContain(4);
	});

	it("a disposed state refuses new saves and edits instead of writing to its old container", async () => {
		const create = vi.spyOn(SupermemoryClient.prototype, "createDocument");
		const update = vi.spyOn(SupermemoryClient.prototype, "updateMemory");
		const forget = vi.spyOn(SupermemoryClient.prototype, "forgetMemory");
		const session = makeSession();
		await start(session);
		const state = session.getSupermemorySessionState();
		await state?.dispose();
		await expect(state!.save("x", { source: "t" })).rejects.toThrow("memory NOT stored");
		await expect(state!.updateMemory("m1", "y")).rejects.toThrow("memory NOT stored");
		await expect(state!.forgetMemory("m1", undefined)).rejects.toThrow("memory NOT stored");
		expect([create, update, forget].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0]);
	});

	it("repeated /memory enqueue tails upsert one open window instead of adding documents", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 3 } });
		await start(session);
		const memory = { agentDir: temp.path(), cwd: "/tmp", session: session as never };
		session.addTurn("one");
		await supermemoryBackend.enqueue!(memory.agentDir, memory.cwd, memory.session);
		session.addTurn("two");
		await supermemoryBackend.enqueue!(memory.agentDir, memory.cwd, memory.session);
		session.addTurn("three");
		await session.endTurn();
		const ids = new Set(create.mock.calls.map(call => call[0]?.customId));
		expect(create).toHaveBeenCalledTimes(3);
		expect(ids.size).toBe(1);
	});

	it("recall lists editable memory ids and marks document chunks", async () => {
		serve(200, {
			results: [
				{ id: "m1", memory: "uses bun" },
				{ id: "c1", chunk: "doc text" },
			],
		});
		const { recall } = await startedTools();
		const output = text(await recall.execute("call", { query: "bun" }));
		expect(output).toContain("- uses bun (id: m1)");
		expect(output).toContain("- doc text [document chunk]");
		expect(output).not.toContain("c1");
	});

	it("memory_edit update PATCHes a redacted new version in the session container", async () => {
		const requests = serve(200, { id: "m2", memory: "new", version: 2 });
		const { edit, tag } = await startedTools();
		const output = text(
			await edit.execute("call", {
				op: "update",
				id: "m1",
				content: "uses bun; key sm-synthetic-key",
				importance: 1,
			}),
		);
		expect(requests).toEqual([
			{
				url: "http://127.0.0.1:1/v4/memories",
				method: "PATCH",
				body: { id: "m1", containerTag: tag, newContent: "uses bun; key [REDACTED]" },
			},
		]);
		expect(output).toContain("new version id m2");
		expect(output).toContain("no importance; it was ignored");
	});

	it("memory_edit forget and invalidate soft-forget with DELETE", async () => {
		const requests = serve(200, { id: "m1", forgotten: true });
		const { edit, tag } = await startedTools();
		await edit.execute("call", { op: "forget", id: "m1" });
		await edit.execute("call", { op: "invalidate", id: "m1", replacement_id: "m2" });
		await edit.execute("call", { op: "invalidate", id: "m3" });
		expect(requests.map(request => [request.method, request.url, request.body])).toEqual([
			["DELETE", "http://127.0.0.1:1/v4/memories", { id: "m1", containerTag: tag }],
			["DELETE", "http://127.0.0.1:1/v4/memories", { id: "m1", containerTag: tag, reason: "superseded by m2" }],
			["DELETE", "http://127.0.0.1:1/v4/memories", { id: "m3", containerTag: tag, reason: "invalidated" }],
		]);
	});

	it("memory_edit maps 404 and 409 to clear errors", async () => {
		const { edit, tag } = await startedTools();
		serve(404, { error: "not found" });
		await expect(edit.execute("call", { op: "update", id: "m1", content: "x" })).rejects.toThrow(
			`Memory m1 was not found in container ${tag}.`,
		);
		vi.restoreAllMocks();
		serve(409, { error: "already forgotten" });
		await expect(edit.execute("call", { op: "forget", id: "m1" })).rejects.toThrow(
			`Memory m1 is already forgotten in container ${tag}.`,
		);
	});

	it("memory_edit rejects update without content before any request", async () => {
		const { edit } = await startedTools();
		const fetchSpy = denyNetwork();
		await expect(edit.execute("call", { op: "update", id: "m1" })).rejects.toThrow(
			"memory_edit update requires content.",
		);
		await expect(edit.execute("call", { op: "update", id: "m1", importance: 0.5 })).rejects.toThrow(
			"Supermemory memories have no importance",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
