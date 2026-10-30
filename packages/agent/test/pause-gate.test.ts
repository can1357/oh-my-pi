import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, AgentPauseGate, agentLoop, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Api, DispatchHold, FetchImpl, Message, Model } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createUserMessage } from "./helpers";

const SOURCE_ID = "pause-gate-test";

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

	// The loop polls the gate before a model call, then resolves the credential,
	// the metadata and the provider-bound context. A pause engaged during any of
	// them used to reach the provider: the main turn installed no dispatch hold.
	it("holds the model call when the pause engages while the credential resolves", async () => {
		const dispatchedWhilePaused: boolean[] = [];
		const api = "pause-gate-main-dispatch" as Api;
		const model = buildModel({
			id: "pause-gate-main",
			name: "Pause Gate Main",
			api,
			provider: "pause-gate-test",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000,
			maxTokens: 100,
		});
		registerCustomApi(
			api,
			() => {
				dispatchedWhilePaused.push(agentPauseGate.paused);
				const events = new AssistantMessageEventStream();
				queueMicrotask(() =>
					events.push({
						type: "done",
						reason: "stop",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							api,
							provider: model.provider,
							model: model.id,
							timestamp: 0,
							stopReason: "stop",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					}),
				);
				return events;
			},
			SOURCE_ID,
		);
		const gateWait = observeGateWait();
		try {
			const run = agentLoop(
				[createUserMessage("hi")],
				{ systemPrompt: ["Test"], messages: [], tools: [] },
				{
					model,
					convertToLlm: identityConverter,
					// The gate closes in the window between the loop's poll and the wire.
					getApiKey: async () => {
						agentPauseGate.pause();
						return "pause-gate-key";
					},
				},
			).result();

			const reached = await Promise.race([
				gateWait.parked.then(() => "parked"),
				run.then(
					() => "dispatched",
					() => "dispatched",
				),
			]);
			expect(reached).toBe("parked");
			expect(dispatchedWhilePaused).toEqual([]);

			agentPauseGate.resume();
			await run;
			expect(dispatchedWhilePaused).toEqual([false]);
		} finally {
			gateWait.restore();
			unregisterCustomApis(SOURCE_ID);
		}
	});
});

/**
 * `AgentPauseGate.dispatchHold` composed with a caller's own hold, at the
 * transport that sends the request. Each test builds its own gate, so none of
 * them touches the process-wide one.
 */
describe("AgentPauseGate.dispatchHold at the wire", () => {
	const endpoint = "https://example.invalid/v1/messages";
	const model = {
		id: "pause-gate-wire",
		name: "Pause Gate Wire",
		api: "pause-gate-wire" as Api,
		provider: "pause-gate-wire",
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;

	function loopTurn(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		return promise;
	}

	/** Whether `pending` was still unsettled after one turn of the event loop. */
	async function heldForATurn(pending: Promise<unknown>): Promise<boolean> {
		const outcome = await Promise.race([
			pending.then(
				() => "settled",
				() => "settled",
			),
			loopTurn().then(() => "held"),
		]);
		return outcome === "held";
	}

	// The gate was checked once, before the caller's hold ran. A pause engaged
	// while that hold waited a whole event-loop turn did not stop the request.
	it("parks a request again when the gate closes while the caller's hold waits", async () => {
		const gate = new AgentPauseGate();
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let asked = 0;
		const sentWhilePaused: boolean[] = [];
		const base = (async () => {
			sentWhilePaused.push(gate.paused);
			return new Response("ok");
		}) satisfies FetchImpl;
		const fetch = transportFetch(
			model,
			base,
			gate.dispatchHold(undefined, () => {
				asked += 1;
				entered.resolve();
				return release.promise;
			}),
		);

		const sent = fetch(endpoint, { method: "POST" });
		await entered.promise;
		gate.pause();
		await loopTurn();
		release.resolve();
		expect(await heldForATurn(sent)).toBe(true);
		expect(sentWhilePaused).toEqual([]);

		gate.resume();
		await sent;
		expect(sentWhilePaused).toEqual([false]);
		// The caller's check runs again after the pause it did not see.
		expect(asked).toBe(2);
	});

	// With two wrapped layers, a later hold that answered asynchronously was
	// confirmed by one more pass, and a pause engaged during that confirming
	// answer still sent: nothing read the gate again before the wire.
	it("reads the gate at the wire, whichever answer of a later hold the pause lands in", async () => {
		const sentWhilePaused: number[] = [];
		const heldAt: number[] = [];
		for (const pauseOnCall of [1, 2, 3]) {
			const gate = new AgentPauseGate();
			let calls = 0;
			const base = (async () => {
				if (gate.paused) sentWhilePaused.push(pauseOnCall);
				return new Response("ok");
			}) satisfies FetchImpl;
			const first = transportFetch(model, base, gate.dispatchHold(), inner => inner);
			const fetch = transportFetch(
				model,
				first,
				async () => {
					calls += 1;
					await Promise.resolve();
					if (calls === pauseOnCall) gate.pause();
				},
				inner => inner,
			);

			const sent = fetch(endpoint, { method: "POST" });
			if (await heldForATurn(sent)) {
				heldAt.push(pauseOnCall);
				gate.resume();
			}
			await sent;
		}

		expect(sentWhilePaused).toEqual([]);
		expect(heldAt).toContain(1);
	});

	// The lifetime given to the hold (a session's disposal) ended only the wait
	// on the gate. Cancelled while the caller's hold waited, the request stayed
	// parked and was sent when that hold resolved.
	it("ends the whole wait on its lifetime, the caller's hold included", async () => {
		const gate = new AgentPauseGate();
		const lifetime = new AbortController();
		const entered = Promise.withResolvers<void>(),
			shared = Promise.withResolvers<void>();
		const next = () => {
			entered.resolve();
			return shared.promise;
		};
		let wires = 0;
		const base = (async () => {
			wires += 1;
			return new Response("ok");
		}) satisfies FetchImpl;
		const owned = transportFetch(
			model,
			base,
			gate.dispatchHold(lifetime.signal, next),
		)(endpoint, {
			method: "POST",
		}).then(
			() => "sent",
			(error: unknown) => error,
		);
		// A sibling waiting on the same caller's hold under no lifetime.
		const sibling = transportFetch(model, base, gate.dispatchHold(undefined, next))(endpoint, { method: "POST" });

		await entered.promise;
		const reason = new Error("session disposed");
		lifetime.abort(reason);
		expect(await Promise.race([owned, loopTurn().then(() => "still parked")])).toBe(reason);
		expect(wires).toBe(0);

		shared.resolve();
		await sibling;
		expect(wires).toBe(1);
	});

	it("reads the gate, its lifetime and the caller's probe in its own probe", async () => {
		const gate = new AgentPauseGate();
		const lifetime = new AbortController();
		let callerClosed = false;
		const reopened = Promise.withResolvers<void>();
		const next: DispatchHold = () => (callerClosed ? reopened.promise : undefined);
		next.isClosed = () => callerClosed;
		const hold = gate.dispatchHold(lifetime.signal, next);

		expect(hold.isClosed?.()).toBe(false);
		gate.pause();
		expect(hold.isClosed?.()).toBe(true);
		gate.resume();
		callerClosed = true;
		expect(hold.isClosed?.()).toBe(true);
		callerClosed = false;
		expect(hold.isClosed?.()).toBe(false);

		// Once its lifetime has ended the hold is closed for good, and asking
		// it fails with that reason rather than answering open.
		const reason = new Error("owner gone");
		lifetime.abort(reason);
		expect(hold.isClosed?.()).toBe(true);
		await expect(Promise.resolve(hold())).rejects.toBe(reason);
	});
});
