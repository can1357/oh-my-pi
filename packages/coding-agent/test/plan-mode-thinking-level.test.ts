/**
 * Tests for plan mode thinking level propagation.
 *
 * Bug: When entering plan mode, the thinking level configured on the plan role
 * (e.g., "anthropic/claude-sonnet-4-5:xhigh") is discarded. resolveRoleModel()
 * calls resolveModelRoleValue() but only returns .model, dropping the thinking level.
 * #applyPlanModeModel() therefore has no thinking level to apply.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("plan mode thinking level", () => {
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;
	let sessionSettings: Settings;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		sessionSettings = Settings.isolated();
		const sonnet = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!sonnet) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: sonnet, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});
	});

	afterAll(async () => {
		await session.dispose();
		authStorage.close();
	});

	function configureRoles(modelRoles: Record<string, string>): AgentSession {
		sessionSettings.override("modelRoles", modelRoles);
		return session;
	}

	describe("resolveRoleModelWithThinking", () => {
		it("returns thinking level when plan role includes a thinking suffix", () => {
			configureRoles({ plan: "anthropic/claude-sonnet-4-5:xhigh" });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.provider).toBe("anthropic");
			expect(result.model!.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe(ThinkingLevel.XHigh);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("returns no explicit thinking level when plan role has no thinking suffix", () => {
			configureRoles({ plan: "anthropic/claude-sonnet-4-5" });

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeDefined();
			expect(result.model!.id).toBe("claude-sonnet-4-5");
			expect(result.explicitThinkingLevel).toBe(false);
		});

		it("returns no model when no plan role is configured", () => {
			configureRoles({});

			const result = session.resolveRoleModelWithThinking("plan");

			expect(result.model).toBeUndefined();
		});

		it("returns thinking level for different levels", () => {
			configureRoles({ plan: "anthropic/claude-sonnet-4-5:high" });

			const result = session.resolveRoleModelWithThinking("plan");
			expect(result.thinkingLevel).toBe(ThinkingLevel.High);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("works with the default role", () => {
			configureRoles({ default: "anthropic/claude-sonnet-4-5:medium" });

			const result = session.resolveRoleModelWithThinking("default");
			expect(result.model!.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe(ThinkingLevel.Medium);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		it("resolveRoleModel still returns just the model (backward compat)", () => {
			configureRoles({ plan: "anthropic/claude-sonnet-4-5:xhigh" });

			const model = session.resolveRoleModel("plan");
			expect(model).toBeDefined();
			expect(model!.provider).toBe("anthropic");
			expect(model!.id).toBe("claude-sonnet-4-5");
		});
	});
});
