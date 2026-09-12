import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { convertToLlm, stripImagesFromMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

const png = (data: string = "iVBORw0KGgo"): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const text = (value: string): TextContent => ({ type: "text", text: value });

describe("stripImagesFromMessage", () => {
	it("removes image blocks from user message content arrays and keeps text in order", () => {
		const message: AgentMessage = {
			role: "user",
			content: [text("look at"), png("a"), text("and"), png("b")],
			timestamp: Date.now(),
		};

		const removed = stripImagesFromMessage(message);

		expect(removed).toBe(2);
		expect(message.content).toEqual([text("look at"), text("and")]);
	});

	it("leaves user content untouched and returns 0 when there are no images", () => {
		const original: (TextContent | ImageContent)[] = [text("hi"), text("there")];
		const message: AgentMessage = {
			role: "user",
			content: original,
			timestamp: Date.now(),
		};

		const removed = stripImagesFromMessage(message);

		expect(removed).toBe(0);
		expect(message.content).toBe(original);
	});

	it("returns 0 for string-form user content (legacy shape, no images possible)", () => {
		const message: AgentMessage = {
			role: "user",
			content: "no images here",
			timestamp: Date.now(),
		};

		expect(stripImagesFromMessage(message)).toBe(0);
		expect(message.content).toBe("no images here");
	});

	it("inserts a placeholder text block when stripping empties the array (user message)", () => {
		const message: AgentMessage = {
			role: "user",
			content: [png(), png()],
			timestamp: Date.now(),
		};

		expect(stripImagesFromMessage(message)).toBe(2);
		expect(message.content).toEqual([text("[image removed]")]);
	});

	it("strips images from tool result content AND details.images, summing the count", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "generate_image",
			content: [text("generated"), png("inline")],
			details: { images: [png("hidden-1"), png("hidden-2")], imageCount: 2 },
			isError: false,
			timestamp: Date.now(),
		};

		const removed = stripImagesFromMessage(message);

		expect(removed).toBe(3);
		expect(message.content).toEqual([text("generated")]);
		const details = message.details as { images: ImageContent[]; imageCount: number };
		expect(details.images).toEqual([]);
		expect(details.imageCount).toBe(2); // unrelated detail fields stay intact
	});

	it("preserves manual Bash images in model context and strips them when requested", () => {
		const message: AgentMessage = {
			role: "bashExecution",
			command: "remote-image-command",
			output: "done",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			images: [png("bash-image")],
			timestamp: Date.now(),
		};

		const converted = convertToLlm([message]);
		expect(converted[0]?.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("remote-image-command") }),
			png("bash-image"),
		]);

		expect(stripImagesFromMessage(message)).toBe(1);
		expect(message.images).toBeUndefined();
	});

	it("clears fileMention image attachments without dropping other file fields", () => {
		const message: AgentMessage = {
			role: "fileMention",
			files: [
				{ path: "a.txt", content: "alpha\nbeta\n", lineCount: 2 },
				{ path: "b.png", content: "", image: png("attached"), byteSize: 1024 },
			],
			timestamp: Date.now(),
		};

		const removed = stripImagesFromMessage(message);

		expect(removed).toBe(1);
		expect(message.files[0]).toEqual({ path: "a.txt", content: "alpha\nbeta\n", lineCount: 2 });
		expect(message.files[1]).toEqual({ path: "b.png", content: "", image: undefined, byteSize: 1024 });
	});

	it("returns 0 for assistant messages (they never carry ImageContent)", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [text("hi")],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
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

		expect(stripImagesFromMessage(message)).toBe(0);
	});
});
