import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemosyneOssBackend } from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/backend";
import type { MnemosyneOssBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/config";
import {
	getMnemosyneOssSessionState,
	MnemosyneOssSessionState,
	type MnemosyneOssWorkerLike,
	setMnemosyneOssSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/state";
import type {
	MnemosyneOssWorkerMethod,
	MnemosyneOssWorkerRecallItem,
	MnemosyneOssWorkerRecord,
} from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/worker-protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

type FakeSessionEntry =
	| {
			type: "message";
			message: { role: "user" | "assistant"; content: string | Array<{ type: "text"; text: string }> };
	  }
	| { type: "custom"; customType: string; data: unknown };

interface RememberCallOptions {
	source?: string;
	metadata?: { sourceId?: string };
}

interface FakeSessionData {
	session: AgentSession;
	entries: FakeSessionEntry[];
	customEntries: Array<{ customType: string; data: unknown }>;
	refreshes: number;
}

interface FakeWorkerData {
	worker: MnemosyneOssWorkerLike;
	calls: Array<{ method: MnemosyneOssWorkerMethod; params: Record<string, unknown> }>;
	memories: Map<string, MnemosyneOssWorkerRecord>;
	shutdowns: number;
}

const config: MnemosyneOssBackendConfig = {
	dataDir: "/tmp/mnemosyne-test",
	baseBank: "project-bank",
	bank: "project-bank",
	globalBank: "default",
	retainBank: "project-bank",
	recallBanks: ["project-bank"],
	sharedBanks: [],
	scoping: "per-project",
	ownership: "omp",
	autoRecall: true,
	autoRetain: true,
	localEmbeddings: false,
	localConsolidation: false,
	consolidationMode: "heuristic",
	autoMigrate: false,
	retainEveryNTurns: 4,
	recallLimit: 8,
	recallContextTurns: 3,
	recallMaxQueryChars: 4000,
	injectionTokenLimit: 5000,
	requestTimeoutMs: 1000,
	sleepTimeoutMs: 1000,
	shutdownTimeoutMs: 100,
	debug: true,
};

const sessions: FakeSessionData[] = [];

afterEach(() => {
	for (const { session } of sessions.splice(0)) setMnemosyneOssSessionState(session, undefined);
});

function createSession(sessionId = "session-1", entries: FakeSessionEntry[] = []): FakeSessionData {
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	const manager = {
		getCwd: () => "/tmp/project",
		getEntries: () => entries,
		appendCustomEntry: (customType: string, data: unknown) => {
			customEntries.push({ customType, data });
			entries.push({ type: "custom", customType, data });
			return `entry-${customEntries.length}`;
		},
		flush: async () => undefined,
	};
	const data: FakeSessionData = {
		entries,
		customEntries,
		refreshes: 0,
		session: {
			sessionId,
			sessionManager: manager,
			subscribe: () => () => {},
			refreshBaseSystemPrompt: async () => {
				data.refreshes++;
			},
		} as unknown as AgentSession,
	};
	sessions.push(data);
	return data;
}

function addTurn(data: FakeSessionData, index: number): void {
	data.entries.push({ type: "message", message: { role: "user", content: `user turn ${index}` } });
	data.entries.push({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: `assistant ${index}` }] },
	});
}

function rememberSourceId(params: Record<string, unknown>): string | undefined {
	const options = params.options;
	if (!options || typeof options !== "object") return undefined;
	const metadata = (options as RememberCallOptions).metadata;
	return metadata?.sourceId;
}

function createWorker(recallItems: MnemosyneOssWorkerRecallItem[] = []): FakeWorkerData {
	const calls: FakeWorkerData["calls"] = [];
	const memories = new Map<string, MnemosyneOssWorkerRecord>();
	let nextId = 1;
	let shutdowns = 0;
	const worker: MnemosyneOssWorkerLike = {
		request: async <T>(method: MnemosyneOssWorkerMethod, params: Record<string, unknown> = {}) => {
			calls.push({ method, params });
			if (method === "recall") return { items: recallItems } as T;
			if (method === "remember") {
				const id = `memory-${nextId++}`;
				const options = (params.options ?? {}) as RememberCallOptions;
				const record: MnemosyneOssWorkerRecord = {
					id,
					content: String(params.content),
					source: options.source,
					metadata: options.metadata,
					bank: "project-bank",
					editable: true,
				};
				memories.set(id, record);
				return { id } as T;
			}
			if (method === "get") {
				const record = memories.get(String(params.id));
				return (record ? { status: "found", record } : { status: "not_found", id: params.id }) as T;
			}
			if (method === "update" || method === "forget" || method === "invalidate") {
				const id = String(params.id);
				const record = memories.get(id);
				if (!record) return { status: "not_found", id } as T;
				if (method === "update") record.content = String(params.content);
				return {
					status: method === "update" ? "updated" : method === "forget" ? "deleted" : "invalidated",
					id,
					bank: record.bank,
				} as T;
			}
			if (method === "status" || method === "stats") {
				return {
					banks: [
						{
							bank: "project-bank",
							database: "/tmp/project-bank.db",
							health: "ok",
							working_count: memories.size,
						},
					],
					sdk_version: "4.0.0",
					python_version: "3.11.0",
					embedding_mode: "lexical",
					consolidation_mode: "heuristic",
				} as T;
			}
			if (method === "capabilities")
				return {
					clear_mode: "bank-manager",
					protocol: 1,
					sdk_version: "4.0.0",
					python_version: "3.11.0",
					embedding_mode: "lexical",
					consolidation_mode: "heuristic",
				} as T;
			if (method === "sleep") return { slept: true } as T;
			if (method === "clear") {
				memories.clear();
				return { deleted: true } as T;
			}
			throw new Error(`Unhandled Mnemosyne OSS worker method: ${method}`);
		},
		shutdown: async () => {
			shutdowns++;
		},
	};
	return {
		worker,
		calls,
		memories,
		get shutdowns() {
			return shutdowns;
		},
	};
}

describe("Mnemosyne OSS backend", () => {
	it("recalls fail-open and caches one untrusted first-turn block for prompt rebuilds and compaction", async () => {
		const session = createSession();
		const fake = createWorker([
			{ id: "seed", content: "stored background", source: "seed", score: 1, bank: "project-bank" },
		]);
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(session.session, state);
		const first = await mnemosyneOssBackend.beforeAgentStartPrompt!(session.session, "current question");
		expect(first?.context).toContain("<memories>");
		expect(first?.context).toContain("stored background");
		expect(first?.commit()).toBe(true);
		const second = await mnemosyneOssBackend.beforeAgentStartPrompt!(session.session, "current question");
		expect(second).toBeUndefined();
		expect(
			(await mnemosyneOssBackend.buildDeveloperInstructions(
				"/tmp",
				"/tmp",
				Settings.isolated({}),
				session.session,
			))!,
		).toContain("stored background");
		const compacted = await mnemosyneOssBackend.preCompactionContext!(
			[{ role: "user", content: "question" }] as AgentMessage[],
			Settings.isolated({}),
			session.session,
		);
		expect(compacted).toContain("stored background");
		expect(fake.calls.filter(call => call.method === "recall")).toHaveLength(2);
	});

	it("retains only unretained root suffixes, persists cursors after acknowledgement, and resumes from the latest cursor", async () => {
		const session = createSession();
		for (let index = 1; index <= 4; index++) addTurn(session, index);
		const fake = createWorker();
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		await state.maybeRetainOnAgentEnd([]);
		for (let index = 5; index <= 6; index++) addTurn(session, index);
		await state.forceRetainCurrentSession();
		const remembers = fake.calls.filter(call => call.method === "remember");
		expect(remembers).toHaveLength(2);
		expect(rememberSourceId(remembers[0].params)).toBe("session-1:turns:1-4");
		expect(rememberSourceId(remembers[1].params)).toBe("session-1:turns:5-6");
		expect(session.customEntries.at(-1)).toEqual({
			customType: "mnemosyne-oss-retention-cursor",
			data: { sessionId: "session-1", retainedThroughUserTurn: 6, sourceId: "session-1:turns:5-6" },
		});
		const resumed = createSession("session-1", session.entries);
		const resumedWorker = createWorker();
		const resumedState = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: resumed.session,
			worker: resumedWorker.worker,
		});
		addTurn(resumed, 7);
		await resumedState.forceRetainCurrentSession();
		expect(rememberSourceId(resumedWorker.calls.find(call => call.method === "remember")!.params)).toBe(
			"session-1:turns:7-7",
		);
	});

	it("aliases share explicit operations but never auto-retain, enqueue, sleep, clear, or shut down", async () => {
		const parentSession = createSession();
		const fake = createWorker();
		const parent = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: parentSession.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(parentSession.session, parent);
		const aliasSession = createSession("alias-1");
		const alias = new MnemosyneOssSessionState({
			sessionId: "alias-1",
			config,
			session: aliasSession.session,
			aliasOf: parent,
		});
		setMnemosyneOssSessionState(aliasSession.session, alias);
		await mnemosyneOssBackend.save!(
			{ agentDir: "/tmp", cwd: "/tmp", session: aliasSession.session },
			{ content: "explicit alias fact" },
		);
		await mnemosyneOssBackend.enqueue("/tmp", "/tmp", aliasSession.session);
		await alias.dispose();
		expect(fake.calls.filter(call => call.method === "remember")).toHaveLength(1);
		expect(fake.calls.some(call => call.method === "sleep")).toBe(false);
		expect(fake.shutdowns).toBe(0);
	});

	it("maps exact get/edit operations, status diagnostics, and refuses shared clear before mutation", async () => {
		const session = createSession();
		const fake = createWorker();
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(session.session, state);
		const saved = await mnemosyneOssBackend.save!(
			{ agentDir: "/tmp", cwd: "/tmp", session: session.session },
			{ content: "editable fact" },
		);
		const id = saved.ids![0];
		expect((await state.get(id)).status).toBe("found");
		expect((await state.edit("update", id, { content: "updated" })).status).toBe("updated");
		expect((await state.edit("invalidate", id)).status).toBe("invalidated");
		const status = await mnemosyneOssBackend.status!({ agentDir: "/tmp", cwd: "/tmp", session: session.session });
		expect(status.sdkVersion).toBe("4.0.0");
		const sharedSession = createSession("shared");
		const sharedConfig = { ...config, ownership: "shared" as const };
		const sharedWorker = createWorker();
		setMnemosyneOssSessionState(
			sharedSession.session,
			new MnemosyneOssSessionState({
				sessionId: "shared",
				config: sharedConfig,
				session: sharedSession.session,
				worker: sharedWorker.worker,
			}),
		);
		await expect(mnemosyneOssBackend.clear("/tmp", "/tmp", sharedSession.session)).rejects.toThrow(
			"active bank is shared",
		);
		expect(sharedWorker.calls.some(call => call.method === "clear")).toBe(false);
	});

	it("sleeps the retain bank without forcing other sessions", async () => {
		const session = createSession();
		const fake = createWorker();
		setMnemosyneOssSessionState(
			session.session,
			new MnemosyneOssSessionState({
				sessionId: "session-1",
				config,
				session: session.session,
				worker: fake.worker,
			}),
		);
		await mnemosyneOssBackend.enqueue("/tmp", "/tmp", session.session);
		expect(fake.calls.find(call => call.method === "sleep")?.params).toEqual({
			dry_run: false,
			force: false,
		});
	});

	it("drops recalled memories from developer instructions after /memory clear", async () => {
		const session = createSession();
		const fake = createWorker();
		const state = new MnemosyneOssSessionState({
			sessionId: "session-1",
			config,
			session: session.session,
			worker: fake.worker,
		});
		setMnemosyneOssSessionState(session.session, state);
		state.lastRecallSnippet = "<memories>\nsecret that was deleted\n</memories>";
		state.hasRecalledForFirstTurn = true;
		state.lastRetainedTurn = 6;
		await mnemosyneOssBackend.clear("/tmp", "/tmp", session.session);
		const instructions = await mnemosyneOssBackend.buildDeveloperInstructions(
			"/tmp",
			"/tmp",
			Settings.isolated({}),
			session.session,
		);
		expect(instructions).not.toContain("secret that was deleted");
		expect(state.lastRecallSnippet).toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(false);
		expect(state.lastRetainedTurn).toBe(0);
		expect(session.customEntries.at(-1)).toEqual({
			customType: "mnemosyne-oss-retention-cursor",
			data: { sessionId: "session-1", retainedThroughUserTurn: 0, sourceId: "session-1:cleared" },
		});
	});

	it("stays inert when the Python worker cannot handshake", async () => {
		const session = createSession();
		await mnemosyneOssBackend.start({
			session: session.session,
			settings: Settings.isolated({
				"memory.backend": "mnemosyne-oss",
				"mnemosyne-oss.executable": "/nonexistent/mnemosyne-oss-python",
				"mnemosyne-oss.requestTimeoutMs": 250,
				"mnemosyne-oss.shutdownTimeoutMs": 100,
			}),
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		expect(getMnemosyneOssSessionState(session.session)).toBeUndefined();
	});
});
