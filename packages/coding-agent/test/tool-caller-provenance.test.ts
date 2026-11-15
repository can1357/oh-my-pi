import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolCaller } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { ToolContextStore, type ToolBaseContext } from "../src/tools/context";

const baseContext = (): ToolBaseContext => ({}) as ToolBaseContext;

describe("tool caller provenance", () => {
	it("omits model role for a main session without an authoritative role", () => {
		expect(new ToolContextStore(baseContext, undefined, { agentId: "Main" }).getContext().caller).toEqual({
			agentId: "Main",
		});
	});

	it("passes a stable agent and model-role snapshot to tool adapters", () => {
		const caller = { agentId: "Worker-1", modelRole: "task" };
		const store = new ToolContextStore(baseContext, undefined, caller);
		caller.agentId = "changed";

		expect(store.getContext().caller).toEqual({ agentId: "Worker-1", modelRole: "task" });
		expect(Object.isFrozen(store.getContext().caller)).toBe(true);
	});

	it("does not let base tool context spoof host-owned caller provenance", () => {
		const store = new ToolContextStore(
			() => ({ caller: { agentId: "spoofed", modelRole: "slow" } }) as unknown as ToolBaseContext,
			undefined,
			{ agentId: "Worker-1", modelRole: "task" },
		);

		expect(store.getContext().caller).toEqual({ agentId: "Worker-1", modelRole: "task" });
	});

	it("omits malformed blank provenance instead of exposing an empty identity", () => {
		const store = new ToolContextStore(baseContext, undefined, { agentId: "  ", modelRole: "\t" });

		expect(store.getContext().caller).toBeUndefined();
	});

	it("omits non-string provenance from JavaScript callers", () => {
		const store = new ToolContextStore(baseContext, undefined, {
			agentId: 42,
			modelRole: {},
		} as unknown as AgentToolCaller);

		expect(store.getContext().caller).toBeUndefined();
	});

	it("delivers nested subagent provenance through the live SDK tool boundary", async () => {
		const root = TempDir.createSync("@pi-tool-caller-");
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
			],
		});
		let caller: AgentToolCaller | undefined;
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Capture execution context",
			parameters: type({}),
			execute: async (_id, _params, _signal, _onUpdate, context) => {
				caller = context?.caller;
				return { content: [{ type: "text", text: "captured" }] };
			},
		};
		const registry = new ModelRegistry(auth);
		try {
			const { session } = await createAgentSession({
				cwd: root.path(),
				agentDir: root.path(),
				sessionManager: SessionManager.inMemory(root.path()),
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"todo.reminders": false,
				}),
				modelRegistry: registry,
				model: mock,
				agentId: "Parent.Child",
				modelRole: "task",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				workspaceTree: {
					rootPath: root.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				toolNames: [],
			});
			try {
				session.agent.setTools([probe]);
				session.agent.streamFn = mock.stream;
				await session.prompt("Run probe.");
			} finally {
				await session.dispose();
			}
		} finally {
			auth.close();
			root.removeSync();
		}

		expect(caller).toEqual({ agentId: "Parent.Child", modelRole: "task" });
	});
});
