// A user/developer message whose `content` is neither a string nor a block
// array (lossy session rebuild / third-party extension) previously crashed
// provider request builds with a bare `for...of` over `content`
// (`undefined is not an object (evaluating 'I of g.content')`), surfacing as
// `stopReason: "error"` on the first turn after compaction. transformMessages
// must normalize such content to a harmless placeholder instead.
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { Message, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		name: "GPT Test",
		id: "gpt-test",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 8192,
		maxTokens: 2048,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function malformedUser(): Message {
	// Cast needed: the type system guarantees content, but the runtime can see
	// malformed messages from extensions/lossy rebuilds.
	return { role: "user", content: undefined, timestamp: Date.now() } as unknown as Message;
}

describe("transformMessages malformed-content normalization", () => {
	it("replaces undefined user content with a text placeholder", () => {
		const messages: Message[] = [malformedUser()];
		const out = transformMessages(messages, makeModel());
		expect(out).toHaveLength(1);
		const user = out[0] as { role: string; content: Array<{ type: string; text: string }> };
		expect(user.role).toBe("user");
		expect(Array.isArray(user.content)).toBe(true);
		expect(user.content[0].type).toBe("text");
	});

	it("leaves well-formed string and array content untouched", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() } as Message,
			{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as Message,
		];
		const out = transformMessages(messages, makeModel());
		expect(out).toHaveLength(2);
		expect((out[0] as { content: string }).content).toBe("hello");
		expect((out[1] as { content: Array<{ text: string }> }).content[0].text).toBe("hi");
	});
});
