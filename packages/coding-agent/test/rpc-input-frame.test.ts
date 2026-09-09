import { describe, expect, test } from "bun:test";
import { RpcHostToolBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-tools";
import {
	dispatchRpcInputFrame,
	type PendingExtensionRequest,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcPendingExtensionRequests,
	RpcShutdownCoordinator,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type OutputFrame = RpcResponse | object;

const makeDeps = (
	handleCommand: RpcInputFrameDeps["handleCommand"],
	options?: { pendingExtensionRequests?: Map<string, PendingExtensionRequest> },
) => {
	const outputs: OutputFrame[] = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: obj => {
			outputs.push(obj as OutputFrame);
		},
		errorResponse: (id, command, message) => ({
			id,
			type: "response",
			command,
			success: false,
			error: message,
		}),
		pendingExtensionRequests: options?.pendingExtensionRequests ?? new Map<string, PendingExtensionRequest>(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
	return { deps, outputs };
};

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

const requestExtensionInput = (deps: RpcInputFrameDeps, id: string, message: string) => {
	const response = Promise.withResolvers<RpcExtensionUIResponse>();
	deps.pendingExtensionRequests.set(id, {
		resolve: response.resolve,
		reject: error => response.reject(error),
	});
	deps.output({
		type: "extension_ui_request",
		id,
		method: "input",
		message,
	});
	return response.promise;
};

const cancelledBashResponse = (id: string): RpcResponse => ({
	id,
	type: "response",
	command: "bash",
	success: true,
	data: {
		output: "",
		exitCode: -1,
		cancelled: true,
		truncated: false,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
	},
});

describe("dispatchRpcInputFrame", () => {
	test("bash is dispatched in the background so abort_bash preempts it (issue #4079 A)", async () => {
		const { promise: bashPending, resolve: resolveBash } = Promise.withResolvers<RpcResponse>();
		let abortBashCalled = false;

		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "bash") {
				// Block until abort_bash resolves the shared promise.
				return await bashPending;
			}
			if (command.type === "abort_bash") {
				abortBashCalled = true;
				// Emulate `session.abortBash()` cancelling the in-flight bash so
				// the queued executeBash promise resolves with cancelled=true.
				resolveBash(cancelledBashResponse("b1"));
				return { id: command.id, type: "response", command: "abort_bash", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		// Kick off bash. If the fix works, dispatchRpcInputFrame returns
		// undefined immediately without waiting for handleCommand.
		const bashAwait = dispatchRpcInputFrame({ id: "b1", type: "bash", command: "sleep 9999" }, deps);
		expect(bashAwait).toBeUndefined();
		await flushMicrotasks();
		expect(outputs).toHaveLength(0);

		// Now dispatch abort_bash. It must run serially (not backgrounded)
		// and resolve after handleCommand completes.
		const abortAwait = dispatchRpcInputFrame({ id: "a1", type: "abort_bash" }, deps);
		expect(abortAwait).toBeInstanceOf(Promise);
		await abortAwait;

		expect(abortBashCalled).toBe(true);
		expect(outputs[0]).toEqual({
			id: "a1",
			type: "response",
			command: "abort_bash",
			success: true,
		});

		// The background bash response arrives after abort_bash.
		await flushMicrotasks();
		expect(outputs).toHaveLength(2);
		const bashFrame = outputs[1] as RpcResponse;
		expect(bashFrame.command).toBe("bash");
		expect(bashFrame.success).toBe(true);
		if (bashFrame.command === "bash" && bashFrame.success) {
			expect(bashFrame.data.cancelled).toBe(true);
			expect(bashFrame.data.exitCode).toBe(-1);
		}
	});

	test("non-bash commands are dispatched serially (ordering preserved)", async () => {
		const started: string[] = [];
		const finished: string[] = [];
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			started.push(command.type);
			finished.push(command.type);
			if (command.type === "abort_retry") {
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		const first = dispatchRpcInputFrame({ id: "c1", type: "abort_retry" }, deps);
		expect(first).toBeInstanceOf(Promise);
		// The input loop awaits each command's promise before pulling the next
		// frame; simulate that contract by awaiting before the next dispatch.
		await first;
		expect(outputs).toHaveLength(1);
		expect(started).toEqual(["abort_retry"]);
		expect(finished).toEqual(["abort_retry"]);

		const second = dispatchRpcInputFrame({ id: "c2", type: "set_auto_retry", enabled: true }, deps);
		await second;
		expect(outputs).toHaveLength(2);
		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
	});

	test("bash handler errors surface as an error response on the background frame", async () => {
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "bash") throw new Error("kaboom");
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		const awaited = dispatchRpcInputFrame({ id: "b2", type: "bash", command: "echo hi" }, deps);
		expect(awaited).toBeUndefined();

		// Give the background dispatch a chance to run its catch.
		await flushMicrotasks();
		await flushMicrotasks();

		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toEqual({
			id: "b2",
			type: "response",
			command: "bash",
			success: false,
			error: "kaboom",
		});
	});

	test("background bash task is exposed so EOF cleanup can await its response", async () => {
		const bashResponse: RpcResponse = {
			id: "b3",
			type: "response",
			command: "bash",
			success: true,
			data: {
				output: "done",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 1,
				totalBytes: 4,
				outputLines: 1,
				outputBytes: 4,
			},
		};
		const { promise: bashPending, resolve: resolveBash } = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "bash") return await bashPending;
			throw new Error(`unexpected: ${command.type}`);
		});
		let trackedTask: Promise<void> | undefined;
		deps.trackBackgroundTask = task => {
			trackedTask = task;
		};

		const awaited = dispatchRpcInputFrame({ id: "b3", type: "bash", command: "echo done" }, deps);
		expect(awaited).toBeUndefined();
		expect(trackedTask).toBeInstanceOf(Promise);
		expect(outputs).toHaveLength(0);

		resolveBash(bashResponse);
		await trackedTask;

		expect(outputs).toEqual([bashResponse]);
	});
});

describe("RpcInputDispatcher", () => {
	test("control frames resolve extension UI requests while an ordinary command is active", async () => {
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
			const response = await requestExtensionInput(depsRef, "ui-active", "Continue?");
			return {
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: "value" in response && response.value === "continue" },
			};
		});
		const depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "prompt-1", type: "prompt", message: "ask extension" });
		await flushMicrotasks();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
		]);

		dispatcher.dispatch({ type: "extension_ui_response", id: "ui-active", value: "continue" });
		await dispatcher.drain();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
			{
				id: "prompt-1",
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			},
		]);
	});

	test("malformed frames emit a parse error without ending the input reader", () => {
		const { deps, outputs } = makeDeps(async command => ({
			id: command.id,
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		}));
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch(null);

		expect(outputs).toEqual([
			expect.objectContaining({
				type: "response",
				command: "parse",
				success: false,
				error: expect.stringContaining("Failed to parse command:"),
			}),
		]);
	});

	test("ordinary commands stay serialized while first command is blocked", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") {
				await releaseFirst.promise;
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "get_state") {
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: {
						thinkingLevel: undefined,
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						interruptMode: "immediate",
						sessionId: "session-1",
						autoCompactionEnabled: false,
						fastModeEnabled: false,
						fastModeActive: false,
						tokensPerSecond: null,
						messageCount: 0,
						queuedMessageCount: 0,
						todoPhases: [],
					},
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "first", type: "abort_retry" });
		dispatcher.dispatch({ id: "second", type: "get_state" });
		await flushMicrotasks();

		expect(started).toEqual(["abort_retry"]);
		expect(outputs).toHaveLength(0);

		releaseFirst.resolve();
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "get_state"]);
		expect((outputs[0] as RpcResponse).id).toBe("first");
		expect((outputs[1] as RpcResponse).id).toBe("second");
		expect((outputs[1] as RpcResponse).command).toBe("get_state");
	});

	test("serial command rejection emits an error response and does not poison the queue", async () => {
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") throw new Error("retry controller exploded");
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "bad", type: "abort_retry" });
		dispatcher.dispatch({ id: "next", type: "set_auto_retry", enabled: true });
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
		expect(outputs).toEqual([
			{
				id: "bad",
				type: "response",
				command: "abort_retry",
				success: false,
				error: "retry controller exploded",
			},
			{
				id: "next",
				type: "response",
				command: "set_auto_retry",
				success: true,
			},
		]);
	});

	test("drain after EOF rejects active and queued host tool requests without emitting new calls", async () => {
		const disconnectMessage = "RPC client disconnected before host tool execution completed";
		const hostToolFrames: Array<RpcHostToolCallRequest | RpcHostToolCancelRequest> = [];
		const bridge = new RpcHostToolBridge(frame => {
			hostToolFrames.push(frame);
		});
		const [tool] = bridge.setTools([
			{
				name: "host_wait",
				description: "Waits for host process",
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		]);
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
			started.push(command.id ?? "");
			await tool.execute(`toolu_${command.id}`, {});
			return {
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			};
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "prompt", message: "active host tool" });
		dispatcher.dispatch({ id: "queued", type: "prompt", message: "queued host tool" });
		await flushMicrotasks();

		expect(started).toEqual(["active"]);
		expect(hostToolFrames).toHaveLength(1);
		expect(hostToolFrames[0]).toMatchObject({
			type: "host_tool_call",
			toolCallId: "toolu_active",
			toolName: "host_wait",
			arguments: {},
		});

		bridge.close(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(hostToolFrames).toHaveLength(1);
		expect(outputs).toEqual([
			{
				id: "active",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
			{
				id: "queued",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
		]);
	});

	test("drain after EOF rejects active and future extension UI requests", async () => {
		const disconnectMessage = "RPC client disconnected before extension UI response completed";
		const pendingExtensionRequests = new RpcPendingExtensionRequests();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(
			async command => {
				if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
				started.push(command.id ?? "");
				await requestExtensionInput(depsRef, `${command.id}-dialog`, command.message);
				return {
					id: command.id,
					type: "response",
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				};
			},
			{ pendingExtensionRequests },
		);
		const depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "prompt", message: "active dialog" });
		dispatcher.dispatch({ id: "queued", type: "prompt", message: "queued dialog" });
		await flushMicrotasks();

		expect(started).toEqual(["active"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
		]);

		pendingExtensionRequests.rejectAll(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
			{
				id: "active",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
			{
				type: "extension_ui_request",
				id: "queued-dialog",
				method: "input",
				message: "queued dialog",
			},
			{
				id: "queued",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
		]);
	});
});

describe("RpcShutdownCoordinator", () => {
	/** performShutdown spy that records call count and outputs.length at the moment it ran. */
	const makeShutdownRecorder = (outputs: OutputFrame[]) => {
		const state = { calls: 0, outputsAtShutdown: -1 };
		const performShutdown = async () => {
			state.calls++;
			state.outputsAtShutdown = outputs.length;
		};
		return { state, performShutdown };
	};

	/**
	 * Full production-shaped harness: a background-dispatched bash frame whose
	 * handler blocks on a gate, tracked by the coordinator exactly as
	 * `runRpcMode` wires it (`trackBackgroundTask: task => coordinator.track(task)`).
	 */
	const makeBashHarness = () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "bash") return await gate.promise;
			throw new Error(`unexpected: ${command.type}`);
		});
		const shutdown = { requested: false };
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => shutdown.requested,
			performShutdown: recorder.performShutdown,
		});
		deps.trackBackgroundTask = task => coordinator.track(task);
		return { gate, deps, outputs, shutdown, recorder, coordinator };
	};

	test("deferred shutdown drains an in-flight background bash before performShutdown", async () => {
		const { gate, deps, outputs, shutdown, recorder, coordinator } = makeBashHarness();

		const awaited = dispatchRpcInputFrame({ id: "s1", type: "bash", command: "sleep 9999" }, deps);
		expect(awaited).toBeUndefined();

		// Extension calls pi.shutdown() while bash is in flight; the input loop
		// re-checks after its next serially-awaited frame.
		shutdown.requested = true;
		const check = coordinator.checkShutdownRequested();

		// The check must stay pending while the background bash still owes its
		// response frame. Race it against a flushed sentinel: if the check could
		// resolve, its microtask would win before the setImmediate tick.
		const winner = await Promise.race([check.then(() => "shutdown"), flushMicrotasks().then(() => "pending")]);
		expect(winner).toBe("pending");
		expect(recorder.state.calls).toBe(0);
		expect(outputs).toHaveLength(0);

		gate.resolve(cancelledBashResponse("s1"));
		await check;

		expect(outputs).toEqual([cancelledBashResponse("s1")]);
		expect(recorder.state.calls).toBe(1);
		// The bash response frame was already written when performShutdown ran.
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("settle hook fires the deferred shutdown when no further client frames arrive", async () => {
		const { gate, deps, outputs, shutdown, recorder } = makeBashHarness();

		const awaited = dispatchRpcInputFrame({ id: "s2", type: "bash", command: "sleep 9999" }, deps);
		expect(awaited).toBeUndefined();

		// Shutdown requested mid-bash; the stdin loop is parked with no frames,
		// so the test never calls checkShutdownRequested() — only track()'s
		// settle hook can trigger it.
		shutdown.requested = true;
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);

		gate.resolve(cancelledBashResponse("s2"));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		expect(outputs).toEqual([cancelledBashResponse("s2")]);
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("concurrent triggers are latched: performShutdown runs exactly once", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: recorder.performShutdown,
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		coordinator.track(gateB.promise);

		// Explicit trigger (input loop) races the settle hooks of both tasks.
		const check = coordinator.checkShutdownRequested();
		gateA.resolve();
		gateB.resolve();
		await check;
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		// A later re-check reuses the latched sequence instead of re-running it.
		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(1);
	});

	test("no-op when shutdown was not requested", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: recorder.performShutdown,
		});

		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(0);

		// A tracked task settling with the flag false never triggers shutdown.
		const gate = Promise.withResolvers<void>();
		coordinator.track(gate.promise);
		gate.resolve();
		await flushMicrotasks();
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);
	});

	test("drain() waits for tasks tracked while draining", async () => {
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: async () => {},
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		// When A settles, a new task B enters the set mid-drain.
		void gateA.promise.then(() => {
			coordinator.track(gateB.promise);
		});

		let drained = false;
		const drain = coordinator.drain().then(() => {
			drained = true;
		});

		gateA.resolve();
		await flushMicrotasks();
		// A settled and B was tracked mid-drain; drain must keep waiting on B.
		expect(drained).toBe(false);

		gateB.resolve();
		await drain;
		expect(drained).toBe(true);
	});
});
