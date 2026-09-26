import { describe, expect, it } from "bun:test";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import type { LiveSteering, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
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

/**
 * Runs a three-response conversation whose first provider call runs `steer`
 * against the live-steering source it was offered; returns the text of every
 * provider call's context.
 */
async function runSteered(
	steer: (live: LiveSteering, queue: AgentMessage[]) => Promise<void>,
	initialQueue: AgentMessage[] = [],
): Promise<{ contexts: string[][]; transcript: AgentMessage[] }> {
	const queue: AgentMessage[] = [];
	const mock = createMockModel({
		responses: [{ content: ["first"] }, { content: ["second"] }, { content: ["third"] }],
	});
	const contexts: string[][] = [];
	const streamFn: StreamFn = async (model, context, options) => {
		contexts.push(context.messages.map(textOf));
		if (contexts.length === 1) {
			if (!options?.liveSteering) throw new Error("live steering was not offered");
			queue.push(...initialQueue);
			await steer(options.liveSteering, queue);
		}
		return mock.stream(model, context, options);
	};
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm,
		getSteeringMessages: async () => queue.splice(0),
		waitForSteeringMessages: async () => {},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
	const run = agentLoop([createUserMessage("start")], context, config, undefined, streamFn);
	for await (const _ of run) {
		// drain
	}
	return { contexts, transcript: await run.result() };
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
			[card],
		);

		expect(claimed).toBe(false);
		expect(contexts[1]).toEqual(["<user>start</user>", "first", "heads up"]);
	});
});
