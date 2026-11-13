import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { prepareRetentionTranscript } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { supermemoryBackend } from "@oh-my-pi/pi-coding-agent/supermemory/backend";
import {
	SupermemoryClient,
	type SupermemoryForgetResult,
	SupermemoryHttpError,
} from "@oh-my-pi/pi-coding-agent/supermemory/client";
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
		.mockResolvedValue({ static: [{ memory: "prefers <tabs>" }], dynamic: [] });
	const search = vi
		.spyOn(SupermemoryClient.prototype, "search")
		.mockResolvedValue([{ id: "m1", kind: "memory", content: "uses bun" }]);
	return { profile, search };
}

const ENV = ["SUPERMEMORY_API_KEY", "SUPERMEMORY_BASE_URL", "SUPERMEMORY_NAMESPACE"] as const;
const savedEnv = new Map(ENV.map(name => [name, Bun.env[name]]));

/** Answers requests with `[status, body]` pairs in order (the last repeats) and records method, URL and JSON body. */
function serve(...responses: Array<[number, unknown]>) {
	const requests: Array<{ url: string; method?: string; body: unknown }> = [];
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body ?? "null")) });
			const [status, body] = responses[Math.min(requests.length, responses.length) - 1];
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
	const tag = session.getSupermemorySessionState()?.namespace;
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
		delete Bun.env.SUPERMEMORY_NAMESPACE;
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

	it("SUPERMEMORY_NAMESPACE overrides scoping for every request; an invalid one leaves Supermemory unconfigured", async () => {
		Bun.env.SUPERMEMORY_NAMESPACE = "team:notes";
		const requests = serve([200, { results: [] }]);
		const { recall, tag } = await startedTools();
		await recall.execute("call", { query: "bun" });
		expect(tag).toBe("team:notes");
		expect(requests.map(request => request.url)).toEqual(["http://127.0.0.1:1/ns/team%3Anotes/search"]);

		vi.restoreAllMocks();
		const fetchSpy = denyNetwork();
		Bun.env.SUPERMEMORY_NAMESPACE = "../other";
		const session = makeSession();
		await start(session);
		expect(session.getSupermemorySessionState()).toBeUndefined();
		expect(MemoryEditTool.createIf(session as never)).toBeNull();
		expect(MemoryRecallTool.createIf(session as never)).toBeNull();
		expect(await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined)).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends the recall limit as is, including 1", async () => {
		const requests = serve([200, { results: [{ id: "m1", memory: "uses bun" }] }]);
		const session = makeSession({ settings: { "supermemory.recallLimit": 1 } });
		await start(session);
		const results = await session.getSupermemorySessionState()!.search("bun", undefined);
		expect(requests[0]?.body).toMatchObject({ limit: 1 });
		expect(results).toHaveLength(1);
	});

	it("switching namespaces A→B→A on one transcript sends no turn to the other namespace", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 2 } });
		const switchTo = async (namespace: string) => {
			await session.getSupermemorySessionState()?.dispose();
			Bun.env.SUPERMEMORY_NAMESPACE = namespace;
			await start(session);
		};
		await switchTo("ns-a");
		session.addTurn("alpha-one");
		await session.endTurn();
		await switchTo("ns-b");
		session.addTurn("beta-one");
		session.addTurn("beta-two");
		await session.endTurn();
		session.addTurn("beta-three");
		await switchTo("ns-a");
		session.addTurn("alpha-two");
		session.addTurn("alpha-three");
		await session.endTurn();

		const sent = create.mock.calls.map(([namespace, input]) => [namespace, input.content] as const);
		expect(sent.map(([namespace]) => namespace)).toEqual(["ns-b", "ns-a"]);
		for (const [namespace, content] of sent) {
			expect(content).not.toContain(namespace === "ns-a" ? "beta-" : "alpha-");
		}
		expect(sent[0]?.[1]).toContain("beta-two");
		expect(sent[1]?.[1]).toContain("alpha-three");
	});

	describe("preCompactionContext", () => {
		const compacted = [
			{ role: "user", content: "older question" },
			{ role: "assistant", content: [{ type: "text", text: "older answer" }] },
			{ role: "user", content: [{ type: "text", text: "how do we build? key sm-synthetic-key" }] },
		];
		const compact = (session: { settings: Settings }) =>
			supermemoryBackend.preCompactionContext!(compacted as never, session.settings, session as never);

		it("recalls for the latest user turn of the summarized messages, redacted", async () => {
			const { profile, search } = spyRecall();
			const session = makeSession();
			await start(session);
			const context = await compact(session);
			expect(context).toContain("<supermemory_recall>");
			expect(context).toContain("- uses bun (id: m1)");
			expect(context).not.toContain("supermemory_profile");
			expect(profile).not.toHaveBeenCalled();
			const query = search.mock.calls[0]?.[1]?.query ?? "";
			expect(query).toContain("how do we build?");
			expect(query).not.toContain("older question");
			expect(query).not.toContain("sm-synthetic-key");
		});

		it("recalls nothing without a key, with autoRecall off, or for a subagent", async () => {
			const { search } = spyRecall();
			const off = makeSession({ settings: { "supermemory.autoRecall": false } });
			await start(off);
			expect(await compact(off)).toBeUndefined();

			const child = makeSession();
			await start(child, 1);
			expect(await compact(child)).toBeUndefined();

			const primary = makeSession();
			await start(primary);
			delete Bun.env.SUPERMEMORY_API_KEY;
			expect(await compact(primary)).toBeUndefined();
			expect(search).not.toHaveBeenCalled();
		});

		it("fails open: a failed search or no match yields no context", async () => {
			const search = vi
				.spyOn(SupermemoryClient.prototype, "search")
				.mockRejectedValueOnce(new SupermemoryHttpError(503))
				.mockResolvedValueOnce([]);
			const session = makeSession();
			await start(session);
			expect(await compact(session)).toBeUndefined();
			expect(await compact(session)).toBeUndefined();
			expect(search).toHaveBeenCalledTimes(2);
		});
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
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		expect(create.mock.calls.map(call => call[1]?.metadata?.turnStart)).toEqual([0]);
	});

	it("leaves an unanswered aborted turn open so its later answer is retained", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		expect(create.mock.calls[1]?.[1]?.content).toContain("resumed answer");
	});

	it("leaves an interrupted, partly answered turn open so /retry's answer is retained", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		expect(create.mock.calls[0]?.[1]?.content).toContain("retried answer");
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

	it("/memory clear waits for a queued retain that is still uploading", async () => {
		const reply = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		vi.spyOn(SupermemoryClient.prototype, "addDocument").mockImplementation(() => {
			sent.resolve();
			return reply.promise;
		});
		const session = makeSession();
		await start(session);
		// The queue starts its own delivery after enqueue, as a subagent's retain does.
		await session.getSupermemorySessionState()?.enqueueRetain("call-1", [{ content: "queued fact", source: "t" }]);
		await sent.promise;
		let cleared = false;
		const clearing = supermemoryBackend.clear("/tmp", "/tmp", session as never).then(() => {
			cleared = true;
		});
		// One macrotask turn lets an unblocked `clear` settle while the upload above is still pending.
		await Bun.sleep(0);
		expect(cleared).toBe(false);
		reply.resolve({ id: "d", status: "queued" });
		await clearing;
		expect(cleared).toBe(true);
	});

	it("the pending-write barrier that /memory clear and dispose wait on includes in-flight memory edits", async () => {
		const reply = Promise.withResolvers<SupermemoryForgetResult>();
		const sent = Promise.withResolvers<void>();
		vi.spyOn(SupermemoryClient.prototype, "forgetMemories").mockImplementation(() => {
			sent.resolve();
			return reply.promise;
		});
		const session = makeSession();
		await start(session);
		const state = session.getSupermemorySessionState();
		// Settle the start-up outbox drain so the edit is the only pending write.
		await state?.flush();
		// A subagent's `memory_edit forget` runs through the parent state.
		const forgetting = state?.forgetMemory("m1");
		await sent.promise;
		let flushed = false;
		const flushing = state?.flush().then(() => {
			flushed = true;
		});
		// One macrotask turn lets an unblocked barrier settle while the edit is still pending.
		await Bun.sleep(0);
		expect(flushed).toBe(false);
		reply.resolve({ matches: ["m1"], errors: [] });
		await Promise.all([flushing, forgetting]);
		expect(flushed).toBe(true);
	});

	it("re-sends the last window when a manual continuation adds an answer without a new user turn", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs).toHaveLength(2);
		expect(docs[1]?.id).toBe(docs[0]?.id);
		expect(docs[1]?.content).toContain("continued answer");
		// A further settle with nothing new sends nothing.
		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("a continuation after a cadence change updates the original window, not a new one", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs).toHaveLength(2);
		expect(docs[1]?.id).toBe(docs[0]?.id);
		expect(docs[1]?.content).toContain("continued");
	});

	it("a continuation after the cadence grows re-sends the shorter saved window once", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		session.settings = Settings.isolated({ ...CONFIGURED, "supermemory.retainEveryNTurns": 3 });
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
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs).toHaveLength(2);
		expect(docs[1]?.id).toBe(docs[0]?.id);
		expect(docs[1]?.content).toContain("continued");
	});

	it("redacts a long window before cutting it, so a cut after a secret's prefix leaks no suffix", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const suffix = "abcdefghijklmnopqrstuvwxyz0123";
		const secret = `ghp_${suffix}`;
		// Size the trailing filler so the 60,000-character cut lands right after `ghp_`.
		const build = async (filler: number, started: boolean) => {
			const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
			if (started) await start(session);
			const at = new Date(0).toISOString();
			const content = `${"a".repeat(1_000)} ${secret} ${"b".repeat(filler)}`;
			session.sessionManager.getEntries().push(
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: at,
					message: { role: "user", content, timestamp: 0 },
				} as never,
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: at,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						stopReason: "stop",
						timestamp: 0,
					},
				} as never,
			);
			const { transcript } = prepareRetentionTranscript(extractMessages(session.sessionManager), true, {
				includeTimestamps: true,
			});
			return { session, transcript: transcript ?? "" };
		};
		const probe = (await build(59_000, false)).transcript;
		const filler = 59_000 + probe.indexOf(secret) + "ghp_".length - (probe.length - 60_000);
		const { session, transcript } = await build(filler, true);
		expect(transcript.slice(transcript.length - 60_000).startsWith(suffix)).toBe(true);

		await session.endTurn();
		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0]?.[1]?.content).not.toContain(suffix);
	});

	it("redacts the recall query before cutting it to the query limit", async () => {
		const { search } = spyRecall();
		const session = makeSession();
		await start(session);
		// The 1,000-character query cut lands inside the token, past the redactor's minimum length.
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123";
		await supermemoryBackend.beforeAgentStartPrompt!(session as never, `${"q".repeat(980)}${secret}`, undefined);
		const sent = search.mock.calls[0]?.[1]?.query ?? "";
		expect(sent).not.toContain("ghp_abcdefghijklmnop");
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

	it("retains every N user turns with a distinct document id per window", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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

		const [first, second] = create.mock.calls.map(call => call[1]);
		expect(first?.id).toMatch(/^omp-[0-9a-f]{64}$/);
		expect(second?.id).not.toBe(first?.id);
		expect(first?.content).toContain("turn two");
		expect(first?.content).not.toContain("turn three");
		expect(second?.content).toContain("turn three");
	});

	it("never re-sends old windows across resumed processes", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([
			{ turnStart: 3, turnEnd: 4 },
			{ turnStart: 4, turnEnd: 5 },
		]);
		expect(new Set(docs.map(doc => doc?.id)).size).toBe(2);
		expect(docs[0]?.content).toContain("four");
		expect(docs[0]?.content).not.toContain("three");
	});

	it("after an in-place transcript reset, retains only turns added since the reset", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		expect(create.mock.calls.map(call => call[1]?.metadata)).toMatchObject([{ turnStart: 4, turnEnd: 5 }]);
		expect(create.mock.calls[0]?.[1]?.content).toContain("after reset");
		expect(create.mock.calls[0]?.[1]?.content).not.toContain("four");
	});

	it("lets the shutdown flush finish every queued due window", async () => {
		const pending = Promise.withResolvers<{ id: string; status: string }>();
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		expect(create.mock.calls.map(call => call[1]?.metadata?.turnStart)).toEqual([0, 1]);
	});

	it("gives subagents tool-only state with no automatic recall or retention", async () => {
		const { profile } = spyRecall();
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn(`OLDEST ${"x".repeat(70_000)} NEWEST`);
		await session.endTurn();
		const doc = create.mock.calls[0]?.[1];
		expect(doc?.content.length).toBe(60_000);
		expect(doc?.content).toContain("NEWEST");
		expect(doc?.content).not.toContain("OLDEST");
		expect(doc?.metadata).toMatchObject({ transcriptTruncated: true });
		expect(Number(doc?.metadata?.omittedChars)).toBeGreaterThan(10_000);
	});

	it("lets a resumed window re-send into an earlier /memory enqueue tail", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 2 } });
		await start(session);
		session.addTurn("one");
		await supermemoryBackend.enqueue("/tmp", "/tmp", session as never);
		await start(session);
		session.addTurn("two");
		await session.endTurn();
		const [tail, window] = create.mock.calls.map(call => call[1]);
		expect(tail?.metadata).toMatchObject({ turnStart: 0, turnEnd: 1 });
		expect(window?.metadata).toMatchObject({ turnStart: 0, turnEnd: 2 });
		expect(window?.id).toBe(tail?.id);
	});

	it("retries a window that failed before exit on resume, without re-sending completed ones", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("one");
		await session.endTurn();
		create.mockRejectedValueOnce(new Error("Supermemory request failed with HTTP 503."));
		session.addTurn("two");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		const failed = create.mock.calls[1]?.[1];
		create.mockClear();

		// A resumed process starts a fresh state on the persisted transcript.
		await start(session);
		session.addTurn("three");
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([
			{ turnStart: 1, turnEnd: 2 },
			{ turnStart: 2, turnEnd: 3 },
		]);
		expect(docs[0]?.id).toBe(failed?.id);
		expect(docs[0]?.content).toContain("two");
	});

	it("retries a session's very first window on resume when it failed before exit", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockRejectedValueOnce(new Error("Supermemory request failed with HTTP 503."))
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
		await start(session);
		session.addTurn("first");
		await session.endTurn();
		await session.getSupermemorySessionState()?.dispose();
		const failed = create.mock.calls[0]?.[1];
		create.mockClear();

		await start(session);
		session.addTurn("second");
		await session.endTurn();
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([
			{ turnStart: 0, turnEnd: 1 },
			{ turnStart: 1, turnEnd: 2 },
		]);
		expect(docs[0]?.id).toBe(failed?.id);
	});

	it.each([422, 410, 404])(
		"skips a window the server refuses for good (HTTP %d), keeps retaining later ones, and never retries it",
		async status => {
			const create = vi
				.spyOn(SupermemoryClient.prototype, "addDocument")
				.mockRejectedValueOnce(new SupermemoryHttpError(status))
				.mockResolvedValue({ id: "d", status: "queued" });
			const session = makeSession({ settings: { "supermemory.retainEveryNTurns": 1 } });
			await start(session);
			session.addTurn("refused");
			await session.endTurn();
			session.addTurn("accepted");
			await session.endTurn();
			await session.getSupermemorySessionState()?.dispose();
			expect(create.mock.calls.map(call => call[1]?.metadata)).toMatchObject([
				{ turnStart: 0, turnEnd: 1 },
				{ turnStart: 1, turnEnd: 2 },
			]);
			expect(session.notices).toEqual([
				`Memory retention skipped turns 1-1: the server refused them (HTTP ${status}).`,
			]);
			create.mockClear();

			await start(session);
			session.addTurn("resumed");
			await session.endTurn();
			expect(create.mock.calls.map(call => call[1]?.metadata)).toMatchObject([{ turnStart: 2, turnEnd: 3 }]);
		},
	);

	it("redacts the API key and recognizable secrets in stored content and search queries", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		const doc = create.mock.calls[0]?.[1];
		const sent = `${doc?.content} ${JSON.stringify(doc?.metadata)} ${search.mock.calls[0]?.[1]?.query}`;
		expect(sent).not.toContain(secret);
		expect(sent).not.toContain("sm-synthetic-key");
		expect(sent).toContain("[REDACTED]");
	});

	it("a branched copy of a transcript ignores the source's retention cursor", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		const docs = create.mock.calls.map(call => call[1]);
		expect(docs.map(doc => doc?.metadata)).toMatchObject([{ sessionId: "t2", turnStart: 1, turnEnd: 2 }]);
		expect(docs[0]?.content).toContain("three");
	});

	it("a window that completes after the session moves to a new transcript records no cursor there", async () => {
		const reply = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		vi.spyOn(SupermemoryClient.prototype, "addDocument").mockImplementation(() => {
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
			const create = vi.spyOn(SupermemoryClient.prototype, "addDocument").mockImplementation(() => {
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
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		expect(create.mock.calls[0]?.[1]?.content).toContain("continuation answer");
	});

	it("a job queued behind a slow upload retains only turns settled when it was queued", async () => {
		// Only the first upload is slow; later ones answer at once.
		const first = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		const create = vi.spyOn(SupermemoryClient.prototype, "addDocument").mockImplementation(() => {
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
		expect(create.mock.calls.map(call => call[1]?.metadata?.turnStart)).toEqual([0, 1]);
		expect(cursors(session).at(-1)?.[1]).toBe(2);
	});

	it("a job queued before the transcript changes uploads nothing and records no cursor for the new one", async () => {
		const first = Promise.withResolvers<{ id: string; status: string }>();
		const sent = Promise.withResolvers<void>();
		const create = vi.spyOn(SupermemoryClient.prototype, "addDocument").mockImplementation(() => {
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
			.spyOn(SupermemoryClient.prototype, "addDocument")
			.mockRejectedValueOnce(new Error("Supermemory request failed with HTTP 503."))
			.mockResolvedValue({ id: "d", status: "queued" });
		const session = makeSession({
			settings: { "supermemory.retainEveryNTurns": 2, "supermemory.autoRetain": false },
		});
		await start(session);
		for (const turn of ["one", "two", "three", "four"]) session.addTurn(turn);
		await supermemoryBackend.enqueue!(temp.path(), "/tmp", session as never);
		expect(create.mock.calls.map(call => [call[1]?.metadata?.turnStart, call[1]?.metadata?.turnEnd])).toEqual([
			[0, 2],
		]);
		expect(cursors(session).map(([, turn]) => turn)).not.toContain(4);
	});

	it("a disposed state refuses new saves and edits instead of writing to its old namespace", async () => {
		const create = vi.spyOn(SupermemoryClient.prototype, "addDocument");
		const forget = vi.spyOn(SupermemoryClient.prototype, "forgetMemories");
		const preview = vi.spyOn(SupermemoryClient.prototype, "previewForget");
		const read = vi.spyOn(SupermemoryClient.prototype, "getMemory");
		const session = makeSession();
		await start(session);
		const state = session.getSupermemorySessionState();
		await state?.dispose();
		await expect(state!.save("x", { source: "t" })).rejects.toThrow("memory NOT stored");
		await expect(state!.forgetMemory("m1")).rejects.toThrow("memory NOT stored");
		await expect(state!.previewForget("old")).rejects.toThrow("state is closed");
		await expect(state!.getMemory("m1")).rejects.toThrow("nothing read");
		expect([create, forget, preview, read].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
	});

	it("repeated /memory enqueue tails re-send one open window instead of adding documents", async () => {
		const create = vi
			.spyOn(SupermemoryClient.prototype, "addDocument")
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
		const ids = new Set(create.mock.calls.map(call => call[1]?.id));
		expect(create).toHaveBeenCalledTimes(3);
		expect(ids.size).toBe(1);
	});

	it("recall lists editable memory ids and marks document chunks", async () => {
		serve([
			200,
			{
				results: [
					{ id: "m1", memory: "uses bun" },
					{ id: "c1", chunk: "doc text" },
				],
			},
		]);
		const { recall } = await startedTools();
		const output = text(await recall.execute("call", { query: "bun" }));
		expect(output).toContain("- uses bun (id: m1)");
		expect(output).toContain("- doc text [document chunk]");
		expect(output).not.toContain("c1");
	});

	it("first-turn recall shows editable ids, none for aggregated summaries or chunks, and marks inferred memories", async () => {
		vi.spyOn(SupermemoryClient.prototype, "profile").mockResolvedValue({
			static: [{ id: "s1", memory: "works in <design>" }, { memory: "legacy fact" }],
			dynamic: [{ id: "aggregated_7", memory: "summary of older work" }],
		});
		vi.spyOn(SupermemoryClient.prototype, "search").mockResolvedValue([
			{ id: "m1", kind: "memory", content: "likes bun", inferred: true },
			{ id: "m2", kind: "memory", content: "uses biome", inferred: false },
			{ id: "c1", kind: "chunk", content: "doc text" },
		]);
		const session = makeSession();
		await start(session);
		const context = (await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined))?.context;
		const lines = context?.split("\n") ?? [];
		expect(lines).toContain("- works in &lt;design&gt; (id: s1)");
		expect(lines).toContain("- legacy fact");
		expect(lines).toContain("- summary of older work");
		expect(lines).toContain("- likes bun (id: m1) [inferred]");
		expect(lines).toContain("- uses biome (id: m2)");
		expect(lines).toContain("- doc text [document chunk]");
		expect(context).not.toContain("c1");
		expect(context).not.toContain("aggregated_7");
	});

	it("recall marks inferred memories, never document chunks", async () => {
		serve([
			200,
			{
				results: [
					{ id: "m1", memory: "likes bun", isInference: true },
					{ id: "m2", memory: "uses biome", isInference: false },
					{ id: "c1", chunk: "doc text", isInference: true },
				],
			},
		]);
		const { recall } = await startedTools();
		const output = text(await recall.execute("call", { query: "bun" }));
		expect(output).toContain("- likes bun (id: m1) [inferred]");
		expect(output).toContain("- uses biome (id: m2)\n");
		expect(output).toContain("- doc text [document chunk]");
		expect(output.match(/\[inferred\]/g)).toHaveLength(1);
	});

	it("recall, the first-turn block and preview_forget strip terminal controls from server text", async () => {
		const evil = "uses \x1b[31mbun\x1b[0m\x07";
		serve(
			[200, { results: [{ id: "m1", memory: evil }] }],
			[200, { count: 1, matches: [{ id: "m9", memory: evil }], errors: [] }],
		);
		const { recall, edit } = await startedTools();
		const recalled = text(await recall.execute("call", { query: "bun" }));
		const previewed = text(await edit.execute("call", { op: "preview_forget", query: "bun" }));
		expect(recalled).toContain("- uses bun (id: m1)");
		expect(previewed).toContain("- uses bun (id: m9)");

		vi.restoreAllMocks();
		vi.spyOn(SupermemoryClient.prototype, "profile").mockResolvedValue({
			static: [{ id: "s1", memory: evil }],
			dynamic: [],
		});
		vi.spyOn(SupermemoryClient.prototype, "search").mockResolvedValue([{ id: "m1", kind: "memory", content: evil }]);
		const session = makeSession();
		await start(session);
		const context = (await supermemoryBackend.beforeAgentStartPrompt!(session as never, "first", undefined))?.context;
		expect(context).toContain("- uses bun (id: s1)");
		expect(context).toContain("- uses bun (id: m1)");
		for (const output of [recalled, previewed, context]) expect(output).not.toMatch(/[\x07\x1b]/);
	});

	it("memory_edit preview_forget lists matches from a redacted dry run and forgets nothing", async () => {
		const requests = serve([
			200,
			{ count: 1, matches: [{ id: "m9", memory: "old build on port 9000" }], errors: [] },
		]);
		const { edit, tag } = await startedTools();
		const query = `old build key sm-synthetic-key ${"x".repeat(3_000)}`;
		const result = await edit.execute("call", { op: "preview_forget", query });
		const output = text(result);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect([request.method, request.url]).toEqual(["DELETE", `http://127.0.0.1:1/ns/${tag}/memories/semantic`]);
		const body = request.body as { query: string; dryRun: boolean };
		expect(body.dryRun).toBe(true);
		expect(body.query.startsWith("old build key [REDACTED] ")).toBe(true);
		expect(body.query).toHaveLength(2_000);
		expect(output).toContain("Preview only, nothing was forgotten.");
		expect(output).toContain("- old build on port 9000 (id: m9)");
		expect(output).toContain("op `forget`, one call per id");
		expect(result.details).toEqual({
			status: "previewed",
			namespace: tag,
			matches: [{ id: "m9", memory: "old build on port 9000" }],
		});
	});

	it("memory_edit update stores the redacted text as an instant-processing document first, then forgets the old memory", async () => {
		const requests = serve([200, { id: "d2", status: "queued" }], [200, { count: 1, matches: [{ id: "m1" }] }]);
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
				url: `http://127.0.0.1:1/ns/${tag}/document`,
				method: "POST",
				body: {
					content: "uses bun; key [REDACTED]",
					metadata: { source: "coding-agent-memory-edit", replaces: "m1" },
					dreaming: "instant",
				},
			},
			{ url: `http://127.0.0.1:1/ns/${tag}/memories`, method: "DELETE", body: { ids: ["m1"] } },
		]);
		expect(output).toContain(`Stored the corrected text as document d2 in namespace ${tag} and forgot memory m1.`);
		expect(output).toContain("asynchronously (instant processing)");
		expect(output).not.toMatch(/replaced|appears/);
		expect(output).toContain("no importance; it was ignored");
	});

	it("memory_edit update forgets nothing when storing the corrected text fails", async () => {
		const requests = serve([503, {}]);
		const { edit } = await startedTools();
		await expect(edit.execute("call", { op: "update", id: "m1", content: "x" })).rejects.toThrow("HTTP 503");
		expect(requests.map(request => request.method)).toEqual(["POST"]);
	});

	it("memory_edit update reports a stored correction whose old memory could not be forgotten", async () => {
		serve([200, { id: "d2", status: "queued" }], [500, {}]);
		const { edit } = await startedTools();
		const error = await edit.execute("call", { op: "update", id: "m1", content: "x" }).catch((e: Error) => e);
		expect(String(error)).toContain("Stored the corrected text as document d2");
		expect(String(error)).toContain("memory m1 could not be forgotten");
		expect(String(error)).toContain("HTTP 500");
	});

	it("memory_edit forget and invalidate soft-forget the id with DELETE and no reason", async () => {
		const requests = serve([200, { count: 1, matches: [{ id: "m1" }], errors: [] }]);
		const { edit, tag } = await startedTools();
		const forgot = text(await edit.execute("call", { op: "forget", id: "m1" }));
		const invalidated = text(await edit.execute("call", { op: "invalidate", id: "m1", replacement_id: "m2" }));
		expect(requests.map(request => [request.method, request.url, request.body])).toEqual([
			["DELETE", `http://127.0.0.1:1/ns/${tag}/memories`, { ids: ["m1"] }],
			["DELETE", `http://127.0.0.1:1/ns/${tag}/memories`, { ids: ["m1"] }],
		]);
		expect(forgot).toBe(`Memory m1 forgotten in namespace ${tag}.`);
		expect(invalidated).toBe(`Memory m1 invalidated in namespace ${tag}.`);
	});

	it("memory_edit maps per-id forget errors to clear messages", async () => {
		const { edit, tag } = await startedTools();
		const forget = (error: string) => {
			vi.restoreAllMocks();
			serve([200, { count: 0, matches: [], errors: [{ id: "m1", error }] }]);
			return edit.execute("call", { op: "forget", id: "m1" });
		};
		await expect(forget("Memory not found")).rejects.toThrow(`Memory m1 was not found in namespace ${tag}.`);
		await expect(forget("Memory is in another namespace")).rejects.toThrow(
			`Memory m1 was not forgotten in namespace ${tag}: Memory is in another namespace.`,
		);
	});

	it("memory_edit treats an already forgotten memory as done for forget, invalidate and update", async () => {
		const { edit, tag } = await startedTools();
		const already = { count: 0, matches: [], errors: [{ id: "m1", error: "Memory already forgotten" }] };
		serve([200, already]);
		const forgot = text(await edit.execute("call", { op: "forget", id: "m1" }));
		const invalidated = text(await edit.execute("call", { op: "invalidate", id: "m1" }));
		expect([forgot, invalidated]).toEqual([
			`Memory m1 was already forgotten in namespace ${tag}.`,
			`Memory m1 was already forgotten in namespace ${tag}.`,
		]);

		vi.restoreAllMocks();
		serve([200, { id: "d2", status: "queued" }], [200, already]);
		const updated = text(await edit.execute("call", { op: "update", id: "m1", content: "x" }));
		expect(updated).toContain(
			`Stored the corrected text as document d2 in namespace ${tag} and memory m1 was already forgotten.`,
		);
	});

	it("memory_edit rejects id-less edits and update without content before any request", async () => {
		const { edit } = await startedTools();
		const fetchSpy = denyNetwork();
		for (const op of ["forget", "invalidate", "update"] as const) {
			await expect(edit.execute("call", { op, content: "x" })).rejects.toThrow(`memory_edit ${op} requires id.`);
		}
		await expect(edit.execute("call", { op: "update", id: "m1" })).rejects.toThrow(
			"memory_edit update requires content.",
		);
		await expect(edit.execute("call", { op: "update", id: "m1", importance: 0.5 })).rejects.toThrow(
			"Supermemory memories have no importance",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
