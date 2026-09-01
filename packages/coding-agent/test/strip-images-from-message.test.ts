import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { stripImagesFromMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

const png = (data: string = "iVBORw0KGgo"): ImageContent => ({ type: "image", data, mimeType: "image/png" });
const detailImage = (data: string): { data: string; mimeType: string } => ({ data, mimeType: "image/png" });
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
			details: { images: [detailImage("hidden-1"), detailImage("hidden-2")], imageCount: 2 },
			isError: false,
			timestamp: Date.now(),
		};

		const removed = stripImagesFromMessage(message);

		expect(removed).toBe(3);
		expect(message.content).toEqual([text("generated")]);
		const details = message.details as { images: Array<{ data: string; mimeType: string }>; imageCount: number };
		expect(details.images).toEqual([]);
		expect(details.imageCount).toBe(2); // unrelated detail fields stay intact
	});
	it("strips detail image payloads without MIME or with non-image MIME metadata", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "tc-mime-less",
			toolName: "generate_image",
			content: [text("generated")],
			details: {
				images: [{ data: "hidden-without-mime" }, { data: "hidden-with-json-mime", mimeType: "application/json" }],
			},
			isError: false,
			timestamp: Date.now(),
		};

		expect(stripImagesFromMessage(message)).toBe(2);
		expect(message.details).toEqual({ images: [] });
	});

	it("strips images from nested xd:// tool result details and keeps unrelated fields", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "tc-nested",
			toolName: "write",
			content: [text("generated"), png("inline")],
			details: {
				xdev: {
					tool: "generate_image",
					mode: "execute",
					inner: {
						images: [detailImage("hidden-1"), detailImage("hidden-2")],
						imageCount: 2,
						provider: "fal",
					},
				},
				retained: "outer detail",
			},
			isError: false,
			timestamp: Date.now(),
		};

		const removed = stripImagesFromMessage(message);

		expect(removed).toBe(3);
		expect(message.content).toEqual([text("generated")]);
		const details = message.details as {
			xdev: {
				tool: string;
				mode: string;
				inner: { images: Array<{ data: string; mimeType: string }>; imageCount: number; provider: string };
			};
			retained: string;
		};
		expect(details.xdev.inner.images).toEqual([]);
		expect(details.xdev.inner.imageCount).toBe(2);
		expect(details.xdev.inner.provider).toBe("fal");
		expect(details.xdev.tool).toBe("generate_image");
		expect(details.xdev.mode).toBe("execute");
		expect(details.retained).toBe("outer detail");
	});

	it("preserves non-image nested detail entries while stripping image payloads", () => {
		const message: AgentMessage = {
			role: "toolResult",
			toolCallId: "tc-mixed",
			toolName: "write",
			content: [text("generated")],
			details: {
				xdev: {
					tool: "generate_image",
					mode: "execute",
					inner: {
						images: [detailImage("hidden"), { provider: "fal", marker: "keep" }],
					},
				},
			},
			isError: false,
			timestamp: Date.now(),
		};

		expect(stripImagesFromMessage(message)).toBe(1);
		const details = message.details as { xdev: { inner: { images: unknown[] } } };
		expect(details.xdev.inner.images).toEqual([{ provider: "fal", marker: "keep" }]);
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
