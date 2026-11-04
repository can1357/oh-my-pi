import { expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { lastDispatchOrigin, transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";

it("refuses a later HTTP attempt after the cost gate closes without recording a dispatch", async () => {
	const model = buildModel({
		id: "cost-gate-attempt",
		name: "Cost Gate Attempt",
		api: "openai-completions",
		provider: "test-cost-gate-transport",
		baseUrl: "https://first.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	});
	let admitted = 0;
	let sent = 0;
	const fetch = transportFetch(
		model,
		async () => {
			sent++;
			return new Response("retryable", { status: 429 });
		},
		() => {
			if (++admitted > 1) throw new Error("cost cap reached");
		},
	);
	await fetch("https://first.invalid/v1/chat/completions", { method: "POST" });
	await expect(fetch("https://second.invalid/v1/chat/completions", { method: "POST" })).rejects.toThrow(
		"cost cap reached",
	);
	expect(sent).toBe(1);
	expect(lastDispatchOrigin(model)).toBe("https://first.invalid");
});
