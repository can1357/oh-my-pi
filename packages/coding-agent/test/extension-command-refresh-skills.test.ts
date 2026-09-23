import { describe, expect, it } from "bun:test";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionRuntime,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

function createRunner(): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner([], runtime, "/tmp", { getCwd: () => "/tmp" } as never, {} as never);
}

const actions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: async () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => undefined,
	setThinkingLevel: () => {},
	getSessionName: () => undefined,
	setSessionName: async () => {},
} as unknown as ExtensionActions;

const contextActions: ExtensionContextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: async () => {},
	getSystemPrompt: () => [],
};

describe("ExtensionCommandContext.refreshSkills", () => {
	it("exposes refreshSkills on command context without rewriting the session", () => {
		const ctx = createRunner().createCommandContext();
		expect(typeof ctx.refreshSkills).toBe("function");
		expect(typeof ctx.reload).toBe("function");
	});

	it("delegates refreshSkills to the wired command action", async () => {
		const runner = createRunner();
		const calls: string[] = [];
		const commandActions: ExtensionCommandContextActions = {
			getContextUsage: () => undefined,
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: false }),
			branch: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			compact: async () => {},
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {
				calls.push("reload");
			},
			refreshSkills: async () => {
				calls.push("refreshSkills");
			},
		};

		runner.initialize(actions, contextActions, commandActions);
		await runner.createCommandContext().refreshSkills();

		expect(calls).toEqual(["refreshSkills"]);
	});
});
