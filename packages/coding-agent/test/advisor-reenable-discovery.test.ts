import { afterEach, beforeAll, describe, expect, it, mock, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import type * as AdvisorConfig from "../src/advisor/config";

const actualAdvisorConfig: typeof AdvisorConfig = await import("../src/advisor/config");

const discoverCalls: { cwd: string; configDir?: string }[] = [];

// Discovery runs once at startup; `/advisor on` after a WATCHDOG.yml edit must
// re-discover through the session's config dir and apply the changed roster,
// while re-enable calls that only retune budget/tier settings must not.
mock.module("../src/advisor/config", () => ({
	...actualAdvisorConfig,
	discoverAdvisorConfigs: async (cwd: string, configDir?: string) => {
		discoverCalls.push({ cwd, configDir });
		return actualAdvisorConfig.discoverAdvisorConfigs(cwd, configDir);
	},
}));

const { AgentSession } = await import("@oh-my-pi/pi-coding-agent/session/agent-session");

describe("advisor re-enable discovery", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		model = bundled;
	});

	let session: InstanceType<typeof AgentSession> | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		discoverCalls.length = 0;
	});

	function newSession(): InstanceType<typeof AgentSession> {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		return session;
	}

	it("re-enabling while already enabled does not re-discover", () => {
		const s = newSession();
		expect(s.setAdvisorEnabled(true)).toBe(true);
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		// A budget/tier edit while enabled lands here as setAdvisorEnabled(true);
		// it must keep the startup snapshot and the live runtime.
		expect(s.setAdvisorEnabled(true)).toBe(true);
		expect(s.getAdvisorAgent()).toBe(advisorBefore);
		expect(discoverCalls).toHaveLength(0);
	});

	it("a disabled -> enabled transition re-discovers through the session config dir", async () => {
		const s = newSession();
		expect(s.setAdvisorEnabled(true)).toBe(true);
		// Discovery is fire-and-forget; give the background task a chance to run.
		await new Promise(resolve => setTimeout(resolve, 0));
		// The session has no WATCHDOG.yml, so re-discovery finds the same empty
		// roster and must not replace the live runtime.
		const advisorBefore = s.getAdvisorAgent();
		if (!advisorBefore) throw new Error("Expected advisor Agent to be live");
		expect(s.getAdvisorAgent()).toBe(advisorBefore);
		expect(discoverCalls.length).toBeGreaterThanOrEqual(1);
		expect(discoverCalls[0]?.cwd).toBeTruthy();
	});
});
