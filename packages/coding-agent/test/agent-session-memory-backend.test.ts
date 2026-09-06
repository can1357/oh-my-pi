import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
		authStorage.setRuntimeApiKey("anthropic", "test-key");
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
		authStorage.close();
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
		const read = createTool("read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
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
				systemPrompt: [`backend:${settings.get("memory.backend")};tools:${toolNames.sort().join(",")}`],
			}),
		});
		return session;
	}

	it("switches runtime state, memory tools, and prompt in one apply", async () => {
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("retain"), createTool("memory_edit")] : [],
		);

		settings.override("memory.backend", "mnemopi");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "retain", "memory_edit"]));
		expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:memory_edit,read,retain"]);

		settings.override("memory.backend", "off");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
	});
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

	// A cwd move re-scopes Settings, so the destination project's
	// `memory.backend` is what the session must run. The Hindsight scope
	// rebuild alone only re-derives an already-active Hindsight bank, so a
	// destination project that turns memory off used to keep the source
	// project's backend, memory tools, and prompt for the rest of the session.
	it("applies the destination project's memory backend on a cwd move", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		const current = createSession(async () =>
			settings.get("memory.backend") === "hindsight" ? [createTool("recall"), createTool("retain")] : [],
		);

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));

		// Destination project settings, as `settings.reloadForCwd` would leave them.
		settings.override("memory.backend", "off");
		await rebindMemoryBackendForCwd(current);

		expect(current.getHindsightSessionState()).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
	});

	// A rebind that fails must fail the move instead of being logged and
	// dropped, which used to leave a half-rebound session reporting success.
	it("surfaces a failed destination rebind to the caller", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return settings.get("memory.backend") === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		settings.override("memory.backend", "off");
		failToolBuild = true;

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});

	// `Settings.reloadForCwd` fires the memory scope hooks synchronously, so the
	// move's own rebind coalesces onto a rebuild that is already in flight. When
	// the first attempt fails after `applyMemoryBackend` already tore the
	// outgoing state down, the coalesced retry finds a runtime that matches the
	// destination settings and no-ops — which must not launder the half-applied
	// move into a success.
	it("keeps a failed rebind failed when the coalesced retry has nothing left to move", async () => {
		settings.override("memory.backend", "hindsight");
		settings.override("hindsight.mentalModelsEnabled", false);
		let failToolBuild = false;
		const current = createSession(async () => {
			if (failToolBuild) throw new Error("destination memory tools unavailable");
			return settings.get("memory.backend") === "hindsight" ? [createTool("recall")] : [];
		});

		await current.applyMemoryBackend();
		expect(current.getHindsightSessionState()).toBeDefined();

		// Destination project settings, as `settings.reloadForCwd` would leave
		// them; the reload then queues the rebuild the move awaits.
		settings.override("memory.backend", "off");
		failToolBuild = true;
		await settings.reloadForCwd(path.join(tempDir.path(), "destination"));

		await expect(rebindMemoryBackendForCwd(current)).rejects.toThrow("destination memory tools unavailable");
	});
});
