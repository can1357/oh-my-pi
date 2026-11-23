import { describe, expect, test } from "bun:test";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "../../catalog/src/build";
import { Effort } from "../../catalog/src/effort";
import { seedModels } from "../../catalog/src/compat/providers";
import { streamOpenAICompletions } from "../src/providers/openai-completions";

const seed = seedModels("yolo-auto").find(entry => entry.id === "qwen3.8-27b");
if (!seed) throw new Error("Yolo-Auto qwen3.8-27b seed missing");
const model = buildModel(seed) as Model<"openai-completions">;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function captureRequest(): { bodies: Record<string, unknown>[]; fetch: FetchImpl } {
	const bodies: Record<string, unknown>[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		if (typeof init?.body === "string") {
			const parsed: unknown = JSON.parse(init.body);
			if (typeof parsed === "object" && parsed !== null) bodies.push(parsed as Record<string, unknown>);
		}
		const chunk = JSON.stringify({
			id: "chatcmpl-yolo",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		});
		return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { bodies, fetch };
}

async function outgoingBody(options: {
	reasoning?: Effort;
	disableReasoning?: boolean;
}): Promise<Record<string, unknown>> {
	const { bodies, fetch } = captureRequest();
	await streamOpenAICompletions(model, context, { apiKey: "yolo-test-key", fetch, ...options }).result();
	const body = bodies[0];
	if (!body) throw new Error("Yolo-Auto request was not captured");
	return body;
}

describe("Yolo-Auto Qwen chat-template thinking wire format", () => {
	test("enables thinking and forwards the effort in chat_template_kwargs", async () => {
		const body = await outgoingBody({ reasoning: Effort.XHigh });
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "xhigh" });
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	test("disables thinking in chat_template_kwargs", async () => {
		const body = await outgoingBody({ disableReasoning: true });
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body).not.toHaveProperty("reasoning_effort");
	});
});
