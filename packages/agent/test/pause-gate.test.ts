import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentLoop, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function makeEchoTool(executed: string[]): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

function makeConcurrentEchoTool(
	executed: string[],
	beforeExecute: (message: string) => void | Promise<void>,
): AgentTool {
	const toolSchema = type({ msg: "string" });
	const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		concurrency: "shared",
		async execute(_toolCallId, params) {
			await beforeExecute(params.msg);
			executed.push(params.msg);
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return echoTool as AgentTool;
}

const echoCall = (msg: string) => ({ type: "toolCall" as const, name: "echo", arguments: { msg } });
type LoopOptions = Omit<Partial<AgentLoopConfig>, "model" | "convertToLlm">;

function runLoop(mock: MockModel, tools: AgentTool[] = [], options: LoopOptions = {}, signal?: AbortSignal) {
	return agentLoop(
		[createUserMessage("hi")],
		{ systemPrompt: ["Test"], messages: [], tools },
		{ model: mock.model, convertToLlm: identityConverter, ...options },
		signal,
		mock.stream,
	).result();
}

function observeGateWait() {
	const parked = Promise.withResolvers<void>();
	const originalWait = agentPauseGate.waitUntilResumed;
	agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
		parked.resolve();
		return originalWait.call(agentPauseGate, signal);
	};
	return {
		parked: parked.promise,
		restore() {
			agentPauseGate.waitUntilResumed = originalWait;
		},
	};
}

describe("agentPauseGate", () => {
	afterEach(() => {
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	it("holds the next model call while paused and releases it on resume", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		expect(agentPauseGate.pause()).toBe(true);
		expect(agentPauseGate.pause()).toBe(false); // already engaged

		const result = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream).result();
		await parked.promise;
		expect(mock.calls.length).toBe(0); // parked before the first provider call

		try {
			expect(agentPauseGate.resume()).toBeGreaterThanOrEqual(0);
			const messages = await result;
			expect(mock.calls.length).toBe(1);
			expect(messages[messages.length - 1].role).toBe("assistant");
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("holds tool execution at the tool boundary when paused mid-turn", async () => {
		const executed: string[] = [];
		// Signal exactly when the loop parks on the gate. A test-local manual
		// patch (not vi.spyOn) so a sibling file's restoreAllMocks cannot remove
		// it, and a gate regression that never parks hangs this await (test
		// timeout) instead of racing past a vacuous assertion.
		const toolBoundary = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			toolBoundary.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		const mock = createMockModel({
			responses: [
				() => {
					// Engage the gate while the model response is being produced: the
					// turn's tool batch must park before the tool starts.
					agentPauseGate.pause();
					return { content: [{ type: "toolCall" as const, name: "echo", arguments: { msg: "frozen" } }] };
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [makeEchoTool(executed)] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

		try {
			const result = agentLoop([createUserMessage("run echo")], context, config, undefined, mock.stream).result();
			await toolBoundary.promise;
			expect(executed).toEqual([]); // tool parked, not started
			expect(mock.calls.length).toBe(1); // and no follow-up model call either

			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["frozen"]);
			expect(mock.calls.length).toBe(2);
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("lets an external abort unwind a parked run without releasing the gate", async () => {
		const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
		const context: AgentContext = { systemPrompt: ["Test"], messages: [], tools: [] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const abortController = new AbortController();

		const parked = Promise.withResolvers<void>();
		const originalWait = agentPauseGate.waitUntilResumed;
		agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
			parked.resolve();
			return originalWait.call(agentPauseGate, signal);
		};
		agentPauseGate.pause();
		const result = agentLoop(
			[createUserMessage("hi")],
			context,
			config,
			abortController.signal,
			mock.stream,
		).result();
		await parked.promise;
		abortController.abort("user interrupt");

		// The run must terminate as aborted promptly (not stay parked until
		// resume). The provider request itself carries the aborted signal, so
		// whether the transport is entered at all is an implementation detail.
		try {
			const messages = await result;
			const last = messages[messages.length - 1];
			expect(last.role).toBe("assistant");
			if (last.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
			}
			expect(agentPauseGate.paused).toBe(true); // aborting one run never resumes the process
		} finally {
			agentPauseGate.waitUntilResumed = originalWait;
		}
	});

	it("re-parks a waiter when the gate is re-engaged in the same tick as resume", async () => {
		agentPauseGate.pause();
		let released = false;
		const waiter = agentPauseGate.waitUntilResumed().then(() => {
			released = true;
		});

		agentPauseGate.resume();
		agentPauseGate.pause(); // re-engage before the waiter's microtask runs
		await Promise.resolve();
		expect(released).toBe(false);

		agentPauseGate.resume();
		await waiter;
		expect(released).toBe(true);
	});

	it("reports pause state transitions to onChange subscribers", () => {
		const transitions: boolean[] = [];
		const unsubscribe = agentPauseGate.onChange(paused => transitions.push(paused));
		agentPauseGate.pause();
		agentPauseGate.resume();
		unsubscribe();
		agentPauseGate.pause();
		agentPauseGate.resume();
		expect(transitions).toEqual([true, false]);
	});

	it("acknowledges a provider-boundary pause before executing a returned tool", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			resumed = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					started.resolve();
					await release.promise;
					return { content: [echoCall("once")] };
				},
				{ content: ["done"] },
			],
		});
		const result = runLoop(mock, [makeEchoTool(executed)], {
			onPauseChange: value => {
				transitions.push(value);
				if (value) paused.resolve();
				else if (transitions.includes(true)) resumed.resolve();
			},
		});
		let finished = false;
		void result.then(() => {
			finished = true;
		});
		await started.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(executed).toEqual([]);
		expect(mock.calls).toHaveLength(1);
		expect(finished).toBe(false);
		agentPauseGate.resume();
		await result;
		await resumed.promise;
		expect(executed).toEqual(["once"]);
		expect(transitions).toContain(true);
		expect(transitions.at(-1)).toBe(false);
	});

	it("waits for a running parallel tool before acknowledging and releasing the next", async () => {
		const started = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>();
		const transitions: boolean[] = [],
			executed: string[] = [];
		const mock = createMockModel({
			responses: [{ content: [echoCall("first"), echoCall("second")] }, { content: ["done"] }],
		});
		const gateWait = observeGateWait();
		try {
			const result = runLoop(
				mock,
				[
					makeConcurrentEchoTool(executed, async msg => {
						if (msg === "first") {
							agentPauseGate.pause();
							started.resolve();
							await release.promise;
						}
					}),
				],
				{
					onPauseChange: value => {
						transitions.push(value);
						if (value) paused.resolve();
					},
				},
			);
			await started.promise;
			await gateWait.parked;
			expect(transitions).not.toContain(true);
			expect(executed).toEqual([]);
			release.resolve();
			await paused.promise;
			expect(transitions).toContain(true);
			expect(executed).toEqual(["first"]);
			agentPauseGate.resume();
			await result;
			expect(executed).toEqual(["first", "second"]);
			expect(mock.calls).toHaveLength(2);
		} finally {
			gateWait.restore();
		}
	});

	it("pauses after asynchronous beforeModelCall preparation and before the provider call", async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const paused = Promise.withResolvers<void>(),
			mock = createMockModel({ responses: [{ content: ["done"] }] });
		const result = runLoop(mock, [], {
			beforeModelCall: async () => {
				entered.resolve();
				await release.promise;
			},
			onPauseChange: value => {
				if (value) paused.resolve();
			},
		});
		await entered.promise;
		agentPauseGate.pause();
		release.resolve();
		await paused.promise;
		expect(mock.calls).toHaveLength(0);
		agentPauseGate.resume();
		await result;
		expect(mock.calls).toHaveLength(1);
	});

	it("clears Agent pause acknowledgement on re-pause and abort", async () => {
		const gateWait = observeGateWait();
		try {
			const mock = createMockModel({ responses: [{ content: ["never sent"] }] });
			const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
			agentPauseGate.pause();
			const prompt = agent.prompt("hi");
			await gateWait.parked;
			expect(agent.isPaused).toBe(true);
			expect(agent.state.isStreaming).toBe(true);
			agentPauseGate.resume();
			expect(agent.isPaused).toBe(false);
			agentPauseGate.pause();
			expect(agent.isPaused).toBe(true);
			await Promise.resolve();
			expect(agent.isPaused).toBe(true);
			agent.abort();
			expect(agent.isPaused).toBe(false);
			await prompt;
			expect(agent.state.isStreaming).toBe(false);
		} finally {
			gateWait.restore();
		}
	});
});
