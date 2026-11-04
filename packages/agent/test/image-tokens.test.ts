import { describe, expect, test } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	countResponsesHistoryTokens,
	trimRemoteCompactionInputToContextWindow,
} from "@oh-my-pi/pi-agent-core/compaction/openai";
import { estimateImageTokens } from "@oh-my-pi/pi-agent-core/image-tokens";
import type { Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

/** Base64 PNG whose IHDR declares `width`x`height`; the pixel data is irrelevant to sizing. */
function pngWithSize(width: number, height: number): string {
	const bytes = Buffer.alloc(64);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	bytes[24] = 8;
	bytes[25] = 6;
	return bytes.toString("base64");
}

describe("estimateImageTokens", () => {
	test("matches OpenAI's documented patch examples", () => {
		expect(estimateImageTokens({ width: 1024, height: 1024 }, "high")).toBe(1229);
		// 4096x4096 patches exceed the 2,500 budget and shrink to 50x50 patches.
		expect(estimateImageTokens({ width: 2048, height: 2048 }, "high")).toBe(3000);
		expect(estimateImageTokens({ width: 4096, height: 512 }, "original")).toBe(2458);
	});

	test("charges the detail level's full budget when dimensions are unknown", () => {
		expect(estimateImageTokens(null, "high")).toBe(3000);
		expect(estimateImageTokens(null, "original")).toBe(12_000);
		expect(estimateImageTokens(null, undefined)).toBe(12_000);
	});
});

describe("image pricing by the reading model", () => {
	function reader(provider: "anthropic" | "google" | "openai-codex", id: string): Model {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`missing bundled model ${provider}/${id}`);
		return model as Model;
	}
	const image = { type: "image" as const, data: pngWithSize(1000, 1000), mimeType: "image/png" };

	test.each([
		// Claude's 28px patches: ⌈1000/28⌉² = 36².
		["Claude", reader("anthropic", "claude-opus-5-5"), 1296],
		// Gemini 3 bills a fixed budget per image.
		["Gemini", reader("google", "gemini-3-pro-preview"), 1120],
	] as const)("a user image costs what %s bills for it", (_reader, model, expected) => {
		const message: UserMessage = { role: "user", content: [image], timestamp: 0 };
		expect(new Tokenizer(model).countMessage(message)).toBe(expected);
	});

	test("a user image without a reader keeps the OpenAI wire's estimate", () => {
		// 32px patches × 1.2, the generic estimate main applied to every reader.
		const message: UserMessage = { role: "user", content: [image], timestamp: 0 };
		expect(new Tokenizer().countMessage(message)).toBe(1229);
	});

	test("the remote-compaction probe charges an image what the local count charges", () => {
		const tokenizer = new Tokenizer(reader("openai-codex", "gpt-6.1-sol"));
		const charges = (width: number, height: number) => {
			const data = pngWithSize(width, height);
			const local = tokenizer.countMessage({
				role: "user",
				content: [{ type: "image", data, mimeType: "image/png", detail: "original" }],
				timestamp: 0,
			});
			const item = { type: "input_image", detail: "original", image_url: `data:image/png;base64,${data}` };
			return { local, remote: countResponsesHistoryTokens([{ role: "user", content: [item] }], tokenizer) };
		};
		const large = charges(4000, 4000);
		const tiny = charges(1, 1);

		// GPT-5.6+ `original` has no patch budget: 125² patches × 1.2.
		expect(large.local).toBe(18_750);
		// Both histories serialize to the same text, so the difference is the image price alone.
		expect(large.remote - tiny.remote).toBe(large.local - tiny.local);
	});
});

describe("image-heavy remote compaction sizing", () => {
	// 1568px is omp's default resize cap, so this is what screenshots look like on the wire.
	const screenshot = pngWithSize(1568, 882);
	const imageCount = 25;

	test("a transcript under the local trigger is sendable for native compaction", () => {
		const images = Array.from({ length: imageCount }, () => ({
			type: "image" as const,
			data: screenshot,
			mimeType: "image/png",
		}));
		const message: UserMessage = { role: "user", content: images, timestamp: 0 };
		const localTokens = new Tokenizer().countMessage(message);
		const contextWindow = localTokens + 2_000;
		const input = [
			{
				type: "message",
				role: "user",
				content: images.map(() => ({
					type: "input_image",
					detail: "auto",
					image_url: `data:image/png;base64,${screenshot}`,
				})),
			},
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), contextWindow, "compact");

		expect(result.fits).toBe(true);
		expect(result.rewrittenOutputs).toBe(0);
	});

	test("sends an over-estimate caused only by images instead of refusing it", () => {
		const input = [
			{
				type: "message",
				role: "user",
				content: Array.from({ length: imageCount }, () => ({
					type: "input_image",
					detail: "original",
					image_url: "https://example.com/screenshot.png",
				})),
			},
			{ type: "function_call_output", call_id: "call_1", output: "useful result" },
		];

		const result = trimRemoteCompactionInputToContextWindow(input, new Tokenizer(), 50_000, "compact");

		expect(result.estimatedTokensBefore).toBeGreaterThan(50_000);
		expect(result.fits).toBe(true);
		expect(result.rewrittenOutputs).toBe(0);
		expect(result.input).toEqual(input);
	});
});
