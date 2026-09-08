import { describe, expect, it } from "bun:test";
import { handleCountTokens } from "@oh-my-pi/pi-ai/providers/anthropic-count-tokens-server";

function resolveKnown(id: string): { contextWindow?: number } | undefined {
	if (id === "claude-sonnet") {
		return { contextWindow: 200_000 };
	}
	return undefined;
}

function post(body: string): Request {
	return new Request("http://gateway/v1/messages/count_tokens", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
}

describe("handleCountTokens", () => {
	it("returns 404 for an unknown model (negative)", async () => {
		const res = await handleCountTokens(
			post(JSON.stringify({ model: "missing-model", messages: [{ role: "user", content: "hi" }] })),
			resolveKnown,
		);
		expect(res.status).toBe(404);
	});

	it("returns 200 with input_tokens >= 0 for a known model", async () => {
		const messages = [{ role: "user", content: "hello" }];
		const res = await handleCountTokens(post(JSON.stringify({ model: "claude-sonnet", messages })), resolveKnown);
		expect(res.status).toBe(200);
		const expected = Math.ceil(JSON.stringify(messages).length / 4);
		expect(expected).toBeGreaterThanOrEqual(0);
		expect(await res.json()).toEqual({ input_tokens: expected });
	});

	it("returns 400 for invalid JSON (negative)", async () => {
		const res = await handleCountTokens(post("{"), resolveKnown);
		expect(res.status).toBe(400);
	});
});
