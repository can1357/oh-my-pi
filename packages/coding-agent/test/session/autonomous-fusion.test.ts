import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { BeforeToolCallContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { BUILTIN_SLASH_COMMANDS } from "../../src/slash-commands/builtin-registry";
import { buildFusionStatusText, handleFusionCommand } from "../../src/slash-commands/helpers/fusion";

function makeToolCallContext(name: string, args: Record<string, unknown>): BeforeToolCallContext {
	return {
		assistantMessage: {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "runtime-provider",
			model: "runtime-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		},
		toolCall: {
			type: "toolCall",
			id: "call-1",
			name,
			arguments: args,
		},
		args,
		context: { messages: [], systemPrompt: [] },
	};
}

describe("Autonomous Fusion Workflow", () => {
	it("sets autonomous mode via /fusion mode autonomous and reflects it in status", async () => {
		const store = new Map<string, unknown>([
			["fusion.enabled", true],
			["fusion.mode", "escalate"],
		]);
		const outputs: string[] = [];
		const settings = {
			get: (key: string) => store.get(key),
			set: (key: string, value: unknown) => {
				store.set(key, value);
			},
		} as unknown as Settings;
		const runtime = {
			settings,
			session: {
				getFusionSidekickId: () => undefined,
				getFusionUsageSplit: () => ({
					total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					frontier: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					sidekick: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			},
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as Parameters<typeof handleFusionCommand>[1];

		await handleFusionCommand({ name: "fusion", args: "mode autonomous", text: "/fusion mode autonomous" }, runtime);
		expect(settings.get("fusion.mode")).toBe("autonomous");
		expect(outputs).toContain('fusion.mode set to "autonomous".');

		const statusText = buildFusionStatusText(runtime);
		expect(statusText).toContain("Mode:            autonomous (planning-only root, isolated durable workers)");
	});

	it("automatically enables fusion when setting a mode from disabled state", async () => {
		const store = new Map<string, unknown>([
			["fusion.enabled", false],
			["fusion.mode", "off"],
		]);
		const outputs: string[] = [];
		const settings = {
			get: (key: string) => store.get(key),
			set: (key: string, value: unknown) => {
				store.set(key, value);
			},
		} as unknown as Settings;
		const runtime = {
			settings,
			session: {
				getFusionSidekickId: () => undefined,
				getFusionUsageSplit: () => ({
					total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					frontier: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					sidekick: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}),
			},
			output: async (text: string) => {
				outputs.push(text);
			},
		} as unknown as Parameters<typeof handleFusionCommand>[1];

		await handleFusionCommand(
			{ name: "fusion", args: "mode token-savings", text: "/fusion mode token-savings" },
			runtime,
		);
		expect(settings.get("fusion.mode")).toBe("token-savings");
		expect(settings.get("fusion.enabled")).toBe(true);
		expect(outputs).toContain('fusion.mode set to "token-savings" and Fusion enabled.');
	});

	it("exposes autonomous completion directly in /fusion argument menu", async () => {
		const fusion = BUILTIN_SLASH_COMMANDS.find(c => c.name === "fusion");
		expect(fusion).toBeDefined();
		const items = await fusion?.getArgumentCompletions?.("");
		expect(items).not.toBeNull();
		const labels = items?.map(item => item.label) ?? [];
		expect(labels).toContain("autonomous");
		expect(labels).toContain("token-savings");

		const autonomousItem = items?.find(item => item.label === "autonomous");
		expect(autonomousItem?.value).toBe("mode autonomous ");
		expect(autonomousItem?.description).toContain("planning-only root");
	});

	it("validates fusion.mode setting schema enum accepts autonomous", () => {
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "autonomous",
		});
		expect(settings.get("fusion.mode")).toBe("autonomous");
	});

	it("blocks direct modification tools for the root session in autonomous mode", async () => {
		const tempDir = TempDir.createSync("@omp-autonomous-session-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = modelRegistry.getAll()[0];
		if (model) authStorage.setRuntimeApiKey(model.provider, "test-key");

		try {
			const settings = Settings.isolated({
				"fusion.enabled": true,
				"fusion.mode": "autonomous",
			});

			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skipPythonPreflight: true,
				enableMCP: false,
				enableLsp: false,
				model,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});

			const beforeToolCall = session.agent.beforeToolCall;
			expect(beforeToolCall).toBeDefined();

			// Direct edit is blocked
			const editRes = await beforeToolCall?.(makeToolCallContext("edit", { path: "src/file.ts" }));
			expect(editRes?.block).toBe(true);
			expect(editRes?.reason).toContain("[Autonomous Fusion Mode]");
			expect(editRes?.reason).toContain("restricted for the planning-only root session");

			// Direct write is blocked
			const writeRes = await beforeToolCall?.(makeToolCallContext("write", { path: "src/new.ts" }));
			expect(writeRes?.block).toBe(true);

			// Mutating bash is blocked
			const bashMutateRes = await beforeToolCall?.(makeToolCallContext("bash", { command: "git commit -m 'feat'" }));
			expect(bashMutateRes?.block).toBe(true);

			// Non-mutating bash is permitted (returns undefined)
			const bashReadRes = await beforeToolCall?.(makeToolCallContext("bash", { command: "git status" }));
			expect(bashReadRes).toBeUndefined();

			// Reading tools are permitted
			const readRes = await beforeToolCall?.(makeToolCallContext("read", { path: "src/file.ts" }));
			expect(readRes).toBeUndefined();
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("permits modification tools when fusion is disabled or in non-autonomous mode", async () => {
		const tempDir = TempDir.createSync("@omp-autonomous-off-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = modelRegistry.getAll()[0];
		if (model) authStorage.setRuntimeApiKey(model.provider, "test-key");

		try {
			const settings = Settings.isolated({
				"fusion.enabled": true,
				"fusion.mode": "token-savings",
			});

			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skipPythonPreflight: true,
				enableMCP: false,
				enableLsp: false,
				model,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});

			const beforeToolCall = session.agent.beforeToolCall;
			// Edit is NOT blocked in token-savings mode
			const editRes = await beforeToolCall?.(makeToolCallContext("edit", { path: "src/file.ts" }));
			expect(editRes).toBeUndefined();
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});
	it("configures task tool with autonomous isolation in autonomous mode", async () => {
		const tempDir = TempDir.createSync("@omp-autonomous-task-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = modelRegistry.getAll()[0];
		if (model) authStorage.setRuntimeApiKey(model.provider, "test-key");

		try {
			const settings = Settings.isolated({
				"fusion.enabled": true,
				"fusion.mode": "autonomous",
				"task.isolation.mode": "worktree",
			});

			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skipPythonPreflight: true,
				enableMCP: false,
				enableLsp: false,
				model,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});

			expect(session.isBuiltInTool("task")).toBe(true);
			expect(session.settings.get("fusion.mode")).toBe("autonomous");
			expect(session.settings.get("task.isolation.mode")).not.toBe("none");
		} finally {
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
