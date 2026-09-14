import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

	it("preserves a memory-tool deselection across a backend rebuild", async () => {
		// A construction-time setting change (e.g. `hindsight.apiToken`) rebuilds
		// the memory backend, which recreates every memory tool and hands them to
		// `replaceMemoryTools`. A user who deselected `recall` through `/tools`
		// must keep it inactive: pre-fix the rebuild appended every newly created
		// tool unconditionally, silently reactivating it.
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("recall"), createTool("retain")] : [],
		);

		settings.override("memory.backend", "mnemopi");
		await current.applyMemoryBackend();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));

		// `/tools` deselection: record an explicit active set without `recall`.
		await current.setActiveToolsByName(["read", "retain"]);
		expect(current.getActiveToolNames()).not.toContain("recall");

		// Rebuild (as a construction-time setting change would): the tools are
		// recreated, but the deselection must survive.
		await current.applyMemoryBackend();

		expect(current.getAllToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));
		expect(current.getActiveToolNames()).toContain("retain");
		expect(current.getActiveToolNames()).not.toContain("recall");
	});

	it("keeps an explicit selection when a backend first registers its tools", async () => {
		// Enabling a backend from `off` registers its memory tools for the FIRST
		// time, so nothing was `removed`. Pre-fix every newly created tool was
		// activated on the strength of `!removed.has(name)`, overriding a `/tools`
		// selection the user had already narrowed while memory was off.
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("recall"), createTool("retain")] : [],
		);

		// `/tools` narrowing while memory is off: record an explicit active set.
		await current.setActiveToolsByName(["read"]);
		expect(current.getActiveToolNames()).toEqual(["read"]);

		// Turn the backend on: its tools become AVAILABLE but must respect the
		// explicit selection instead of forcing themselves active.
		settings.override("memory.backend", "mnemopi");
		await current.applyMemoryBackend();

		expect(current.getAllToolNames()).toEqual(expect.arrayContaining(["read", "recall", "retain"]));
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getActiveToolNames()).not.toContain("recall");
		expect(current.getActiveToolNames()).not.toContain("retain");
	});
});
