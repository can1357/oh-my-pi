import { Database, type Statement } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { extendRecallWithLegacyBanks, type MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { currentLoopPhase, TempDir } from "@oh-my-pi/pi-utils";

// State construction uses the same preloaded, synchronous facade as memory-tools.test.ts.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const SESSION_ID = "loop-phase-session";
let checking = false;
let monitoredExecutions = 0;
let violations: { method: string; sql: string; stack: string | undefined }[] = [];
const spies: { mockRestore(): void }[] = [];
let state: MnemopiSessionState | undefined;
let root: TempDir | undefined;
const featureEnv = ["MNEMOPI_POLYPHONIC_RECALL", "MNEMOPI_ENHANCED_RECALL", "MNEMOPI_PROACTIVE_LINKING"];
let savedEnv: (string | undefined)[] = [];

function record(method: string, sql: string): void {
	if (!checking) return;
	monitoredExecutions++;
	if (!currentLoopPhase()?.startsWith("mnemopi.")) {
		violations.push({ method, sql, stack: new Error().stack?.split("\n").slice(1, 7).join("\n") });
	}
}

function spyOnSql(): void {
	const wrapped = new WeakSet<Statement>();
	const wrap = (statement: Statement): Statement => {
		if (wrapped.has(statement)) return statement;
		wrapped.add(statement);
		// Bun installs execution methods on each statement, and query() caches instances.
		for (const method of ["all", "get", "run", "values", "iterate", "raw"] as const) {
			const original = statement[method];
			spies.push(
				spyOn(statement, method).mockImplementation((...args: unknown[]) => {
					record(`Statement.${method}`, String(statement));
					return Reflect.apply(original, statement, args);
				}),
			);
		}
		return statement;
	};
	const query = Database.prototype.query;
	const prepare = Database.prototype.prepare;
	const run = Database.prototype.run;
	const exec = Database.prototype.exec;
	spies.push(
		spyOn(Database.prototype, "query").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof query>
		) {
			return wrap(Reflect.apply(query, this, args));
		} as typeof query),
		spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof prepare>
		) {
			return wrap(Reflect.apply(prepare, this, args));
		} as typeof prepare),
		spyOn(Database.prototype, "run").mockImplementation(function (this: Database, ...args: Parameters<typeof run>) {
			record("Database.run", args[0]);
			return Reflect.apply(run, this, args);
		} as typeof run),
		spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, ...args: Parameters<typeof exec>) {
			record("Database.exec", args[0]);
			return Reflect.apply(exec, this, args);
		} as typeof exec),
	);
}

function makeMnemopiConfig(): MnemopiBackendConfig {
	return {
		dbPath: root!.join("mnemopi.db"),
		bank: "project-alpha",
		scoping: "per-project-tagged",
		globalBank: "default",
		autoRecall: true,
		autoRetain: true,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: true,
		retainEveryNTurns: 2,
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
	};
}

function registerMnemopiState(entries: () => unknown[]): MnemopiSessionState {
	const registered = new MnemopiSessionState({
		sessionId: SESSION_ID,
		config: makeMnemopiConfig(),
		session: {
			sessionId: SESSION_ID,
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
				getEntries: entries,
				getBranch: entries,
				appendCustomEntry: () => {},
				getCwd: () => "/work/project-alpha",
			} as never,
			getXdevToolEntries: () => [],
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
			subscribe: () => () => {},
		} as never,
	});
	setMnemopiSessionState(registered.session, registered);
	return registered;
}

beforeEach(() => {
	checking = false;
	monitoredExecutions = 0;
	violations = [];
	resetSettingsForTest();
	resetMemoryForTests();
	savedEnv = featureEnv.map(key => process.env[key]);
	for (const key of featureEnv) delete process.env[key];
	spyOnSql();
	expect(currentLoopPhase()).toBeUndefined();
	checking = true;
	try {
		using control = new Database(":memory:");
		control.query("SELECT 1").get();
	} finally {
		checking = false;
	}
	expect(violations).toHaveLength(1);
	violations = [];
	monitoredExecutions = 0;
	root = TempDir.createSync("@mnemopi-agent-loop-phase-");
});

afterEach(async () => {
	checking = false;
	try {
		await state?.dispose();
	} finally {
		state = undefined;
		for (const spy of spies.splice(0).reverse()) spy.mockRestore();
		resetMemoryForTests();
		resetSettingsForTest();
		for (const [index, key] of featureEnv.entries()) {
			if (savedEnv[index] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[index];
		}
		await root?.remove();
		root = undefined;
	}
});

it("labels every SQLite statement across scoped session memory flows", async () => {
	const entries = Array.from({ length: 5 }, (_, index) => ({
		type: "message",
		message: { role: "user", content: `espresso launch checklist turn ${index + 1}` },
	}));
	let visibleTurns = 1;
	const activeCwd = path.resolve("/work/project-alpha");
	const legacyBank = "legacy-label-probe";
	const legacyBankDir = root!.join("banks", legacyBank);
	await fs.mkdir(legacyBankDir, { recursive: true });
	{
		using db = new Database(path.join(legacyBankDir, "mnemopi.db"), { create: true });
		db.exec("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT, metadata_json TEXT)");
		db.run("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)", [
			"legacy-row",
			"legacy espresso checklist",
			JSON.stringify({ cwd: activeCwd }),
		]);
	}
	expect(currentLoopPhase()).toBeUndefined();
	checking = true;
	try {
		state = registerMnemopiState(() => entries.slice(0, visibleTurns));
		await state.maybeRetainOnAgentEnd([] as never); // Gate turn.
		expect(state.lastRetainedTurn).toBe(0);
		visibleTurns = 2;
		await state.maybeRetainOnAgentEnd([] as never); // Retain turn.
		expect(state.lastRetainedTurn).toBe(2);
		visibleTurns = 3;
		await state.forceRetainCurrentSession();
		expect(state.lastRetainedTurn).toBe(3);

		const updateId = state.rememberScoped("espresso launch checklist lives in the ops wiki", {
			source: "test",
			scope: "bank",
			extract: false,
		});
		const invalidateId = state.rememberScoped("espresso launch checklist has an obsolete rotation", {
			source: "test",
			scope: "bank",
			extract: false,
		});
		const forgetId = state.rememberScoped("espresso launch checklist has a temporary note", {
			source: "test",
			scope: "bank",
			extract: false,
		});
		state.rememberScoped(
			"The user prefers espresso while preparing the launch checklist",
			{ source: "test", scope: "global", extract: false },
			state.getGlobalRetainTarget(),
		);
		const prepared = await state.beforeAgentStartPrompt("espresso launch checklist");
		expect(prepared?.context).toContain("espresso");
		expect(prepared?.commit()).toBe(true);
		expect(
			await state.recallForCompaction([{ role: "user", content: "espresso launch checklist" }] as never),
		).toContain("espresso");
		const recalled = await state.recallResultsScoped("project alpha espresso launch checklist");
		expect(recalled.map(result => result.content)).toContain("espresso launch checklist lives in the ops wiki");
		expect(recalled.map(result => result.content)).toContain(
			"The user prefers espresso while preparing the launch checklist",
		);
		expect(state.formatScopedRecallWithIds(recalled)).toContain(updateId);
		expect(state.formatContextScoped(recalled)).toContain("espresso");
		expect(state.formatContextScoped(recalled, "json")).toContain("espresso");
		expect(state.getScopedMemory(updateId)?.row.content).toContain("ops wiki");
		expect(
			state.editScopedMemory("update", updateId, { content: "espresso launch checklist moved to the wiki" }),
		).toMatchObject({
			status: "updated",
		});
		expect(state.editScopedMemory("invalidate", invalidateId)).toMatchObject({ status: "invalidated" });
		expect(state.editScopedMemory("forget", forgetId)).toMatchObject({ status: "deleted" });

		const beforeDiagnostics = monitoredExecutions;
		const diagnostics = await mnemopiBackend.diagnose?.(root!.path(), activeCwd, state.session);
		expect(diagnostics).toContain("project-alpha");
		expect(monitoredExecutions).toBeGreaterThan(beforeDiagnostics);
		const beforeLegacyProbe = monitoredExecutions;
		expect(extendRecallWithLegacyBanks(["project-alpha", "default"], state.config.dbPath, activeCwd)).toContain(
			legacyBank,
		);
		expect(monitoredExecutions).toBeGreaterThan(beforeLegacyProbe);

		visibleTurns = 4;
		await state.consolidate({ full: true, retain: true });
		expect(state.lastRetainedTurn).toBe(4);
		visibleTurns = 5;
		const sleepSpy = spyOn(Bun, "sleep").mockReturnValue(Promise.withResolvers<void>().promise);
		try {
			await state.dispose({ timeoutMs: 30_000 });
		} finally {
			sleepSpy.mockRestore();
		}
		state = undefined;
	} finally {
		checking = false;
	}
	expect(monitoredExecutions).toBeGreaterThan(0);
	expect(currentLoopPhase()).toBeUndefined();
	expect(violations).toEqual([]);
});
