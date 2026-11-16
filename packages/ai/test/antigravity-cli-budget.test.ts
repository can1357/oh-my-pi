import { describe, expect, it } from "bun:test";
import {
	ACP_STEP_TEXT_BYTES,
	checkPromptBudget,
	MAX_IMAGE_BYTES,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/budget";
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";

const model = { id: "gemini-3.8-flash" };

function text(value: string): ContentBlock {
	return { type: "text", text: value };
}

function ascii(bytes: number): ContentBlock {
	return text("a".repeat(bytes));
}

function image(decodedBytes: number): ContentBlock {
	return { type: "image", data: Buffer.alloc(decodedBytes).toString("base64"), mimeType: "image/png" };
}

describe("checkPromptBudget", () => {
	it("accepts a prompt that fits both budgets", () => {
		expect(checkPromptBudget([], model)).toBeUndefined();
		expect(checkPromptBudget([ascii(ACP_STEP_TEXT_BYTES)], model)).toBeUndefined();
		expect(checkPromptBudget([ascii(100_000), ascii(88_000)], model)).toBeUndefined();
		expect(checkPromptBudget([ascii(ACP_STEP_TEXT_BYTES), image(MAX_IMAGE_BYTES)], model)).toBeUndefined();
	});

	it("rejects text that crosses the step budget across blocks", () => {
		const single = checkPromptBudget([ascii(ACP_STEP_TEXT_BYTES + 1)], model);
		expect(single).toContain("188001 bytes of text in one step");
		expect(single).toContain("safe single-step budget is 188000 bytes");
		expect(single).toContain("gemini-3.8-flash");
		expect(single).toContain("silently truncated");
		expect(checkPromptBudget([ascii(100_000), ascii(88_001)], model)).toContain("188001 bytes of text in one step");
		expect(checkPromptBudget([ascii(60_000), ascii(60_000), ascii(60_000), ascii(8_001)], model)).toContain(
			"188001 bytes of text in one step",
		);
	});

	it("measures UTF-8 bytes instead of characters", () => {
		expect(checkPromptBudget([text("😀".repeat(47_000))], model)).toBeUndefined();
		expect(checkPromptBudget([text("😀".repeat(47_001))], model)).toContain("188004 bytes of text");
		expect(checkPromptBudget([text("é".repeat(94_000))], model)).toBeUndefined();
		expect(checkPromptBudget([text("é".repeat(94_001))], model)).toContain("188002 bytes of text");
		expect(checkPromptBudget([text("漢".repeat(62_666))], model)).toBeUndefined();
		expect(checkPromptBudget([text("漢".repeat(62_667))], model)).toContain("188001 bytes of text");
		expect(checkPromptBudget([text("😀".repeat(30_000)), text("漢".repeat(22_667))], model)).toContain(
			"188001 bytes of text",
		);
		expect(checkPromptBudget([text("😀".repeat(30_000)), text("漢".repeat(22_666))], model)).toBeUndefined();
	});

	it("rejects images over the decoded image budget with the 413 payload wording", () => {
		const error = checkPromptBudget([image(MAX_IMAGE_BYTES + 1)], model);
		expect(error).toContain("Request payload too large (413)");
		expect(error).toContain("would send 8388609 bytes of images");
		expect(error).toContain("local ACP image budget is 8388608 bytes");
		expect(error).toContain("No images were silently omitted");
	});

	it("counts images by decoded bytes rather than base64 characters", () => {
		const data = "A".repeat(16_777_220);
		expect(Buffer.byteLength(data, "base64")).toBe(12_582_915);
		const error = checkPromptBudget([{ type: "image", data, mimeType: "image/png" }], model);
		expect(error).toContain("would send 12582915 bytes of images");
		expect(error).toContain("local ACP image budget");
	});
});
