import { describe, expect, it } from "bun:test";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { Agent } from "../src/agent";
import { createCompactionSummaryMessage, defaultConvertToLlm } from "../src/compaction/messages";
import { base64ImageSize } from "../src/image-tokens";
import { Tokenizer } from "../src/tokenizer";

const tokenizer = new Tokenizer();

function bundled(provider: "anthropic" | "openai-codex", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled ${provider}/${id}`);
	return model;
}

/** A real frame rendered in `shape`, as the archive would attach it; full-height unless `text` is short. */
async function frameImage(shape: snapcompact.Shape, text?: string): Promise<ImageContent> {
	const fill = "the archived transcript ".repeat(Math.ceil(snapcompact.geometry(shape).capacity / 24) + 1);
	const frame = await snapcompact.render(text ?? fill, shape);
	return { type: "image", data: frame.data, mimeType: "image/png" };
}

/** Tokens `counter` charges for `frames` inside a compaction summary, beyond its text. */
function frameCharge(counter: Tokenizer, frames: ImageContent[]): number {
	const withFrames = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString(), {
		blocks: [{ type: "text", text: "archive" }, ...frames],
	});
	const textOnly = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString(), {
		blocks: [{ type: "text", text: "archive" }],
	});
	return counter.countMessage(withFrames) - counter.countMessage(textOnly);
}

describe("compaction summary message with snapcompact frames", () => {
	const images: ImageContent[] = [
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
	];

	it("charges frames whose size cannot be read at the conservative ceiling", () => {
		const bare = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString());
		const withFrames = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString(), { images });
		expect(tokenizer.countMessage(withFrames) - tokenizer.countMessage(bare)).toBe(
			2 * snapcompact.FRAME_TOKEN_ESTIMATE,
		);
	});

	it("charges each frame what its reading model bills for the frame's size", async () => {
		const codex = { api: "openai-codex-responses", id: "gpt-6-astra" } as const;
		const opus = { api: "anthropic-messages", id: "claude-opus-5-5" } as const;
		const gemini = { api: "google-generative-ai", id: "gemini-3-pro-preview" } as const;
		const codexShape = snapcompact.resolveShape(codex);
		const opusShape = snapcompact.resolveShape(opus);
		const geminiShape = snapcompact.resolveShape(gemini);
		expect(codexShape.frameSize).toBe(1568);
		expect(opusShape.frameSize).toBe(1932);
		expect(geminiShape.frameSize).toBe(2048);

		const codexFrames = [await frameImage(codexShape), await frameImage(codexShape)];
		expect(base64ImageSize(codexFrames[0].data)).toEqual({ width: 1568, height: 1562 });
		// Codex bills 32px patches × 1.2: 49² × 1.2 = 2,882 per full 1568px frame.
		expect(frameCharge(new Tokenizer(codex), codexFrames)).toBe(2 * 2882);
		expect(codexShape.frameTokenEstimate).toBe(2882);

		// A short frame (height hugs its rows) bills only the patches it covers.
		const shortFrame = await frameImage(codexShape, "the archived transcript ".repeat(20));
		const shortSize = base64ImageSize(shortFrame.data);
		if (!shortSize) throw new Error("Expected a readable frame size");
		expect(shortSize.height).toBeLessThan(1568);
		expect(frameCharge(new Tokenizer(codex), [shortFrame])).toBe(
			Math.ceil(49 * Math.ceil(shortSize.height / 32) * 1.2),
		);

		const opusFrames = [await frameImage(opusShape)];
		// Claude's high-res tier bills 28px patches: 69² = 4,761.
		expect(frameCharge(new Tokenizer(opus), opusFrames)).toBe(4761);
		expect(frameCharge(new Tokenizer(opus), opusFrames)).toBe(opusShape.frameTokenEstimate);

		// Gemini bills a fixed 1,120 per image regardless of its 2048px size.
		expect(frameCharge(new Tokenizer(gemini), [await frameImage(geminiShape)])).toBe(1120);
	});

	it("re-prices the archive when the active model's frame billing changes", async () => {
		const opusFrame = await frameImage(
			snapcompact.resolveShape({ api: "anthropic-messages", id: "claude-opus-5-5" }),
		);
		// Same (absent) encoding on every model, so only the frame billing can force a new tokenizer.
		const opus55: Model = { ...bundled("anthropic", "claude-opus-5-5"), tokenizer: undefined };
		const opus46: Model = { ...bundled("anthropic", "claude-opus-4-6"), tokenizer: undefined };
		const opus48: Model = { ...bundled("anthropic", "claude-opus-4-8"), tokenizer: undefined };
		const codexModel: Model = { ...bundled("openai-codex", "gpt-6-astra"), tokenizer: undefined };
		const agent = new Agent({ initialState: { model: opus55, systemPrompt: [], tools: [], messages: [] } });
		const charges = [frameCharge(agent.tokenizer, [opusFrame])];
		for (const model of [codexModel, opus46, opus48]) {
			agent.setModel(model);
			charges.push(frameCharge(agent.tokenizer, [opusFrame]));
		}
		// The same full 1932×1920 frame: Claude high-res 69² = 4,761; OpenAI 61·60 × 1.2
		// = 4,392; Opus 4.6 shrinks it under the standard tier's 1,568-token cap to
		// 40·39 = 1,560, and Opus 4.8 on the same API reads it high-res again.
		expect(charges).toEqual([4761, 4392, 1560, 4761]);
	});

	it("defaultConvertToLlm appends frames as image blocks after the summary text", () => {
		const message = createCompactionSummaryMessage("the snapcompact archive", 1000, new Date().toISOString(), {
			images,
		});
		const [converted] = defaultConvertToLlm([message]);
		expect(converted.role).toBe("user");
		const content = converted.content as Array<{ type: string; text?: string; data?: string }>;
		expect(content.length).toBe(3);
		expect(content[0].type).toBe("text");
		expect(content[0].text).toContain("the snapcompact archive");
		expect(content[1]).toEqual(images[0]);
		expect(content[2]).toEqual(images[1]);
	});
});
