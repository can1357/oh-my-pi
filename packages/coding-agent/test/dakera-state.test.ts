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
		/** Durable session-manager id; defaults to the provider id like a live session that never rekeyed. */
		durableSessionId?: string;
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
		// The session-manager id is always present — production never sees a
		// SessionManager without one, so the double must not either.
		session: {
			sessionManager: {
				getEntries: stateOverrides.entries,
				getSessionId: () => stateOverrides.durableSessionId ?? stateOverrides.sessionId ?? "sess-1",
			},
		} as AgentSession,
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

	// A store entering while the first registration is still in flight (a tool
	// retain racing the first auto-retain publish) must join it: racing ahead
	// stamps rows with the local session id the Dakera UI does not group by.
	it("concurrent stores share one registration and the server-minted id", async () => {
		const registration = Promise.withResolvers<unknown>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				requests.push({
					method: String(init?.method ?? "GET"),
					url,
					body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
				});
				if (url.endsWith("/v1/sessions/start")) {
					return new Response(JSON.stringify(await registration.promise), { status: 200 });
				}
				return new Response(JSON.stringify({ stored: [{ id: "m1" }] }), { status: 200 });
			}),
		);
		const state = stateFor();
		const first = state.retainItems([{ content: "from the tool" }]);
		const second = state.retainItems([{ content: "from auto-retain" }]);
		for (let hop = 0; hop < 50 && !requests.some(r => r.url.endsWith("/v1/sessions/start")); hop++) {
			await Promise.resolve();
		}
		registration.resolve({ session: { id: "srv-conc" } });
		expect(await Promise.all([first, second])).toEqual([1, 1]);

		expect(requests.filter(r => r.url.endsWith("/v1/sessions/start"))).toHaveLength(1);
		for (const store of storeRequests()) {
			for (const memory of storedMemories(store)) expect(memory?.session_id).toBe("srv-conc");
		}
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
									// The server mints its own session id, distinct from the local one —
									// only the marker can identify the row as this session's transcript.
									session_id: "srv-minted-9",
									metadata: { "omp-transcript": "sess-1" },
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

	// The marker must carry the durable session-manager id, not the provider
	// session id: `this.sessionId` rotates to a fresh UUIDv7 on freshSession()/
	// resetContext()/compaction, and a cold process falls back to the durable id —
	// a provider-id marker could never match again, so every restart would POST
	// a duplicate transcript row. Pin which id is stamped.
	it("stamps the marker with the durable session id, not the provider id", async () => {
		serve(() => ({ stored: [{ id: "m1" }] }));
		const state = stateFor({}, { sessionId: "provider-rotated-7", durableSessionId: "durable-omp-1" });

		await state.retainTranscript(messages);

		const posted = requests.filter(r => r.method === "POST" && !r.url.endsWith("/v1/sessions/start"));
		expect(storedMemories(posted[0])[0]?.metadata).toEqual({ "omp-transcript": "durable-omp-1" });
	});

	// The resume twin of the test above: a rekeyed live session (provider id
	// rotated) must still recover the row its durable id owns, because the
	// restarted process computes the marker from that same durable id.
	it("recovers the transcript row across a mid-session provider-id rotation", async () => {
		serve(request =>
			request.method === "PUT"
				? { memory: { id: "old-row" } }
				: request.method === "GET"
					? {
							memories: [
								{
									id: "old-row",
									content: "transcript owned by durable id",
									memory_type: "episodic",
									session_id: "srv-minted-4",
									metadata: { "omp-transcript": "durable-omp-1" },
									updated_at: Date.now() - 1000,
								},
							],
						}
					: { stored: [{ id: "new-row" }] },
		);
		const state = stateFor({}, { sessionId: "provider-rotated-8", durableSessionId: "durable-omp-1" });

		await state.retainTranscript(messages);

		expect(requests.filter(r => r.method === "PUT")).toHaveLength(1);
	});
	// Regression: two sessions of the same agent id share a cwd-derived agent, so a
	// boolean marker let a new session adopt (and overwrite) the previous session's
	// transcript row. Recovery must match the row's own session id.
	it("does not adopt another session's transcript row", async () => {
		serve(request =>
			request.method === "GET"
				? {
						memories: [
							{
								id: "other-row",
								content: "another session's transcript",
								memory_type: "episodic",
								session_id: "sess-2",
								metadata: { "omp-transcript": "sess-2" },
								updated_at: Date.now() - 1000,
							},
						],
					}
				: { stored: [{ id: "new-row" }] },
		);
		const state = stateFor({}, { sessionId: "sess-1" });

		await state.retainTranscript(messages);

		expect(requests.filter(r => r.method === "PUT")).toHaveLength(0);
		const posted = requests.filter(r => r.method === "POST" && !r.url.endsWith("/v1/sessions/start"));
		expect(storedMemories(posted[0])[0]?.metadata).toEqual({ "omp-transcript": "sess-1" });
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
		expect((memory?.metadata as Record<string, unknown> | undefined)?.["omp-transcript"]).toBe("sess-1");
	});

	// A compaction or /reset rekeys the state to a fresh provider id. The
	// transcript row is owned by the durable omp session id, so the next retain
	// must re-adopt and UPDATE the same row — not POST a duplicate (the old
	// provider-id-marker behavior, which forked a row per rekey).
	it("re-adopts the transcript row after a provider-id rekey", async () => {
		serve(request =>
			request.method === "GET"
				? {
						memories: [
							{
								id: "row-1",
								content: "transcript owned by the durable id",
								memory_type: "episodic",
								metadata: { "omp-transcript": "sess-1" },
								updated_at: Date.now() - 1000,
							},
						],
					}
				: { stored: [{ id: "row-1" }] },
		);
		const state = stateFor({}, { sessionId: "sess-1", durableSessionId: "sess-1" });
		await state.retainTranscript(messages);

		state.setSessionId("provider-rekeyed-uuid");
		await state.retainTranscript(messages);

		const puts = requests.filter(r => r.method === "PUT");
		expect(puts).toHaveLength(2);
		expect(puts.map(put => put.url)).toEqual([
			"http://dakera.local/v1/memory/update/row-1?agent_id=omp",
			"http://dakera.local/v1/memory/update/row-1?agent_id=omp",
		]);
		expect(storeRequests()).toHaveLength(0);
	});

	// A rekey landing while the recovery listing is in flight must invalidate the
	// continuation: adopting the old row (or storing the old transcript under
	// the new state) resurrects what the rekey just discarded.
	it("aborts recovery when a rekey lands during the listing", async () => {
		const listing = Promise.withResolvers<unknown>();
		// Record the real verb: a mock that labels every request GET makes the
		// PUT assertion below vacuously true.
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				requests.push({ method: String(init?.method ?? "GET"), url, body: {} });
				// The listing carries a query string, so match on the path — a
				// mismatched check lets the listing answer instantly and the
				// "race" collapses into a plain store.
				if (url.includes("/memories")) return new Response(JSON.stringify(await listing.promise), { status: 200 });
				return new Response(JSON.stringify({ stored: [{ id: "stale-row" }] }), { status: 200 });
			}),
		);
		const state = stateFor({}, { durableSessionId: "sess-1" });
		const pending = state.retainTranscript(messages);
		// Wait for the listing request itself (not just any request) so the
		// rekey lands while it is in flight, not before it is issued.
		for (let hop = 0; hop < 50 && !requests.some(r => r.url.includes("/memories")); hop++) {
			await Promise.resolve();
		}
		state.setSessionId("provider-rekeyed-uuid");
		listing.resolve({
			memories: [
				{ id: "old-row", content: "stale", memory_type: "episodic", metadata: { "omp-transcript": "sess-1" } },
			],
		});
		await pending;

		expect(requests.filter(r => r.method === "PUT")).toHaveLength(0);
		expect(storeRequests()).toHaveLength(0);
	});

	// A conversation reset (`/new`, fork, branch switch) bumps the retain
	// generation under the same provider session id. Adopting the previous
	// conversation's row after the reset would send the next retain into the
	// update branch and PUT-overwrite that conversation's transcript row
	// server-side — the caller's own re-check protects only its own write.
	it("does not adopt a transcript row a conversation reset invalidated", async () => {
		const listing = Promise.withResolvers<unknown>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				requests.push({ method: String(init?.method ?? "GET"), url, body: {} });
				if (url.includes("/memories")) return new Response(JSON.stringify(await listing.promise), { status: 200 });
				return new Response(JSON.stringify({ stored: [{ id: "fresh-row" }] }), { status: 200 });
			}),
		);
		const state = stateFor({}, { durableSessionId: "sess-1" });
		const pending = state.retainTranscript(messages);
		for (let hop = 0; hop < 50 && !requests.some(r => r.url.includes("/memories")); hop++) {
			await Promise.resolve();
		}
		state.resetConversationTracking();
		listing.resolve({
			memories: [
				{
					id: "old-row",
					content: "previous conversation",
					memory_type: "episodic",
					metadata: { "omp-transcript": "sess-1" },
				},
			],
		});
		await pending;

		// The reset conversation retains a fresh row: POST only, never a PUT to
		// the row the reset severed.
		await state.retainTranscript(messages);
		expect(requests.filter(r => r.method === "PUT")).toHaveLength(0);
		expect(storeRequests()).toHaveLength(1);
	});
});

describe("DakeraSessionState.endSessionWithSummary", () => {
	// Only a server-minted session id can be closed: ending the local id would
	// target a row the server never opened (it ignores the requested id).
	it("closes nothing when no server-minted session id exists", async () => {
		serve(request => (request.url.includes("/end") ? { session: {} } : { stored: [{ id: "m1" }] }));
		const state = stateFor();

		await state.endSessionWithSummary("summary");

		expect(requests.filter(r => r.url.includes("/end"))).toHaveLength(0);
	});

	it("ends the server-minted session id after registration", async () => {
		serve(request =>
			request.url.endsWith("/v1/sessions/start")
				? { session: { id: "srv-minted-42" } }
				: request.url.includes("/end")
					? { session: {} }
					: { stored: [{ id: "m1" }] },
		);
		const state = stateFor();
		await state.retainItems([{ content: "a fact" }]);

		await state.endSessionWithSummary("summary");

		const ends = requests.filter(r => r.url.includes("/end"));
		expect(ends).toHaveLength(1);
		expect(ends[0]?.url).toBe("http://dakera.local/v1/sessions/srv-minted-42/end");
	});

	// A rekey (compaction, /reset, /fresh) abandons the server row registered
	// under the old provider id — it must be ended, not leaked open. This is
	// the fix for the open `memory_count: 0` rows piling up in the Dakera UI.
	it("ends the old server row when a rekey abandons it", async () => {
		serve(request =>
			request.url.endsWith("/v1/sessions/start")
				? { session: { id: "srv-minted-7" } }
				: request.url.includes("/end")
					? { session: {} }
					: { stored: [{ id: "m1" }] },
		);
		const state = stateFor();
		await state.retainItems([{ content: "a fact" }]);

		state.setSessionId("provider-rekeyed");
		await state.awaitPending();

		const ends = requests.filter(r => r.url.includes("/end"));
		expect(ends).toHaveLength(1);
		expect(ends[0]?.url).toBe("http://dakera.local/v1/sessions/srv-minted-7/end");
		expect(ends[0]?.body.summary).toBe("omp: provider session rekeyed");
	});

	// Registration that lost its race with a rekey created a server row whose
	// only write was just invalidated — end it immediately instead of leaving
	// an empty open row behind.
	it("ends a registration that lost its race with a rekey", async () => {
		const registration = Promise.withResolvers<unknown>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				requests.push({
					method: String(init?.method ?? "GET"),
					url,
					body: (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<string, unknown>,
				});
				if (url.endsWith("/v1/sessions/start"))
					return new Response(JSON.stringify(await registration.promise), { status: 200 });
				if (url.includes("/end")) return new Response(JSON.stringify({ session: {} }), { status: 200 });
				return new Response(JSON.stringify({ stored: [{ id: "m1" }] }), { status: 200 });
			}),
		);
		const state = stateFor();
		const pending = state.retainItems([{ content: "a fact" }]);
		for (let hop = 0; hop < 50 && !requests.some(r => r.url.endsWith("/v1/sessions/start")); hop++) {
			await Promise.resolve();
		}
		state.setSessionId("provider-rekeyed");
		registration.resolve({ session: { id: "srv-minted-9" } });
		await pending;
		await state.awaitPending();

		const ends = requests.filter(r => r.url.includes("/end"));
		expect(ends).toHaveLength(1);
		expect(ends[0]?.url).toBe("http://dakera.local/v1/sessions/srv-minted-9/end");
		expect(ends[0]?.body.summary).toBe("omp: abandoned registration");
		// The abandoned store was dropped, not written under the new state.
		expect(storeRequests()).toHaveLength(0);
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
