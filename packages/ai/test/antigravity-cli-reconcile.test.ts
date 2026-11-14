import { describe, expect, it } from "bun:test";
import {
	type Ledger,
	inputBlocks,
	lateToolResultPrompt,
	planTurn,
	replayPrompt,
	transcriptDigest,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/reconcile";
import type {
	AntigravityCliPayload,
	AssistantMessage,
	Message,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(text: string, toolCallIds: string[] = [], payload?: AntigravityCliPayload): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCallIds.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: "a.txt" } })),
		],
		api: "antigravity-acp",
		provider: "antigravity-cli",
		model: "gemini-3.8-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallIds.length > 0 ? "toolUse" : "stop",
		providerPayload: payload,
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

/** A transcript whose last message is a turn end agy recorded, as the transport stamps it. */
function recordedTurn(messages: Message[], conversationId: string): Message[] {
	const end = assistant("done");
	const withEnd = [...messages, end];
	end.providerPayload = {
		type: "antigravityCli",
		conversationId,
		digest: transcriptDigest(withEnd),
		checkpoint: { steps: 2, generations: 1, executions: 1 },
	};
	return withEnd;
}

function ledgerFor(messages: Message[], pendingToolCallId?: string): Ledger {
	return { count: messages.length, digest: transcriptDigest(messages), pendingToolCallId };
}

describe("planTurn", () => {
	it("returns the held tool call's result to agy and steers with input sent after it", () => {
		const seen = [user("read a.txt"), assistant("reading", ["call-1"])];
		const result = toolResult("call-1", "file body");
		const steer = user("also check b.txt");

		const plan = planTurn([...seen, result, steer], ledgerFor(seen, "call-1"));

		expect(plan).toEqual({ kind: "resume", toolResult: result, input: [steer] });
	});

	it("reseeds when assistant or tool-result text was edited", () => {
		const seen = [user("read a.txt"), assistant("reading", ["call-1"]), toolResult("call-1", "long output")];
		const ledger = ledgerFor([...seen, assistant("summary")]);
		const pruned = [user("read a.txt"), assistant("", ["call-1"]), toolResult("call-1", "[pruned]"), assistant("")];

		const plan = planTurn([...pruned, user("next")], ledger);

		expect(plan.kind).toBe("fresh");
	});

	it("rewinds to the newest recorded turn end when an earlier message was edited", () => {
		const first = recordedTurn([user("one")], "conv-a");
		const second = recordedTurn([...first, user("two")], "conv-a");
		const edited = [...first, user("two, edited")];

		const plan = planTurn(edited, ledgerFor(second));

		expect(plan).toEqual({
			kind: "restore",
			conversationId: "conv-a",
			digest: transcriptDigest(first),
			checkpoint: { steps: 2, generations: 1, executions: 1 },
			replay: [user("two, edited")],
		});
	});

	it("does not resume a held call whose result is missing", () => {
		const seen = [user("read a.txt"), assistant("reading", ["call-1"])];

		const plan = planTurn([...seen, user("never mind")], ledgerFor(seen, "call-1"));

		expect(plan).toEqual({ kind: "fresh", replay: [...seen, user("never mind")] });
	});

	it("starts fresh from another provider's history with nothing recorded", () => {
		const foreign = [
			user("hi"),
			{ ...assistant("hello"), provider: "anthropic", api: "anthropic-messages" },
			user("go"),
		];

		expect(planTurn(foreign, undefined)).toEqual({ kind: "fresh", replay: foreign });
	});
});

describe("transcriptDigest", () => {
	it("includes assistant text, tool names, arguments, ordered ids and actual result content", () => {
		const original = [user("read"), assistant("reading", ["a", "b"]), toolResult("a", "original")];
		const digest = transcriptDigest(original);
		const variants: Message[][] = [
			[user("edited"), original[1]!, original[2]!],
			[original[0]!, assistant("edited", ["a", "b"]), original[2]!],
			[original[0]!, assistant("reading", ["b", "a"]), original[2]!],
			[original[0]!, original[1]!, toolResult("a", "edited")],
			[original[0]!, original[1]!, { ...toolResult("a", "original"), isError: true }],
			[original[0]!, original[1]!, { ...toolResult("a", "original"), toolName: "write" }],
		];
		const changedCall = assistant("reading", ["a", "b"]);
		const call = changedCall.content[1];
		if (call?.type !== "toolCall") throw new Error("Missing test tool call");
		call.arguments = { path: "different" };
		variants.push([original[0]!, changedCall, original[2]!]);
		for (const variant of variants) expect(transcriptDigest(variant)).not.toBe(digest);
	});

	it("ignores presentation metadata and object key insertion order", () => {
		const first = assistant("reading", ["a"]);
		const reordered = assistant("reading", ["a"]);
		const a = first.content[1];
		const b = reordered.content[1];
		if (a?.type !== "toolCall" || b?.type !== "toolCall") throw new Error("Missing test tool call");
		a.arguments = { path: "x", options: { first: 1, second: 2 } };
		b.arguments = { options: { second: 2, first: 1 }, path: "x" };
		reordered.timestamp = 999;
		reordered.duration = 12;
		reordered.usage.input = 999;
		const body = toolResult("a", "body");
		expect(transcriptDigest([first, body])).toBe(
			transcriptDigest([reordered, { ...body, details: { preview: "display" }, prunedAt: 123 }]),
		);
	});

	it("includes image bytes and MIME types but not presentation URLs", () => {
		const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
		const first: UserMessage = { role: "user", timestamp: 0, content: [image] };
		expect(transcriptDigest([first])).not.toBe(
			transcriptDigest([{ ...first, content: [{ ...image, data: "Yg==" }] }]),
		);
		expect(transcriptDigest([first])).not.toBe(
			transcriptDigest([{ ...first, content: [{ ...image, mimeType: "image/jpeg" }] }]),
		);
		expect(transcriptDigest([user("same")])).toBe(
			transcriptDigest([{ ...user("same"), content: [{ type: "text", text: "same" }] }]),
		);
	});
});

describe("replayPrompt", () => {
	it("keeps historical user, assistant and tool-result images in content order", () => {
		const firstImage = { type: "image" as const, data: "dXNlcg==", mimeType: "image/png" };
		const secondImage = { type: "image" as const, data: "YXNzaXN0YW50", mimeType: "image/png" };
		const thirdImage = { type: "image" as const, data: "dG9vbA==", mimeType: "image/jpeg" };
		const reply = assistant("image response");
		reply.content.push(secondImage);
		const body = toolResult("a", "before");
		body.content.push(thirdImage, { type: "text", text: "after" });
		const blocks = replayPrompt([{ ...user(""), content: [firstImage] }, reply, body, user("continue")]);
		expect(blocks.filter(block => block.type === "image")).toEqual([firstImage, secondImage, thirdImage]);
		const imageIndex = blocks.findIndex(block => block.type === "image" && block.data === thirdImage.data);
		expect(blocks[imageIndex - 1]).toEqual({ type: "text", text: "before" });
		expect(blocks[imageIndex + 1]).toEqual({ type: "text", text: "after" });
	});

	it("preserves direct and delayed result text/image ordering", () => {
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const content = [{ type: "text" as const, text: "before" }, image, { type: "text" as const, text: "after" }];
		expect(inputBlocks({ role: "user", content, timestamp: 0 })).toEqual(content);
		const blocks = lateToolResultPrompt({ ...toolResult("a", ""), content });
		expect(blocks.slice(1, -1)).toEqual(content);
	});
	it("sends trailing user input as-is and labels earlier transcript messages", () => {
		const blocks = replayPrompt([
			user("read a.txt"),
			assistant("reading", ["call-1"]),
			toolResult("call-1", "FILE-BODY-42"),
			user("what did it say?"),
		]);

		const text = blocks.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		expect(text).toContain("FILE-BODY-42");
		expect(text).toContain("read a.txt");
		expect(text).toContain('id="call-1"');
		expect(blocks.at(-1)).toEqual({ type: "text", text: "what did it say?" });
	});
});
