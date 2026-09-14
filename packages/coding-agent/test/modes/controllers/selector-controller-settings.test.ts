import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SelectorController prompt-affecting settings", () => {
	it("refreshes the active prompt when xdev docs mode changes", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {});
		const ctx = {
			session: { refreshBaseSystemPrompt },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		controller.handleSettingChange("tools.xdevDocs", "catalog");
		await Promise.resolve();

		expect(refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	describe("queue-mode toggles from the settings panel", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let settings: Settings;
		let session: AgentSession;
		let controller: SelectorController;
		let configPath: string;

		beforeEach(async () => {
			tempDir = TempDir.createSync("@pi-selector-queue-");
			const agentDir = tempDir.path();
			configPath = path.join(agentDir, "config.yml");

			authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);

			const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
			settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			session = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: SessionManager.create(agentDir, agentDir),
				settings,
				modelRegistry,
				obfuscator: new SecretObfuscator([]),
			});
			controller = new SelectorController({ session } as unknown as InteractiveModeContext);
		});

		afterEach(async () => {
			authStorage.close();
			try {
				await tempDir.remove();
			} catch {}
		});

		it("applies panel queue-mode toggles live and persists them globally", async () => {
			controller.handleSettingChange("steeringMode", "all");
			controller.handleSettingChange("followUpMode", "all");
			controller.handleSettingChange("interruptMode", "wait");
			await settings.flush();

			expect(session.steeringMode).toBe("all");
			expect(session.followUpMode).toBe("all");
			expect(session.interruptMode).toBe("wait");
			expect(settings.getGlobalSettings()).toMatchObject({
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "wait",
			});
			const onDisk = await Bun.file(configPath).text();
			expect(onDisk).toContain("steeringMode: all");
			expect(onDisk).toContain("followUpMode: all");
			expect(onDisk).toContain("interruptMode: wait");
		});
	});
});
