import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const EXACT_SPAWN_ERROR =
	"Subagent spawn model resolution failed: none of the requested models resolved to a usable model: " +
	"anthropic/claude-opus-5-5:high (absent from catalog); anthropic/claude-sonnet-5-5:medium (absent from catalog)";

function model(provider: string, id: string): Model<"anthropic-messages"> {
	return buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		baseUrl: `https://${provider}.example.com`,
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const GPT = model("openai", "gpt-5.5");

function fakeRegistry(available: Model<"anthropic-messages">[]) {
	return {
		refresh: async () => {},
		getAvailable: () => available,
		getAll: () => available,
		getApiKey: async () => "sk-test",
	} as unknown as ModelRegistry;
}

function createMockSession(): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as never[] };
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		...createSessionDefaults(),
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-failclosed",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			return true;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => false,
	};
	return session as unknown as AgentSession;
}

function mockCreateAgentSession(session: AgentSession, modelFallbackMessage?: string) {
	const result: CreateAgentSessionResult = {
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
		modelFallbackMessage,
		modelPatternResolutionFailed: modelFallbackMessage === "Model not found",
	};
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(result);
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("explicit spawn model resolution fails closed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("errors naming the requested patterns instead of running on the role model", async () => {
		const session = createMockSession();
		const prompt = vi.spyOn(session, "prompt");
		const dispose = vi.spyOn(session, "dispose").mockResolvedValue(undefined);
		const spy = mockCreateAgentSession(session, "Model not found");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-failclosed",
			modelOverride: ["anthropic/claude-opus-5-5:high", "anthropic/claude-sonnet-5-5:medium"],
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(String(result.error).split("\n")[0]).toBe(`Error: ${EXACT_SPAWN_ERROR}`);
		expect(prompt).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledTimes(1);
		// No role-chain model may be selected or recorded for the child.
		expect(session.model).toBeUndefined();
	});

	it("keeps the role chain when the unresolved patterns were inherited from the parent session", async () => {
		const session = createMockSession();
		const prompt = vi.spyOn(session, "prompt");
		mockCreateAgentSession(session, "Model not found");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-inherited",
			modelOverride: ["anthropic/claude-opus-5-5:high"],
			modelExplicit: false,
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(result.error).toBeUndefined();
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("classifies a disabled or unauthenticated catalog model by its real cause", async () => {
		const CLAUDE = model("anthropic", "claude-opus-5-5");
		const OFFLINE = model("offline", "local-model");
		const registry = {
			refresh: async () => {},
			getAvailable: () => [GPT],
			getAll: () => [GPT, CLAUDE, OFFLINE],
			getApiKey: async () => "sk-test",
		} as unknown as ModelRegistry;
		mockCreateAgentSession(createMockSession(), "Model not found");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-classified",
			modelOverride: ["anthropic/claude-opus-5-5", "offline/local-model", "ghost/none"],
			settings: Settings.isolated({ disabledProviders: ["anthropic"] }),
			modelRegistry: registry,
			enableLsp: false,
		});
		expect(String(result.error).split("\n")[0]).toContain(
			"anthropic/claude-opus-5-5 (provider disabled); offline/local-model (no auth); ghost/none (absent from catalog)",
		);
	});

	it("control: with no explicit model the spawn still proceeds to the role chain", async () => {
		const spy = mockCreateAgentSession(createMockSession());
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-role-chain",
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]?.model).toBeUndefined();
	});

	// Deferred discovery must run before the explicit-pattern guard rejects a spawn.
	it("neighbour: a later order element that resolves is used with its exact id", async () => {
		const spy = mockCreateAgentSession(createMockSession());
		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id: "spawn-second-element",
			modelOverride: ["anthropic/claude-opus-5-5:high", "openai/gpt-5.5:medium"],
			settings: Settings.isolated(),
			modelRegistry: fakeRegistry([GPT]),
			enableLsp: false,
		});
		expect(result.error).toBeUndefined();
		expect(result.exitCode).toBe(0);
		const passed = spy.mock.calls[0]?.[0]?.model;
		expect(passed?.provider).toBe("openai");
		expect(passed?.id).toBe("gpt-5.5");
	});

	it("uses the exact explicit model supplied by deferred discovery", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-deferred-model-"));
		const authStorage = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const createAgentSession = sdkModule.createAgentSession;
		const session = createMockSession();
		const usedModels: Array<string | undefined> = [];
		const prompt = session.prompt.bind(session);
		vi.spyOn(session, "prompt").mockImplementation(async (text, options) => {
			usedModels.push(session.model?.id);
			return prompt(text, options);
		});
		const discover = vi.fn(async () => [
			{
				id: "discovered-spawn-model",
				name: "Discovered spawn model",
				reasoning: false,
				input: ["text"] as ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		]);
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const created = await createAgentSession({
				...options,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				disableExtensionDiscovery: true,
				extensions: [
					pi => {
						pi.registerProvider("spawn-discovery", {
							baseUrl: "https://spawn-discovery.example.com/v1",
							api: "openai-completions",
							apiKey: "test-key",
							fetchDynamicModels: discover,
						});
					},
				],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			Object.defineProperty(session, "model", { value: created.session.model });
			await created.session.dispose();
			return { ...created, session };
		});
		try {
			expect(registry.getAll().filter(candidate => candidate.provider === "spawn-discovery")).toEqual([]);
			const result = await runSubprocess({
				cwd: tempDir,
				agent: baseAgent,
				task: "do work",
				index: 0,
				id: "spawn-deferred-discovery",
				modelOverride: "spawn-discovery/discovered-spawn-model",
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: registry,
				enableLsp: false,
			});
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(spy.mock.calls[0]?.[0]?.modelPattern).toEqual(["spawn-discovery/discovered-spawn-model"]);
			expect(discover).toHaveBeenCalledTimes(1);
			expect(session.model?.provider).toBe("spawn-discovery");
			expect(session.model?.id).toBe("discovered-spawn-model");
			expect(usedModels).toEqual(["discovered-spawn-model"]);
		} finally {
			authStorage.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
	it("prompts with a deferred explicit role's usage fallback instead of rejecting its warning", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-deferred-role-"));
		const authStorage = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const createAgentSession = sdkModule.createAgentSession;
		const session = createMockSession();
		const prompt = vi.spyOn(session, "prompt");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.usageAwareFallback": true,
			"retry.usageReservePolicy": "confirm",
		});
		settings.setModelRole("task", "spawn-role/primary,spawn-role/fallback");
		vi.spyOn(authStorage.health, "model").mockImplementation(async (_provider, options) =>
			options.modelId === "primary"
				? { state: "depleted", accounts: [{ credentialId: 1, credentialType: "oauth", state: "depleted" }] }
				: { state: "healthy", accounts: [{ credentialId: 2, credentialType: "oauth", state: "healthy" }] },
		);
		const discover = vi.fn(async () =>
			["primary", "fallback"].map(id => ({
				id,
				name: id,
				reasoning: false,
				input: ["text"] as ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			})),
		);
		let fallbackMessage: string | undefined;
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const created = await createAgentSession({
				...options,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				disableExtensionDiscovery: true,
				extensions: [
					pi => {
						pi.registerProvider("spawn-role", {
							baseUrl: "https://spawn-role.example.com/v1",
							api: "openai-completions",
							apiKey: "test-key",
							fetchDynamicModels: discover,
						});
					},
				],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			fallbackMessage = created.modelFallbackMessage;
			Object.defineProperty(session, "model", { value: created.session.model });
			await created.session.dispose();
			return { ...created, session };
		});
		try {
			expect(registry.getAll().filter(candidate => candidate.provider === "spawn-role")).toEqual([]);
			const result = await runSubprocess({
				cwd: tempDir,
				agent: baseAgent,
				task: "do work",
				index: 0,
				id: "spawn-deferred-role",
				modelOverride: "task",
				settings,
				modelRegistry: registry,
				enableLsp: false,
			});
			expect(fallbackMessage).toContain("spawn-role/primary -> spawn-role/fallback");
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(spy.mock.calls[0]?.[0]?.modelPattern).toEqual(["task"]);
			expect(discover).toHaveBeenCalledTimes(1);
			expect(session.model?.id).toBe("fallback");
			expect(prompt).toHaveBeenCalledTimes(1);
		} finally {
			authStorage.close();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
