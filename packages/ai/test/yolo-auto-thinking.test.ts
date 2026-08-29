import { describe, expect, test } from "bun:test";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "../../catalog/src/build";
import { Effort } from "../../catalog/src/effort";
import { YOLO_AUTO_STATIC_MODELS } from "../../catalog/src/provider-models/openai-compat";
import { streamOpenAICompletions } from "../src/providers/openai-completions";

const model = buildModel(YOLO_AUTO_STATIC_MODELS[0]) as Model<"openai-completions">;

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

describe("Yolo-Auto chat-template thinking wire format", () => {
	test("enables thinking in chat_template_kwargs", async () => {
		const body = await outgoingBody({ reasoning: Effort.Low });
		expect(body.chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: "low" });
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	test("disables thinking in chat_template_kwargs", async () => {
		const body = await outgoingBody({ disableReasoning: true });
		expect(body.chat_template_kwargs).toEqual({ thinking: false });
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	test("maps and forwards the selected effort in chat_template_kwargs", async () => {
		const body = await outgoingBody({ reasoning: Effort.XHigh });
		expect(body.chat_template_kwargs).toEqual({ thinking: true, reasoning_effort: "max" });
		expect(body).not.toHaveProperty("reasoning_effort");
	});
});
