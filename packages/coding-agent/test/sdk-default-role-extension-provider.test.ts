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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
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
		authStorage.setRuntimeApiKey("openai", "test-openai-key");
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
});
