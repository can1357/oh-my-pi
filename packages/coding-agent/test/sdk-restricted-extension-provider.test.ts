import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, getCustomApi } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const providerName = "restricted-session-provider";
const modelId = "restricted-session-model";
const apiId = "restricted-session-api";
const sourceId = "<inline-0>";

describe("restricted sessions sharing extension providers", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-restricted-provider-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		settings = Settings.isolated();
		settings.setModelRole("default", `${providerName}/${modelId}`);
	});

	afterEach(() => {
		modelRegistry.clearSourceRegistrations(sourceId);
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	const providerExtension: ExtensionFactory = pi => {
		pi.registerProvider(providerName, {
			baseUrl: "https://runtime.example.com/v1",
			apiKey: "RUNTIME_KEY",
			api: apiId,
			streamSimple: () => createAssistantMessageEventStream(),
			models: [
				{
					id: modelId,
					name: "Restricted Session Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	function createOptions(): CreateAgentSessionOptions {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
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
		};
	}

	test("does not unregister the parent's provider when extension loading is restricted", async () => {
		const { session: parent } = await createAgentSession({
			...createOptions(),
			extensions: [providerExtension],
		});

		try {
			expect(parent.model?.provider).toBe(providerName);
			expect(modelRegistry.authStorage.hasAuth(providerName)).toBe(true);
			expect(getCustomApi(apiId)).toBeDefined();

			const { session: child } = await createAgentSession({
				...createOptions(),
				model: parent.model,
				restrictToolNames: true,
				toolNames: ["read"],
			});

			try {
				expect(child.model?.provider).toBe(providerName);
				expect(modelRegistry.find(providerName, modelId)).toBeDefined();
				expect(modelRegistry.authStorage.hasAuth(providerName)).toBe(true);
				expect(getCustomApi(apiId)).toBeDefined();
			} finally {
				await child.dispose();
			}
		} finally {
			await parent.dispose();
		}
	});
});
