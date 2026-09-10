import { describe, expect, it } from "bun:test";
import { handleCountTokens } from "@oh-my-pi/pi-ai/providers/anthropic-count-tokens-server";

const resolve = (id: string) => (id === "claude" ? { contextWindow: 200_000 } : undefined);

describe("handleCountTokens", () => {
	it("rejects missing messages (negative)", async () => {
		const res = await handleCountTokens(
			new Request("http://local/v1/messages/count_tokens", {
				method: "POST",
				body: JSON.stringify({ model: "claude" }),
			}),
			resolve,
		);
		expect(res.status).toBe(400);
	});

	it("rejects non-array messages (negative)", async () => {
		const res = await handleCountTokens(
			new Request("http://local/v1/messages/count_tokens", {
				method: "POST",
				body: JSON.stringify({ model: "claude", messages: "invalid" }),
			}),
			resolve,
		);
		expect(res.status).toBe(400);
	});

	it("counts system and tools in the estimate", async () => {
		const base = await handleCountTokens(
			new Request("http://local/v1/messages/count_tokens", {
				method: "POST",
				body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] }),
			}),
			resolve,
		);
		const withSystem = await handleCountTokens(
			new Request("http://local/v1/messages/count_tokens", {
				method: "POST",
				body: JSON.stringify({
					model: "claude",
					system: "x".repeat(400),
					messages: [{ role: "user", content: "hi" }],
				}),
			}),
			resolve,
		);
		const baseJson = (await base.json()) as { input_tokens: number };
		const sysJson = (await withSystem.json()) as { input_tokens: number };
		expect(sysJson.input_tokens).toBeGreaterThan(baseJson.input_tokens);
	});
});
