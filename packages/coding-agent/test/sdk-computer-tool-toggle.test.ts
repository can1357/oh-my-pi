import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Guards the /computer session-scoped toggle mechanism: createTools derives the
// built-in slate once at session start, so with `computer.enabled=false` the
// computer tool is entirely absent from the registry. `setComputerToolEnabled`
// must re-derive that one entry through the SDK-provided factory and flip the
// active slate for the next turn — without persisting anything. Constructing
// the tool is inert (the desktop worker only spawns on first execute), so this
// runs headless.
describe("AgentSession.setComputerToolEnabled", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-computer-toggle-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("flips the active tool slate on enable and disable, session-only", async () => {
		const settings = Settings.isolated({});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		// computer.enabled defaults to false: absent from registry and slate.
		expect(session.getAllToolNames()).not.toContain("computer");
		expect(session.getActiveToolNames()).not.toContain("computer");

		// The /computer command's enable path: slate refresh + runtime override.
		expect(await session.setComputerToolEnabled(true)).toBe(true);
		session.settings.override("computer.enabled", true);
		expect(session.getAllToolNames()).toContain("computer");
		expect(session.getEnabledToolNames()).toContain("computer");
		expect(session.settings.get("computer.enabled")).toBe(true);

		// Disable removes it from the active slate but keeps the registry entry,
		// so a re-enable never registers a second desktop controller.
		expect(await session.setComputerToolEnabled(false)).toBe(true);
		session.settings.override("computer.enabled", false);
		expect(session.getEnabledToolNames()).not.toContain("computer");
		expect(session.getAllToolNames()).toContain("computer");

		// Re-enable reuses the retained registry entry.
		expect(await session.setComputerToolEnabled(true)).toBe(true);
		session.settings.override("computer.enabled", true);
		expect(session.getEnabledToolNames()).toContain("computer");

		const gemini = getBundledModel("google", "gemini-2.5-flash");
		if (!gemini) throw new Error("Expected bundled Google Gemini model to exist");
		await session.setModel(gemini);
		expect(session.model).toBe(gemini);
		expect(session.settings.get("computer.enabled")).toBe(true);
		expect(session.getEnabledToolNames()).toContain("computer");
	});
});
