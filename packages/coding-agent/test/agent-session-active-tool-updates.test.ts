/**
 * Focus rebuilds replay `AgentSession.activeToolExecutionUpdates()` to restore a
 * live task board (#10446). Snapshots stay cached until the overall call ends:
 * mixed blocking+async calls can report a settled async subset while blocking
 * work continues, while an already-returned background call uses that same
 * settled update as its terminal frame. Logical session transitions must clear
 * every snapshot.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentEvent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function taskUpdate(state: "running" | "completed" | "failed", toolCallId = "task-1"): AgentEvent {
	return {
		type: "tool_execution_update",
		toolCallId,
		toolName: "task",
		args: {},
		partialResult: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 5,
				progress: [],
				async: { state, jobId: "job-1", type: "task" },
			},
		},
	} satisfies AgentEvent;
}

function taskEnd(state: "running" | "completed" | "failed", toolCallId = "task-1"): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "task",
		result: {
			content: [{ type: "text", text: `Task ${state}` }],
			details: { async: { state, jobId: "job-1", type: "task" } },
		},
	} satisfies AgentEvent;
}

describe("AgentSession.activeToolExecutionUpdates cache lifecycle", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function makeSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
	}

	it("retains a settled async subset until its mixed task call ends", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running"));
		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);

		session.agent.emitExternalEvent(taskEnd("completed"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);
	});

	it("retains a terminal background snapshot after the original task call returned", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskEnd("running"));
		session.agent.emitExternalEvent(taskUpdate("completed"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["task-1"]);
	});

	it("clears snapshots across a new session", async () => {
		session = await makeSession();

		session.agent.emitExternalEvent(taskUpdate("running", "cached-call"));
		session.agent.emitExternalEvent(taskEnd("running", "returned-call"));
		expect(session.activeToolExecutionUpdates()).toHaveLength(1);

		expect(await session.newSession()).toBe(true);
		expect(session.activeToolExecutionUpdates()).toHaveLength(0);

		session.agent.emitExternalEvent(taskUpdate("completed", "returned-call"));
		expect(session.activeToolExecutionUpdates().map(event => event.toolCallId)).toEqual(["returned-call"]);
	});
});
