import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DakeraApi } from "@oh-my-pi/pi-coding-agent/dakera/client";
import { loadDakeraConfig } from "@oh-my-pi/pi-coding-agent/dakera/config";
import { DakeraSessionState } from "@oh-my-pi/pi-coding-agent/dakera/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { asGlobalFetch } from "./helpers/fetch-mock";

const NPM_TOKEN = `npm_${"a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXy".slice(0, 36)}`;

interface Captured {
	method: string;
	url: string;
	body: Record<string, unknown>;
}

const requests: Captured[] = [];

/** Reply to every call with `respond(request)` and record the request. */
function serve(respond: (request: Captured) => unknown): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch((input, init) => {
			const captured: Captured = {
				method: String(init?.method ?? "GET"),
				url: String(input),
				body: (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<string, unknown>,
			};
			requests.push(captured);
			const reply = respond(captured) ?? {};
			if (isRecord(reply) && typeof reply.status === "number") {
				return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
			}
			return new Response(JSON.stringify(reply), { status: 200 });
		}),
	);
}

const stateFor = (
	overrides: Record<string, unknown> = {},
	stateOverrides: {
		sessionId?: string;
		retainTags?: string[];
		recallTags?: string[];
		entries?: () => SessionEntry[];
	} = {},
): DakeraSessionState => {
	const config = loadDakeraConfig(Settings.isolated({ "dakera.apiUrl": "http://dakera.local", ...overrides }));
	return new DakeraSessionState({
		sessionId: stateOverrides.sessionId ?? "sess-1",
		client: new DakeraApi({ baseUrl: config.apiUrl ?? "http://dakera.local" }),
		agentId: "omp",
		retainTags: stateOverrides.retainTags,
		recallTags: stateOverrides.recallTags,
		config,
		// Auto-retain listeners are not exercised here; the state only stores the session.
		session: (stateOverrides.entries
			? { sessionManager: { getEntries: stateOverrides.entries } }
			: {}) as AgentSession,
	});
};

const storedMemories = (request: Captured): Record<string, unknown>[] =>
	(request.body.memories as Record<string, unknown>[]) ?? [];
const firstStore: () => Captured = () =>
	requests.find(r => r.url.endsWith("/v1/memories/store/batch")) ?? ({ body: {} } as Captured);

const storeRequests = (): Captured[] => requests.filter(r => r.url.endsWith("/v1/memories/store/batch"));
afterEach(() => {
	vi.restoreAllMocks();
	requests.length = 0;
});

describe("DakeraSessionState.retainItems", () => {
	it("keeps a credential out of both the content and the metadata it persists", async () => {
		serve(() => ({ stored: [{ id: "m1" }] }));
		await stateFor().retainItems([{ content: `auth uses ${NPM_TOKEN}`, context: `deploy with ${NPM_TOKEN}` }]);

		const [memory] = storedMemories(firstStore());
		expect(memory?.content).toBe("auth uses [REDACTED]");
		expect(memory?.metadata).toEqual({ context: "deploy with [REDACTED]" });
	});

	it("stamps every store with the scope tags and the session id", async () => {
		serve(() => ({ stored: [{ id: "m1" }] }));
		await stateFor({}, { retainTags: ["project:alpha"] }).retainItems([{ content: "a fact" }]);

		const [memory] = storedMemories(firstStore());
		expect(memory?.tags).toEqual(["project:alpha"]);
		expect(memory?.session_id).toBe("sess-1");
	});

	// `learn` refuses to mint a skill when nothing was stored, which only works if
	// a server that answers without ids reports zero.
	it("reports zero when the server returns memories it cannot give ids for", async () => {
		serve(() => ({ stored: [{ content: "no id here" }] }));
		expect(await stateFor().retainItems([{ content: "a fact" }])).toBe(0);
	});

	// The Dakera UI groups memories by session; the row is created lazily with
	// the first store and never re-registered, even when that store fails.
	it("registers the server session once, before the first store", async () => {
		serve(request =>
			request.url.endsWith("/v1/sessions/start") ? { session: { id: "srv-sess-9" } } : { stored: [{ id: "m1" }] },
		);
		const state = stateFor({}, { sessionId: "sess-9" });
		await state.retainItems([{ content: "a fact" }]);
		await state.retainItems([{ content: "another" }]);

		const registrations = requests.filter(request => request.url.endsWith("/v1/sessions/start"));
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.body.session_id).toBe("sess-9");
		// The server mints its own id; stores must reference that one.
		expect(storedMemories(firstStore())[0]?.session_id).toBe("srv-sess-9");
		// The store still follows the registration, in order.
		expect(requests[0]?.url).toContain("/v1/sessions/start");
		expect(requests[1]?.url).toContain("/v1/memories/store/batch");
	});
	it("stores even when session registration fails", async () => {
		// Return a real non-2xx (a thrown Error would be JSON-serialized into
		// `{}` with HTTP 200 and never exercise the failure path).
		serve(request =>
			request.url.endsWith("/v1/sessions/start") ? { status: 500, body: {} } : { stored: [{ id: "m1" }] },
		);
		expect(await stateFor().retainItems([{ content: "a fact" }])).toBe(1);
	});
});

describe("DakeraSessionState.retainTranscript", () => {
	const messages = [
		{ role: "user" as const, content: "the oldest fact" },
		{ role: "assistant" as const, content: "and its reply" },
		{ role: "user" as const, content: "the newest fact" },
	];

	// A resumed process has no in-process transcript memory id, so the first
	// full-session retain lists the agent's memories to recover the row the
	// previous process maintained (the recovery GET returns no marker rows
	// here). The test server answers every non-list call with an id.
	it("maintains one full-session memory and updates it in place", async () => {
		serve(request =>
			request.method === "PUT"
				? { memory: { id: "t1" } }
				: request.method === "GET"
					? { memories: [] }
					: { stored: [{ id: "t1", content: "x" }] },
		);
		const state = stateFor();

		await state.retainTranscript(messages);
		await state.retainTranscript(messages);

		const memoryCalls = requests.filter(r => !r.url.endsWith("/v1/sessions/start"));
		// GET first: recovery lists memories before the initial store.
		expect(memoryCalls.map(request => request.method)).toEqual(["GET", "POST", "PUT"]);
		expect(memoryCalls[2]?.url).toBe("http://dakera.local/v1/memory/update/t1?agent_id=omp");
	});

	// After `/new` or a resume the old transcript memory belongs to another
	// conversation; updating it would overwrite the wrong session.
	it("stops updating the previous transcript memory after a session switch", async () => {
		serve(request =>
			request.method === "PUT"
				? { memory: { id: "t1" } }
				: request.method === "GET"
					? { memories: [] }
					: { stored: [{ id: "t1", content: "x" }] },
		);
		const state = stateFor();

		await state.retainTranscript(messages);
		state.setSessionId("sess-2");
		await state.retainTranscript(messages);

		const memoryCalls = requests.filter(r => !r.url.endsWith("/v1/sessions/start"));
		// Recovery GET per session id: once before each session's first store.
		expect(memoryCalls.map(request => request.method)).toEqual(["GET", "POST", "GET", "POST"]);
	});

	// Two publishes in flight would each read an unset transcript id and fork a
	// second permanent transcript memory, so the queue must hold one back.
	it("keeps overlapping full-session retains from forking the transcript memory", async () => {
		serve(request =>
			request.method === "PUT"
				? { memory: { id: "t1" } }
				: request.method === "GET"
					? { memories: [] }
					: { stored: [{ id: "t1" }] },
		);
		const state = stateFor();

		await Promise.all([state.retainTranscript(messages), state.retainTranscript(messages)]);

		const memoryCalls = requests.filter(r => !r.url.endsWith("/v1/sessions/start"));
		// Queued publishes share one recovery GET: the second publish sees the
		// id the first stored and updates in place.
		expect(memoryCalls.map(request => request.method)).toEqual(["GET", "POST", "PUT"]);
	});

	// One failed write must not wedge the queue: the next retain still has to
	// reach the server, or a dropped connection would end retention for good.
	// Non-idempotent POSTs are never retried by the client (a lost response
	// could have committed the rows), so a failed transcript write surfaces to
	// the state layer immediately — and the *next* retain re-stores cleanly.
	it("runs the next transcript retain after a failed one", async () => {
		let stores = 0;
		serve(request => {
			if (request.url.endsWith("/v1/sessions/start")) return {};
			if (request.method === "GET") return { memories: [] };
			stores++;
			if (stores === 1) return { status: 503, body: {} };
			return { stored: [{ id: "t1" }] };
		});
		const state = stateFor();

		await expect(state.retainTranscript(messages)).rejects.toThrow("failed: ");
		await state.retainTranscript(messages);

		expect(requests.filter(r => r.method === "POST" && !r.url.endsWith("/v1/sessions/start"))).toHaveLength(2);
	});

	// `last-turn` is the cheap mode: everything before the window must stay local.
	it("retains only the last-turn window when retainMode=last-turn", async () => {
		serve(() => ({ stored: [{ id: "m1" }] }));
		await stateFor({ "dakera.retainMode": "last-turn", "dakera.retainEveryNTurns": 1 }).retainTranscript(messages);

		const text = JSON.stringify(storedMemories(firstStore()));
		expect(text).toContain("the newest fact");
		expect(text).not.toContain("the oldest fact");
	});

	// `last-turn` appends: overwriting one row in place would erase the previous
	// window's history, and re-extracting a growing transcript is O(turns²).
	it("keeps every last-turn window as its own memory instead of updating one row", async () => {
		serve(() => ({ stored: [{ id: "w1" }, { id: "w2" }] }));
		const state = stateFor({ "dakera.retainMode": "last-turn", "dakera.retainEveryNTurns": 1 });
		await state.retainTranscript(messages);
		await state.retainTranscript(messages);

		const memoryCalls = requests.filter(r => !r.url.endsWith("/v1/sessions/start"));
		expect(memoryCalls.map(request => request.method)).toEqual(["POST", "POST"]);
		expect(memoryCalls.every(request => request.url.endsWith("/v1/memories/store/batch"))).toBe(true);
	});

	it("skips the request when the window renders no transcript", async () => {
		serve(() => ({ stored: [] }));
		await stateFor().retainTranscript([]);
		expect(requests).toHaveLength(0);
	});

	// An ESC-aborted turn still fires `agent_end`, with only the prompt in the
	// transcript. Retaining that husk spent the turn delta, so the real answer —
	// written minutes later when the user resumed — never reached the server.
	it("leaves an aborted turn unretained and keeps its window for the reply", async () => {
		serve(() => ({ stored: [{ id: "w1", content: "x" }] }));
		const aborted: SessionEntry[] = [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "the question" }] } } as never,
		];
		const entries = { current: aborted };
		const state = stateFor(
			{ "dakera.retainMode": "last-turn", "dakera.retainEveryNTurns": 1 },
			{ entries: () => entries.current },
		);

		await state.maybeRetainOnAgentEnd();

		expect(storeRequests()).toHaveLength(0);
		expect(state.lastRetainedTurn).toBe(0);

		// The same turn, now answered.
		entries.current = [
			...aborted,
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "the completed answer" }] },
			} as never,
		];
		await state.maybeRetainOnAgentEnd();

		const retained = storeRequests().map(request => String(storedMemories(request)[0]?.content ?? ""));
		expect(retained).toHaveLength(1);
		expect(retained[0]).toContain("the question");
		expect(retained[0]).toContain("the completed answer");
		expect(state.lastRetainedTurn).toBe(1);
	});

	// Regression: a resumed session starts with a fresh state and no in-process
	// transcript id — the first full-session retain must UPDATE the row the
	// previous process maintained, not POST a second one.
	it("recovers the previous process transcript memory on resume", async () => {
		serve(request =>
			request.method === "PUT"
				? { memory: { id: "old-row" } }
				: request.method === "GET"
					? {
							memories: [
								{
									id: "old-row",
									content: "earlier process transcript",
									memory_type: "episodic",
									session_id: "sess-1",
									metadata: { "omp-transcript": true },
									updated_at: Date.now() - 1000,
								},
							],
						}
					: { stored: [{ id: "new-row" }] },
		);
		const state = stateFor();

		await state.retainTranscript(messages);

		const updateCalls = requests.filter(r => r.method === "PUT");
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]?.url).toBe("http://dakera.local/v1/memory/update/old-row?agent_id=omp");
	});

	// And the fresh-session case: no marker rows on the server → the retain
	// stores a new row (and stamps it with the recovery marker).
	it("stores a fresh transcript row with the recovery marker when nothing to recover", async () => {
		serve(request => (request.method === "GET" ? { memories: [] } : { stored: [{ id: "fresh-row" }] }));
		const state = stateFor();

		await state.retainTranscript(messages);

		const storeRequestsList = requests.filter(r => r.method === "POST" && !r.url.endsWith("/v1/sessions/start"));
		expect(storeRequestsList).toHaveLength(1);
		const memory = storedMemories(storeRequestsList[0])[0] as Record<string, unknown> | undefined;
		expect((memory?.metadata as Record<string, unknown> | undefined)?.["omp-transcript"]).toBe(true);
	});
});

describe("DakeraSessionState.recallFormatted", () => {
	// The server's own order is the one to trust, but a `score`-ordered response
	// must still come out best-first for the model.
	it("re-ranks hits by smart_score and renders type plus date", async () => {
		serve(() => ({
			memories: [
				{
					memory: { id: "low", content: "weaker", memory_type: "semantic", created_at: 1_700_000_000 },
					smart_score: 0.11,
				},
				{
					memory: { id: "high", content: "stronger", memory_type: "episodic", created_at: 1_700_000_000 },
					smart_score: 0.94,
				},
			],
		}));

		const { hits, text } = await stateFor().recallFormatted("query");
		expect(hits.map(hit => hit.memory.id)).toEqual(["high", "low"]);
		// Fragments render first (higher signal density); episodic transcripts trail.
		expect(text).toBe(
			"- weaker [semantic] (2023-11-14T22:13:20.000Z)\n\n- stronger [episodic] (2023-11-14T22:13:20.000Z)",
		);
	});

	it("forwards the configured recall knobs", async () => {
		serve(() => ({ memories: [] }));
		await stateFor({ "dakera.recallTopK": 5, "dakera.recallRerank": false }).recallFormatted("query");
		expect(requests[0]?.body).toEqual({
			agent_id: "omp",
			query: "query",
			top_k: 5,
			min_importance: 0,
			rerank: false,
		});
	});

	// `per-project-tagged` isolation lives here: without the filter reaching the
	// server, every project sharing the agent id would read every other's memory.
	it("sends the tag filter on every recall", async () => {
		serve(() => ({ memories: [] }));
		await stateFor({}, { recallTags: ["project:alpha", "global:shared"] }).recallFormatted("query");
		expect(requests[0]?.body).toEqual({
			agent_id: "omp",
			query: "query",
			top_k: 8,
			min_importance: 0,
			rerank: true,
			tags: ["project:alpha", "global:shared"],
		});
	});
});
