import { describe, expect, it, mock } from "bun:test";

import type {
	GatewayCommand,
	GatewayEvent,
	GatewayEventListener,
	GatewaySessionEvent,
} from "@pk-nerdsaver-ai/pi-coding-agent/gateway/types";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";

import type { TaskInput } from "../src/types";
import { PiWorker } from "../src/worker";

class FakeAgentSession {
	readonly abort = mock(async () => {});
	readonly dispose = mock(async () => {});
	bridge: ClientBridge | undefined;

	setClientBridge(bridge: ClientBridge): void {
		this.bridge = bridge;
	}
}

class FakeGateway {
	readonly dispose = mock(() => {});
	readonly commands: GatewayCommand[] = [];
	readonly #listeners: GatewayEventListener[] = [];
	#dispatchError: Error | undefined;

	constructor(
		readonly session: FakeAgentSession,
		dispatchError?: Error,
	) {
		this.#dispatchError = dispatchError;
	}

	async dispatch(command: GatewayCommand): Promise<void> {
		this.commands.push(command);
		const dispatchError = this.#dispatchError;
		if (dispatchError) {
			this.#dispatchError = undefined;
			throw dispatchError;
		}
		if (command.type === "abort") await this.session.abort();
	}

	subscribe(listener: GatewayEventListener): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index >= 0) this.#listeners.splice(index, 1);
		};
	}

	emitSession(event: GatewaySessionEvent): void {
		const gatewayEvent: GatewayEvent = { type: "session_event", event };
		for (const listener of [...this.#listeners]) listener(gatewayEvent);
	}
}

const taskInput: TaskInput = {
	contextPacket: {
		captureId: "capture-1",
		timestamp: "2026-07-10T00:00:00.000Z",
		userRequest: "Inspect the screen",
		captureMode: "screen",
		visual: { displayScale: 1, annotations: [] },
		foregroundApp: {},
		browser: {},
		selection: {},
		availableCapabilities: [],
	},
	routing: {
		executorId: "pi-agent",
		tools: [],
		level: 0,
		message: "Use pi-agent",
	},
};

function createWorker(dispatchError?: Error): { worker: PiWorker; session: FakeAgentSession; gateway: FakeGateway } {
	const session = new FakeAgentSession();
	const gateway = new FakeGateway(session, dispatchError);
	const worker = new PiWorker(async () => ({ session, gateway }));
	return { worker, session, gateway };
}

describe("PiWorker lifecycle", () => {
	it("waits for agent_end instead of completing on an assistant message", async () => {
		const { worker, gateway } = createWorker();
		const handle = await worker.createSession("task-final", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();

		gateway.emitSession({ type: "agent_start" });
		expect(await events.next()).toEqual({ done: false, value: { type: "task.started", taskId: "task-final" } });

		gateway.emitSession({ type: "assistant_end", stopReason: "toolUse", hasError: false });
		gateway.emitSession({ type: "tool_start", toolCallId: "call-1", toolName: "read" });
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "tool.started", callId: "call-1", toolName: "read" },
		});

		gateway.emitSession({ type: "tool_end", toolCallId: "call-1", toolName: "read", isError: false });
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "tool.completed", callId: "call-1", result: null, isError: false },
		});

		gateway.emitSession({ type: "agent_end" });
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.completed", taskId: "task-final", summary: "" },
		});
		expect(await events.next()).toEqual({ done: true, value: undefined });
		expect(() => worker.subscribe(handle.sessionId)).toThrow("Session task-final not found");
	});

	it("settles and disposes once when initial dispatch rejects", async () => {
		const { worker, session, gateway } = createWorker(new Error("dispatch failed"));
		const handle = await worker.createSession("task-dispatch-rejection", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();

		expect(await events.next()).toEqual({
			done: false,
			value: {
				type: "task.failed",
				taskId: "task-dispatch-rejection",
				error: "Failed to start task: dispatch failed",
			},
		});
		expect(await events.next()).toEqual({ done: true, value: undefined });
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(gateway.dispose).toHaveBeenCalledTimes(1);

		gateway.emitSession({ type: "agent_end" });
		await worker.cancel(handle.sessionId);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(gateway.dispose).toHaveBeenCalledTimes(1);
		expect(() => worker.subscribe(handle.sessionId)).toThrow("Session task-dispatch-rejection not found");
	});

	it("keeps approval replies available until final agent settlement", async () => {
		const { worker, session, gateway } = createWorker();
		const handle = await worker.createSession("task-approval", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();
		const approval = session.bridge?.requestPermission?.(
			{ toolCallId: "approval-live", toolName: "write", title: "Write file", rawInput: { path: "result.txt" } },
			[
				{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
				{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
			],
		);
		if (!approval) throw new Error("Permission bridge was not installed");
		expect(await events.next()).toMatchObject({
			done: false,
			value: { type: "approval.requested", request: { scope: "once", level: 1 } },
		});

		await worker.approve(handle.sessionId, "approval-live", { allowed: true, scope: "once" });
		expect(await approval).toEqual({ outcome: "selected", optionId: "allow_once" });
		expect(worker.subscribe(handle.sessionId)).toBeDefined();

		gateway.emitSession({ type: "agent_end" });
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.completed", taskId: "task-approval", summary: "" },
		});
	});

	it("rejects approval edits and unsupported scopes instead of executing original arguments", async () => {
		const { worker } = createWorker();
		const handle = await worker.createSession("task-edited-approval", taskInput);

		await expect(
			worker.approve(handle.sessionId, "approval-edited", {
				allowed: true,
				scope: "once",
				editedArguments: { command: "safe-command" },
			}),
		).rejects.toThrow("Edited approval arguments are not supported");
		await expect(
			worker.approve(handle.sessionId, "approval-group", { allowed: true, scope: "group" }),
		).rejects.toThrow('Approval scope "group" is not supported');
		await worker.cancel(handle.sessionId);
	});

	it("does not dispatch the deferred prompt after immediate cancellation", async () => {
		const { worker, gateway } = createWorker();
		const handle = await worker.createSession("task-immediate-cancel", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();

		await worker.cancel(handle.sessionId);
		await Bun.sleep(0);

		expect(gateway.commands.filter(command => command.type === "prompt")).toHaveLength(0);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.failed", taskId: "task-immediate-cancel", error: "Task cancelled." },
		});
		expect(await events.next()).toEqual({ done: true, value: undefined });
	});

	it("cancels active execution, settles once, and releases the session", async () => {
		const { worker, session } = createWorker();
		const handle = await worker.createSession("task-cancel", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();
		const approval = session.bridge?.requestPermission?.(
			{ toolCallId: "approval-1", toolName: "bash", title: "Run command", rawInput: { command: "sleep" } },
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);
		if (!approval) throw new Error("Permission bridge was not installed");
		expect(await events.next()).toEqual({
			done: false,
			value: {
				type: "approval.requested",
				request: {
					actionId: "approval-1",
					stepId: "approval-1",
					toolName: "bash",
					arguments: { command: "sleep" },
					effects: "Run command",
					level: 1,
					scope: "once",
				},
			},
		});

		await worker.cancel(handle.sessionId);
		expect(await approval).toEqual({ outcome: "cancelled" });
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.failed", taskId: "task-cancel", error: "Task cancelled." },
		});
		expect(await events.next()).toEqual({ done: true, value: undefined });

		await worker.cancel(handle.sessionId);
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(() => worker.subscribe(handle.sessionId)).toThrow("Session task-cancel not found");
	});
});
