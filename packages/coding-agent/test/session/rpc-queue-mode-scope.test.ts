import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { applyRpcQueueModeCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression guard for #11555: the RPC queue-mode path (`persist: false`)
 * must configure only the calling session — never write the machine-global
 * `config.yml`, and never leak into later sessions via the shared Settings
 * singleton. The default (settings panel, existing SDK callers) still
 * persists.
 */
describe("AgentSession queue-mode controls are session-scoped by default", () => {
	let tempDir: TempDir;
	let agentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let settings: Settings;
	let session: AgentSession;
	let configPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-queue-scope-");
		agentDir = tempDir.path();
		configPath = path.join(agentDir, "config.yml");

		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);

		model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			modelRegistry,
			obfuscator: new SecretObfuscator([]),
		});
	});

	afterEach(async () => {
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("applies RPC queue-mode commands to the live agent only, without touching Settings", async () => {
		applyRpcQueueModeCommand(session, { type: "set_steering_mode", mode: "all" });
		applyRpcQueueModeCommand(session, { type: "set_follow_up_mode", mode: "all" });
		applyRpcQueueModeCommand(session, { type: "set_interrupt_mode", mode: "wait" });
		await settings.flush();

		expect(session.steeringMode).toBe("all");
		expect(session.followUpMode).toBe("all");
		expect(session.interruptMode).toBe("wait");
		expect(settings.get("steeringMode")).toBe("one-at-a-time");
		expect(settings.get("followUpMode")).toBe("one-at-a-time");
		expect(settings.get("interruptMode")).toBe("immediate");
		expect(settings.getGlobalSettings()).toEqual({});
		expect(await Bun.file(configPath).exists()).toBe(false);
	});

	it("does not leak session-scoped queue modes into later sessions sharing the same Settings", () => {
		session.setSteeringMode("all", false);
		session.setFollowUpMode("all", false);
		session.setInterruptMode("wait", false);

		// Later SDK sessions initialize their agent from Settings (sdk.ts),
		// so an untouched Settings means defaults — not the caller's modes.
		const laterSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
				followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
				interruptMode: settings.get("interruptMode") ?? "immediate",
			}),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			modelRegistry,
			obfuscator: new SecretObfuscator([]),
		});

		expect(laterSession.steeringMode).toBe("one-at-a-time");
		expect(laterSession.followUpMode).toBe("one-at-a-time");
		expect(laterSession.interruptMode).toBe("immediate");
		expect(session.steeringMode).toBe("all");
		expect(session.followUpMode).toBe("all");
		expect(session.interruptMode).toBe("wait");
	});

	it("persists to global config.yml by default (settings panel and existing callers)", async () => {
		session.setSteeringMode("all");
		session.setFollowUpMode("all");
		session.setInterruptMode("wait");
		await settings.flush();

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
