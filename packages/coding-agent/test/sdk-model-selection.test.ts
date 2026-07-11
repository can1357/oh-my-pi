import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";

describe("createAgentSession deferred model pattern resolution", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-model-selection-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStoragesToClose) {
			authStorage.close();
		}
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
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
				{
					id: "runtime-reasoning-model",
					name: "Runtime Reasoning Model",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	};

	async function buildSessionOptions(modelPattern: string) {
		// Pass an explicit ModelRegistry so createAgentSession skips its implicit
		// ModelRegistry.refreshInBackground() — a network model-discovery pass
		// (~250ms/session) that contributes nothing here: the model resolves from
		// the inline extension provider, never from network catalogs. Mirrors the
		// explicit-registry pattern the resume tests below already rely on.
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		return {
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelPattern,
		};
	}

	test("resolves explicit modelPattern after extension providers register", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			await buildSessionOptions("runtime-provider/runtime-model"),
		);

		expect(session.model).toBeDefined();
		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-model");
		expect(modelFallbackMessage).toBeUndefined();
	});

	test("does not silently fallback when explicit modelPattern is unresolved", async () => {
		const { session, modelFallbackMessage } = await createAgentSession(
			await buildSessionOptions("missing-provider/missing-model"),
		);

		expect(session.model).toBeUndefined();
		expect(modelFallbackMessage).toBe('Model "missing-provider/missing-model" not found');
	});

	test("does not apply default role thinking override when modelPattern is explicit", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "off" });
		settings.setModelRole("smol", "runtime-provider/runtime-reasoning-model");
		settings.setModelRole("default", "pi/smol:high");

		const { session } = await createAgentSession({
			...(await buildSessionOptions("runtime-provider/runtime-reasoning-model")),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe("off");
	});

	test("normalizes max default thinking level from settings", async () => {
		const settings = Settings.isolated({ defaultThinkingLevel: "max" });

		const { session } = await createAgentSession({
			...(await buildSessionOptions("runtime-provider/runtime-reasoning-model")),
			settings,
		});

		expect(session.model?.provider).toBe("runtime-provider");
		expect(session.model?.id).toBe("runtime-reasoning-model");
		expect(session.thinkingLevel).toBe(Effort.XHigh);
	});

	test("selects the settings default model without synchronously validating auth", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated();
		settings.setModelRole("default", `${defaultModel.provider}/${defaultModel.id}`);

		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("settings default model should not validate auth during startup"));

		try {
			const { session } = await createAgentSession({
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
			});

			try {
				expect(session.model?.provider).toBe(defaultModel.provider);
				expect(session.model?.id).toBe(defaultModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
			authStorage.close();
		}
	});

	test("restores the saved session model without resolving auth over the network", async () => {
		// Regression: `restoreSessionModel` probed each saved-model candidate with
		// the async `getApiKey`, which refreshes OAuth tokens and hits the auth
		// broker. When the broker was unreachable that blocked resume for the full
		// ~10s refresh timeout — the "Still starting … restoreSessionModel" hang.
		// Selection now uses the synchronous, side-effect-free `hasConfiguredAuth`
		// probe; the real key is resolved lazily per request via the resolver.
		const savedModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!savedModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "resume-saved-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey(savedModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-saved-model.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-saved", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${savedModel.provider}/${savedModel.id}`,
					role: "default",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "resume-saved-sessions"));

		// A rejecting getApiKey stands in for the unreachable broker / hanging
		// OAuth refresh: if startup awaits it to pick the restore model, it surfaces.
		const getApiKeySpy = vi
			.spyOn(modelRegistry, "getApiKey")
			.mockRejectedValue(new Error("startup model restore must not resolve auth over the network"));

		try {
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				authStorage,
				modelRegistry,
				sessionManager,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});

			try {
				expect(session.model?.provider).toBe(savedModel.provider);
				expect(session.model?.id).toBe(savedModel.id);
				expect(getApiKeySpy).not.toHaveBeenCalled();
			} finally {
				await session.dispose();
			}
		} finally {
			getApiKeySpy.mockRestore();
		}
	});

	test("prefers the provider default over catalog order in the startup fallback", async () => {
		// Regression: with an Anthropic key but no configured `default` role and no
		// session/CLI model, the step-4 startup fallback used to pick the first
		// anthropic model in models.json catalog order (claude-3-5-sonnet-20240620)
		// instead of the provider's configured default from DEFAULT_MODEL_PER_PROVIDER
		// (claude-opus-4-8).
		const providerDefault = getBundledModel("anthropic", "claude-opus-4-8");
		const catalogFirst = getBundledModel("anthropic", "claude-3-5-sonnet-20240620");
		if (!providerDefault || !catalogFirst) {
			throw new Error("Expected bundled anthropic models for fallback regression");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "fallbackauth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		// No `default` model role configured: forces the step-4 startup fallback.
		const settings = Settings.isolated({ enabledModels: ["anthropic/*"] });

		const { session } = await createAgentSession({
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
		});

		try {
			expect(session.model?.provider).toBe("anthropic");
			expect(session.model?.id).toBe(providerDefault.id);
			expect(session.model?.id).not.toBe(catalogFirst.id);
		} finally {
			await session.dispose();
		}
	});

	test("prefers Codex OAuth over plain OpenAI for the shared startup default", async () => {
		const openaiDefault = getBundledModel("openai", "gpt-5.5");
		const codexDefault = getBundledModel("openai-codex", "gpt-5.5");
		if (!openaiDefault || !codexDefault) {
			throw new Error("Expected bundled OpenAI and Codex GPT-5.5 defaults");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "codex-fallback-auth.db"));
		authStoragesToClose.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "sk-or-v1-invalid-openai-key");
		authStorage.setRuntimeApiKey("openai-codex", "codex-oauth-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ enabledModels: ["openai/gpt-5.5", "openai-codex/gpt-5.5"] }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("openai-codex");
			expect(session.model?.id).toBe(codexDefault.id);
			expect(session.model?.id).toBe(openaiDefault.id);
		} finally {
			await session.dispose();
		}
	});

	test("restores role model max selector from extension provider after startup resume", async () => {
		const defaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(defaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		const targetSessionFile = path.join(tempDir, "resume-extension.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: `${defaultModel.provider}/${defaultModel.id}`,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "runtime-provider/runtime-reasoning-model:max",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions"));

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-reasoning-model");
			expect(session.thinkingLevel).toBe(Effort.XHigh);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	test("restores extension role model when saved default cannot be restored before extensions load", async () => {
		const settingsDefaultModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!settingsDefaultModel) {
			throw new Error("Expected bundled anthropic default model");
		}

		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey(settingsDefaultModel.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		// Saved default points at a provider that has no usable credentials. The
		// last active role (`smol`) is supplied by the inline extension and is
		// only resolvable once provider registrations are processed.
		const targetSessionFile = path.join(tempDir, "resume-extension-default-missing.jsonl");
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "resume-ext-no-default", timestamp, cwd: tempDir },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: "anthropic/not-available",
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: "runtime-provider/runtime-model",
					role: "smol",
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir, "sessions-no-default"));

		const settings = Settings.isolated();
		settings.setModelRole("default", `${settingsDefaultModel.provider}/${settingsDefaultModel.id}`);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			extensions: [providerExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			expect(session.model?.provider).toBe("runtime-provider");
			expect(session.model?.id).toBe("runtime-model");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
