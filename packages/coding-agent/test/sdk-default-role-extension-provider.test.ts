/**
 * Regression: issue #3569.
 *
 * `modelRoles.default` set to a model from an extension-registered provider was
 * ignored on fresh interactive launches (no `-c`/`--resume`, no `--model`).
 * Extensions register their providers AFTER the SDK's early `defaultRoleSpec`
 * resolution, so the role-pointed model wasn't visible there. The post-extension
 * fallback then went straight to `pickDefaultAvailableModel`, which prefers a
 * bundled provider's default (e.g. `openai/gpt-5.5` when `OPENAI_API_KEY` is set)
 * over the configured default role.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("issue #3569 fresh launch default role from extension provider", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-default-role-ext-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider("runtime-provider", {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: "openai-completions",
			models: [
				{
					id: "runtime-model",
					name: "Runtime Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	test("honors modelRoles.default pointing at an extension model when a bundled provider key is present", async () => {
		const bundledOpenAiDefault = getBundledModel("openai", "gpt-5.5");
		if (!bundledOpenAiDefault) {
			throw new Error("Expected bundled OpenAI GPT-5.5 default");
		}

		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		// Mirrors the reporter's environment: `OPENAI_API_KEY` is configured for a
		// bundled provider whose `pickDefaultAvailableModel` entry would otherwise
		// win the startup fallback.
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const settings = Settings.isolated();
		settings.setModelRole("default", "runtime-provider/runtime-model");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
		}
	});

	test("keeps a parent's dynamic extension model visible while an ordinary child rebinds its provider", async () => {
		const providerName = "dynamic-snapshot-provider";
		const modelId = "dynamic-only-model";
		const sourceId = "<inline-0>";
		const authStorage = createInMemoryAuthStorage();
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
			fetch: () => Promise.reject(new Error("network disabled in SDK catalog snapshot test")),
		});
		const dynamicModels: NonNullable<ProviderConfigInput["models"]> = [
			{
				id: modelId,
				name: "Dynamic-only Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		];
		const fetchDynamicModels = vi.fn(async () => dynamicModels);
		const providerConfig: ProviderConfigInput = {
			baseUrl: "https://dynamic-snapshot.example.com/v1",
			apiKey: "snapshot-test-key",
			api: "openai-completions",
			fetchDynamicModels,
		};
		const dynamicProviderExtension: ExtensionFactory = pi => {
			pi.registerProvider(providerName, providerConfig);
		};
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${providerName}/${modelId}`);
		const createOptions = (): CreateAgentSessionOptions => ({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [dynamicProviderExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames: ["read"],
			cacheWarming: false,
		});
		const sessions: AgentSession[] = [];

		try {
			// Seed SQLite through real runtime discovery; registration itself has
			// no static rows that could hide the clear/rebind hydration gap.
			modelRegistry.registerProvider(providerName, providerConfig, sourceId);
			await modelRegistry.refreshRuntimeProviders("online");
			expect(modelRegistry.find(providerName, modelId)).toBeDefined();
			expect(fetchDynamicModels).toHaveBeenCalledTimes(1);

			const parentResult = await createAgentSession(createOptions());
			const parent = parentResult.session;
			sessions.push(parent);
			await parentResult.startBackgroundModelDiscovery?.();
			expect(parent.modelRegistry).toBe(modelRegistry);
			expect(parent.model).toMatchObject({ provider: providerName, id: modelId });

			const observations: { phase: string; model: Model<Api> | undefined }[] = [];
			const observe = (phase: string): void => {
				observations.push({ phase, model: parent.modelRegistry.find(providerName, modelId) });
			};
			const clearSourceRegistrations = modelRegistry.clearSourceRegistrations.bind(modelRegistry);
			const clearSpy = vi.spyOn(modelRegistry, "clearSourceRegistrations").mockImplementation(sourceIds => {
				const sources = typeof sourceIds === "string" ? [sourceIds] : [...sourceIds];
				clearSourceRegistrations(sources);
				if (!sources.includes(sourceId)) return;
				// Observe only natural microtask interleavings: do not add an await
				// between clearing, rebinding, and publishing the cached catalog.
				queueMicrotask(() => {
					observe("after source replacement");
					queueMicrotask(() => observe("following reader"));
				});
			});
			try {
				queueMicrotask(() => observe("child startup"));
				const childResult = await createAgentSession({
					...createOptions(),
					model: parent.model,
					taskDepth: 1,
					agentId: "SubAgent",
				});
				const child = childResult.session;
				sessions.push(child);
				await childResult.startBackgroundModelDiscovery?.();

				expect(child.modelRegistry).toBe(parent.modelRegistry);
				expect(observations.map(({ phase }) => phase)).toEqual([
					"child startup",
					"after source replacement",
					"following reader",
				]);
				for (const { model } of observations) {
					expect(model).toMatchObject({ provider: providerName, id: modelId });
				}
				expect(child.model).toMatchObject({ provider: providerName, id: modelId });
				expect(childResult.modelFallbackMessage).toBeUndefined();
				expect(modelRegistry.find(providerName, modelId)).toMatchObject({ provider: providerName, id: modelId });
				expect(fetchDynamicModels).toHaveBeenCalledTimes(1);
			} finally {
				clearSpy.mockRestore();
			}
		} finally {
			try {
				for (const session of sessions.reverse()) {
					await session.dispose();
				}
			} finally {
				modelRegistry.clearSourceRegistrations(sourceId);
			}
		}
	});
});
