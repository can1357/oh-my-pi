import { expect, test } from "bun:test";
import {
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcUserInputGate,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function deps(handleCommand: RpcInputFrameDeps["handleCommand"]): RpcInputFrameDeps {
	return {
		handleCommand,
		output: () => {},
		errorResponse: (id, command, message) => ({ id, type: "response", command, success: false, error: message }),
		pendingExtensionRequests: new Map(),
		onHostToolResult: () => {},
		onHostToolUpdate: () => {},
		onHostUriResult: () => {},
	};
}

test("an abort accepted while an earlier frame is blocked invalidates a prompt accepted before it", async () => {
	const gate = new RpcUserInputGate();
	const blocked = Promise.withResolvers<void>();
	const steer = { id: "steer", type: "steer", message: "hook" } as const;
	const prompt = { id: "prompt", type: "prompt", message: "X" } as const;
	gate.accept(steer);
	const steerDone = gate.enqueue(() => blocked.promise);
	gate.accept(prompt);
	gate.accept({ id: "abort", type: "abort" });

	expect(gate.isCurrent(prompt)).toBe(false);
	expect(gate.isCurrent(steer)).toBe(false);

	blocked.resolve();
	await steerDone;
});

test("a prompt accepted after abort stays current", () => {
	const gate = new RpcUserInputGate();
	gate.accept({ type: "abort" });
	const prompt = { type: "prompt", message: "after" } as const;
	gate.accept(prompt);
	expect(gate.isCurrent(prompt)).toBe(true);
});

test("later input does not start until the earlier submission's work settles", async () => {
	const gate = new RpcUserInputGate();
	const release = Promise.withResolvers<void>();
	let secondStarted = false;
	const first = gate.enqueue(() => release.promise);
	const second = gate.enqueue(async () => {
		secondStarted = true;
	});
	await flush();
	expect(secondStarted).toBe(false);
	release.resolve();
	await first;
	await second;
	expect(secondStarted).toBe(true);
});

test("dispatch captures the frame before its handler runs, including while an earlier command is blocked", async () => {
	const accepted: string[] = [];
	const started: string[] = [];
	const release = Promise.withResolvers<void>();
	const dispatcher = new RpcInputDispatcher({
		deps: deps(async command => {
			started.push(command.type);
			if (command.type === "set_model") await release.promise;
			return { id: command.id, type: "response", command: command.type, success: true } as RpcResponse;
		}),
		acceptInput: (command: RpcCommand) => accepted.push(command.type),
	});

	dispatcher.dispatch({ id: "s", type: "set_model", provider: "mock", model: "mock" });
	dispatcher.dispatch({ id: "p", type: "prompt", message: "X" });
	dispatcher.dispatch({ id: "a", type: "abort" });
	await flush();

	expect(accepted).toEqual(["set_model", "prompt", "abort"]);
	expect(started).toEqual(["set_model"]);

	release.resolve();
	await dispatcher.drain();
	expect(started).toEqual(["set_model", "prompt", "abort"]);
});

test("abort starts immediately and is not stuck behind steer waiting on an admitting prompt", async () => {
	const gate = new RpcUserInputGate();
	const visionDescription = Promise.withResolvers<void>();
	const abortReceived = Promise.withResolvers<void>();
	const executionOrder: string[] = [];

	const dispatcher = new RpcInputDispatcher({
		deps: deps(async command => {
			if (command.type === "prompt") {
				await gate.enqueue(async () => {
					executionOrder.push("prompt-start");
					await visionDescription.promise;
					executionOrder.push("prompt-admitted");
				});
				return { id: command.id, type: "response", command: "prompt", success: true } as RpcResponse;
			}
			if (command.type === "steer") {
				await gate.enqueue(async () => {
					executionOrder.push("steer");
				});
				return { id: command.id, type: "response", command: "steer", success: true } as RpcResponse;
			}
			if (command.type === "abort") {
				executionOrder.push("abort");
				abortReceived.resolve();
				// Abort cuts the vision description short:
				visionDescription.resolve();
				return { id: command.id, type: "response", command: "abort", success: true } as RpcResponse;
			}
			throw new Error(`unexpected command ${command.type}`);
		}),
		acceptInput: command => gate.accept(command),
	});

	// Sequence: prompt (vision description running) -> steer -> abort
	dispatcher.dispatch({ id: "p", type: "prompt", message: "image prompt" });
	dispatcher.dispatch({ id: "s", type: "steer", message: "steering note" });
	dispatcher.dispatch({ id: "a", type: "abort" });

	// Abort must run and resolve visionDescription without waiting for the prompt to admit on its own
	await abortReceived.promise;
	expect(executionOrder[0]).toBe("prompt-start");
	expect(executionOrder).toContain("abort");

	await dispatcher.drain();
	expect(executionOrder).toEqual(["prompt-start", "abort", "prompt-admitted", "steer"]);
});

test("untrusted command types like constructor do not invalidate accepted input", () => {
	const gate = new RpcUserInputGate();
	const prompt = { id: "p", type: "prompt", message: "test" } as const;
	gate.accept(prompt);
	expect(gate.isCurrent(prompt)).toBe(true);

	gate.accept({ type: "constructor" } as unknown as RpcCommand);
	expect(gate.isCurrent(prompt)).toBe(true);
	expect(gate.isCurrent({ type: "constructor" } as unknown as RpcCommand)).toBe(false);
});

test("a session change invalidates earlier input only once it commits, never input pipelined after it", () => {
	const gate = new RpcUserInputGate();
	const before = { id: "before", type: "prompt", message: "before" } as const;
	const change = { id: "change", type: "new_session" } as const;
	const after = { id: "after", type: "prompt", message: "after" } as const;
	gate.accept(before);
	gate.accept(change);
	gate.accept(after);
	// Accepted but not yet committed (or vetoed): nothing is invalidated.
	expect(gate.isCurrent(before)).toBe(true);
	expect(gate.isCurrent(after)).toBe(true);

	gate.commitSessionChange(change);
	expect(gate.isCurrent(before)).toBe(false);
	expect(gate.isCurrent(after)).toBe(true);
});

test("an abort accepted after a session change keeps its own boundary when the change commits", () => {
	const gate = new RpcUserInputGate();
	const change = { id: "change", type: "switch_session", sessionPath: "/tmp/other.jsonl" } as const;
	const between = { id: "between", type: "steer", message: "between" } as const;
	gate.accept(change);
	gate.accept(between);
	gate.accept({ id: "abort", type: "abort" });
	const after = { id: "after", type: "prompt", message: "after" } as const;
	gate.accept(after);

	gate.commitSessionChange(change);
	expect(gate.isCurrent(between)).toBe(false);
	expect(gate.isCurrent(after)).toBe(true);
});
