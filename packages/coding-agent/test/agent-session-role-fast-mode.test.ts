import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { applyModelPreset, saveModelPreset } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withOfficialAnthropicEndpoint } from "./helpers/anthropic-endpoint";

withOfficialAnthropicEndpoint();

describe("role model fast mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-role-fast-mode-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function createSession(options?: {
		modelRoles?: Record<string, string>;
		modelRoleFast?: Record<string, boolean>;
	}): Promise<AgentSession> {
		const defaultModel = getBundledModel("openai", "gpt-5.2");
		if (!defaultModel) throw new Error("Expected bundled openai/gpt-5.2 to exist");
		const agent = new Agent({
			initialState: { model: defaultModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({
			modelRoles: options?.modelRoles ?? {},
			modelRoleFast: options?.modelRoleFast ?? {},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		return session;
	}

	it("cycles into a role with fast mode enabled and restores when cycling back", async () => {
		const currentSession = await createSession({
			modelRoles: {
				default: "openai/gpt-5.2",
				smol: "anthropic/claude-sonnet-4-5",
			},
			modelRoleFast: {
				smol: true,
			},
		});

		expect(currentSession.isFastModeEnabled()).toBe(false);
		expect(currentSession.serviceTierByFamily).toEqual({});

		const toSmol = await currentSession.cycleRoleModels(["default", "smol"]);
		expect(toSmol?.role).toBe("smol");
		expect(toSmol?.model.id).toBe("claude-sonnet-4-5");
		expect(currentSession.isFastModeEnabled()).toBe(true);
		expect(currentSession.serviceTierByFamily.anthropic).toBe("priority");

		const toDefault = await currentSession.cycleRoleModels(["default", "smol"]);
		expect(toDefault?.role).toBe("default");
		expect(toDefault?.model.id).toBe("gpt-5.2");
		expect(currentSession.isFastModeEnabled()).toBe(false);
	});

	it("syncs /fast changes to active role when role has configured fast mode", async () => {
		const currentSession = await createSession({
			modelRoles: {
				default: "openai/gpt-5.2",
				smol: "anthropic/claude-sonnet-4-5",
			},
			modelRoleFast: {
				smol: true,
			},
		});

		await currentSession.cycleRoleModels(["default", "smol"]);
		expect(currentSession.isFastModeEnabled()).toBe(true);

		currentSession.setFastMode(false);
		expect(currentSession.isFastModeEnabled()).toBe(false);
		expect(currentSession.settings.getModelRoleFast("smol")).toBe(false);

		currentSession.setFastMode(true);
		expect(currentSession.isFastModeEnabled()).toBe(true);
		expect(currentSession.settings.getModelRoleFast("smol")).toBe(true);

		await currentSession.cycleRoleModels(["default", "smol"]);
		expect(currentSession.settings.getModelRoleFast("default")).toBeUndefined();
		currentSession.setFastMode(true);
		expect(currentSession.isFastModeEnabled()).toBe(true);
		expect(currentSession.settings.getModelRoleFast("default")).toBeUndefined();
	});

	it("captures and restores role fast mode preferences in model presets", async () => {
		const currentSession = await createSession({
			modelRoles: {
				default: "openai/gpt-5.2",
				smol: "anthropic/claude-sonnet-4-5",
			},
			modelRoleFast: {
				smol: true,
			},
		});

		const preset = saveModelPreset(currentSession.settings, "fast-test");
		expect(preset.modelRoleFast).toEqual({ smol: true });

		currentSession.settings.setModelRoleFast("smol", undefined);
		expect(currentSession.settings.getModelRoleFast("smol")).toBeUndefined();

		const applied = await applyModelPreset(currentSession.settings, currentSession, "fast-test");
		expect(applied.kind).toBe("switched");
		expect(currentSession.settings.getModelRoleFast("smol")).toBe(true);
	});

	it("supports project scoping for modelRoleFast", async () => {
		const currentSession = await createSession();
		currentSession.settings.setProjectModelRoleFast("smol", true);
		expect(currentSession.settings.getModelRoleFast("smol")).toBe(true);

		currentSession.settings.clearProjectModelRoleFast("smol");
		expect(currentSession.settings.getModelRoleFast("smol")).toBeUndefined();
	});

	it("activates role fastMode on setModel and respects explicit fastMode option", async () => {
		const currentSession = await createSession({
			modelRoles: {
				default: "openai/gpt-5.2",
				smol: "anthropic/claude-sonnet-4-5",
			},
			modelRoleFast: {
				smol: true,
			},
		});

		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		await currentSession.setModel(sonnet, "smol");
		expect(currentSession.isFastModeEnabled()).toBe(true);
		expect(currentSession.serviceTierByFamily.anthropic).toBe("priority");

		const gpt = getBundledModel("openai", "gpt-5.2")!;
		await currentSession.setModel(gpt, "default", { fastMode: true });
		expect(currentSession.isFastModeEnabled()).toBe(true);
		expect(currentSession.serviceTierByFamily.openai).toBe("priority");
	});

	it("seeds priority on startup for default model family when modelRoleFast.default is true", async () => {
		const defaultDir = TempDir.createSync("@pi-startup-fast-");
		try {
			const settings = Settings.isolated({
				modelRoles: { default: "anthropic/claude-sonnet-4-5" },
				modelRoleFast: { default: true },
			});
			const { session: startupSession } = await createAgentSession({
				cwd: defaultDir.path(),
				agentDir: defaultDir.path(),
				settings,
				authStorage,
				modelRegistry,
				sessionManager: SessionManager.inMemory(defaultDir.path()),
			});
			try {
				expect(startupSession.serviceTierByFamily.anthropic).toBe("priority");
				expect(startupSession.isFastModeEnabled()).toBe(true);
			} finally {
				await startupSession.dispose();
			}
		} finally {
			defaultDir.removeSync();
		}
	});
});
