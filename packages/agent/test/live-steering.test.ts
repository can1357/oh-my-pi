import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolContext,
	StreamFn,
} from "@oh-my-pi/pi-agent-core/types";
import type { LiveSteering, Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { createUserMessage } from "./helpers";

/** Marks user text so tests can see the provider received the converted view. */
function convertToLlm(messages: AgentMessage[]): Message[] {
	const out: Message[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ ...message, content: `<user>${message.content}</user>` });
		} else if (message.role === "assistant" || message.role === "toolResult") {
			out.push(message);
		} else if (message.role === "custom") {
			out.push({ role: "developer", content: String(message.content), timestamp: message.timestamp });
		}
	}
	return out;
}

function textOf(message: Message): string {
	if (message.role === "assistant") {
		return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

interface SteeredRunOptions {
	/** Steering already queued when the first provider call opens. */
	initialQueue?: AgentMessage[];
	/** First response; later ones are plain text. */
	first?: MockResponse;
	tools?: AgentTool[];
	getToolContext?: AgentLoopConfig["getToolContext"];
}

/**
 * Runs a three-response conversation whose first provider call runs `steer`
 * against the live-steering source it was offered; returns the text of every
 * provider call's context.
 */
async function runSteered(
	steer: (live: LiveSteering, queue: AgentMessage[]) => Promise<void>,
	setup: SteeredRunOptions = {},
): Promise<{ contexts: string[][]; transcript: AgentMessage[]; events: AgentEvent[] }> {
	const queue: AgentMessage[] = [];
	const mock = createMockModel({
		responses: [setup.first ?? { content: ["first"] }, { content: ["second"] }, { content: ["third"] }],
	});
	const contexts: string[][] = [];
	const streamFn: StreamFn = async (model, context, options) => {
		contexts.push(context.messages.map(textOf));
		if (contexts.length === 1) {
			if (!options?.liveSteering) throw new Error("live steering was not offered");
			queue.push(...(setup.initialQueue ?? []));
			await steer(options.liveSteering, queue);
		}
		return mock.stream(model, context, options);
	};
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm,
		getSteeringMessages: async () => queue.splice(0),
		waitForSteeringMessages: async () => {},
		getToolContext: setup.getToolContext,
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: setup.tools ?? [] };
	const run = agentLoop([createUserMessage("start")], context, config, undefined, streamFn);
	const events: AgentEvent[] = [];
	for await (const event of run) events.push(event);
	return { contexts, transcript: await run.result(), events };
}

/**
 * Starts an `Agent` run whose provider stream stays open until aborted and
 * claims one steer live without settling it, as while `response.steer` awaits
 * its acknowledgement; resolves once claimed.
 */
async function startLiveSteeredRun(): Promise<{ agent: Agent; steer: AgentMessage; running: Promise<void> }> {
	const claimed = Promise.withResolvers<void>();
	const agent = new Agent({
		streamFn: async (_model, _context, options) => {
			const live = options?.liveSteering;
			const signal = options?.signal;
			if (!live || !signal) throw new Error("live steering was not offered");
			const stream = new AssistantMessageEventStream();
			signal.addEventListener("abort", () => stream.fail(new Error("aborted")), { once: true });
			await live.wait(signal);
			if (!(await live.claim(signal))) throw new Error("steer was not claimed");
			claimed.resolve();
			return stream;
		},
	});
	const running = agent.prompt("start");
	const steer = createUserMessage("use tabs");
	agent.steer(steer);
	await claimed.promise;
	return { agent, steer, running };
}

/** Transcript user messages the UI marks as delivered live. */
function liveSteeredTexts(transcript: AgentMessage[]): unknown[] {
	const texts: unknown[] = [];
	for (const message of transcript) {
		if (message.role === "user" && message.liveSteered) texts.push(message.content);
	}
	return texts;
}

describe("agent loop live steering", () => {
	it("records accepted steering right after the steered response and holds later input for the next boundary", async () => {
		let claimedView: string[] | undefined;
		const { contexts, transcript } = await runSteered(async (live, queue) => {
			queue.push(createUserMessage("use tabs"));
			const claim = await live.claim(new AbortController().signal);
			claimedView = claim?.messages.map(textOf);
			claim?.accept();
			// Queued after the server took the first steer.
			queue.push(createUserMessage("also lint"));
		});

		// The provider submits the same bytes the transcript later replays.
		expect(claimedView).toEqual(["<user>use tabs</user>"]);
		// The continuation carries only the delivered steering…
		expect(contexts[1]).toEqual(["<user>start</user>", "first", "<user>use tabs</user>"]);
		// …and later input arrives at the following boundary.
		expect(contexts[2]).toEqual([
			"<user>start</user>",
			"first",
			"<user>use tabs</user>",
			"second",
			"<user>also lint</user>",
		]);
		// Only the delivered steer is marked in the transcript.
		expect(liveSteeredTexts(transcript)).toEqual(["use tabs"]);
	});

	it("delivers rejected steering at the next boundary ahead of input queued after it", async () => {
		const { contexts, transcript } = await runSteered(async (live, queue) => {
			queue.push(createUserMessage("use tabs"));
			const claim = await live.claim(new AbortController().signal);
			queue.push(createUserMessage("also lint"));
			claim?.reject();
		});

		expect(contexts[1]).toEqual(["<user>start</user>", "first", "<user>use tabs</user>", "<user>also lint</user>"]);
		expect(contexts).toHaveLength(2);
		expect(liveSteeredTexts(transcript)).toEqual([]);
	});

	it("keeps steering whose provider view is not a user message out of the live response", async () => {
		let claimed = true;
		const card: AgentMessage = {
			role: "custom",
			customType: "note",
			content: "heads up",
			display: true,
			timestamp: Date.now(),
		};
		const { contexts } = await runSteered(
			async live => {
				claimed = (await live.claim(new AbortController().signal)) !== undefined;
			},
			{ initialQueue: [card] },
		);

		expect(claimed).toBe(false);
		expect(contexts[1]).toEqual(["<user>start</user>", "first", "heads up"]);
	});

	it("soft-interrupts the tool batch of the response that took live steering", async () => {
		// The steer left the queue, so the batch's queue peek never sees it; the
		// loop must still signal foreground tools (bash auto-backgrounds on it).
		const schema = type({});
		let steeringSignal: AbortSignal | undefined;
		let softInterrupted = false;
		const work: AgentTool<typeof schema, Record<string, never>> = {
			name: "work",
			label: "Work",
			description: "Foreground work that yields to steering",
			parameters: schema,
			async execute() {
				// The steer is pending before the batch starts, so the signal is
				// already up when the tool runs.
				softInterrupted = steeringSignal?.aborted === true;
				return { content: [{ type: "text", text: "worked" }], details: {} };
			},
		};
		const { contexts, transcript } = await runSteered(
			async (live, queue) => {
				queue.push(createUserMessage("use tabs"));
				(await live.claim(new AbortController().signal))?.accept();
			},
			{
				first: { content: [{ type: "toolCall", id: "call-1", name: "work", arguments: {} }] },
				tools: [work],
				getToolContext: toolCall => {
					steeringSignal = toolCall?.steeringSignal;
					return { toolCall } as AgentToolContext;
				},
			},
		);

		expect(softInterrupted).toBe(true);
		expect(contexts[1]).toEqual(["<user>start</user>", "", "", "<user>use tabs</user>"]);
		expect(liveSteeredTexts(transcript)).toEqual(["use tabs"]);
	});

	it("requeues live steering when its run aborts, even after the queue was replaced", async () => {
		// The steer left the queue for the response (before any ack); queue edits
		// (Alt+Up, Esc's clear) must not lose it, and the empty-submit interrupt redelivers it.
		const { agent, steer, running } = await startLiveSteeredRun();
		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(agent.peekLiveSteeredMessages()).toEqual([steer]);

		agent.replaceQueues([], []);
		agent.abort();
		await running;

		expect(agent.peekLiveSteeredMessages()).toEqual([]);
		expect(agent.peekSteeringQueue()).toEqual([steer]);
	});

	it("drops withdrawn live steering from the aborted run", async () => {
		// Esc hands the steer back to the editor: the abort must neither requeue nor record it.
		const { agent, steer, running } = await startLiveSteeredRun();

		expect(agent.withdrawLiveSteering()).toEqual([steer]);
		agent.abort();
		await running;

		expect(agent.peekSteeringQueue()).toEqual([]);
		expect(agent.peekUndeliveredQueuedMessages()).toEqual([]);
		expect(agent.state.messages).not.toContain(steer);
	});
});
