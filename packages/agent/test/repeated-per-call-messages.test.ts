/**
 * An Agent marks a per-call message repeated when the previous answered main request sent the same bytes at the same
 * place: after the same history message, at the same ordinal there. Four things a host does that the record must get
 * right, each one a wrong answer a reader would never see on the wire: the place is the history message and not the
 * index in the request, so a per-call message added elsewhere does not move the note; a request carries the bytes
 * its hook built this time, even where the hook rewrites one message object in place, and the record sees a rewrite
 * at any depth; and a note rebuilt with a new timestamp, which reaches no provider parameter, is the same note.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AnthropicMessagePayload,
	AnthropicRequestControls,
	AssistantMessage,
	Context,
	DeveloperMessage,
	TextContent,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	isPerCallContextMessage,
	isRepeatedPerCallContextMessage,
	markPerCallContextMessage,
} from "@oh-my-pi/pi-ai/utils/block-symbols";

function perCall(content: string): UserMessage {
	const message: UserMessage = { role: "user", content, timestamp: 0 };
	markPerCallContextMessage(message);
	return message;
}

/** Each reply reports its response (`onResponse`), as a provider does, which takes the per-call record. */
function recordingMock(replies: number) {
	const sent: Context[] = [];
	const reply = (text: string) => (context: Context) => {
		sent.push(context);
		return { content: [text], responseHeaders: {} };
	};
	const mock = createMockModel({ responses: Array.from({ length: replies }, (_, turn) => reply(`reply ${turn}`)) });
	return { sent, mock };
}

describe("repeated per-call messages", () => {
	it("keeps a note's place when a per-call message is added ahead of the history", async () => {
		const { sent, mock } = recordingMock(2);
		let leadingNote = false;
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			// A fixed note after the first history message; from the second request on, another hook's note ahead of
			// all history shifts every index after it by one.
			transformContext: async messages => [
				...(leadingNote ? [perCall("recalled: nothing new")] : []),
				...messages.slice(0, 1),
				perCall("Read the shared notes before planning."),
				...messages.slice(1),
			],
		});

		await agent.prompt("first");
		leadingNote = true;
		await agent.prompt("second");

		expect(sent).toHaveLength(2);
		const second = sent[1]!.messages;
		expect(second[0]?.content).toBe("recalled: nothing new");
		expect(second[2]?.content).toBe("Read the shared notes before planning.");
		// New at its place: per-call.
		expect(isPerCallContextMessage(second[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(second[0])).toBe(false);
		// Same bytes after the same history message as in the first request, though now at index 2, not 1.
		expect(isRepeatedPerCallContextMessage(second[2])).toBe(true);
	});

	it("sends the bytes of this request when a hook rewrites one message object in place", async () => {
		const { sent, mock } = recordingMock(3);
		// A host that hoists its note: the same object on every request, its text rewritten in place.
		const note = perCall("status: idle");
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [note, ...messages],
		});

		await agent.prompt("first");
		await agent.prompt("second");
		note.content = "status: busy";
		await agent.prompt("third");

		expect(sent).toHaveLength(3);
		// The second request repeats the first, which the provider answered.
		expect(isRepeatedPerCallContextMessage(sent[1]!.messages[0])).toBe(true);
		// It stays per-call: every reader but placement treats it as before (a request holding it gets no thread).
		expect(isPerCallContextMessage(sent[1]!.messages[0])).toBe(true);
		// The third carries what the host wrote, and says so: the recorded bytes are the answered request's, not this
		// object's current ones.
		expect(sent[2]!.messages[0]?.content).toBe("status: busy");
		expect(isPerCallContextMessage(sent[2]!.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(sent[2]!.messages[0])).toBe(false);
	});

	it("sees a rewrite of a block inside a reused message's content", async () => {
		const { sent, mock } = recordingMock(4);
		// A host that hoists its note and rewrites the text of its one content block in place.
		const block: TextContent = { type: "text", text: "status: idle" };
		const note: UserMessage = { role: "user", content: [block], timestamp: 0 };
		markPerCallContextMessage(note);
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [note, ...messages],
		});

		await agent.prompt("first");
		await agent.prompt("second");
		block.text = "status: busy";
		await agent.prompt("third");
		await agent.prompt("fourth");

		expect(sent).toHaveLength(4);
		expect(isRepeatedPerCallContextMessage(sent[1]!.messages[0])).toBe(true);
		// The block changed since the answered request: the record kept its own copy of the old text.
		expect(sent[2]!.messages[0]?.content).toEqual([{ type: "text", text: "status: busy" }]);
		expect(isPerCallContextMessage(sent[2]!.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(sent[2]!.messages[0])).toBe(false);
		// The fourth repeats the third, whose text the record now holds.
		expect(isRepeatedPerCallContextMessage(sent[3]!.messages[0])).toBe(true);
	});

	it("repeats a note the hook rebuilds with a new timestamp", async () => {
		const { sent, mock } = recordingMock(2);
		let stamp = 1_000;
		const agent = new Agent({
			initialState: { model: mock.model },
			// As a hook does: a fresh message each request, the same text, the clock's stamp.
			transformContext: async messages => {
				const note: AgentMessage = { role: "user", content: "status: idle", timestamp: (stamp += 1_000) };
				markPerCallContextMessage(note);
				return [note, ...messages];
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		await agent.prompt("first");
		await agent.prompt("second");

		expect(sent).toHaveLength(2);
		// The stamps differ and reach no provider parameter, so the note is the previous request's.
		expect(sent[0]!.messages[0]?.timestamp).not.toBe(sent[1]!.messages[0]?.timestamp);
		expect(isRepeatedPerCallContextMessage(sent[1]!.messages[0])).toBe(true);
	});

	it("sees a rewrite of a reused developer note's effort", async () => {
		const { sent, mock } = recordingMock(4);
		// The effort of a developer turn becomes its `output_config` on the wire.
		const payload: AnthropicMessagePayload = { type: "anthropicMessage", effort: "low" };
		const note: DeveloperMessage = { role: "developer", content: "status", providerPayload: payload, timestamp: 0 };
		markPerCallContextMessage(note);
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [note, ...messages],
		});

		await agent.prompt("first");
		await agent.prompt("second");
		payload.effort = "high";
		await agent.prompt("third");
		await agent.prompt("fourth");

		expect(sent).toHaveLength(4);
		expect(isRepeatedPerCallContextMessage(sent[1]!.messages[0])).toBe(true);
		expect(isPerCallContextMessage(sent[2]!.messages[0])).toBe(true);
		expect(isRepeatedPerCallContextMessage(sent[2]!.messages[0])).toBe(false);
		expect(isRepeatedPerCallContextMessage(sent[3]!.messages[0])).toBe(true);
	});

	it("sees a rewrite of the request controls of the history message a note follows", async () => {
		const { sent, mock } = recordingMock(4);
		// An assistant turn's request controls become control markers on the wire.
		const controls: AnthropicRequestControls = { messageIndex: 0, effort: { topLevel: "low", tail: null } };
		const anchor: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "pinned" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			requestControls: controls,
			timestamp: 0,
		};
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [anchor, perCall("status: idle"), ...messages],
		});

		await agent.prompt("first");
		await agent.prompt("second");
		controls.effort!.topLevel = "high";
		await agent.prompt("third");
		await agent.prompt("fourth");

		expect(sent).toHaveLength(4);
		expect(isRepeatedPerCallContextMessage(sent[1]!.messages[1])).toBe(true);
		// The place changed: the note after it is not the one the record holds.
		expect(isPerCallContextMessage(sent[2]!.messages[1])).toBe(true);
		expect(isRepeatedPerCallContextMessage(sent[2]!.messages[1])).toBe(false);
		expect(isRepeatedPerCallContextMessage(sent[3]!.messages[1])).toBe(true);
	});

	// A host's own object in a content block, such as a handle with methods, is a value structured cloning refuses.
	const uncopyable = (text: string) =>
		({ type: "text", text, hostHandle: { release: () => undefined } }) as unknown as TextContent;

	it("sends a note it cannot copy, unmarked, on this request and the next", async () => {
		const { sent, mock } = recordingMock(3);
		const note: UserMessage = { role: "user", content: [uncopyable("status: idle")], timestamp: 0 };
		markPerCallContextMessage(note);
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [note, ...messages],
		});

		for (const prompt of ["first", "second", "third"]) await agent.prompt(prompt);

		// Every request went out, and the same note is never marked: a failed copy matches nothing later.
		expect(sent).toHaveLength(3);
		for (const request of sent) {
			expect(isPerCallContextMessage(request.messages[0])).toBe(true);
			expect(isRepeatedPerCallContextMessage(request.messages[0])).toBe(false);
		}
	});

	it("never matches a place whose history message it cannot copy", async () => {
		const { sent, mock } = recordingMock(3);
		const anchor: UserMessage = { role: "user", content: [uncopyable("pinned")], timestamp: 0 };
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [anchor, perCall("status: idle"), ...messages],
		});

		for (const prompt of ["first", "second", "third"]) await agent.prompt(prompt);

		expect(sent).toHaveLength(3);
		for (const request of sent) {
			expect(isPerCallContextMessage(request.messages[1])).toBe(true);
			expect(isRepeatedPerCallContextMessage(request.messages[1])).toBe(false);
		}
	});

	it("compares the note as the provider-context transform leaves it", async () => {
		const { sent, mock } = recordingMock(3);
		let rewrites = 0;
		const agent = new Agent({
			initialState: { model: mock.model },
			streamFn: (model, context, options) => mock.stream(model, context, options),
			transformContext: async messages => [perCall("status: idle"), ...messages],
			// A host transform that rewrites the note's bytes on every request, as a blob store's fresh reference does.
			transformProviderContext: context => ({
				...context,
				messages: context.messages.map((message, index) =>
					index === 0 ? { ...message, content: `status: idle (${++rewrites})` } : message,
				) as Context["messages"],
			}),
		});

		for (const prompt of ["first", "second", "third"]) await agent.prompt(prompt);

		expect(sent).toHaveLength(3);
		// Each request sent the note with other bytes.
		expect(new Set(sent.map(request => request.messages[0]?.content)).size).toBe(3);
		for (const request of sent) {
			expect(isPerCallContextMessage(request.messages[0])).toBe(true);
			expect(isRepeatedPerCallContextMessage(request.messages[0])).toBe(false);
		}
	});
});
