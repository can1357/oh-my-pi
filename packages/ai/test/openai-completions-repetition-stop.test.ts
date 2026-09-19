import { expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { THINKING_LOOP_ERROR_MARKER } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const model = {
	...getBundledModel("openai", "gpt-4o-mini"),
	api: "openai-completions",
} as Model<"openai-completions">;

function chunk(choice: Record<string, unknown>): Record<string, unknown> {
	return {
		id: "synthetic-repetition",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, ...choice }],
	};
}

for (const reasons of [
	{ finish_reason: "repetition", stop_reason: "repetition_detected" },
	{ finish_reason: "repetition" },
	{ finish_reason: "stop", stop_reason: "repetition_detected" },
	{ stop_reason: "repetition_detected" },
]) {
	test(`provider repetition stop ${JSON.stringify(reasons)} is a ThinkingLoop with empty content`, async () => {
		// 64 characters stays below the local detector's 180-character floor so
		// classification comes from the server stop signal, not exact-cycle scan.
		const events = [
			...Array.from({ length: 32 }, () => chunk({ delta: { reasoning_content: "?!" }, finish_reason: null })),
			chunk({ delta: {}, ...reasons }),
		];
		const body = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
		let requests = 0;
		const mockFetch: FetchImpl = async () => {
			requests++;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		};

		const result = await streamOpenAICompletions(
			model,
			{ messages: [{ role: "user", content: "Say hello", timestamp: 0 }] },
			{ apiKey: "synthetic-unused", fetch: mockFetch },
		).result();

		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		expect(result.content).toEqual([]);
		expect(result.errorMessage).toContain(THINKING_LOOP_ERROR_MARKER);
		if (reasons.finish_reason) {
			expect(result.errorMessage).toContain(`finish_reason: ${reasons.finish_reason}`);
		}
		if (reasons.stop_reason) {
			expect(result.errorMessage).toContain(`stop_reason: ${reasons.stop_reason}`);
		}
	});
}
