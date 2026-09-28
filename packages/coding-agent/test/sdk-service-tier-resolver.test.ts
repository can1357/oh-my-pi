import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const runtimeProviderExtension: ExtensionFactory = pi => {
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

describe("createAgentSession resolveServiceTierByFamily", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages) authStorage.close();
		authStorages.length = 0;
	});

	function openAuthStorage(): AuthStorage {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		return authStorage;
	}

	function sessionOptions(cwd: string, authStorage: AuthStorage, settings: Settings, sessionManager: SessionManager) {
		return {
			cwd,
			agentDir: cwd,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
			settings,
			sessionManager,
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

	it("evaluates the resolver against the model resolved from a deferred pattern and replaces the configured tiers", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resolver-");
		const authStorage = openAuthStorage();
		const resolvedModels: Array<Model | undefined> = [];
		const { session } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				Settings.isolated({ "tier.anthropic": "priority" }),
				SessionManager.inMemory(),
			),
			extensions: [runtimeProviderExtension],
			// Only the extension can resolve this pattern, so dispatch-time
			// resolution would have seen no model at all.
			modelPattern: "runtime-provider/runtime-model",
			resolveServiceTierByFamily: model => {
				resolvedModels.push(model);
				return { openai: "scale" };
			},
		});
		try {
			expect(resolvedModels.map(model => model && `${model.provider}/${model.id}`)).toEqual([
				"runtime-provider/runtime-model",
			]);
			expect(session.model?.id).toBe("runtime-model");
			expect(session.serviceTierByFamily).toEqual({ openai: "scale" });
		} finally {
			await session.dispose();
		}
	});

	it("persists an empty resolved tier map so a reopened session does not re-derive tiers from settings", async () => {
		using tempDir = TempDir.createSync("@omp-service-tier-resolver-reopen-");
		const authStorage = openAuthStorage();
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		// The settings a cold revival rebuilds from say `priority`; the spawn's
		// per-agent override resolved to no tier at all.
		const settings = Settings.isolated({ "tier.openai": "priority" });

		const { session: spawned } = await createAgentSession({
			...sessionOptions(
				tempDir.path(),
				authStorage,
				settings,
				await SessionManager.open(sessionFile, tempDir.path()),
			),
			resolveServiceTierByFamily: () => ({}),
		});
		try {
			expect(spawned.serviceTierByFamily).toEqual({});
		} finally {
			await spawned.dispose();
		}

		const { session: revived } = await createAgentSession(
			sessionOptions(tempDir.path(), authStorage, settings, await SessionManager.open(sessionFile, tempDir.path())),
		);
		try {
			expect(revived.serviceTierByFamily).toEqual({});
		} finally {
			await revived.dispose();
		}
	});
});
