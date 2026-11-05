import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { createSessionDefaults } from "../helpers/session-defaults";

/** A subagent session on the executor's own journal that yields on its first prompt. */
function yieldingSession(sessionManager: SessionManager): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const session = {
		...createSessionDefaults(),
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "yield-call",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: true } },
					},
					isError: false,
				});
			}
			return true;
		},
	};
	return session as unknown as AgentSession;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("subagent label usage", () => {
	it("journals the billed label request on the subagent session", async () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!model) throw new Error("Expected claude-haiku-4-5 model to exist");
		const labelResponse = createAssistantMessage("<title>Audit shutdown ordering</title>");
		labelResponse.usage.cost.total = 0.004;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(labelResponse);
		let subagentManager: SessionManager | undefined;
		const recorded = Promise.withResolvers<void>();
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const manager = options?.sessionManager;
			if (!manager) throw new Error("Expected the executor to supply the subagent journal");
			subagentManager = manager;
			const append = manager.appendModelUsage.bind(manager);
			vi.spyOn(manager, "appendModelUsage").mockImplementation((usage, owner) => {
				const id = append(usage, owner);
				recorded.resolve();
				return id;
			});
			return {
				session: yieldingSession(manager),
				extensionsResult: { extensions: [], errors: [], runtime: {} },
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "Audit the shutdown ordering",
			assignment: "Audit the shutdown ordering in the session teardown path",
			index: 0,
			id: "LabelUsage",
			settings: Settings.isolated({ modelRoles: { tiny: `${model.provider}/${model.id}` } }),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [model],
				getApiKey: async () => "test-key",
				resolver: () => async () => "test-key",
			} as unknown as ModelRegistry,
			enableLsp: false,
		});
		await recorded.promise;

		expect(result.exitCode).toBe(0);
		const usage = subagentManager?.getEntries().filter(entry => entry.type === "model_usage");
		expect(usage).toMatchObject([{ purpose: "task-label", usage: { cost: { total: 0.004 } } }]);
	});
});
