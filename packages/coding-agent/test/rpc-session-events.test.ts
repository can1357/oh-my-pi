import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAX_RPC_FRAME_BYTES, RpcFrameEncoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import { RpcSessionEventForwarder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-events";
import type {
	RpcDeltaMessageUpdateFrame,
	RpcProjectedSessionEventFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

const reply = { role: "assistant", content: [] } as unknown as AgentMessage;
const card = { role: "custom", customType: "advisor-card", content: "note" } as unknown as AgentMessage;

function messageEvent(
	type: "message_start" | "message_end",
	message: AgentMessage,
): Extract<AgentSessionEvent, { type: "message_start" | "message_end" }> {
	return { type, message };
}

function update(): AgentSessionEvent {
	return {
		type: "message_update",
		message: reply,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: reply },
	} as unknown as AgentSessionEvent;
}

function idsOf(frames: RpcProjectedSessionEventFrame[]): Array<[string, string | undefined]> {
	return frames.map(frame => [frame.type, "messageId" in frame ? frame.messageId : undefined]);
}

describe("RpcSessionEventForwarder", () => {
	test("delta updates preserve each streaming subtype without mutating shared events", () => {
		const message = makeAssistantMessage();
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "file" } };
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: message },
			{ type: "text_start", contentIndex: 0, partial: message },
			{ type: "text_delta", contentIndex: 0, delta: "hello", partial: message },
			{ type: "text_end", contentIndex: 0, content: "hello", partial: message },
			{ type: "thinking_start", contentIndex: 1, partial: message },
			{ type: "thinking_delta", contentIndex: 1, delta: "consider", partial: message },
			{ type: "thinking_end", contentIndex: 1, content: "consider", partial: message },
			{
				type: "image_end",
				contentIndex: 2,
				content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				partial: message,
			},
			{ type: "toolcall_start", contentIndex: 3, partial: message },
			{ type: "toolcall_delta", contentIndex: 3, delta: '{"path":"file"}', partial: message },
			{ type: "toolcall_end", contentIndex: 3, toolCall, partial: message },
			{ type: "done", reason: "stop", message },
			{ type: "error", reason: "error", error: message },
		];
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		forwarder.setFilter(null, "delta");
		for (const assistantMessageEvent of events) {
			const event = { type: "message_update" as const, message, assistantMessageEvent, extra: "preserved" };
			const before = JSON.stringify(event);
			Object.freeze(assistantMessageEvent);
			Object.freeze(event);
			forwarder.forward(event);
			const { partial: _partial, ...expected } = assistantMessageEvent as AssistantMessageEvent & {
				partial?: unknown;
			};
			expect(frames.at(-1)).toMatchObject({
				...event,
				message: { role: "assistant" },
				assistantMessageEvent: expected,
				messageId: "msg-1",
			});
			expect(frames.at(-1)).toHaveProperty("message", { role: "assistant" });
			expect(frames.at(-1)).not.toHaveProperty("assistantMessageEvent.partial");
			expect(JSON.stringify(event)).toBe(before);
		}
	});

	test("a delta stream carries each block once: whole at its start, only the missing metadata at its end", () => {
		const message = makeAssistantMessage();
		const text = { type: "text" as const, text: "hello", textSignature: "sig-1" };
		const thinking = { type: "thinking" as const, thinking: "hmm", thinkingSignature: "sig-2" };
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
		const toolCall = { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "file" } };
		message.content = [text, thinking, image, toolCall] as unknown as typeof message.content;
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		forwarder.setFilter(null, "delta");
		const send = (assistantMessageEvent: AssistantMessageEvent) =>
			forwarder.forward({ type: "message_update", message, assistantMessageEvent });
		send({ type: "start", partial: message });
		send({ type: "text_start", contentIndex: 0, partial: message });
		send({ type: "text_delta", contentIndex: 0, delta: "hello", partial: message });
		send({ type: "text_end", contentIndex: 0, content: "hello", partial: message });
		send({ type: "thinking_start", contentIndex: 1, partial: message });
		send({ type: "thinking_delta", contentIndex: 1, delta: "hmm", partial: message });
		send({ type: "thinking_end", contentIndex: 1, content: "hmm", partial: message });
		send({ type: "image_end", contentIndex: 2, content: image, partial: message });
		send({ type: "toolcall_start", contentIndex: 3, partial: message });
		send({ type: "toolcall_delta", contentIndex: 3, delta: "{}", partial: message });
		send({ type: "toolcall_end", contentIndex: 3, toolCall, partial: message });
		const events = frames.flatMap(frame => (frame.type === "message_update" ? [frame.assistantMessageEvent] : []));

		expect(events).toEqual([
			{ type: "start", message },
			{ type: "text_start", contentIndex: 0, block: { ...text, text: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "hello" },
			{ type: "text_end", contentIndex: 0, content: "hello", block: { type: "text", textSignature: "sig-1" } },
			{ type: "thinking_start", contentIndex: 1, block: { ...thinking, thinking: "" } },
			{ type: "thinking_delta", contentIndex: 1, delta: "hmm" },
			{
				type: "thinking_end",
				contentIndex: 1,
				content: "hmm",
				block: { type: "thinking", thinkingSignature: "sig-2" },
			},
			{ type: "image_end", contentIndex: 2, content: image },
			{ type: "toolcall_start", contentIndex: 3, block: { ...toolCall, arguments: {} } },
			{ type: "toolcall_delta", contentIndex: 3, delta: "{}" },
			{ type: "toolcall_end", contentIndex: 3, toolCall },
		]);
		for (const event of events) expect(event).not.toHaveProperty("partial");
	});

	test("a large end event is not doubled and still rebuilds its block", () => {
		const size = 600_000;
		const text = "x".repeat(size);
		const message = makeAssistantMessage();
		message.content = [{ type: "text", text, textSignature: "sig" }] as unknown as typeof message.content;
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		forwarder.setFilter(null, "delta");
		forwarder.forward({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text, partial: message },
		});
		const line = JSON.stringify(frames[0]);
		expect(line.length).toBeLessThan(size + 1_000);
		const update = (frames[0] as RpcDeltaMessageUpdateFrame).assistantMessageEvent;
		if (update.type !== "text_end") throw new Error("expected text_end");
		expect({ ...update.block, text: update.content }).toEqual(message.content[0]);
	});

	test("a start whose snapshot is ahead of the stream still opens an empty block", () => {
		const message = makeAssistantMessage();
		message.content = [
			{ type: "thinking", thinking: "already streamed" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file" } },
		] as unknown as typeof message.content;
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		forwarder.setFilter(null, "delta");
		for (const assistantMessageEvent of [
			{ type: "thinking_start", contentIndex: 0, partial: message },
			{ type: "toolcall_start", contentIndex: 1, partial: message },
		] satisfies AssistantMessageEvent[])
			forwarder.forward({ type: "message_update", message, assistantMessageEvent });
		expect(frames.map(frame => (frame as RpcDeltaMessageUpdateFrame).assistantMessageEvent)).toEqual([
			{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
			{
				type: "toolcall_start",
				contentIndex: 1,
				block: { type: "toolCall", id: "call-1", name: "read", arguments: {} },
			},
		]);
		// The shared snapshot is not mutated by the projection.
		expect(message.content[0]).toMatchObject({ thinking: "already streamed" });
	});

	test("a contentIndex pointing at no block omits `block` instead of sending undefined", () => {
		const message = makeAssistantMessage();
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		forwarder.setFilter(null, "delta");
		for (const assistantMessageEvent of [
			{ type: "text_start", contentIndex: 5, partial: message },
			{ type: "text_end", contentIndex: 5, content: "", partial: message },
			{ type: "thinking_end", contentIndex: 5, content: "", partial: message },
		] satisfies AssistantMessageEvent[])
			forwarder.forward({ type: "message_update", message, assistantMessageEvent });
		for (const frame of frames) expect(frame).not.toHaveProperty("assistantMessageEvent.block");
	});

	test("switching projection mid-message keeps identity and omission restores byte-identical full updates", () => {
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));
		const event = update();
		forwarder.forward(messageEvent("message_start", reply));
		forwarder.forward(event);
		forwarder.setFilter(["message_update", "message_end"], "delta");
		forwarder.forward(event);
		forwarder.setFilter(null);
		forwarder.forward(event);
		forwarder.setFilter(null, "full");
		forwarder.forward(event);
		forwarder.setFilter(null, "delta");
		forwarder.forward(messageEvent("message_end", reply));
		expect(idsOf(frames)).toEqual([
			["message_start", "msg-1"],
			["message_update", "msg-1"],
			["message_update", "msg-1"],
			["message_update", "msg-1"],
			["message_update", "msg-1"],
			["message_end", "msg-1"],
		]);
		for (const index of [1, 3, 4])
			expect(JSON.stringify(frames[index])).toBe(JSON.stringify({ ...event, messageId: "msg-1" }));
		expect(frames[2]).toEqual({
			type: "message_update",
			messageId: "msg-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
		});
		expect(frames[5]).toEqual({ ...messageEvent("message_end", reply), messageId: "msg-1" });
	});

	test("delta projection avoids v2 chunking caused by accumulated snapshots, not by the text delta", () => {
		const message = makeAssistantMessage();
		message.content = [{ type: "text", text: "x".repeat(3 * 512000) }];
		const event: AgentSessionEvent = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(512000), partial: message },
		};
		const encoder = new RpcFrameEncoder();
		encoder.setProtocolVersion(2);
		const lines: string[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => lines.push(...encoder.encodeFrames(frame)));
		forwarder.setFilter(null, "delta");
		forwarder.forward(event);
		expect(lines).toHaveLength(1);
		expect(Buffer.byteLength(lines[0])).toBeLessThan(MAX_RPC_FRAME_BYTES);
		expect(JSON.parse(lines[0]).assistantMessageEvent.delta).toBe("x".repeat(512000));
		expect(JSON.parse(lines[0]).type).toBe("message_update");
		lines.length = 0;
		forwarder.setFilter(null, "full");
		forwarder.forward(event);
		expect(JSON.parse(lines[0]).type).toBe("rpc_chunk");
	});
	test("keeps one messageId per message while an external record nests inside a streaming reply", () => {
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));

		forwarder.forward(messageEvent("message_start", reply));
		forwarder.forward(update());
		forwarder.forward(messageEvent("message_start", card));
		forwarder.forward(messageEvent("message_end", card));
		forwarder.forward(update());
		forwarder.forward(messageEvent("message_end", reply));
		forwarder.forward(messageEvent("message_start", reply));

		expect(idsOf(frames)).toEqual([
			["message_start", "msg-1"],
			["message_update", "msg-1"],
			["message_start", "msg-2"],
			["message_end", "msg-2"],
			["message_update", "msg-1"],
			["message_end", "msg-1"],
			["message_start", "msg-3"],
		]);
	});

	test("filters unlisted event types without shifting message ids, and null restores everything", () => {
		const frames: RpcProjectedSessionEventFrame[] = [];
		const forwarder = new RpcSessionEventForwarder(frame => frames.push(frame));

		expect(forwarder.setFilter(["message_end", "agent_end"])).toEqual(["message_end", "agent_end"]);
		forwarder.forward({ type: "agent_start" });
		forwarder.forward(messageEvent("message_start", reply));
		forwarder.forward(update());
		forwarder.forward(messageEvent("message_end", reply));
		forwarder.forward({ type: "agent_end", messages: [reply] });

		expect(forwarder.setFilter(null)).toBeNull();
		forwarder.forward(messageEvent("message_start", reply));

		expect(idsOf(frames)).toEqual([
			["message_end", "msg-1"],
			["agent_end", undefined],
			["message_start", "msg-2"],
		]);
	});
});

type Block = AssistantMessage["content"][number];

/** What a plain RPC client does with delta frames: no snapshots, only starts, increments, and ends. */
function applyDelta(message: AssistantMessage, event: RpcDeltaMessageUpdateFrame) {
	const update = event.assistantMessageEvent;
	if (update.type === "start") return structuredClone(update.message);
	if (update.type === "done" || update.type === "error") return message;
	const index = update.contentIndex;
	switch (update.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			message.content[index] = structuredClone(update.block!);
			break;
		case "text_delta":
			(message.content[index] as { text: string }).text += update.delta;
			break;
		case "thinking_delta":
			(message.content[index] as { thinking: string }).thinking += update.delta;
			break;
		case "text_end":
			message.content[index] = { ...update.block!, text: update.content } as Block;
			break;
		case "thinking_end":
			message.content[index] = { ...update.block!, thinking: update.content } as Block;
			break;
		case "image_end":
			message.content[index] = structuredClone(update.content);
			break;
		case "toolcall_end":
			message.content[index] = structuredClone(update.toolCall);
			break;
		case "toolcall_delta":
			// A fragment of the arguments JSON: the arguments are complete only at toolcall_end.
			break;
	}
	return message;
}

describe("delta message updates over a real session run", () => {
	let session: AgentSession | undefined;
	let tempDir: string | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		if (tempDir) await removeWithRetries(tempDir);
	});

	// `burst`: the provider queues every event before the agent loop reads one, so each snapshot is far ahead of its event.
	test.each([
		["paced", true],
		["burst", false],
	])(
		"every streamed message rebuilds from delta frames alone and matches the full-mode message (%s)",
		async (_name, paced) => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			let turn = 0;
			// Mutates one partial message in place and yields between events, like a provider reading a socket.
			const streamFn = (streamModel: Model, _context: Context) => {
				const stream = new AssistantMessageEventStream();
				const first = turn++ === 0;
				void (async () => {
					const push = async (event: AssistantMessageEvent) => {
						stream.push(event);
						if (paced) await Bun.sleep(0);
					};
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: streamModel.api,
						provider: streamModel.provider,
						model: streamModel.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					await push({ type: "start", partial });
					if (first) {
						partial.content.push({ type: "thinking", thinking: "" });
						await push({ type: "thinking_start", contentIndex: 0, partial });
						for (const delta of ["let me ", "think"]) {
							(partial.content[0] as { thinking: string }).thinking += delta;
							await push({ type: "thinking_delta", contentIndex: 0, delta, partial });
						}
						(partial.content[0] as { thinkingSignature?: string }).thinkingSignature = "sig-think";
						await push({ type: "thinking_end", contentIndex: 0, content: "let me think", partial });
					}
					partial.content.push({ type: "text", text: "" });
					const textIndex = partial.content.length - 1;
					await push({ type: "text_start", contentIndex: textIndex, partial });
					for (const delta of ["hel", "lo ", "there"]) {
						(partial.content[textIndex] as { text: string }).text += delta;
						await push({ type: "text_delta", contentIndex: textIndex, delta, partial });
					}
					(partial.content[textIndex] as { textSignature?: string }).textSignature = "sig-text";
					await push({ type: "text_end", contentIndex: textIndex, content: "hello there", partial });
					if (first) {
						const toolCall = { type: "toolCall" as const, id: "call-1", name: "missing_tool", arguments: {} };
						partial.content.push(toolCall);
						await push({ type: "toolcall_start", contentIndex: 2, partial });
						await push({ type: "toolcall_delta", contentIndex: 2, delta: '{"path":', partial });
						await push({ type: "toolcall_delta", contentIndex: 2, delta: '"file"}', partial });
						toolCall.arguments = { path: "file" };
						await push({ type: "toolcall_end", contentIndex: 2, toolCall, partial });
						partial.stopReason = "toolUse";
					}
					await push({ type: "done", reason: first ? "toolUse" : "stop", message: partial });
				})();
				return stream;
			};

			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-delta-rebuild-"));
			const authStorage = await AuthStorage.create(":memory:");
			authStorage.keys.setRuntime("anthropic", "test-key");
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn,
				convertToLlm,
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			});

			// Frames are serialized when emitted, as on the wire: the provider keeps mutating its partial afterwards.
			const full: string[] = [];
			const delta: string[] = [];
			const fullForwarder = new RpcSessionEventForwarder(frame => full.push(JSON.stringify(frame)));
			const deltaForwarder = new RpcSessionEventForwarder(frame => delta.push(JSON.stringify(frame)));
			deltaForwarder.setFilter(null, "delta");
			session.subscribe(event => {
				fullForwarder.forward(event);
				deltaForwarder.forward(event);
			});
			await session.prompt("go");

			const fullFrames = full.map(line => JSON.parse(line) as RpcProjectedSessionEventFrame);
			const deltaFrames = delta.map(line => JSON.parse(line) as RpcProjectedSessionEventFrame);
			expect(deltaFrames.map(frame => frame.type)).toEqual(fullFrames.map(frame => frame.type));

			// Block by block: a start's shell plus deltas must equal the full-mode block at its end, and the message's
			// content must equal message_end's. Intermediate frames are not compared: a snapshot can be ahead of its event.
			let rebuilt: AssistantMessage | undefined;
			let streamed = 0;
			let blocksCompared = 0;
			for (const [index, fullFrame] of fullFrames.entries()) {
				const deltaFrame = deltaFrames[index]!;
				if (deltaFrame.type === "message_start" && deltaFrame.message.role === "assistant") {
					rebuilt = structuredClone(deltaFrame.message);
					streamed++;
				}
				if (deltaFrame.type === "message_end" && deltaFrame.message.role === "assistant") {
					expect(rebuilt!.content).toEqual(deltaFrame.message.content);
				}
				if (fullFrame.type !== "message_update" || deltaFrame.type !== "message_update") continue;
				expect(deltaFrame.messageId).toBe(fullFrame.messageId);
				const delta = deltaFrame as RpcDeltaMessageUpdateFrame;
				rebuilt = applyDelta(rebuilt!, delta);
				const type = delta.assistantMessageEvent.type;
				if (delta.assistantMessageEvent.type === "text_start")
					expect(delta.assistantMessageEvent.block).toMatchObject({ type: "text", text: "" });
				if (delta.assistantMessageEvent.type === "thinking_start")
					expect(delta.assistantMessageEvent.block).toMatchObject({ type: "thinking", thinking: "" });
				if (delta.assistantMessageEvent.type === "toolcall_start")
					expect(delta.assistantMessageEvent.block).toMatchObject({ type: "toolCall", arguments: {} });
				if (type === "text_end" || type === "thinking_end" || type === "toolcall_end") {
					const at = delta.assistantMessageEvent.contentIndex!;
					expect(rebuilt.content[at]).toEqual((fullFrame.message as AssistantMessage).content[at]);
					blocksCompared++;
				}
			}
			expect(streamed).toBe(2);
			expect(blocksCompared).toBe(4);
		},
	);
});
