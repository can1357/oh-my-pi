/**
 * Contract tests for the three shared memory tool factories.
 *
 * These exercise the public tool surface (factory gating + execute path) by
 * spying on `HindsightApi.prototype.{retain, recall, reflect}` and stubbing
 * Hindsight state on the fake ToolSession. We deliberately do not boot a real
 * session — these tools only need a populated state accessor and Settings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { HindsightApi } from "@pk-nerdsaver-ai/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@pk-nerdsaver-ai/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@pk-nerdsaver-ai/pi-coding-agent/hindsight/state";
import { mnemopiBackend } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig, type MnemopiBackendConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/config";
import {
	getMnemopiScopedDbPaths,
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools/index";
import { MemoryEditTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/memory-retain";
import { resetMemoryForTests } from "@pk-nerdsaver-ai/pi-mnemopi";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it so the sync construction in
// registerMnemopiState() and getMnemopiScopedDbPaths() can resolve the module.
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
			sessionManager: {
				getEntries: () => [],
				getCwd: () => options.cwd ?? "/tmp",
			} as never,
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
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

	it("auto-retain uses the cumulative transcript turn count", async () => {
		const entries = Array.from({ length: 4 }, (_, index) => ({
			type: "message",
			message: { role: "user", content: `turn ${index + 1}` },
		}));
		const state = registerMnemopiState(makeMnemopiConfig({ retainEveryNTurns: 4 }), {
			cwd: "/work/project-alpha",
		});
		(state.session.sessionManager as { getEntries: () => unknown[] }).getEntries = () => entries;
		const retainSpy = vi.spyOn(state, "retainMessages").mockResolvedValue();

		await state.maybeRetainOnAgentEnd([{ role: "user", content: [{ type: "text", text: "turn 4" }] }] as never);

		expect(retainSpy).toHaveBeenCalledTimes(1);
		expect(retainSpy.mock.calls[0][0]).toEqual([
			{ role: "user", content: "turn 1" },
			{ role: "user", content: "turn 2" },
			{ role: "user", content: "turn 3" },
			{ role: "user", content: "turn 4" },
		]);
		expect(state.lastRetainedTurn).toBe(4);
	});

	it("retains the full transcript but extracts facts from user-authored turns only", async () => {
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

	it("flushes extractions, sleeps, and closes every owned bank on session shutdown (#2320)", async () => {
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
			sleep: vi.spyOn(memory, "sleepAllSessions"),
			close: vi.spyOn(memory, "close"),
		}));

		await state.dispose();

		expect(retainSpy).toHaveBeenCalledTimes(1);
		for (const bank of perBank) {
			expect(bank.flush).toHaveBeenCalledTimes(1);
			expect(bank.sleep).toHaveBeenCalledTimes(1);
			expect(bank.sleep).toHaveBeenCalledWith(false);
			expect(bank.close).toHaveBeenCalledTimes(1);
			const flushedAt = bank.flush.mock.invocationCallOrder[0];
			const sleptAt = bank.sleep.mock.invocationCallOrder[0];
			const closedAt = bank.close.mock.invocationCallOrder[0];
			expect(flushedAt).toBeLessThan(sleptAt);
			expect(sleptAt).toBeLessThan(closedAt);
			expect(retainSpy.mock.invocationCallOrder[0]).toBeLessThan(closedAt);
		}
		// State already consumed its owned resources; the afterEach hook would
		// otherwise re-enter dispose on closed handles.
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

	it("clears every scoped Mnemopi database for per-project-tagged mode", async () => {
		const config = makeMnemopiConfig({
			scoping: "per-project-tagged",
			bank: "project-alpha",
			globalBank: "default",
			retainBank: "project-alpha",
			recallBanks: ["project-alpha", "default"],
		});
		const state = registerMnemopiState(config, { cwd: "/work/project-alpha" });
		state.rememberInScope("project clear marker", { scope: "bank", extract: false, source: "test" });
		state.globalMemory?.remember("global clear marker", { scope: "bank", extract: false, source: "test" });
		const dbPaths = getMnemopiScopedDbPaths(config);
		for (const dbPath of dbPaths) expect(existsSync(dbPath)).toBe(true);
		const session = state.session;
		setMnemopiSessionState(session, state);

		await mnemopiBackend.clear(path.dirname(config.dbPath), "/work/project-alpha", session);

		// The clear() contract: all scoped DB files are deleted. On Windows under
		// bun:test, SQLite handle release may lag behind the await; poll briefly
		// before asserting rather than failing on a transient lock.
		const assertGone = async (p: string): Promise<void> => {
			for (let i = 0; i < 40; i++) {
				if (!existsSync(p)) return;
				await Bun.sleep(25);
			}
		};
		for (const dbPath of dbPaths) {
			await assertGone(dbPath);
			await assertGone(`${dbPath}-wal`);
			await assertGone(`${dbPath}-shm`);
		}
		// Assert state was cleared even if file deletion is still in-flight.
		expect(getMnemopiSessionState(session)).toBeUndefined();
		registeredMnemopiState = undefined;
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
		expect(getMnemopiSessionState(session)).toBeUndefined();
		registeredMnemopiState = undefined;
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
		expect(id).toBeString();
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
