import { afterEach, describe, expect, it } from "bun:test";
import { isProviderEnabled } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { effectsSettings } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// A top-level SDK session holds process-wide state on its settings until disposed: setting
// effects (theme, credential redaction fallback, request limits) and the discovery provider
// toggles. Holds stack across concurrent sessions; neither may outlive its session, and a
// startup failure must not leave them bound to a discarded Settings instance.
describe("createAgentSession process-state holds", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("releases both holds when startup fails", async () => {
		const previousEffects = effectsSettings();
		const hostSettings = Settings.isolated({ disabledProviders: ["claude"] });
		cleanups.push(initializeWithSettings(hostSettings));
		const authStorage = createInMemoryAuthStorage();
		const registryAuthStorage = createInMemoryAuthStorage();
		cleanups.push(
			() => authStorage.close(),
			() => registryAuthStorage.close(),
		);

		await expect(
			createAgentSession({
				settings: Settings.isolated(),
				authStorage,
				modelRegistry: new ModelRegistry(registryAuthStorage),
			}),
		).rejects.toThrow("must be the same instance");

		expect(effectsSettings()).toBe(previousEffects);
		expect(isProviderEnabled("claude")).toBe(false);
	});

	it("keeps both driven by the remaining session when the first of two is disposed", async () => {
		using tempDir = TempDir.createSync("@pi-sdk-process-state-");
		const previousEffects = effectsSettings();
		cleanups.push(initializeWithSettings(Settings.isolated()));
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const modelRegistry = new ModelRegistry(authStorage);
		const start = async (settings: Settings): Promise<AgentSession> => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			cleanups.push(async () => {
				if (!session.isDisposed) await session.dispose();
			});
			return session;
		};
		const firstSettings = Settings.isolated({ disabledProviders: ["claude"] });
		const secondSettings = Settings.isolated({ disabledProviders: ["cursor"] });
		const first = await start(firstSettings);
		const second = await start(secondSettings);

		await first.dispose();
		expect(effectsSettings()).toBe(secondSettings);
		expect(isProviderEnabled("claude")).toBe(true);
		expect(isProviderEnabled("cursor")).toBe(false);

		await second.dispose();
		expect(effectsSettings()).toBe(previousEffects);
		expect(isProviderEnabled("cursor")).toBe(true);
	});
});
