import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProviderCooldownsPath, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { coolDownExhaustedProvider, recordProviderFailure } from "../src/session/provider-exhaustion";
import { SessionManager } from "../src/session/session-manager";

test.each([
	{
		name: "cold discovery outage",
		excluded: false,
		blockedFallback: true,
		discoveryMiss: true,
		provider: undefined,
		id: undefined,
	},
	{
		name: "initial missing credentials",
		excluded: false,
		blockedFallback: true,
		missingKey: true,
		provider: "anthropic",
		id: "claude-sonnet-4-5",
	},
	{ name: "all blocked", excluded: false, blockedFallback: true, provider: "anthropic", id: "claude-sonnet-4-5" },
	{ name: "scope excludes default", excluded: true, blockedFallback: true, provider: "google", id: "gemini-2.5-pro" },
	{ name: "available configured fallback", excluded: false, blockedFallback: false, provider: "openai", id: "gpt-4o" },
])(
	"startup preserves configured group and scope: $name",
	async ({ excluded, blockedFallback, discoveryMiss, missingKey, provider, id }) => {
		const directory = TempDir.createSync("provider-startup-");
		const auth = await AuthStorage.create(":memory:");
		for (const provider of ["anthropic", "openai", "google"]) {
			if (!missingKey || provider !== "anthropic") auth.keys.setRuntime(provider, "fixture-key");
		}
		const registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		const discovery = spyOn(registry, "getDiscoverableProviders").mockReturnValue([]);
		const catalog = registry.getAll();
		const catalogSpy = discoveryMiss
			? spyOn(registry, "getAll").mockReturnValue(catalog.filter(model => model.provider !== "anthropic"))
			: undefined;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { default: ["openai/gpt-4o"] },
			...(excluded ? { enabledModels: ["google/gemini-2.5-pro"] } : {}),
		});
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");
		for (const failedProvider of blockedFallback ? ["anthropic", "openai"] : ["anthropic"]) {
			if (failedProvider === "anthropic" && discoveryMiss)
				coolDownExhaustedProvider(failedProvider, { discoveryFailure: true });
			else if (failedProvider !== "anthropic" || !missingKey)
				recordProviderFailure(failedProvider, { status: 401, credentialVersion: "rejected" });
		}
		try {
			const { session } = await createAgentSession({
				cwd: directory.path(),
				agentDir: directory.path(),
				authStorage: auth,
				modelRegistry: registry,
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
				expect(session.model?.provider).toBe(provider);
				expect(session.model?.id).toBe(id);
			} finally {
				await session.dispose();
			}
		} finally {
			catalogSpy?.mockRestore();
			discovery.mockRestore();
			registry.stopAvailabilityMonitoring();
			await fs.rm(getProviderCooldownsPath(), { force: true });
			auth.close();
			directory.removeSync();
		}
	},
);
