import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { loadHindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState, type MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { embed } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { complete } from "@oh-my-pi/pi-mnemopi/core/local-llm";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { TempDir } from "@oh-my-pi/pi-utils";

const MEMORY_HOST = "memory.test";
const HINDSIGHT_HOST = "hindsight.test";

interface SentRequest {
	path: string;
	paused: boolean;
}

/** One macrotask turn: every continuation queued before it has run. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/**
 * Give an unheld request every chance to reach the wire. The fetch spy records
 * at the call, so nothing on these paths waits on a timer or a socket first.
 */
async function untilSentOrIdle<T>(sent: readonly T[], matches: (request: T) => boolean = () => true): Promise<void> {
	for (let i = 0; i < 200 && !sent.some(matches); i++) await tick();
}

/** Whether `promise` settled within a few hundred event-loop turns. */
async function settles(promise: Promise<unknown>, turns = 200): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let i = 0; i < turns && !settled; i++) await tick();
	return settled;
}

/** Records every request to `host` with the gate's state at the instant it was sent. */
function recordFetches(host: string, reply: (pathname: string, body: unknown) => Response): SentRequest[] {
	const sent: SentRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.host !== host) return new Response(null, { status: 404 });
		sent.push({ path: url.pathname, paused: agentPauseGate.paused });
		return reply(url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
	}) as typeof fetch);
	return sent;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	agentPauseGate.resume();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function createSession(
	settings: Settings,
): Promise<{ session: AgentSession; registry: ModelRegistry; dir: TempDir; auth: AuthStorage }> {
	const dir = TempDir.createSync("@memory-remote-pause-");
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
	const model = getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled openai/gpt-4o-mini");
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, tools: [] } }),
		sessionManager: SessionManager.inMemory(dir.path()),
		settings,
		modelRegistry: registry,
	});
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
		dir.removeSync();
	});
	return { session, registry, dir, auth };
}

/** A real Mnemopi backend on a real session, in the explicitly configured remote mode. */
async function startRemoteMnemopi(): Promise<{ session: AgentSession; state: MnemopiSessionState }> {
	const dir = TempDir.createSync("@memory-remote-pause-db-");
	cleanups.push(() => dir.removeSync());
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("memory.db"),
		"mnemopi.autoRetain": false,
		"mnemopi.llmMode": "remote",
		"mnemopi.llmBaseUrl": `http://${MEMORY_HOST}/v1`,
		"mnemopi.llmApiKey": "fake",
		"mnemopi.llmModel": "review-model",
		"mnemopi.embeddingModel": "openai/text-embedding-3-small",
		"mnemopi.embeddingApiUrl": `http://${MEMORY_HOST}/v1`,
		"mnemopi.embeddingApiKey": "fake",
	});
	const { session, registry } = await createSession(settings);
	await mnemopiBackend.start({ session, settings, agentDir: dir.path(), modelRegistry: registry, taskDepth: 0 });
	const state = getMnemopiSessionState(session);
	if (!state) throw new Error("Expected a Mnemopi session state");
	return { session, state };
}

function memoryReply(pathname: string, body: unknown): Response {
	if (pathname.endsWith("/embeddings")) {
		const { input } = body as { input: string[] };
		return Response.json({ data: input.map(() => ({ embedding: [1, 2, 3] })) });
	}
	return Response.json({ choices: [{ message: { content: "summary" } }] });
}

function inMemoryScope<T>(state: MnemopiSessionState, fn: () => T): T {
	return withMnemopiRuntimeOptions(state.memory.runtimeOptions, fn);
}

// With `mnemopi.llmMode: remote` the library got a bare endpoint and no hold,
// and the embedding configuration had none either: both requests went out
// while `/pause` was engaged.
describe("Mnemopi remote completion and embeddings under /pause", () => {
	test("send nothing until resume", async () => {
		const sent = recordFetches(MEMORY_HOST, memoryReply);
		const { state } = await startRemoteMnemopi();

		agentPauseGate.pause();
		const text = inMemoryScope(state, () => complete("summarize these memories"));
		const rows = inMemoryScope(state, () => embed(["review paused memory"]));
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		expect(await text).toBe("summary");
		expect((await rows)?.length).toBe(1);
		// Held requests are released together; which one reaches the wire first is not ordered.
		expect(sent.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "/v1/chat/completions", paused: false },
			{ path: "/v1/embeddings", paused: false },
		]);
	});

	test("a held request fails without sending when the session is disposed", async () => {
		const sent = recordFetches(MEMORY_HOST, memoryReply);
		const { session, state } = await startRemoteMnemopi();

		agentPauseGate.pause();
		const text = inMemoryScope(state, () => complete("summarize these memories"));
		const rows = inMemoryScope(state, () => embed(["review paused memory"]));
		await untilSentOrIdle(sent);
		await session.dispose();

		expect(await settles(text)).toBe(true);
		expect(await text).toBeNull();
		expect(await rows).toBeNull();
		agentPauseGate.resume();
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);
	});

	test("a held request fails without sending when its memory closes", async () => {
		const sent = recordFetches(MEMORY_HOST, memoryReply);
		const { state } = await startRemoteMnemopi();

		agentPauseGate.pause();
		const rows = inMemoryScope(state, () => embed(["review paused memory"]));
		await untilSentOrIdle(sent);
		await state.dispose({ consolidate: false });

		expect(await settles(rows)).toBe(true);
		expect(await rows).toBeNull();
		agentPauseGate.resume();
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);
	});

	test("a turn's abort releases a recall held at its query embedding, without sending it", async () => {
		const sent = recordFetches(MEMORY_HOST, memoryReply);
		const { state } = await startRemoteMnemopi();
		const turn = new AbortController();

		agentPauseGate.pause();
		const recalled = state.recallForContext("deploy host", turn.signal);
		await untilSentOrIdle(sent);
		turn.abort(new Error("turn cancelled"));

		expect(await settles(recalled)).toBe(true);
		expect(await recalled).toBeUndefined();
		agentPauseGate.resume();
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);
	});
});

function memoryModelReply(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Sam works at Globex." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 8,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// The managed completion waited out a pause with no lifetime at all, so a
// memory closed while its completion was held still paid for it on resume.
describe("Mnemopi managed completion under /pause", () => {
	async function startManagedMnemopi(): Promise<{ state: MnemopiSessionState; sent: boolean[] }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-6");
		const sent: boolean[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (candidate, _context, options) => {
			// The provider layer's contract: await the request's hold, then send.
			await options?.beforeDispatch?.();
			sent.push(agentPauseGate.paused);
			return memoryModelReply(candidate);
		});
		const dir = TempDir.createSync("@memory-managed-pause-db-");
		cleanups.push(() => dir.removeSync());
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
			"mnemopi.dbPath": dir.join("memory.db"),
			"mnemopi.noEmbeddings": true,
			"mnemopi.autoRetain": false,
			"mnemopi.llmMode": "smol",
			modelRoles: { memory: `${model.provider}/${model.id}` },
		});
		const { session, registry, auth } = await createSession(settings);
		auth.keys.setRuntime(model.provider, "test-key");
		vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
		vi.spyOn(registry, "getApiKeyForProvider").mockResolvedValue(undefined);
		await mnemopiBackend.start({ session, settings, agentDir: dir.path(), modelRegistry: registry, taskDepth: 0 });
		const state = getMnemopiSessionState(session);
		if (!state) throw new Error("Expected a Mnemopi session state");
		return { state, sent };
	}

	test("sends nothing until resume", async () => {
		const { state, sent } = await startManagedMnemopi();

		agentPauseGate.pause();
		const text = inMemoryScope(state, () => complete("Sam works at Globex."));
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		expect(await text).toBe("Sam works at Globex.");
		expect(sent).toEqual([false]);
	});

	test("a held completion fails without sending when its memory closes", async () => {
		const { state, sent } = await startManagedMnemopi();

		agentPauseGate.pause();
		const text = inMemoryScope(state, () => complete("Sam works at Globex."));
		await untilSentOrIdle(sent);
		await state.dispose({ consolidate: false });

		expect(await settles(text)).toBe(true);
		expect(await text).toBeNull();
		agentPauseGate.resume();
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);
	});
});

function hindsightState(client: HindsightApi): HindsightSessionState {
	const config = loadHindsightConfig(
		Settings.isolated({ "hindsight.apiUrl": `http://${HINDSIGHT_HOST}`, "hindsight.autoRetain": false }),
	);
	const session = {
		getHindsightSessionState: () => state,
		emitNotice: () => {},
	};
	const state: HindsightSessionState = new HindsightSessionState({
		sessionId: "review",
		bankId: "review",
		client,
		config,
		banksSet: new Set(["review"]),
		session: session as never,
	});
	cleanups.push(() => state.dispose());
	return state;
}

const hindsightReply = () => Response.json({ success: true, results: [], items: [] });

// A retain the agent queued before the pause was flushed, and a reflect was
// asked, while `/pause` was engaged: both are new work for the Hindsight
// server's models, and both went out.
describe("Hindsight model work under /pause", () => {
	test("a queued retain flush waits for resume", async () => {
		const sent = recordFetches(HINDSIGHT_HOST, hindsightReply);
		const state = hindsightState(new HindsightApi({ baseUrl: `http://${HINDSIGHT_HOST}` }));

		state.enqueueRetain("A retained fact queued before pause");
		agentPauseGate.pause();
		const flushing = state.flushRetainQueue();
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		await flushing;
		expect(sent).toEqual([{ path: "/v1/default/banks/review/memories", paused: false }]);
	});

	test("reflect and recall wait for resume", async () => {
		const sent = recordFetches(HINDSIGHT_HOST, hindsightReply);
		const client = new HindsightApi({ baseUrl: `http://${HINDSIGHT_HOST}` });

		agentPauseGate.pause();
		const reflected = client.reflect("review", "What should I do next?");
		const recalled = client.recall("review", "next steps");
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		await Promise.all([reflected, recalled]);
		expect(sent.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "/v1/default/banks/review/memories/recall", paused: false },
			{ path: "/v1/default/banks/review/reflect", paused: false },
		]);
	});

	test("a caller's abort releases a held recall without sending it", async () => {
		const sent = recordFetches(HINDSIGHT_HOST, hindsightReply);
		const client = new HindsightApi({ baseUrl: `http://${HINDSIGHT_HOST}` });
		const turn = new AbortController();

		agentPauseGate.pause();
		const recalled = client.recall("review", "next steps", { signal: turn.signal });
		await untilSentOrIdle(sent);
		turn.abort(new Error("turn cancelled"));

		await expect(recalled).rejects.toThrow("turn cancelled");
		agentPauseGate.resume();
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);
	});

	test("the session's disposal releases a held retain flush without sending it", async () => {
		const sent = recordFetches(HINDSIGHT_HOST, hindsightReply);
		const settings = Settings.isolated({
			"memory.backend": "hindsight",
			"hindsight.apiUrl": `http://${HINDSIGHT_HOST}`,
			"hindsight.autoRecall": false,
			"hindsight.autoRetain": false,
			"hindsight.mentalModelsEnabled": false,
		});
		const { session, registry, dir } = await createSession(settings);
		await hindsightBackend.start({ session, settings, agentDir: dir.path(), modelRegistry: registry, taskDepth: 0 });
		const state = session.getHindsightSessionState();
		if (!state) throw new Error("Expected a Hindsight session state");

		state.enqueueRetain("A retained fact queued before pause");
		agentPauseGate.pause();
		const flushing = state.flushRetainQueue();
		const isRetain = (request: SentRequest) => request.path.endsWith("/memories");
		await untilSentOrIdle(sent, isRetain);
		await session.dispose();

		expect(await settles(flushing)).toBe(true);
		agentPauseGate.resume();
		await untilSentOrIdle(sent, isRetain);
		expect(sent.filter(isRetain)).toEqual([]);
	});

	// Reads and the bank's idempotent setup ask the server for no model work,
	// so they are not held.
	test("reads and bank setup are not held", async () => {
		const sent = recordFetches(HINDSIGHT_HOST, hindsightReply);
		const client = new HindsightApi({ baseUrl: `http://${HINDSIGHT_HOST}` });

		agentPauseGate.pause();
		await client.createBank("review");
		await client.listMentalModels("review");
		expect(sent).toEqual([
			{ path: "/v1/default/banks/review", paused: true },
			{ path: "/v1/default/banks/review/mental-models", paused: true },
		]);
	});
});
