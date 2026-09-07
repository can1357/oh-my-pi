import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import * as taskDiscovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	createDefaultPersonaModelHooks,
	type ModelBaseline,
	type PersonaModelApplyHooks,
} from "@oh-my-pi/pi-coding-agent/session/persona-model-hooks";
import { makePersonaAgent, makePersonaHooks, makeSessionStub } from "./persona-test-utils";

/** Shared persona fixture with this suite's narrowed-grant default. */
const makeAgent = (overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent =>
	makePersonaAgent({ tools: ["read", "grep"], ...overrides });
/** ACP/text-mode `/agent` harness: fake runtime mirroring acp-builtins.test.ts. */
function makeAgentSlashHarness(session: AgentSession): {
	output: string[];
	runtime: SlashCommandRuntime;
} {
	const settings = Settings.isolated();
	const output: string[] = [];
	return {
		output,
		runtime: {
			session,
			sessionManager: {
				appendModeChange: (_mode: string, _data?: Record<string, unknown>) => "fake-entry",
			} as unknown as SessionManager,
			settings,
			cwd: "/tmp/project",
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

const discoverySpies: Array<Mock<typeof taskDiscovery.discoverAgents>> = [];
afterEach(() => {
	for (const spy of discoverySpies) spy.mockRestore();
	discoverySpies.length = 0;
});

/** Point discoverAgents at a fixed agent list for the duration of a test. */
function mockDiscovery(agents: DiscoveredAgent[]): void {
	discoverySpies.push(vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null }));
}

describe("/agent slash command", () => {
	it("switches the active persona and applies the grant to the live tool set", async () => {
		const { stub, session, policy } = makeSessionStub();
		const { output, runtime: slashRuntime } = makeAgentSlashHarness(session);
		mockDiscovery([makeAgent()]);

		const result = await executeAcpBuiltinSlashCommand("/agent persona-a", slashRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Agent persona: persona-a"]);
		expect(policy.isPersonaActive()).toBe(true);
		// Persona grant: only read/grep survive the persona layer.
		expect(policy.effective("read")).toBe(true);
		expect(policy.effective("grep")).toBe(true);
		expect(stub.appendPrompt).toBe("persona prompt");
		// Presentation channel narrowed to the intersected set (enter body).
		expect(stub.presentationCalls[stub.presentationCalls.length - 1]?.toolNames).toEqual(["read", "grep"]);
		expect(stub.refreshBaseSystemPromptCalls).toBe(1);
	});

	it("persists the switch as an agent mode_change entry after enter succeeds", async () => {
		const { session, policy, modeChangeEntries } = makeSessionStub();
		const { runtime: slashRuntime } = makeAgentSlashHarness(session);
		mockDiscovery([makeAgent()]);

		await executeAcpBuiltinSlashCommand("/agent persona-a", slashRuntime);

		expect(policy.isPersonaActive()).toBe(true);
		expect(modeChangeEntries).toEqual([{ mode: "agent", data: { name: "persona-a" } }]);
	});

	it("clears the persona via bare /agent when one is active", async () => {
		const { stub, session, policy, runtime, modeChangeEntries } = makeSessionStub();
		const { output, runtime: slashRuntime } = makeAgentSlashHarness(session);
		mockDiscovery([makeAgent()]);
		await runtime.enter(makeAgent(), {}, makePersonaHooks());
		expect(policy.isPersonaActive()).toBe(true);

		const result = await executeAcpBuiltinSlashCommand("/agent", slashRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Agent persona cleared."]);
		expect(policy.isPersonaActive()).toBe(false);
		expect(stub.appendPrompt).toBeUndefined();
		expect(stub.spawnsOverride).toBeNull();
		expect(modeChangeEntries).toEqual([{ mode: "none" }]);
	});

	it("reports usage when no persona is active and no name is given", async () => {
		const { session } = makeSessionStub();
		const { output, runtime: slashRuntime } = makeAgentSlashHarness(session);

		const result = await executeAcpBuiltinSlashCommand("/agent", slashRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Usage: /agent <name> to activate an agent persona."]);
	});

	it("errors when the session has no persona runtime", async () => {
		const bareSession = {
			getPersonaRuntime: () => undefined,
			getToolPolicy: () => undefined,
		} as unknown as AgentSession;
		const { output, runtime: slashRuntime } = makeAgentSlashHarness(bareSession);

		const result = await executeAcpBuiltinSlashCommand("/agent persona-a", slashRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("no persona runtime");
	});
});

/** Live mid-turn deferral: persona tools/prompt apply immediately, model channel queues (plan §8, acceptance 9). */
describe("persona switch deferral", () => {
	it("defers the persona model switch mid-turn while still applying tools and prompt", async () => {
		// ACP semantics: notice + skip the model half; tools/prompt/policy still
		// apply immediately (plan §8 — no whole-switch deferral anymore).
		const { stub, session, policy, runtime } = makeSessionStub({
			isStreaming: true,
		});
		let queued: string | undefined;
		let deferNotices = 0;
		const hooks: PersonaModelApplyHooks = {
			...createDefaultPersonaModelHooks(session),
			shouldDeferModelSwitch: () => true,
			deferModelSwitchWhileStreaming: agent => {
				deferNotices += 1;
				queued = agent.model?.[0];
			},
		};

		const agent = makeAgent({
			model: ["deferred-model-pattern"],
			tools: ["read"],
		});
		await runtime.enter(agent, {}, hooks);

		expect(deferNotices).toBe(1);
		expect(queued).toBe("deferred-model-pattern");
		// Persona state applied immediately even though the model half deferred.
		expect(runtime.policy.isPersonaActive()).toBe(true);
		expect(policy.effective("read")).toBe(true);
		expect(stub.appendPrompt).toBe("persona prompt");
	});

	it("queues the pre-persona model restore when exiting mid-turn", async () => {
		// TUI semantics (acceptance 9): the exit's policy/prompt/spawns teardown
		// applies immediately; the RUNTIME passes its own captured baseline to
		// the surface queue, never mutating a live turn.
		const { runtime } = makeSessionStub({ isStreaming: true });
		const queued: Array<ModelBaseline> = [];
		const hooks: PersonaModelApplyHooks = {
			apply: async () => {},
			shouldDeferModelSwitch: () => true,
			deferModelSwitchWhileStreaming: () => {},
			deferModelRestoreWhileStreaming: baseline => {
				queued.push(baseline);
			},
		};

		await runtime.enter(makeAgent(), {}, hooks);
		await runtime.exit(hooks);

		// Teardown applied immediately; the model restore is queued, not dropped.
		expect(runtime.policy.isPersonaActive()).toBe(false);
		expect(queued).toHaveLength(1);
	});
});
