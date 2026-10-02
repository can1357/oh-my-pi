import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend, rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { MEMORY_BACKEND_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/memory-backend/tool-names";
import { computeMnemopiBankScope } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import * as sharpshooterModule from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { getProjectAgentDir, getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import {
	cfgHindsightApiUrl,
	cfgHindsightBankId,
	cfgHindsightMentalModelsEnabled,
} from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { cfgMnemopiBank, cfgMnemopiRecallLimit, cfgMnemopiScoping } from "@oh-my-pi/pi-coding-agent/mnemopi/settings";
import { cfgSharpshooterEnabled } from "@oh-my-pi/pi-coding-agent/sharpshooter/settings";

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} memory tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("AgentSession memory backend lifecycle", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let tempDir: TempDir;
	/** Counts base-prompt rebuilds; the memory host routes them away from the session object. */
	let promptRebuilds = 0;

	beforeEach(() => {
		tempDir = TempDir.createSync("@memory-backend-lifecycle-");
		promptRebuilds = 0;
		authStorage = createInMemoryAuthStorage();
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
	});

	afterEach(async () => {
		// Restored here rather than at the end of each test, so a failing assertion
		// cannot leave a mock installed and hand its call history to the next test.
		mock.restore();
		await session?.dispose();
		session = undefined;
		resetMemoryForTests();
		authStorage.close();
		// `Settings.loadIsolated` opens agent.db under tempDir; close it before the directory goes away.
		AgentStorage.close();
		tempDir.removeSync();
	});

	function createSession(createMemoryTools: () => Promise<AgentTool[]>): AgentSession {
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		// AgentSession validates the prompt key through the registry for the session model's provider;
		// without a runtime key it falls back to ambient env/~/.env credentials.
		authStorage.keys.setRuntime(model.provider, "test-key");
		const read = createTool("read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] }).stream,
		});
		const toolRegistry = new Map<string, AgentTool>([[read.name, read]]);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			memoryAgentDir: tempDir.path(),
			memoryTaskDepth: 0,
			createMemoryTools,
			toolRegistry,
			builtInToolNames: [read.name],
			rebuildSystemPrompt: async toolNames => {
				promptRebuilds += 1;
				return { systemPrompt: [`backend:${cfgMemoryBackend.get(settings)};tools:${toolNames.sort().join(",")}`] };
			},
		});
		return session;
	}

	it("removes unusable Hindsight tools after a cwd reload clears the URL and restores them when configured", async () => {
		const apiUrl = "http://127.0.0.1:1";
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, apiUrl);
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgAutolearnEnabled.override(settings, true);
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
		} as ToolSession;
		const current = createSession(async () => {
			const tools = await Promise.all(MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)));
			return tools.filter((tool): tool is AgentTool => tool !== null);
		});
		await current.applyMemoryBackend();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "learn"]));

		cfgHindsightApiUrl.override(settings, "");
		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.getActiveToolNames()).toEqual(["read"]);

		cfgHindsightApiUrl.override(settings, apiUrl);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		await rebindMemoryBackendForCwd(current);
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["recall", "retain", "reflect", "learn"]));
	});

	/**
	 * Record every Sharpshooter install as `<reason> <cwd>`.
	 *
	 * The reason is half the assertion, not decoration: a start against the right
	 * project still files the source project's trailing prompt into the destination
	 * bank when it catches up, and a cwd-keyed check alone reads that as success.
	 * `afterEach` restores the mocks.
	 */
	function trackSharpshooterStarts(): string[] {
		const startedAt: string[] = [];
		spyOn(sharpshooterBackend, "start").mockImplementation(options => {
			startedAt.push(`${options.reason ?? "start"} ${options.settings.getCwd()}`);
		});
		return startedAt;
	}

	it("rebinds a paired Sharpshooter to the destination project when Hindsight owns the backend", async () => {
		// The rebind path skips the full apply while Hindsight state exists, so that
		// it does not retry a partially torn-down store. Sharpshooter keys its bank
		// and its per-bank scheduler on cwd, so without a rebind of its own it keeps
		// consolidating the project the session just left.
		const source = path.join(tempDir.path(), "source");
		const destination = path.join(tempDir.path(), "destination");
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, "http://127.0.0.1:1");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgSharpshooterEnabled.override(settings, true);
		await settings.reloadForCwd(source);
		const startedAt = trackSharpshooterStarts();

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(startedAt).toEqual([`start ${source}`]);

		await settings.reloadForCwd(destination);
		await rebindMemoryBackendForCwd(current);

		expect(startedAt).toEqual([`start ${source}`, `rebind ${destination}`]);
	});

	it("does not catch up on the source prompt when the destination changes the backend", async () => {
		// The paired rebind above is undone by what follows it: the selection moved,
		// so the scope rebuild re-applies the whole backend, and a full apply catches
		// up on a transcript that still ends in the source project's prompt. An
		// interrupted or failed turn is enough to leave it in that shape, and the
		// catch-up would file a decision the destination never earned.
		const source = path.join(tempDir.path(), "source");
		const destination = path.join(tempDir.path(), "destination");
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, "http://127.0.0.1:1");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgSharpshooterEnabled.override(settings, true);
		await settings.reloadForCwd(source);
		const startedAt = trackSharpshooterStarts();

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();

		await settings.reloadForCwd(destination);
		current.sessionManager.setCwdWithoutRelocation(destination);
		cfgMemoryBackend.override(settings, "local");
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(startedAt.slice(1).every(entry => entry === `rebind ${destination}`)).toBe(true);
		expect(startedAt.length).toBeGreaterThan(1);
	});

	it("does not catch up when the scope hook schedules the rebuild before the move asks for it", async () => {
		// `reloadForCwd` fires the Hindsight scope hook while the move is still
		// inside it, so the rebuild task is queued as a microtask before the move
		// reaches `rebindMemoryBackendForCwd`, and it runs on that function's first
		// await. Anything the move tells the scheduler afterwards arrives too late
		// to change the apply that already ran, which is why the rebuild asks for
		// "rebind" itself rather than taking a reason from its caller. The
		// overrides below stand in for the destination project's own config: what
		// matters is that the hook fires before the rebind call, exactly as a
		// reload does.
		const source = path.join(tempDir.path(), "source");
		const destination = path.join(tempDir.path(), "destination");
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, "http://127.0.0.1:1");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgSharpshooterEnabled.override(settings, true);
		// `set`, not `override`: only `set` and the reload paths run SETTING_HOOKS,
		// and `hindsight.bankId` is one of the three paths whose hook fires the
		// scope signal.
		cfgHindsightBankId.set(settings, "source-bank");
		await settings.reloadForCwd(source);
		const startedAt = trackSharpshooterStarts();

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();

		await settings.reloadForCwd(destination);
		current.sessionManager.setCwdWithoutRelocation(destination);
		cfgMemoryBackend.override(settings, "local");
		// Fires `onHindsightScopeChanged`, which schedules the rebuild. Nothing
		// awaits between here and the rebind call, so the queued task is still
		// unrun when the move starts.
		cfgHindsightBankId.set(settings, "destination-bank");
		await rebindMemoryBackendForCwd(current);

		expect(startedAt.slice(1)).not.toContain(`start ${destination}`);
		expect(startedAt.slice(1).every(entry => entry === `rebind ${destination}`)).toBe(true);
	});

	it("does not catch up on the source prompt when a store backend moves", async () => {
		// Nothing about the catch-up is Hindsight's. A session on `local`, `mnemopi`
		// or `off` takes the full-apply branch of the same move and reaches the same
		// start, so the reason has to travel with that apply too.
		const source = path.join(tempDir.path(), "source");
		const destination = path.join(tempDir.path(), "destination");
		cfgMemoryBackend.override(settings, "local");
		cfgSharpshooterEnabled.override(settings, true);
		await settings.reloadForCwd(source);
		const startedAt = trackSharpshooterStarts();

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		expect(startedAt).toEqual([`start ${source}`]);

		await settings.reloadForCwd(destination);
		await rebindMemoryBackendForCwd(current);

		expect(startedAt).toEqual([`start ${source}`, `rebind ${destination}`]);
	});

	it("keeps the live Hindsight store across a pairing toggle", async () => {
		// A full apply would dispose the store and build a new one, and a fresh
		// `HindsightSessionState` starts at `lastRetainedTurn: 0` with an empty
		// transcript cache, so the next `agent_end` re-retains the whole
		// conversation under a new document. Toggling a flag that the store does
		// not read must not cost that.
		const cwd = path.join(tempDir.path(), "project");
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, "http://127.0.0.1:1");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgSharpshooterEnabled.override(settings, false);
		await settings.reloadForCwd(cwd);
		const startedAt = trackSharpshooterStarts();

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		const store = current.getHindsightSessionState();
		expect(store).toBeDefined();
		expect(startedAt).toEqual([]);
		const rebuildsBefore = promptRebuilds;

		cfgSharpshooterEnabled.override(settings, true);
		await current.applyPairedMemoryBackend("start");

		expect(current.getHindsightSessionState()).toBe(store);
		expect(startedAt).toEqual([`start ${cwd}`]);
		expect(promptRebuilds).toBeGreaterThan(rebuildsBefore);
	});

	it("releases Sharpshooter when the destination project turns pairing off", async () => {
		// The destination decides both ways. Left installed, the source project's
		// subscription would keep extracting from this session's messages and its
		// scheduler would keep consolidating a project the session has left.
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, "http://127.0.0.1:1");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgSharpshooterEnabled.override(settings, true);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		const startedAt = trackSharpshooterStarts();
		const releaseSpy = spyOn(sharpshooterModule, "releaseSharpshooterSession").mockImplementation(() => {});

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		expect(startedAt).toHaveLength(1);
		releaseSpy.mockClear();

		// Sharpshooter's decisions are injected as developer instructions, so the
		// prompt has to be rebuilt or the session keeps being told the source
		// project's rules after pairing was turned off. The Hindsight rebuild does
		// not do it when its own bank scope is unchanged.
		const rebuildsBefore = promptRebuilds;

		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));
		cfgSharpshooterEnabled.override(settings, false);
		await rebindMemoryBackendForCwd(current);

		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(startedAt).toHaveLength(1);
		expect(promptRebuilds).toBeGreaterThan(rebuildsBefore);
	});

	it("leaves Sharpshooter alone on a cwd move when the flag is off", async () => {
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightApiUrl.override(settings, "http://127.0.0.1:1");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		cfgSharpshooterEnabled.override(settings, false);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		const startedAt = trackSharpshooterStarts();

		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));
		await rebindMemoryBackendForCwd(current);

		expect(startedAt).toEqual([]);
	});

	it("applies memory settings edited mid-session before the next prompt", async () => {
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "mnemopi" ? [createTool("retain")] : [],
		);

		cfgMemoryBackend.override(settings, "mnemopi");
		await current.prompt("first");
		const started = getMnemopiSessionState(current);
		expect(started?.config.recallLimit).toBe(8);
		expect(current.getActiveToolNames()).toEqual(["read", "retain"]);

		cfgMnemopiRecallLimit.override(settings, 2);
		await current.prompt("second");
		const rebuilt = getMnemopiSessionState(current);
		expect(rebuilt).not.toBe(started);
		expect(rebuilt?.config.recallLimit).toBe(2);
	});

	it("switches runtime state, memory tools, and prompt in one apply", async () => {
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "mnemopi" ? [createTool("retain"), createTool("memory_edit")] : [],
		);

		cfgMemoryBackend.override(settings, "mnemopi");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "retain", "memory_edit"]));
		expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:memory_edit,read,retain"]);

		cfgMemoryBackend.override(settings, "off");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
	});
	it.each([
		["mnemopi", "mnemopi"],
		["mnemopi", "off"],
		["off", "mnemopi"],
	] as const)("rebinds %s to %s on a cwd move without Hindsight", async (source, destination) => {
		cfgMemoryBackend.override(settings, source);
		await settings.reloadForCwd(path.join(tempDir.path(), "source"));
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "mnemopi" ? [createTool("retain")] : [],
		);
		await current.applyMemoryBackend();

		const destinationCwd = path.join(tempDir.path(), "destination");
		current.sessionManager.setCwdWithoutRelocation(destinationCwd);
		cfgMemoryBackend.override(settings, destination);
		await settings.reloadForCwd(destinationCwd);
		await rebindMemoryBackendForCwd(current);

		const state = getMnemopiSessionState(current);
		if (destination === "mnemopi") {
			const scope = computeMnemopiBankScope(
				cfgMnemopiBank.get(settings),
				destinationCwd,
				cfgMnemopiScoping.get(settings),
			);
			expect(state?.config.retainBank).toBe(scope.retainBank);
			expect(state?.config.recallBanks).toEqual(scope.recallBanks);
			expect(current.getActiveToolNames()).toEqual(["read", "retain"]);
			expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:read,retain"]);
		} else {
			expect(state).toBeUndefined();
			expect(current.getActiveToolNames()).toEqual(["read"]);
			expect(current.getAllToolNames()).toEqual(["read"]);
			expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
		}
	});

	it.each([false, true])("headless /move suppresses teardown retention (rollback: %s)", async rollback => {
		const sourceCwd = tempDir.path();
		const destinationCwd = path.join(sourceCwd, "destination");
		await Promise.all(
			[sourceCwd, destinationCwd].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend: "mnemopi" },
						mnemopi: {
							scoping: "per-project",
							autoRetain: true,
							noEmbeddings: true,
							llmMode: "none",
						},
					}),
				),
			),
		);
		settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
		const current = createSession(async () => []);
		await current.applyMemoryBackend();
		current.sessionManager.appendMessage({
			role: "user",
			content: "The source project uses a dedicated release branch for production deployments.",
			timestamp: Date.now(),
		});
		const sourceDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
		let destinationDbPath: string | undefined;
		const output: string[] = [];
		const originalProjectDir = getProjectDir();
		try {
			await executeAcpBuiltinSlashCommand("/move " + destinationCwd, {
				session: current,
				sessionManager: current.sessionManager,
				settings,
				cwd: sourceCwd,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {
					if (current.sessionManager.getCwd() !== destinationCwd) return;
					destinationDbPath = getMnemopiSessionState(current)!.memory.dbPath!;
					if (rollback) throw new Error("destination plugin rescope failed");
				},
			});
		} finally {
			setProjectDir(originalProjectDir);
		}
		const committedCwd = rollback ? sourceCwd : destinationCwd;
		expect(current.sessionManager.getCwd()).toBe(committedCwd);
		expect(output).toContainEqual(
			expect.stringContaining(rollback ? "destination plugin rescope failed" : destinationCwd),
		);
		expect(destinationDbPath).toBeDefined();
		expect(destinationDbPath).not.toBe(sourceDbPath);
		const transcriptRows = (dbPath: string) => {
			const db = new Database(dbPath, { readonly: true });
			try {
				return db
					.query(
						"SELECT json_extract(metadata_json, '$.cwd') AS cwd FROM working_memory WHERE source = 'coding-agent-transcript'",
					)
					.all();
			} finally {
				db.close();
			}
		};
		expect(transcriptRows(sourceDbPath)).toEqual([]);
		expect(transcriptRows(destinationDbPath!)).toEqual([]);

		// Ordinary backend changes still retain once, in the committed project.
		cfgMemoryBackend.override(settings, "off");
		await current.applyMemoryBackend();
		expect(transcriptRows(sourceDbPath)).toEqual(rollback ? [{ cwd: sourceCwd }] : []);
		expect(transcriptRows(destinationDbPath!)).toEqual(rollback ? [] : [{ cwd: destinationCwd }]);
	});

	it.each(["mnemopi", "hindsight"] as const)(
		"headless /move rolls back from %s when destination Mnemopi cannot open its database",
		async source => {
			const sourceCwd = tempDir.path();
			const destinationCwd = path.join(sourceCwd, "destination");
			const sourceDbPath = path.join(sourceCwd, "source.db");
			const destinationConfig = path.join(getProjectAgentDir(destinationCwd), "config.yml");
			const mnemopi = { scoping: "global", autoRetain: false, noEmbeddings: true, llmMode: "none" };
			await Bun.write(
				path.join(getProjectAgentDir(sourceCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: source },
					mnemopi: { ...mnemopi, dbPath: sourceDbPath },
					hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
				}),
			);
			// An existing directory is not a SQLite database, regardless of filesystem permissions.
			await Bun.write(
				destinationConfig,
				Bun.YAML.stringify({ memory: { backend: "mnemopi" }, mnemopi: { ...mnemopi, dbPath: sourceCwd } }),
			);
			settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
			const toolSession = {
				cwd: sourceCwd,
				hasUI: false,
				settings,
				getHindsightSessionState: () => session?.getHindsightSessionState(),
				getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			} as ToolSession;
			const current = createSession(async () => {
				const tools = await Promise.all(MEMORY_BACKEND_TOOL_NAMES.map(name => BUILTIN_TOOLS[name](toolSession)));
				return tools.filter((tool): tool is AgentTool => tool !== null);
			});
			await current.applyMemoryBackend();
			const sourceTools = current.getActiveToolNames();
			const sourcePrompt = current.systemPrompt;
			const sourceBank = source === "hindsight" ? current.getHindsightSessionState()!.bankId : undefined;
			const output: string[] = [];
			const runtime = {
				session: current,
				sessionManager: current.sessionManager,
				settings,
				cwd: sourceCwd,
				output: (text: string) => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			};
			const originalProjectDir = getProjectDir();
			try {
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, runtime);
				expect(output).toContainEqual(expect.stringMatching(/Move failed:.*Mnemopi/));
				expect(current.sessionManager.getCwd()).toBe(sourceCwd);
				expect(cfgMemoryBackend.get(settings)).toBe(source);
				expect(current.getActiveToolNames()).toEqual(sourceTools);
				expect(current.systemPrompt).toEqual(sourcePrompt);
				if (source === "mnemopi") {
					expect(current.getMnemopiSessionState()?.memory.dbPath).toBe(sourceDbPath);
				} else {
					expect(current.getHindsightSessionState()?.bankId).toBe(sourceBank);
				}

				// Repair the destination and retry the same command; the installed tool must really write there.
				const destinationDbPath = path.join(destinationCwd, "memory.db");
				await Bun.write(
					destinationConfig,
					Bun.YAML.stringify({
						memory: { backend: "mnemopi" },
						mnemopi: { ...mnemopi, dbPath: destinationDbPath },
					}),
				);
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, runtime);
				expect(current.sessionManager.getCwd()).toBe(destinationCwd);
				await current.getToolByName("retain")!.execute("after-move", {
					items: [{ content: "The destination project deploys from its release branch." }],
				});
				const db = new Database(destinationDbPath, { readonly: true });
				try {
					expect(
						db.query("SELECT content FROM working_memory WHERE source = 'coding-agent-retain'").all(),
					).toEqual([{ content: "The destination project deploys from its release branch." }]);
				} finally {
					db.close();
				}
			} finally {
				setProjectDir(originalProjectDir);
			}
		},
	);

	// The re-scope's settings listener starts the backend switch; the rebind must
	// judge the destination only once that switch settled, however many
	// microtasks separate the reload from the rebind.
	it.each([0, 1].flatMap(hops => [[hops, true] as const, [hops, false] as const]))(
		"headless /move from Hindsight settles a pending Mnemopi switch (%i reload hops, destination usable: %p)",
		async (hops, usable) => {
			const sourceCwd = tempDir.path();
			const destinationCwd = path.join(sourceCwd, "destination");
			const destinationDbPath = path.join(destinationCwd, "memory.db");
			await Bun.write(
				path.join(getProjectAgentDir(sourceCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: "hindsight" },
					hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
				}),
			);
			await Bun.write(
				path.join(getProjectAgentDir(destinationCwd), "config.yml"),
				Bun.YAML.stringify({
					memory: { backend: "mnemopi" },
					mnemopi: {
						scoping: "global",
						autoRetain: false,
						noEmbeddings: true,
						llmMode: "none",
						// An existing directory is not a SQLite database.
						dbPath: usable ? destinationDbPath : sourceCwd,
					},
				}),
			);
			settings = await Settings.loadIsolated({ cwd: sourceCwd, agentDir: path.join(sourceCwd, "agent") });
			const current = createSession(async () => [
				createTool(cfgMemoryBackend.get(settings) === "hindsight" ? "recall" : "retain"),
			]);
			await current.applyMemoryBackend();
			const sourceBank = current.getHindsightSessionState()?.bankId;
			const sourcePrompt = current.systemPrompt;
			expect(sourceBank).toBeDefined();

			// Park every backend startup behind a macrotask, so the switch the
			// re-scope starts is still pending wherever the rebind first looks.
			const startSpies = [mnemopiBackend, hindsightBackend].map(backend => {
				const start = backend.start;
				return spyOn(backend, "start").mockImplementation(async options => {
					await new Promise<void>(resolve => setImmediate(resolve));
					await start.call(backend, options);
				});
			});
			const reload = settings.reloadForCwd;
			const reloadSpy = spyOn(settings, "reloadForCwd").mockImplementation(async cwd => {
				await reload.call(settings, cwd);
				for (let i = 0; i < hops; i++) await Promise.resolve();
			});
			const output: string[] = [];
			const originalProjectDir = getProjectDir();
			try {
				await executeAcpBuiltinSlashCommand("/move " + destinationCwd, {
					session: current,
					sessionManager: current.sessionManager,
					settings,
					cwd: sourceCwd,
					output: text => {
						output.push(text);
					},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				});
			} finally {
				for (const spy of startSpies) spy.mockRestore();
				reloadSpy.mockRestore();
				setProjectDir(originalProjectDir);
			}
			if (usable) {
				expect(output.join("\n")).not.toContain("Move failed");
				expect(current.sessionManager.getCwd()).toBe(destinationCwd);
				expect(current.getHindsightSessionState()).toBeUndefined();
				expect(getMnemopiSessionState(current)?.memory.dbPath).toBe(destinationDbPath);
				expect(current.getActiveToolNames()).toEqual(["read", "retain"]);
			} else {
				expect(output).toContainEqual(expect.stringMatching(/Move failed:.*Mnemopi/));
				expect(current.sessionManager.getCwd()).toBe(sourceCwd);
				expect(getMnemopiSessionState(current)).toBeUndefined();
				expect(current.getHindsightSessionState()?.bankId).toBe(sourceBank);
				expect(current.getActiveToolNames()).toEqual(["read", "recall"]);
				expect(current.systemPrompt).toEqual(sourcePrompt);
			}
		},
	);

	it("cancels a displaced local startup generation", async () => {
		const current = createSession(async () => []);
		const localStartup = current.beginLocalMemoryStartup();

		await current.applyMemoryBackend();

		expect(localStartup.aborted).toBe(true);
	});

	it("serializes concurrent backend applies", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		let running = 0;
		let maxRunning = 0;
		const current = createSession(async () => {
			calls++;
			running++;
			maxRunning = Math.max(maxRunning, running);
			if (calls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running--;
			return [];
		});

		const first = current.applyMemoryBackend();
		await firstStarted.promise;
		const second = current.applyMemoryBackend();
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(maxRunning).toBe(1);
		expect(calls).toBe(2);
	});

	it("applies the destination project's memory backend on a cwd move", async () => {
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		const current = createSession(async () =>
			cfgMemoryBackend.get(settings) === "hindsight" ? [createTool("recall"), createTool("retain")] : [],
		);

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));

		cfgMemoryBackend.override(settings, "off");
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
	});

	// A hook-triggered retry may find teardown already done; that no-op must preserve the failure.
	it.each([false, true])("reports destination rebind failures (coalesced no-op: %s)", async coalesced => {
		cfgMemoryBackend.override(settings, "hindsight");
		cfgHindsightMentalModelsEnabled.override(settings, false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return cfgMemoryBackend.get(settings) === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		cfgMemoryBackend.override(settings, "off");
		failToolBuild = true;
		if (coalesced) await settings.reloadForCwd(path.join(tempDir.path(), "destination"));

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});
});
