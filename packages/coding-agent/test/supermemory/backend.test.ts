import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { supermemoryBackend } from "@oh-my-pi/pi-coding-agent/supermemory/backend";
import { SupermemoryClient } from "@oh-my-pi/pi-coding-agent/supermemory/client";
import type { SupermemorySessionState } from "@oh-my-pi/pi-coding-agent/supermemory/state";

const CONFIGURED = { "memory.backend": "supermemory" };

function makeSession(options: { settings?: Record<string, unknown>; cwd?: string } = {}) {
	const listeners = new Set<AgentSessionEventListener>();
	const entries: SessionEntry[] = [];
	let state: SupermemorySessionState | undefined;
	const cwd = options.cwd ?? "/tmp";
	const session = {
		sessionId: "s1",
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
			getSessionId: () => "t1",
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emitNotice: () => {},
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
		async endTurn() {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const listener of [...listeners]) listener({ type: "agent_end", messages: [] } as never);
			await state?.flush();
		},
		listenerCount: () => listeners.size,
	};
	return session;
}

async function start(session: { settings: Settings }, taskDepth = 0) {
	await supermemoryBackend.start({
		session: session as never,
		settings: session.settings,
		modelRegistry: {} as never,
		agentDir: "/tmp",
		taskDepth,
	});
}

function spyRecall() {
	const profile = vi
		.spyOn(SupermemoryClient.prototype, "profile")
		.mockResolvedValue({ static: ["prefers <tabs>"], dynamic: [] });
	const search = vi
		.spyOn(SupermemoryClient.prototype, "search")
		.mockResolvedValue([{ id: "m1", content: "uses bun" }]);
	return { profile, search };
}

const ENV = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL"] as const;
const savedEnv = new Map(ENV.map(name => [name, Bun.env[name]]));

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
		Bun.env.SUPERMEMORY_API_KEY = "sm-synthetic-key";
		Bun.env.SUPERMEMORY_BASE_URL = "http://127.0.0.1:1";
	});
	afterEach(() => {
		vi.restoreAllMocks();
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
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

	it("tolerates one failing recall endpoint and returns nothing when both fail", async () => {
		vi.spyOn(SupermemoryClient.prototype, "profile").mockRejectedValue(
			new Error("Supermemory request failed with HTTP 500."),
		);
		const search = vi.spyOn(SupermemoryClient.prototype, "search").mockResolvedValue([{ id: "m", content: "kept" }]);
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

	it("redacts the API key and recognizable secrets in stored content and search queries", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "createDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const search = vi.spyOn(SupermemoryClient.prototype, "search").mockResolvedValue([]);
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123";
		const session = makeSession();
		await start(session);
		const memory = { agentDir: "/tmp", cwd: "/tmp", session: session as never };
		await supermemoryBackend.save!(memory, { content: `token ${secret} and key sm-synthetic-key` });
		await supermemoryBackend.search!(memory, `find ${secret}`);
		const sent = `${create.mock.calls[0]?.[0]?.content} ${search.mock.calls[0]?.[0]?.q}`;
		expect(sent).not.toContain(secret);
		expect(sent).not.toContain("sm-synthetic-key");
		expect(sent).toContain("[REDACTED]");
	});
});
