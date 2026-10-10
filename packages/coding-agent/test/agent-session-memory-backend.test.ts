import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend, rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { MEMORY_BACKEND_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/memory-backend/tool-names";
import { computeMnemopiBankScope } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { getProjectAgentDir, getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import { cfgHindsightApiUrl, cfgHindsightMentalModelsEnabled } from "@oh-my-pi/pi-coding-agent/hindsight/settings";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import { cfgMnemopiBank, cfgMnemopiRecallLimit, cfgMnemopiScoping } from "@oh-my-pi/pi-coding-agent/mnemopi/settings";

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

	beforeEach(() => {
		tempDir = TempDir.createSync("@memory-backend-lifecycle-");
		authStorage = createInMemoryAuthStorage();
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		resetMemoryForTests();
		vi.restoreAllMocks();
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
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`backend:${cfgMemoryBackend.get(settings)};tools:${toolNames.sort().join(",")}`],
			}),
		});
		return session;
	}

	async function startMemoryCompletion(models: Model<Api>[]) {
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "mnemopi",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "smol",
			"mnemopi.autoRetain": false,
			modelRoles: { memory: `${models[0]!.provider}/${models[0]!.id}` },
			"retry.fallbackChains": { memory: models.slice(1).map(model => `${model.provider}/${model.id}`) },
		});
		const current = createSession(async () => []);
		for (const model of models) authStorage.keys.setRuntime(model.provider, "test-key");
		spyOn(current.modelRegistry, "getAvailable").mockReturnValue(models);
		spyOn(current.modelRegistry, "getApiKeyForProvider").mockResolvedValue(undefined);
		await current.applyMemoryBackend();
		const llm = getMnemopiSessionState(current)!.config.providerOptions.llm;
		const complete =
			typeof llm === "function"
				? llm
				: llm && typeof llm === "object" && "complete" in llm
					? llm.complete
					: undefined;
		if (!complete) throw new Error("Expected managed memory completion");
		return { current, complete };
	}

	function memoryReply(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
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
				cost: { input: 0.000024, output: 0.00006, cacheRead: 0, cacheWrite: 0, total: 0.000084 },
			},
			stopReason,
			errorMessage: stopReason === "error" ? "Invalid request" : undefined,
			timestamp: Date.now(),
		};
	}

	it("journals one remote memory completion with its reported usage on the active branch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const response = memoryReply(model);
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			options?.onAttempt?.(response);
			return response;
		});
		const { current, complete } = await startMemoryCompletion([model]);
		const manager = current.sessionManager;
		manager.appendMessage({ role: "user", content: "Remember Sam's employer.", timestamp: 1 });
		const leafBefore = manager.getLeafId();

		await complete("Sam works at Globex.");

		const usage = manager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({
			parentId: leafBefore,
			purpose: "memory",
			role: "memory",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: response.usage,
			stopReason: "stop",
		});
		expect(manager.getLeafId()).toBe(usage[0]!.id);
	});

	it("journals both the billed memory failure and its successful remote fallback", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const backup = { ...model, id: "memory-backup" };
		const failed = memoryReply(model, "error");
		const succeeded = memoryReply(backup);
		spyOn(ai, "completeSimple").mockImplementation(async (candidate, _context, options) => {
			const response = candidate.id === model.id ? failed : succeeded;
			options?.onAttempt?.(response);
			return response;
		});
		const { current, complete } = await startMemoryCompletion([model, backup]);

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");

		const usage = current.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(2);
		expect(usage).toMatchObject([
			{
				purpose: "memory",
				role: "memory",
				model: model.id,
				usage: failed.usage,
				stopReason: "error",
				errorMessage: "Invalid request",
			},
			{ purpose: "memory", role: "memory", model: backup.id, usage: succeeded.usage, stopReason: "stop" },
		]);
	});

	it("does not journal unbilled local-inference memory completions", async () => {
		const model = getBundledModel("local", "qwen2.5-1.5b")!;
		spyOn(tinyModelClient, "complete").mockResolvedValue("Sam works at Globex.");
		const { current, complete } = await startMemoryCompletion([model]);

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");
		expect(current.sessionManager.getBranch().filter(entry => entry.type === "model_usage")).toEqual([]);
	});

	it("drops a late memory usage entry after the session changes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const started = Promise.withResolvers<void>();
		const response = Promise.withResolvers<AssistantMessage>();
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			started.resolve();
			const message = await response.promise;
			options?.onAttempt?.(message);
			return message;
		});
		const { current, complete } = await startMemoryCompletion([model]);
		const pending = complete("Sam works at Globex.");
		await started.promise;
		await current.sessionManager.newSession();
		response.resolve(memoryReply(model));

		expect(await pending).toBe("Sam works at Globex.");
		expect(current.sessionManager.getBranch().filter(entry => entry.type === "model_usage")).toEqual([]);
	});

	it("journals a successful memory completion on the session that started after a switch", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;
		const response = memoryReply(model);
		spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
			options?.onAttempt?.(response);
			return response;
		});
		const { current, complete } = await startMemoryCompletion([model]);
		const previousSessionId = current.sessionManager.getSessionId();
		await current.sessionManager.newSession();
		expect(current.sessionManager.getSessionId()).not.toBe(previousSessionId);
		current.sessionManager.appendMessage({ role: "user", content: "Remember Sam's employer.", timestamp: 1 });
		const leafBefore = current.sessionManager.getLeafId();

		expect(await complete("Sam works at Globex.")).toBe("Sam works at Globex.");

		const usage = current.sessionManager.getBranch().filter(entry => entry.type === "model_usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({
			parentId: leafBefore,
			purpose: "memory",
			role: "memory",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: response.usage,
			stopReason: "stop",
		});
	});

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
