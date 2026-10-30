import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, agentLoop, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

// Queued input the loop has dequeued for its next turn is still the queue's until a turn that can
// answer it opens. When an abort is what ends a pause, nothing answers that input, so it must go
// back to its queue rather than into the transcript ahead of an aborted turn.

interface PauseParks {
	/** Resolves when a loop next parks on the gate; call it before the step that parks. */
	next(): Promise<void>;
	restore(): void;
}

// A manual patch rather than vi.spyOn, so a sibling file's restoreAllMocks cannot remove it.
function watchPauseParks(): PauseParks {
	const originalWait = agentPauseGate.waitUntilResumed;
	let park = Promise.withResolvers<void>();
	agentPauseGate.waitUntilResumed = (signal?: AbortSignal) => {
		park.resolve();
		return originalWait.call(agentPauseGate, signal);
	};
	return {
		next() {
			park = Promise.withResolvers<void>();
			return park.promise;
		},
		restore() {
			agentPauseGate.waitUntilResumed = originalWait;
		},
	};
}

function makeTool(execute: () => void): AgentTool {
	const toolSchema = type({ msg: "string" });
	const tool: AgentTool<typeof toolSchema, { msg: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a message back",
		parameters: toolSchema,
		async execute(_toolCallId, params) {
			execute();
			return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
		},
	};
	return tool as AgentTool;
}

/** A first response that stays in flight until the test releases it. */
function heldFirstResponse() {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	return {
		started: started.promise,
		release: () => release.resolve(),
		respond: async () => {
			started.resolve();
			await release.promise;
			return { content: ["first response"] };
		},
	};
}

function lastUserText(messages: readonly Message[]): unknown {
	return messages.findLast(message => message.role === "user")?.content;
}

describe("queued input drained before a paused turn", () => {
	let parks: PauseParks;
	beforeEach(() => {
		parks = watchPauseParks();
	});
	afterEach(() => {
		parks.restore();
		// The gate is process-global: never leak an engaged pause into other files.
		agentPauseGate.resume();
	});

	it("returns steering drained at a paused stop boundary to the queue when the run aborts", async () => {
		const first = heldFirstResponse();
		const wire: boolean[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					wire.push(agentPauseGate.paused);
					return first.respond();
				},
				() => {
					wire.push(agentPauseGate.paused);
					return { content: ["steering response"] };
				},
			],
		});
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		const steering = createUserMessage("queued task");

		const run = agent.prompt("initial request");
		await first.started;
		agentPauseGate.pause();
		agent.steer(steering);
		const parked = parks.next();
		first.release();
		await parked;
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([steering]);

		agent.abort();
		await run;
		expect(agent.peekSteeringQueue()).toEqual([steering]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		// The run ends as it would have had the abort come before the drain: no steering and no
		// empty aborted turn in the transcript.
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(wire).toEqual([false]);

		// The queue still delivers it once the pause lifts.
		agentPauseGate.resume();
		await agent.continue();
		expect(wire).toEqual([false, false]);
		expect(lastUserText(mock.calls[1]!.context.messages)).toBe("queued task");
		expect(agent.state.messages.slice(2)).toMatchObject([
			{ role: "user", content: "queued task" },
			{ role: "assistant", stopReason: "stop" },
		]);
	});

	it("delivers steering drained at a paused stop boundary after resume", async () => {
		const first = heldFirstResponse();
		const wire: boolean[] = [];
		const mock = createMockModel({
			responses: [
				async () => {
					wire.push(agentPauseGate.paused);
					return first.respond();
				},
				() => {
					wire.push(agentPauseGate.paused);
					return { content: ["steering response"] };
				},
			],
		});
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		const steering = createUserMessage("queued task");

		const run = agent.prompt("initial request");
		await first.started;
		agentPauseGate.pause();
		agent.steer(steering);
		const parked = parks.next();
		first.release();
		await parked;
		agentPauseGate.resume();
		await run;

		expect(wire).toEqual([false, false]);
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		expect(agent.state.messages.slice(2)).toMatchObject([
			{ role: "user", content: "queued task" },
			{ role: "assistant", stopReason: "stop" },
		]);
	});

	it("returns steering drained after a tool batch and still records the interrupted work turn", async () => {
		const steering = createUserMessage("queued task");
		// The tool steers the agent that owns it, so it reaches the agent through
		// a holder the constructor call fills in.
		const owner: { agent?: Agent } = {};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "echo", arguments: { msg: "work" } }] },
				{ content: ["steering response"] },
			],
		});
		const tool = makeTool(() => {
			agentPauseGate.pause();
			owner.agent?.steer(steering);
		});
		const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
		owner.agent = agent;

		const parked = parks.next();
		const run = agent.prompt("initial request");
		await parked;
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([steering]);

		agent.abort();
		await run;
		expect(agent.peekSteeringQueue()).toEqual([steering]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		// The tool results still owed a model call, so that call ends aborted, without the steering.
		expect(agent.state.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		// Whether the aborted call enters the transport is an implementation detail; it never
		// carries the steering.
		const sent = mock.calls.flatMap(call => call.context.messages);
		expect(sent.some(message => message.role === "user" && message.content === "queued task")).toBe(false);
	});

	it("returns steering a continuation dequeued while paused when the run aborts", async () => {
		const mock = createMockModel({
			responses: [{ content: ["first response"] }, { content: ["steering response"] }],
		});
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		const steering = createUserMessage("queued task");
		await agent.prompt("initial request");

		agentPauseGate.pause();
		agent.steer(steering);
		const parked = parks.next();
		const run = agent.continue();
		await parked;
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([steering]);

		agent.abort();
		await run;
		expect(agent.peekSteeringQueue()).toEqual([steering]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(mock.calls).toHaveLength(1);

		agentPauseGate.resume();
		await agent.continue();
		expect(lastUserText(mock.calls[1]!.context.messages)).toBe("queued task");
		expect(agent.state.messages.slice(2)).toMatchObject([
			{ role: "user", content: "queued task" },
			{ role: "assistant", stopReason: "stop" },
		]);
	});

	it("returns a follow-up a continuation dequeued while paused when the run aborts", async () => {
		const mock = createMockModel({
			responses: [{ content: ["first response"] }, { content: ["follow-up response"] }],
		});
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		const followUp = createUserMessage("follow-up task");
		await agent.prompt("initial request");

		agentPauseGate.pause();
		agent.followUp(followUp);
		const parked = parks.next();
		const run = agent.continue();
		await parked;

		agent.abort();
		await run;
		expect(agent.peekFollowUpQueue()).toEqual([followUp]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(mock.calls).toHaveLength(1);
	});

	it("returns a follow-up drained at a paused yield point to its queue when the run aborts", async () => {
		const first = heldFirstResponse();
		const mock = createMockModel({ responses: [first.respond, { content: ["follow-up response"] }] });
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		const followUp = createUserMessage("follow-up task");

		const run = agent.prompt("initial request");
		await first.started;
		agentPauseGate.pause();
		agent.followUp(followUp);
		const parked = parks.next();
		first.release();
		await parked;
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([followUp]);

		agent.abort();
		await run;
		expect(agent.peekFollowUpQueue()).toEqual([followUp]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(mock.calls).toHaveLength(1);
	});

	it("returns drained steering when the pause engages during model-call preparation", async () => {
		const first = heldFirstResponse();
		const mock = createMockModel({ responses: [first.respond, { content: ["steering response"] }] });
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		let preparations = 0;
		agent.setBeforeModelCall(async () => {
			preparations++;
			if (preparations === 2) agentPauseGate.pause();
		});
		const steering = createUserMessage("queued task");

		const run = agent.prompt("initial request");
		await first.started;
		agent.steer(steering);
		const parked = parks.next();
		first.release();
		await parked;
		expect(preparations).toBe(2);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([steering]);

		agent.abort();
		await run;
		expect(agent.peekSteeringQueue()).toEqual([steering]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(mock.calls).toHaveLength(1);
	});

	it("returns drained steering when the run aborts during model-call preparation", async () => {
		const first = heldFirstResponse();
		const mock = createMockModel({ responses: [first.respond, { content: ["steering response"] }] });
		const agent = new Agent({ initialState: { model: mock.model }, streamFn: mock.stream });
		const preparing = Promise.withResolvers<void>();
		let preparations = 0;
		agent.setBeforeModelCall(async (_context, signal) => {
			preparations++;
			if (preparations !== 2) return;
			// Holds like a hook awaiting slow work, until the run aborts.
			const aborted = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			preparing.resolve();
			await aborted.promise;
		});
		const steering = createUserMessage("queued task");

		const run = agent.prompt("initial request");
		await first.started;
		agent.steer(steering);
		first.release();
		await preparing.promise;
		agent.abort();
		await run;

		expect(agent.peekSteeringQueue()).toEqual([steering]);
		expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(mock.calls).toHaveLength(1);
	});

	it("never records steering its host dequeued when an abort ends the pause", async () => {
		const first = heldFirstResponse();
		const mock = createMockModel({ responses: [first.respond, { content: ["steering response"] }] });
		const steering = createUserMessage("queued task");
		let queued: AgentMessage[] = [];
		const abortController = new AbortController();
		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[createUserMessage("initial request")],
			{ systemPrompt: ["Test"], messages: [], tools: [] },
			{
				model: mock.model,
				convertToLlm: messages => messages as Message[],
				getSteeringMessages: async () => {
					const taken = queued;
					queued = [];
					return taken;
				},
			},
			abortController.signal,
			mock.stream,
		);
		const result = (async () => {
			for await (const event of stream) events.push(event);
			return stream.result();
		})();

		await first.started;
		agentPauseGate.pause();
		queued = [steering];
		const parked = parks.next();
		first.release();
		await parked;
		abortController.abort();
		const messages = await result;

		expect(messages).not.toContain(steering);
		const recorded = events.flatMap(event =>
			event.type === "message_start" || event.type === "message_end" ? [event.message] : [],
		);
		expect(recorded).not.toContain(steering);
		expect(events.at(-1)?.type).toBe("agent_end");
		expect(mock.calls).toHaveLength(1);
	});
});
