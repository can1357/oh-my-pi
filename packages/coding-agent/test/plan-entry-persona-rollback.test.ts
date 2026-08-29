import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("plan entry persona rollback", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "probe-plan-rollback-"));
		projectDir = path.join(tempHome, "project");
		await fs.promises.mkdir(projectDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage?.close();
		await fs.promises.rm(tempHome, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("rolls back the torn-down persona when plan setup fails", async () => {
		// `/plan` from an active persona clears the persona's tools, prompt,
		// and spawn policy BEFORE the tool-activation step. A failure there
		// (e.g. a rejected activation) must restore the persona state: the
		// persisted mode is still `agent`, so a half-cleared persona would
		// leave the session resuming with a live persona marker over discarded
		// state. Regression test for the rollback added with the plan-entry
		// snapshot.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("missing bundled anthropic model");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempHome, "models.yml"));
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: tempHome,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(projectDir),
			settings: Settings.isolated({ "compaction.enabled": false, "plan.enabled": true }),
			model,
			personaName: "launch-persona",
			personaAppendPrompt: "You are launch-persona.",
			spawns: "scout",
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		try {
			// Persona is active at entry.
			expect(session.getPersonaAppendPrompt()).toBe("You are launch-persona.");
			expect(session.getSessionSpawns()).toBe("scout");

			const mode = new InteractiveMode(session, "test");
			// Make plan setup fail at the tool-activation step.
			vi.spyOn(session, "setActiveToolsByName").mockRejectedValueOnce(new Error("tool activation rejected"));
			await expect(mode.handlePlanModeCommand()).rejects.toThrow("tool activation rejected");

			// The persona state must be restored by rollbackPersonaSwitch.
			expect(session.getSessionSpawns()).toBe("scout");
			expect(session.getPersonaAppendPrompt()).toBe("You are launch-persona.");
			expect(session.getEnabledToolNames()).toEqual(["read"]);
			// Plan mode must NOT be enabled.
			expect(mode.planModeEnabled).toBe(false);
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
