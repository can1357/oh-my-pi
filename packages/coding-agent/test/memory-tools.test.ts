/**
 * Contract tests for the three shared memory tool factories.
 *
 * These exercise the public tool surface (factory gating + execute path) by
 * spying on `HindsightApi.prototype.{retain, recall, reflect}` and stubbing
 * Hindsight state on the fake ToolSession. We deliberately do not boot a real
 * session — these tools only need a populated state accessor and Settings.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig, type MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiScopedDbPaths,
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const TEST_SESSION_ID = "test-session-id";
let registeredState: HindsightSessionState | undefined;
let registeredMnemopiState: MnemopiSessionState | undefined;
let tempDbPath: string | undefined;
let tempDbDir: TempDir | undefined;

function makeConfig(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
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
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 120_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 60_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelRefreshIntervalMs: 5 * 60 * 1000,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

function makeSession(settings: Settings, sessionId: string | null = TEST_SESSION_ID): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => (sessionId === TEST_SESSION_ID ? registeredState : undefined),
		getMnemopiSessionState: () => (sessionId === TEST_SESSION_ID ? registeredMnemopiState : undefined),
	} as unknown as ToolSession;
}

interface RegisterStateOptions {
	retainTags?: string[];
	recallTags?: string[];
	recallTagsMatch?: "any" | "all" | "any_strict" | "all_strict";
	sessionOverrides?: Record<string, unknown>;
}

function registerState(client: HindsightApi, settings?: Settings, opts: RegisterStateOptions = {}) {
	registeredState = new HindsightSessionState({
		sessionId: TEST_SESSION_ID,
		client,
		bankId: "test-bank",
		retainTags: opts.retainTags,
		recallTags: opts.recallTags,
		recallTagsMatch: opts.recallTagsMatch,
		config: makeConfig(),
		session: {
			sessionId: TEST_SESSION_ID,
			sessionManager: { getEntries: () => [] } as never,
			emitNotice: () => {},
			getHindsightSessionState: () => registeredState,
			...opts.sessionOverrides,
		} as never,
		banksSet: new Set(),
		lastRetainedTurn: 0,
		hasRecalledForFirstTurn: false,
	});
	void settings;
}

function makeMnemopiConfig(
	overrides: (Partial<MnemopiBackendConfig> & Record<string, unknown>) | undefined = {},
): MnemopiBackendConfig {
	if (!tempDbPath) {
		tempDbDir = TempDir.createSync(`@mnemopi-test-${Date.now()}-`);
		tempDbPath = tempDbDir.join("mnemopi.db");
	}
	return {
		dbPath: tempDbPath,
		bank: "test-bank",
		autoRecall: true,
		autoRetain: true,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
			embeddingApiKey: undefined,
			llm: false,
		},
		llmMode: "none",
		llmBaseUrl: undefined,
		llmApiKey: undefined,
		llmModel: undefined,
		...overrides,
	};
}

interface RegisterMnemopiStateOptions {
	cwd?: string;
	sessionId?: string;
	entries?: () => unknown[];
	listeners?: Set<AgentSessionEventListener>;
}

function registerMnemopiState(
	config?: MnemopiBackendConfig,
	options: RegisterMnemopiStateOptions = {},
): MnemopiSessionState {
	const finalConfig = config ?? makeMnemopiConfig();
	const sessionId = options.sessionId ?? TEST_SESSION_ID;
	registeredMnemopiState = new MnemopiSessionState({
		sessionId,
		config: finalConfig,
		session: {
			sessionId,
			settings: Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.noEmbeddings": true,
				"mnemopi.llmMode": "none",
			}),
			modelRegistry: {
				getApiKeyForProvider: async () => undefined,
				resolver: () => async () => undefined,
			} as never,
			sessionManager: {
				getEntries: options.entries ?? (() => []),
				getCwd: () => options.cwd ?? "/tmp",
			} as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: (listener: AgentSessionEventListener) => {
				options.listeners?.add(listener);
				return () => options.listeners?.delete(listener);
			},
		} as never,
	});
	setMnemopiSessionState(registeredMnemopiState.session as never, registeredMnemopiState);
	return registeredMnemopiState;
}

describe("Hindsight tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("retain/recall/reflect factories return null when memory.backend !== hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "local", "memories.enabled": false });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeNull();
		expect(MemoryRecallTool.createIf(session)).toBeNull();
		expect(MemoryReflectTool.createIf(session)).toBeNull();
	});

	it("retain/recall/reflect factories return tool instances when memory.backend === hindsight", () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(session)).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(session)).toBeInstanceOf(MemoryReflectTool);
	});
});

describe("Mnemopi tool factories", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemopiState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemopiState?.dispose();
		registeredMnemopiState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("memory tool factories gate on supported backends", () => {
		const offSettings = Settings.isolated({ "memory.backend": "off", "memories.enabled": false });
		const hindsightSettings = Settings.isolated({ "memory.backend": "hindsight" });
		const localSession = makeSession(Settings.isolated({ "memory.backend": "local", "memories.enabled": false }));
		expect(MemoryRetainTool.createIf(localSession)).toBeNull();
		expect(MemoryRecallTool.createIf(localSession)).toBeNull();
		expect(MemoryReflectTool.createIf(localSession)).toBeNull();
		expect(MemoryEditTool.createIf(makeSession(offSettings))).toBeNull();
		expect(MemoryEditTool.createIf(makeSession(hindsightSettings))).toBeNull();
	});

	it("retain/recall/reflect/edit factories return tool instances when memory.backend === mnemopi", () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const session = makeSession(settings);
		expect(MemoryRetainTool.createIf(session)).toBeInstanceOf(MemoryRetainTool);
		expect(MemoryRecallTool.createIf(session)).toBeInstanceOf(MemoryRecallTool);
		expect(MemoryReflectTool.createIf(session)).toBeInstanceOf(MemoryReflectTool);
		expect(MemoryEditTool.createIf(session)).toBeInstanceOf(MemoryEditTool);
	});
});

describe("retain.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("queues the memory and reports success without calling the API", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		const retainSpy = vi.spyOn(HindsightApi.prototype, "retain").mockResolvedValue({} as never);
		registerState(client, settings);

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-1", { items: [{ content: "user prefers tabs" }] });

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory queued." });
		// Tool returns before any HTTP work happens.
		expect(retainBatchSpy).not.toHaveBeenCalled();
		expect(retainSpy).not.toHaveBeenCalled();
		expect(registeredState?.retainQueue.depth).toBe(1);
	});

	it("flushes a multi-item tool call as a single retainBatch call with per-item context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const retainBatchSpy = vi.spyOn(HindsightApi.prototype, "retainBatch").mockResolvedValue({} as never);
		registerState(client, settings, { retainTags: ["project:pi"] });

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-batch", {
			items: [{ content: "fact one" }, { content: "fact two", context: "user override" }],
		});
		expect(result.content[0]).toEqual({ type: "text", text: "2 memories queued." });

		await registeredState?.flushRetainQueue();

		expect(retainBatchSpy).toHaveBeenCalledTimes(1);
		const [bankId, items, options] = retainBatchSpy.mock.calls[0];
		expect(bankId).toBe("test-bank");
		expect(options).toEqual(expect.objectContaining({ async: true }));
		expect(items).toEqual([
			expect.objectContaining({
				content: "fact one",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:pi"],
			}),
			expect.objectContaining({
				content: "fact two",
				context: "user override",
				metadata: { session_id: TEST_SESSION_ID },
				tags: ["project:pi"],
			}),
		]);
		expect(registeredState?.retainQueue.depth).toBe(0);
	});

	it("emits a UI-only warning notice when the batch flush fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "retainBatch").mockRejectedValue(new Error("HTTP 503"));
		const noticeSpy = vi.fn();
		registerState(client, settings, { sessionOverrides: { emitNotice: noticeSpy } });

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await tool.execute("call-x", { items: [{ content: "doomed fact" }] });
		await registeredState?.flushRetainQueue();

		expect(noticeSpy).toHaveBeenCalledTimes(1);
		const [level, message, source] = noticeSpy.mock.calls[0];
		expect(level).toBe("warning");
		expect(source).toBe("Hindsight");
		expect(message).toContain("HTTP 503");
		expect(message).toContain("1 memory");
	});

	it("throws when no per-session state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-2", { items: [{ content: "x" }] })).rejects.toThrow(/not initialised/i);
	});
});

describe("retain.execute (Mnemopi backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemopiState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemopiState?.dispose();
		registeredMnemopiState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("writes memories synchronously and returns a stored success message", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemopi-1", {
			items: [{ content: "user prefers tabs", context: "editor configuration" }],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "1 memory stored." });

		// Verify the memory was actually stored by recalling it
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const recallResult = await recallTool.execute("call-mnemopi-recall", { query: "user preferences" });

		const text = (recallResult.content[0] as { text: string }).text;
		expect(text).toContain("user prefers tabs");
	});

	it("stores multiple memories and returns correct count", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemopi-multi", {
			items: [
				{ content: "fact one" },
				{ content: "fact two", context: "additional context" },
				{ content: "fact three" },
			],
		});

		expect(result.content[0]).toEqual({ type: "text", text: "3 memories stored." });

		// Verify all memories are recallable
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const recallResult = await recallTool.execute("call-mnemopi-recall-multi", { query: "facts" });

		const text = (recallResult.content[0] as { text: string }).text;
		expect(text).toContain("fact one");
		expect(text).toContain("fact two");
		expect(text).toContain("fact three");
	});

	it("isolates memories between projects when scoping is per-project", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project",
		});
		const alphaConfig = makeMnemopiConfig({ scoping: "per-project", bank: "project-alpha" });
		const betaConfig = makeMnemopiConfig({ scoping: "per-project", bank: "project-beta" });
		registerMnemopiState(alphaConfig, { cwd: "/work/project-alpha" });
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-alpha-store", {
			items: [{ content: "alpha uses tabs" }],
		});
		await registeredMnemopiState?.dispose();
		registerMnemopiState(betaConfig, { cwd: "/work/project-beta" });
		const betaRecall = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemopi-beta-recall", {
			query: "tabs",
		});
		expect(betaRecall.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
		await registeredMnemopiState?.dispose();
		registerMnemopiState(alphaConfig, { cwd: "/work/project-alpha" });
		const alphaRecall = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemopi-alpha-recall", {
			query: "tabs",
		});
		expect((alphaRecall.content[0] as { text: string }).text).toContain("alpha uses tabs");
	});
	it("throws when no per-session Mnemopi state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const tool = MemoryRetainTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemopi-no-state", { items: [{ content: "x" }] })).rejects.toThrow(
			/not initialised/i,
		);
	});
});

describe("Mnemopi backend lifecycle", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemopiState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
		// Close any leaked default Mnemopi instance from a prior test so its
		// SQLite handle doesn't keep the next test's DB files locked on Windows.
		resetMemoryForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemopiState?.dispose();
		registeredMnemopiState = undefined;
		// Close the mnemopi default instance so its SQLite handle doesn't keep
		// the temp DB files locked on Windows.
		resetMemoryForTests();
		await tempDbDir?.remove().catch(() => {});
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("keeps background auto-recall engine failures from escaping", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "existing memory" } }];
		const state = registerMnemopiState(makeMnemopiConfig({ autoRecall: true }), {
			entries: () => entries,
		});
		vi.spyOn(state.getScopedRecallTargets()[0].memory, "recallEnhanced").mockRejectedValue(
			new TypeError("mmrRerankIndices is not a function"),
		);

		await expect(state.maybeRecallOnAgentStart()).resolves.toBeUndefined();
		expect(state.hasRecalledForFirstTurn).toBe(false);
	});

	it("contains unavailable-bank failures from agent-end retention", async () => {
		const listeners = new Set<AgentSessionEventListener>();
		const entries = [{ type: "message", message: { role: "user", content: "turn one" } }];
		const state = registerMnemopiState(makeMnemopiConfig({ retainEveryNTurns: 1 }), {
			entries: () => entries,
			listeners,
		});
		state.attachSessionListeners();
		state.memory.beam.db.close();
		const warning = Promise.withResolvers<void>();
		const warn = vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "Mnemopi: lifecycle hook failed") warning.resolve();
			void context;
		});

		for (const listener of listeners) listener({ type: "agent_end", messages: [] } as never);
		await warning.promise;

		expect(warn).toHaveBeenCalledWith("Mnemopi: lifecycle hook failed", {
			banks: ["test-bank"],
			operation: "agent_end retention",
			error: "Cannot use a closed database",
		});
	});

	it("contains failures before agent-start recall reaches its internal bank guard", async () => {
		const listeners = new Set<AgentSessionEventListener>();
		const state = registerMnemopiState(makeMnemopiConfig(), {
			entries: () => {
				throw new Error("session journal unavailable");
			},
			listeners,
		});
		state.attachSessionListeners();
		const warning = Promise.withResolvers<void>();
		const warn = vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			if (message === "Mnemopi: lifecycle hook failed") warning.resolve();
			void context;
		});

		for (const listener of listeners) listener({ type: "agent_start" } as never);
		await warning.promise;

		expect(warn).toHaveBeenCalledWith("Mnemopi: lifecycle hook failed", {
			banks: ["test-bank"],
			operation: "agent_start recall",
			error: "session journal unavailable",
		});
	});
	it("auto-retain stores only the not-yet-retained suffix", async () => {
		const entries = Array.from({ length: 4 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		const state = registerMnemopiState(makeMnemopiConfig({ retainEveryNTurns: 2 }), {
			cwd: "/work/project-alpha",
			entries: () => entries,
		});
		state.lastRetainedTurn = 2;
		const retainSpy = vi.spyOn(state, "retainMessages").mockResolvedValue();

		await state.maybeRetainOnAgentEnd([{ role: "user", content: [{ type: "text", text: "turn 4" }] }] as never);

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0][0]).toEqual([
			{ role: "user", content: "turn 3" },
			{ role: "user", content: "turn 4" },
		]);
		expect(state.lastRetainedTurn).toBe(4);
	});

	it("does not retain the current session on dispose when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "private turn" } }];
		const state = registerMnemopiState(makeMnemopiConfig({ autoRetain: false }), {
			entries: () => entries,
		});
		const dbPath = state.memory.dbPath;
		if (!dbPath) throw new Error("Expected a file-backed Mnemopi database");

		await state.dispose();

		const db = new Database(dbPath, { readonly: true });
		const row = db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		db.close();
		expect(row?.count).toBe(0);
	});

	it("explicit force-retention stores the current session when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "explicitly forced turn" } }];
		const state = registerMnemopiState(makeMnemopiConfig({ autoRetain: false }), {
			entries: () => entries,
		});

		await state.forceRetainCurrentSession();

		const row = state.memory.beam.db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		expect(row?.count).toBe(1);
	});
	it("explicit consolidation stores the current session when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "explicitly consolidated turn" } }];
		const state = registerMnemopiState(makeMnemopiConfig({ autoRetain: false }), {
			entries: () => entries,
		});

		await state.consolidate({ sleep: false });

		const row = state.memory.beam.db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		expect(row?.count).toBe(1);
	});

	it("explicit enqueue retains the current session when auto-retain is disabled", async () => {
		const entries = [{ type: "message", message: { role: "user", content: "explicitly retained turn" } }];
		const state = registerMnemopiState(makeMnemopiConfig({ autoRetain: false }), {
			entries: () => entries,
		});
		const retainMemory = state.getScopedRetainTarget().memory;
		vi.spyOn(retainMemory, "sleepAllSessions");

		await mnemopiBackend.enqueue(path.dirname(tempDbPath!), "/tmp", state.session);

		const row = retainMemory.beam.db
			.prepare<{ count: number }, []>(`
				SELECT COUNT(*) AS count
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
			`)
			.get();
		expect(row?.count).toBe(1);
		expect(retainMemory.sleepAllSessions).toHaveBeenCalledTimes(1);
	});

	it("consolidates age-eligible working memory at session start so the next write does not TTL-trim it (#10770)", () => {
		const state = registerMnemopiState();
		const memory = state.getScopedRetainTarget().memory;
		const beam = memory.beam;
		// Explicit retain from a prior session: STATED, unconsolidated.
		const retainId = memory.remember("durable lesson worth keeping across sessions", {
			source: "coding-agent-retain",
			importance: 0.75,
			scope: "bank",
			extract: false,
		});
		// Simulate a >24h session gap: past the 24h TTL and the 12h sleep gate.
		const oldTs = new Date(Date.now() - 48 * 3_600_000).toISOString();
		beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [oldTs, retainId]);

		// Session start consolidation stamps consolidated_at before any write.
		state.promoteEligibleWorkingMemory();
		const consolidatedAt = (
			beam.db.query("SELECT consolidated_at FROM working_memory WHERE id = ?").get(retainId) as {
				consolidated_at: string | null;
			} | null
		)?.consolidated_at;
		expect(consolidatedAt).not.toBeNull();

		// A later write triggers trimWorkingMemory(); the consolidated row survives.
		memory.remember("a fresh note in the new session", { source: "coding-agent-transcript", scope: "bank" });
		expect(memory.get(retainId)).not.toBeNull();
	});

	it("promotes aged working memory when the backend starts a top-level session (#10770)", async () => {
		// Resolve seed and started session to the SAME bank/db: `global` scoping
		// with the shared `default` bank maps the retain bank straight to dbPath.
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.scoping": "global",
			"mnemopi.bank": "default",
			"mnemopi.dbPath": makeMnemopiConfig().dbPath,
		});
		// Seed an aged, unconsolidated retain row, then close the bank handles so
		// backend.start reopens the same DB file from disk.
		const seed = registerMnemopiState(makeMnemopiConfig({ scoping: "global", bank: "default" }));
		const seedMemory = seed.getScopedRetainTarget().memory;
		const retainId = seedMemory.remember("aged durable lesson", {
			source: "coding-agent-retain",
			scope: "bank",
			extract: false,
		});
		seedMemory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [
			new Date(Date.now() - 48 * 3_600_000).toISOString(),
			retainId,
		]);
		await seed.dispose({ consolidate: false });
		registeredMnemopiState = undefined;
		resetMemoryForTests();

		const modelRegistry = { getApiKeyForProvider: async () => undefined, resolver: () => async () => undefined };
		const session = {
			sessionId: TEST_SESSION_ID,
			settings,
			modelRegistry,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: () => () => {},
		} as never;
		await mnemopiBackend.start({
			session,
			settings,
			modelRegistry: modelRegistry as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 0,
		});

		const started = getMnemopiSessionState(session);
		expect(started).toBeDefined();
		registeredMnemopiState = started;
		const memory = started!.getScopedRetainTarget().memory;
		// The row must have survived start into the reopened bank, and a later
		// write (which triggers trimWorkingMemory) must not remove it — start
		// promoted it to episodic, so the TTL trim skips it.
		expect(memory.get(retainId)).not.toBeNull();
		memory.remember("a fresh note after start", { source: "coding-agent-transcript", scope: "bank" });
		expect(memory.get(retainId)).not.toBeNull();
	});

	it("does not re-store retained turns during consolidation or after resume", async () => {
		const entries = Array.from({ length: 6 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		let visibleTurns = 2;
		const config = makeMnemopiConfig({ retainEveryNTurns: 2 });
		const state = registerMnemopiState(config, {
			cwd: "/work/project-alpha",
			entries: () => entries.slice(0, visibleTurns),
		});

		await state.maybeRetainOnAgentEnd([] as never);
		visibleTurns = 4;
		await state.maybeRetainOnAgentEnd([] as never);
		await state.forceRetainCurrentSession();
		await state.dispose({ consolidate: false });

		visibleTurns = 6;
		const resumed = registerMnemopiState(config, {
			cwd: "/work/project-alpha",
			entries: () => entries.slice(0, visibleTurns),
		});
		await resumed.forceRetainCurrentSession();

		const rows = resumed.memory.beam.db
			.prepare<{ content: string; retainedThroughUserTurn: number }, [string]>(`
				SELECT
					content,
					CAST(json_extract(metadata_json, '$.retained_through_user_turn') AS INTEGER)
						AS retainedThroughUserTurn
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
				  AND json_extract(metadata_json, '$.session_id') = ?
				ORDER BY rowid
			`)
			.all(TEST_SESSION_ID);
		expect(rows.map(row => row.content.match(/turn \d+/g))).toEqual([
			["turn 1", "turn 2"],
			["turn 3", "turn 4"],
			["turn 5", "turn 6"],
		]);
		expect(rows.map(row => row.retainedThroughUserTurn)).toEqual([2, 4, 6]);
	});

	it("does not over-count legacy cumulative resumed rows when restoring the cursor", async () => {
		const entries = Array.from({ length: 8 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		const config = makeMnemopiConfig({ retainEveryNTurns: 2 });
		const seed = registerMnemopiState(config, { cwd: "/work/project-alpha" });
		const turn = (index: number) => ({ role: "user", content: `turn ${index}` });
		// Legacy pre-fix bank: two incremental rows plus a cumulative row written
		// by a resumed session whose in-memory cursor had reset to zero. None of
		// them carry retained_through_user_turn metadata.
		await seed.retainMessages([turn(1), turn(2)], `${TEST_SESSION_ID}-1`);
		await seed.retainMessages([turn(3), turn(4)], `${TEST_SESSION_ID}-2`);
		await seed.retainMessages([turn(1), turn(2), turn(3), turn(4), turn(5), turn(6)], `${TEST_SESSION_ID}-3`);
		await seed.dispose({ consolidate: false });

		const resumed = registerMnemopiState(config, {
			cwd: "/work/project-alpha",
			entries: () => entries,
		});
		await resumed.maybeRetainOnAgentEnd([] as never);

		const rows = resumed.memory.beam.db
			.prepare<{ content: string }, [string]>(`
				SELECT content
				FROM working_memory
				WHERE source = 'coding-agent-transcript'
				  AND json_extract(metadata_json, '$.session_id') = ?
				ORDER BY rowid
			`)
			.all(TEST_SESSION_ID);
		expect(rows).toHaveLength(4);
		expect(rows.at(-1)?.content.match(/turn \d+/g)).toEqual(["turn 7", "turn 8"]);
	});

	it("retains the full transcript but extracts and embeds clean projections", async () => {
		const state = registerMnemopiState(makeMnemopiConfig(), { cwd: "/work/project-alpha" });
		const rememberSpy = vi.spyOn(state, "rememberInScope").mockReturnValue("memory-id");

		await state.retainMessages(
			[
				{ role: "user", content: "I always prefer tabs" },
				{ role: "assistant", content: "the parser never initializes and reorder never activates" },
				{ role: "user", content: "I never use semicolons" },
			],
			"source-1",
		);

		expect(rememberSpy).toHaveBeenCalledTimes(1);
		const [storedTranscript, options] = rememberSpy.mock.calls[0];
		if (options === undefined) throw new Error("retainMessages did not pass remember options");
		expect(storedTranscript).toContain("[role: assistant]");
		expect(storedTranscript).toContain("reorder never activates");
		expect(options.extract).toBe(true);
		expect(options.extractEntities).toBe(true);
		expect(options.extractText).toContain("I always prefer tabs");
		expect(options.extractText).toContain("I never use semicolons");
		expect(options.extractText).not.toContain("parser never initializes");
		expect(options.embedText).toContain("I always prefer tabs");
		expect(options.embedText).toContain("parser never initializes");
		expect(options.embedText).toContain("I never use semicolons");
		expect(options.embedText).not.toContain("[role:");
		expect(options.embedText).not.toContain(":end]");
	});

	it("registers subagent aliases from parent Mnemopi state without Hindsight", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const parentState = registerMnemopiState();
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => "/tmp",
			},
			emitNotice: () => {},
		} as never;

		await mnemopiBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemopiSessionState: parentState,
		});

		const childState = getMnemopiSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);
		expect(childState?.getScopedRetainTarget().bank).toBe(parentState.getScopedRetainTarget().bank);
		await childState?.dispose();
	});

	it("flushes extractions and closes every owned bank on session shutdown (#2320)", async () => {
		const config = makeMnemopiConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemopiState(config, { cwd: "/work/project-alpha" });
		// Seed working memory in each owned bank so the SQL consolidation path
		// has rows to walk and the sleep call is not a trivial no-op.
		state.rememberInScope("project-alpha note", { scope: "bank", extract: false, source: "test" });
		state.globalMemory?.remember("default-bank note", { scope: "bank", extract: false, source: "test" });

		const retainMemory = state.getScopedRetainTarget().memory;
		const ownedMemories = [retainMemory];
		if (state.globalMemory && state.globalMemory !== retainMemory) {
			ownedMemories.push(state.globalMemory);
		}

		const retainSpy = vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();
		const perBank = ownedMemories.map(memory => ({
			memory,
			flush: vi.spyOn(memory, "flushExtractions"),
			sleep: vi.spyOn(memory, "sleep"),
			close: vi.spyOn(memory, "close"),
		}));

		await state.dispose();

		expect(retainSpy).toHaveBeenCalledTimes(1);
		for (const bank of perBank) {
			expect(bank.flush).toHaveBeenCalledTimes(1);
			expect(bank.sleep).not.toHaveBeenCalled();
			expect(bank.close).toHaveBeenCalledTimes(1);
			const flushedAt = bank.flush.mock.invocationCallOrder[0];
			const closedAt = bank.close.mock.invocationCallOrder[0];
			expect(flushedAt).toBeLessThan(closedAt);
			expect(retainSpy.mock.invocationCallOrder[0]).toBeLessThan(closedAt);
		}
		// State already consumed its owned resources; the afterEach hook would
		// otherwise re-enter dispose on closed handles.
		registeredMnemopiState = undefined;
	});

	it("dispose({ timeoutMs }) returns within the budget when consolidate stalls (#3641)", async () => {
		const state = registerMnemopiState();
		const retainMemory = state.getScopedRetainTarget().memory;
		// Hold flushExtractions hostage longer than any reasonable shutdown budget
		// so the race exclusively settles via the timeout branch.
		const flushStall = Promise.withResolvers<void>();
		let flushCalls = 0;
		const flushSpy = vi.spyOn(retainMemory, "flushExtractions").mockImplementation(async () => {
			flushCalls++;
			await flushStall.promise;
		});
		const closeDone = Promise.withResolvers<void>();
		const close = retainMemory.close.bind(retainMemory);
		const closeSpy = vi.spyOn(retainMemory, "close").mockImplementation(() => {
			close();
			closeDone.resolve();
		});

		const BUDGET_MS = 20;
		const start = Bun.nanoseconds();
		await state.dispose({ timeoutMs: BUDGET_MS });
		const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;

		// Dispose must surrender within the budget (plus a generous slack); the
		// in-flight consolidate is detached, not awaited.
		expect(elapsedMs).toBeLessThan(BUDGET_MS * 5);
		expect(elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS - 10);
		expect(flushSpy).toHaveBeenCalled();
		expect(flushCalls).toBe(1);
		// `close()` is deferred so SQLite writes don't race a closed handle.
		expect(closeSpy).not.toHaveBeenCalled();

		// Release the stall and confirm the deferred close runs once consolidate
		// settles — i.e. the SQLite handle still ends up released eventually.
		flushStall.resolve();
		await closeDone.promise;
		expect(closeSpy).toHaveBeenCalledTimes(1);

		registeredMnemopiState = undefined;
	});

	it("bounds synchronous SQLite lock waits on every owned bank during final retention (#7351)", async () => {
		// per-project-tagged owns a project retain bank AND the shared bank; lock the
		// shared bank so a retain-only busy-timeout fix would still stall teardown.
		const config = makeMnemopiConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
		});
		const entries = [
			{ type: "message", message: { role: "user", content: "hello" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		];
		const state = registerMnemopiState(config, { cwd: "/work/project-alpha", entries: () => entries });
		const ownedDbPaths = getMnemopiScopedDbPaths(config);
		const sharedDbPath = ownedDbPaths.find(dbPath => dbPath === config.dbPath);
		const lock = new Database(sharedDbPath!);
		lock.exec("BEGIN IMMEDIATE");
		const sharedMemory = state.globalMemory;
		const sharedFlushCalled = Promise.withResolvers<void>();
		const sharedFlushSpy = vi.spyOn(sharedMemory!, "flushExtractions").mockImplementation(async () => {
			// Signal first: the exec below may throw SQLITE_BUSY while the lock is
			// still held, and the call itself is what the test awaits.
			sharedFlushCalled.resolve();
			// Model a pending extraction/embedding commit. An idle shared bank performs
			// no SQLite work during flush, so merely locking it would not exercise its
			// connection's busy timeout.
			sharedMemory!.beam.db.exec("PRAGMA user_version=7351");
		});

		const started = performance.now();
		try {
			await state.dispose({ timeoutMs: 50 });
		} finally {
			lock.exec("ROLLBACK");
			lock.close();
		}
		const elapsedMs = performance.now() - started;

		try {
			expect(elapsedMs).toBeLessThan(500);
			// When the shutdown budget expires mid-consolidate, dispose detaches the
			// pass instead of abandoning it (#3641) — so on a slow runner the shared
			// flush may not have run yet when dispose returns. The lock is released
			// above, so the detached pass must still reach the shared bank; await
			// the call itself instead of asserting synchronously.
			await sharedFlushCalled.promise;
			expect(sharedFlushSpy).toHaveBeenCalledTimes(1);
		} finally {
			registeredMnemopiState = undefined;
		}
	});

	it("dispose with no timeoutMs retains, flushes, and closes without sleeping (#3641)", async () => {
		const state = registerMnemopiState();
		const retainMemory = state.getScopedRetainTarget().memory;
		const flushSpy = vi.spyOn(retainMemory, "flushExtractions").mockResolvedValue();
		const sleepSpy = vi.spyOn(retainMemory, "sleep");
		const closeSpy = vi.spyOn(retainMemory, "close");

		await state.dispose();

		// Unbounded dispose still runs the consolidate-then-close pipeline, but
		// skips the synchronous bank sleep so the interactive shutdown path stays
		// fast (#3641). Full consolidation remains reachable via `/memory enqueue`.
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(sleepSpy).not.toHaveBeenCalled();
		expect(closeSpy).toHaveBeenCalledTimes(1);

		registeredMnemopiState = undefined;
	});

	it("dispose retains the current session without scheduling LLM fact extraction", async () => {
		const state = registerMnemopiState();
		const retainSpy = vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();

		await state.dispose();

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy).toHaveBeenCalledWith({ extract: false });

		registeredMnemopiState = undefined;
	});

	it("consolidate({ sleep: false }) retains and flushes without sleeping the bank", async () => {
		const state = registerMnemopiState();
		const retainMemory = state.getScopedRetainTarget().memory;
		vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();
		vi.spyOn(retainMemory, "flushExtractions").mockResolvedValue();
		const sleepAllSessionsSpy = vi.spyOn(retainMemory, "sleepAllSessions");
		const sleepSpy = vi.spyOn(retainMemory, "sleep");

		await state.consolidate({ sleep: false });

		expect(sleepAllSessionsSpy).not.toHaveBeenCalled();
		expect(sleepSpy).not.toHaveBeenCalled();

		registeredMnemopiState = undefined;
	});

	it("consolidate({ full: true }) runs the full cross-session sleepAllSessions", async () => {
		const state = registerMnemopiState();
		const retainMemory = state.getScopedRetainTarget().memory;
		vi.spyOn(state, "forceRetainCurrentSession").mockResolvedValue();
		vi.spyOn(retainMemory, "flushExtractions").mockResolvedValue();
		const sleepAllSessionsSpy = vi.spyOn(retainMemory, "sleepAllSessions");
		const sleepSpy = vi.spyOn(retainMemory, "sleep");

		await state.consolidate({ full: true });

		expect(sleepAllSessionsSpy).toHaveBeenCalledTimes(1);
		expect(sleepAllSessionsSpy).toHaveBeenCalledWith(false);
		expect(sleepSpy).not.toHaveBeenCalled();

		registeredMnemopiState = undefined;
	});

	it("skips consolidation when disposing an aliased subagent state (#2320)", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const parentState = registerMnemopiState();
		const parentMemory = parentState.getScopedRetainTarget().memory;
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
		} as never;
		await mnemopiBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemopiSessionState: parentState,
		});
		const childState = getMnemopiSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);

		const flushSpy = vi.spyOn(parentMemory, "flushExtractions");
		const sleepSpy = vi.spyOn(parentMemory, "sleepAllSessions");
		const closeSpy = vi.spyOn(parentMemory, "close");
		const parentRetainSpy = vi.spyOn(parentState, "forceRetainCurrentSession");

		await childState?.dispose();

		// Alias dispose must not touch the parent's owned memories or trigger
		// parent retention; the parent state outlives the subagent.
		expect(flushSpy).not.toHaveBeenCalled();
		expect(sleepSpy).not.toHaveBeenCalled();
		expect(closeSpy).not.toHaveBeenCalled();
		expect(parentRetainSpy).not.toHaveBeenCalled();
	});

	it("aliased subagent enqueue still flushes and sleeps the parent's shared banks (#2327 review)", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const parentState = registerMnemopiState();
		const parentMemory = parentState.getScopedRetainTarget().memory;
		const childSession = {
			sessionId: "child-session-id",
			settings,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
			modelRegistry: {} as never,
			getMnemopiSessionState: () => getMnemopiSessionState(childSession),
		} as never;
		await mnemopiBackend.start({
			session: childSession,
			settings,
			modelRegistry: {} as never,
			agentDir: path.dirname(tempDbPath!),
			taskDepth: 1,
			parentMnemopiSessionState: parentState,
		});
		const childState = getMnemopiSessionState(childSession);
		expect(childState?.aliasOf).toBe(parentState);

		const flushSpy = vi.spyOn(parentMemory, "flushExtractions");
		const sleepSpy = vi.spyOn(parentMemory, "sleepAllSessions");
		const parentRetainSpy = vi.spyOn(parentState, "forceRetainCurrentSession");
		const childRetainSpy = vi.spyOn(childState!, "forceRetainCurrentSession");

		await mnemopiBackend.enqueue(path.dirname(tempDbPath!), "/tmp", childSession);

		// /memory enqueue from a subagent must still consolidate the shared
		// banks; `forceRetainCurrentSession` is the one piece that the alias
		// guard short-circuits (the subagent's transcript is the parent's
		// concern), but the SQL-level flush and sleep must reach every owned
		// bank or the user's enqueue silently no-ops.
		expect(flushSpy).toHaveBeenCalledTimes(1);
		expect(sleepSpy).toHaveBeenCalledTimes(1);
		expect(sleepSpy).toHaveBeenCalledWith(false);
		expect(childRetainSpy).toHaveBeenCalledTimes(1);
		expect(parentRetainSpy).not.toHaveBeenCalled();
	});

	it("clears scoped Mnemopi data and rehydrates active state", async () => {
		const config = makeMnemopiConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const listeners = new Set<AgentSessionEventListener>();
		const state = registerMnemopiState(config, { cwd: "/work/project-alpha", listeners });
		state.rememberInScope("project clear marker", { scope: "bank", extract: false, source: "test" });
		state.globalMemory?.remember("global clear marker", { scope: "bank", extract: false, source: "test" });
		const session = state.session;
		setMnemopiSessionState(session, state);

		await mnemopiBackend.clear(path.dirname(config.dbPath), "/work/project-alpha", session);

		const rehydrated = getMnemopiSessionState(session);
		if (!rehydrated) throw new Error("Mnemopi state was not rehydrated");
		expect(rehydrated).not.toBe(state);
		expect(listeners.size).toBe(1);
		const remaining = await rehydrated.recallResultsScoped("clear marker");
		expect(remaining.some(hit => String(hit.content).includes("clear marker"))).toBe(false);
		expect(rehydrated.rememberScoped("after-clear", { source: "test", scope: "bank", extract: false })).toEqual(
			expect.any(String),
		);
		registeredMnemopiState = rehydrated;
	});
	it("attaches listeners when enqueue rehydrates missing state", async () => {
		const config = makeMnemopiConfig();
		const listeners = new Set<AgentSessionEventListener>();
		const seed = registerMnemopiState(config, { listeners });
		const session = seed.session;
		setMnemopiSessionState(session, undefined);
		await seed.dispose({ consolidate: false });
		registeredMnemopiState = undefined;

		await mnemopiBackend.enqueue(path.dirname(config.dbPath), "/tmp", session);

		registeredMnemopiState = getMnemopiSessionState(session);
		expect(registeredMnemopiState).toBeDefined();
		expect(listeners.size).toBe(1);
	});

	it("clear() skips consolidation before deleting the DBs (#2327 review)", async () => {
		const config = makeMnemopiConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemopiState(config, { cwd: "/work/project-alpha" });
		const ownedMemories = [state.getScopedRetainTarget().memory];
		if (state.globalMemory && state.globalMemory !== ownedMemories[0]) {
			ownedMemories.push(state.globalMemory);
		}

		const retainSpy = vi.spyOn(state, "forceRetainCurrentSession");
		const consolidateSpy = vi.spyOn(state, "consolidate");
		const perBank = ownedMemories.map(memory => ({
			flush: vi.spyOn(memory, "flushExtractions"),
			sleep: vi.spyOn(memory, "sleepAllSessions"),
			close: vi.spyOn(memory, "close"),
		}));

		const session = state.session;
		setMnemopiSessionState(session, state);

		await mnemopiBackend.clear(path.dirname(config.dbPath), "/work/project-alpha", session);

		// `/memory clear` is about to delete the SQLite files: spending tokens
		// and time consolidating memory that will be wiped is wasted work.
		expect(retainSpy).not.toHaveBeenCalled();
		expect(consolidateSpy).not.toHaveBeenCalled();
		for (const bank of perBank) {
			expect(bank.flush).not.toHaveBeenCalled();
			expect(bank.sleep).not.toHaveBeenCalled();
			expect(bank.close).toHaveBeenCalledTimes(1);
		}
		registeredMnemopiState = getMnemopiSessionState(session);
		expect(registeredMnemopiState).toBeDefined();
	});

	it("exposes direct mnemopi runtime status and search/save results", async () => {
		const config = makeMnemopiConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemopiState(config, { cwd: "/work/project-alpha" });
		const session = state.session;
		setMnemopiSessionState(session, state);

		const save = await mnemopiBackend.save!(
			{ agentDir: path.dirname(config.dbPath), cwd: "/work/project-alpha", session },
			{
				content: "the user prefers dark mode in their editor",
				source: "test-source",
				context: "editor preferences",
				importance: 0.8,
			},
		);
		expect(save).toMatchObject({ backend: "mnemopi", stored: 1, ids: [expect.any(String)] });

		const status = await mnemopiBackend.status!({
			agentDir: path.dirname(config.dbPath),
			cwd: "/work/project-alpha",
			session,
		});
		expect(status).toMatchObject({
			backend: "mnemopi",
			active: true,
			writable: true,
			searchable: true,
			retainBank: "project-alpha",
		});
		expect(status.recallBanks).toEqual(expect.arrayContaining(["project-alpha", "default"]));

		const search = await mnemopiBackend.search!(
			{ agentDir: path.dirname(config.dbPath), cwd: "/work/project-alpha", session },
			"dark mode",
		);
		expect(search.backend).toBe("mnemopi");
		expect(search.count).toBeGreaterThan(0);
		expect(search.items[0]).toMatchObject({
			content: expect.stringContaining("dark mode"),
			source: "test-source",
			score: expect.any(Number),
		});
	});

	it("reports aborted searches and save-without-id failures", async () => {
		const state = registerMnemopiState();
		const session = state.session;
		setMnemopiSessionState(session, state);

		const controller = new AbortController();
		controller.abort();
		await expect(
			mnemopiBackend.search!({ agentDir: "/tmp/agent", cwd: "/tmp", session }, "anything", {
				signal: controller.signal,
			}),
		).resolves.toMatchObject({
			backend: "mnemopi",
			count: 0,
			message: "Search aborted.",
		});

		const rememberSpy = vi.spyOn(state, "rememberScoped").mockReturnValue(undefined);
		await expect(
			mnemopiBackend.save!({ agentDir: "/tmp/agent", cwd: "/tmp", session }, { content: "memory without id" }),
		).resolves.toMatchObject({
			backend: "mnemopi",
			stored: 0,
			message: "Mnemopi did not return a stored memory id.",
		});
		rememberSpy.mockRestore();
	});

	it("derives valid project banks from the absolute project root", async () => {
		const rootDir = TempDir.createSync(`@mnemopi-bank-${Date.now()}-`);
		const root = rootDir.path();
		const alphaCwd = path.join(root, "a", "api");
		const betaCwd = path.join(root, "b", "api");
		mkdirSync(alphaCwd, { recursive: true });
		mkdirSync(betaCwd, { recursive: true });
		try {
			const base = Settings.isolated({
				"memory.backend": "mnemopi",
				"mnemopi.scoping": "per-project",
				"mnemopi.bank": "../../bad bank name with spaces and punctuation!",
			});
			const alpha = loadMnemopiConfig(await base.cloneForCwd(alphaCwd), root);
			const beta = loadMnemopiConfig(await base.cloneForCwd(betaCwd), root);

			expect(alpha.bank).not.toBe(beta.bank);
			const banks = [alpha.bank, beta.bank, alpha.globalBank, beta.globalBank].filter(
				(bank): bank is string => typeof bank === "string",
			);
			for (const bank of banks) {
				expect(bank).toMatch(/^[A-Za-z0-9_-]+$/);
				expect(bank.length).toBeLessThanOrEqual(64);
			}
			expect(alpha.globalBank).toBe("bad-bank-name-with-spaces-and-punctuation");
		} finally {
			rootDir.removeSync();
		}
	});
});
describe("recall.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the no-results sentinel when recall yields empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-3", { query: "anything" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("formats non-empty results with count + UTC timestamp header", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [
				{ text: "fact one", type: "world", id: "1" },
				{ text: "fact two", id: "2" },
			],
		} as never);
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-4", { query: "anything" });
		const block = (result.content[0] as { text: string }).text;
		expect(block).toMatch(/^Found 2 relevant memories \(as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
		expect(block).toContain("- fact one [world]");
		expect(block).toContain("- fact two");
	});

	it("forwards recall tags + tagsMatch from session state when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const recallSpy = vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		registerState(client, settings, { recallTags: ["project:pi"], recallTagsMatch: "any" });

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await tool.execute("call-tags", { query: "anything" });

		expect(recallSpy).toHaveBeenCalledWith(
			"test-bank",
			"anything",
			expect.objectContaining({ tags: ["project:pi"], tagsMatch: "any" }),
		);
	});

	it("rethrows underlying client errors", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "recall").mockRejectedValue(new Error("HTTP 503"));
		registerState(client, settings);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-5", { query: "anything" })).rejects.toThrow(/HTTP 503/);
	});
});

describe("recall.execute (Mnemopi backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemopiState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemopiState?.dispose();
		registeredMnemopiState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("returns the no-results sentinel when empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemopi-empty", { query: "nonexistent query" });

		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("surfaces recall engine failures instead of the no-results sentinel", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const state = registerMnemopiState();
		const failure = new TypeError("mmrRerankIndices is not a function");
		vi.spyOn(state.getScopedRecallTargets()[0].memory, "recallEnhanced").mockRejectedValue(failure);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemopi-failure", { query: "existing memory" })).rejects.toThrow(failure);
	});

	it("keeps healthy scoped targets available when another target fails", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const state = registerMnemopiState(
			makeMnemopiConfig({
				scoping: "per-project-tagged",
				bank: "project-bank",
				globalBank: "global-bank",
			}),
		);
		vi.spyOn(state.getScopedRecallTargets()[0].memory, "recallEnhanced").mockRejectedValue(
			new Error("project bank unavailable"),
		);

		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemopi-partial-failure", { query: "nonexistent query" });
		expect(result.content[0]).toEqual({ type: "text", text: "No relevant memories found." });
	});

	it("returns a populated text block when a retained memory exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		// First, store a memory
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemopi-store", {
			items: [{ content: "the user prefers dark mode in their editor" }],
		});

		// Then recall it
		const recallTool = MemoryRecallTool.createIf(makeSession(settings))!;
		const result = await recallTool.execute("call-mnemopi-query", { query: "editor preferences" });

		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/\(id: [^)]+\)/);
		expect(text).toContain("Found 1 relevant memory");
		expect(text).toContain("the user prefers dark mode in their editor");
	});

	it("shares memories across projects when scoping is global", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "global",
		});
		const config = makeMnemopiConfig({ scoping: "global", bank: "default" });
		registerMnemopiState(config, { cwd: "/work/project-alpha" });
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-global-store", {
			items: [{ content: "global memory survives project switches" }],
		});
		registeredMnemopiState?.dispose();
		registerMnemopiState(config, { cwd: "/work/project-beta" });
		const result = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemopi-global-recall", {
			query: "project switches",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("global memory survives project switches");
	});

	it("merges global and project-local memories on recall when scoping is per-project-tagged", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project-tagged",
		});
		// Store a global memory (uses default/global bank)
		registerMnemopiState(makeMnemopiConfig({ scoping: "global", bank: "default", globalBank: "default" }), {
			cwd: "/work/project-alpha",
		});
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-tagged-global", {
			items: [{ content: "the user likes concise CLI output" }],
		});
		// Store project-alpha local memory
		registeredMnemopiState?.dispose();
		registerMnemopiState(
			makeMnemopiConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-tagged-local", {
			items: [{ content: "project alpha uses pnpm workspaces" }],
		});
		// Store project-beta local memory
		registeredMnemopiState?.dispose();
		registerMnemopiState(
			makeMnemopiConfig({ scoping: "per-project-tagged", bank: "project-beta", globalBank: "default" }),
			{ cwd: "/work/project-beta" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-tagged-other", {
			items: [{ content: "project beta deploys to staging first" }],
		});
		// Recall from project-alpha should merge global + alpha, exclude beta
		registeredMnemopiState?.dispose();
		registerMnemopiState(
			makeMnemopiConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		const result = await MemoryRecallTool.createIf(makeSession(settings))!.execute("call-mnemopi-tagged-recall", {
			query: "what should I know about this user and project alpha?",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("the user likes concise CLI output");
		expect(text).toContain("project alpha uses pnpm workspaces");
		expect(text).not.toContain("project beta deploys to staging first");
	});

	it("throws when no per-session Mnemopi state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const tool = MemoryRecallTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemopi-no-state", { query: "anything" })).rejects.toThrow(/not initialised/i);
	});
});

describe("memory_edit.execute (Mnemopi backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemopiState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemopiState?.dispose();
		registeredMnemopiState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	async function retainAndRecallId(settings: Settings, content: string, query: string): Promise<string> {
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-memory-edit-store", {
			items: [{ content }],
		});
		const id = (await registeredMnemopiState?.recallResultsScoped(query))?.[0]?.id;
		return id!;
	}

	it("updates a working memory by recall id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();
		const id = await retainAndRecallId(settings, "editor accent color is blue", "accent color");

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-update", {
			op: "update",
			id,
			content: "editor accent color is green",
			importance: 2,
		});

		expect((result.content[0] as { text: string }).text).toContain("updated");
		const recalled = await registeredMnemopiState!.recallResultsScoped("accent color");
		expect(recalled.map(memory => memory.content)).toContain("editor accent color is green");
	});

	it("forgets a working memory by recall id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();
		const id = await retainAndRecallId(settings, "temporary deployment note can be deleted", "deployment note");

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-forget", {
			op: "forget",
			id,
		});

		expect((result.content[0] as { text: string }).text).toContain("deleted");
		const recalled = await registeredMnemopiState!.recallResultsScoped("deployment note");
		expect(recalled.map(memory => memory.content)).not.toContain("temporary deployment note can be deleted");
	});

	it("invalidates a working memory by recall id", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();
		const id = await retainAndRecallId(settings, "stale api key rotation policy", "api key rotation");

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-invalidate", {
			op: "invalidate",
			id,
		});

		expect((result.content[0] as { text: string }).text).toContain("invalidated");
		const recalled = await registeredMnemopiState!.recallResultsScoped("api key rotation");
		expect(recalled.map(memory => memory.content)).not.toContain("stale api key rotation policy");
	});

	it("reports not_found for unknown ids", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		const result = await MemoryEditTool.createIf(makeSession(settings))!.execute("call-memory-edit-missing", {
			op: "forget",
			id: "missing-memory-id",
		});

		expect(result.details).toEqual({ status: "not_found" });
		expect((result.content[0] as { text: string }).text).toContain("not found");
	});

	it("throws when no per-session Mnemopi state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const tool = MemoryEditTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-memory-edit-no-state", { op: "forget", id: "anything" })).rejects.toThrow(
			/not initialised/i,
		);
	});

	it("renders backend stats and diagnostics for scoped banks", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const state = registerMnemopiState();
		await retainAndRecallId(settings, "stats fixture memory for mnemopi", "stats fixture");

		const stats = await mnemopiBackend.stats?.("/tmp/agent", "/tmp", state.session);
		const diagnose = await mnemopiBackend.diagnose?.("/tmp/agent", "/tmp", state.session);

		expect(stats).toContain("# Mnemopi Memory Stats");
		expect(stats).toContain("test-bank");
		expect(diagnose).toContain("# Mnemopi Memory Diagnostics");
		expect(diagnose).toContain("test-bank");
	});
});

describe("reflect.execute", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredState = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		registeredState = undefined;
	});

	it("returns the reflect text and forwards context", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		const reflectSpy = vi
			.spyOn(HindsightApi.prototype, "reflect")
			.mockResolvedValue({ text: "Synthesised answer" } as never);
		registerState(client, settings);

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-6", { query: "what does the user prefer?", context: "background" });
		expect(reflectSpy).toHaveBeenCalledWith(
			"test-bank",
			"what does the user prefer?",
			expect.objectContaining({ context: "background", budget: "mid" }),
		);
		expect((result.content[0] as { text: string }).text).toBe("Synthesised answer");
	});

	it("falls back to a sentinel when reflect returns blank text", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight" });
		const client = new HindsightApi({ baseUrl: "http://localhost:8888" });
		vi.spyOn(HindsightApi.prototype, "reflect").mockResolvedValue({ text: "  " } as never);
		registerState(client, settings);

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-7", { query: "anything" });
		expect((result.content[0] as { text: string }).text).toBe("No relevant information found to reflect on.");
	});
});

describe("reflect.execute (Mnemopi backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		registeredMnemopiState = undefined;
		tempDbPath = undefined;
		tempDbDir = undefined;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await registeredMnemopiState?.dispose();
		registeredMnemopiState = undefined;
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("returns the no-results sentinel when empty", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await tool.execute("call-mnemopi-reflect-empty", {
			query: "what does the user prefer?",
		});

		expect(result.content[0]).toEqual({
			type: "text",
			text: "No relevant information found to reflect on.",
		});
	});

	it("returns a synthesized text block based on recalled memories when data exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		// First, store memories
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemopi-store-reflect", {
			items: [
				{ content: "the user prefers dark mode in their editor" },
				{ content: "the user uses Vim keybindings" },
				{ content: "the user likes tabs over spaces" },
			],
		});

		// Then reflect on them
		const reflectTool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await reflectTool.execute("call-mnemopi-reflect-query", {
			query: "what are the user's editor preferences?",
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("dark mode");
		expect(text).toContain("Vim");
		expect(text).toContain("tabs");
	});

	it("includes additional context in the query when provided", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		registerMnemopiState();

		// Store a memory
		const retainTool = MemoryRetainTool.createIf(makeSession(settings))!;
		await retainTool.execute("call-mnemopi-store-context", {
			items: [{ content: "the user works on Python projects" }],
		});

		// Reflect with context
		const reflectTool = MemoryReflectTool.createIf(makeSession(settings))!;
		const result = await reflectTool.execute("call-mnemopi-reflect-context", {
			query: "what does the user work on?",
			context: "this is for a new project setup",
		});

		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("Python");
	});

	it("merges global and project-local memories on reflect when scoping is per-project-tagged", async () => {
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.scoping": "per-project-tagged",
		});
		// Store a global memory (uses default/global bank)
		registerMnemopiState(makeMnemopiConfig({ scoping: "global", bank: "default", globalBank: "default" }), {
			cwd: "/work/project-alpha",
		});
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-reflect-global", {
			items: [{ content: "the user prefers concise summaries" }],
		});
		// Store project-alpha local memory
		registeredMnemopiState?.dispose();
		registerMnemopiState(
			makeMnemopiConfig({ scoping: "per-project-tagged", bank: "project-alpha", globalBank: "default" }),
			{ cwd: "/work/project-alpha" },
		);
		await MemoryRetainTool.createIf(makeSession(settings))!.execute("call-mnemopi-reflect-local", {
			items: [{ content: "project alpha uses turbo for task orchestration" }],
		});
		const result = await MemoryReflectTool.createIf(makeSession(settings))!.execute("call-mnemopi-reflect-tagged", {
			query: "what matters for this user working in project alpha?",
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Based on recalled memories");
		expect(text).toContain("the user prefers concise summaries");
		expect(text).toContain("project alpha uses turbo for task orchestration");
	});

	it("throws when no per-session Mnemopi state is registered", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const tool = MemoryReflectTool.createIf(makeSession(settings))!;
		await expect(tool.execute("call-mnemopi-reflect-no-state", { query: "anything" })).rejects.toThrow(
			/not initialised/i,
		);
	});
});
