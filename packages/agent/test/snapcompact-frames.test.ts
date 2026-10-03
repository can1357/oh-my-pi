import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createCompactionSummaryMessage, defaultConvertToLlm } from "../src/compaction/messages";
import { Tokenizer } from "../src/tokenizer";

const tokenizer = new Tokenizer();

describe("compaction summary message with snapcompact frames", () => {
	const images: ImageContent[] = [
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
	];

	it("countMessage charges per attached frame", () => {
		const bare = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString());
		const withFrames = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString(), { images });
		expect(tokenizer.countMessage(withFrames) - tokenizer.countMessage(bare)).toBe(
			2 * snapcompact.FRAME_TOKEN_ESTIMATE,
		);
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
