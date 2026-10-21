// Contract: an `audio/*` inline block reaches models that hear audio as the transport's audio
// part (Google inline data, an `input_audio` part on Chat Completions and Responses), and
// `audioInputMimeType` names the encoding only where the model and its transport both carry it.
import { describe, expect, it } from "bun:test";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { convertResponsesInputContent } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { audioInputMimeType } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Api, Context, FetchImpl, Model, UserMessage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const AUDIO_B64 = Buffer.from("opaque audio bytes").toString("base64");

function audioMessage(mimeType: string): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "image", data: AUDIO_B64, mimeType },
			{ type: "text", text: "Transcribe this." },
		],
		timestamp: 0,
	};
}

function hearing<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	return { ...model, input: ["text", "audio"] };
}

describe("audio input", () => {
	const gemini = getBundledModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
	const gpt = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;

	it("names the encoding a model's transport carries only when the model hears audio", () => {
		expect(audioInputMimeType(hearing(gemini))).toBe("audio/ogg");
		expect(audioInputMimeType(hearing({ ...gpt, api: "openai-completions" }))).toBe("audio/mpeg");
		expect(audioInputMimeType(hearing({ ...gpt, api: "openrouter" }))).toBe("audio/mpeg");
		expect(audioInputMimeType({ ...gpt, api: "openai-completions", input: ["text", "image"] })).toBeUndefined();
		expect(audioInputMimeType(hearing({ ...gpt, api: "anthropic-messages" }))).toBeUndefined();
		expect(audioInputMimeType(hearing({ ...gemini, transport: "pi-native" }))).toBeUndefined();
	});

	it("google sends the audio as inline data", () => {
		const contents = convertGoogleMessages(hearing(gemini), { messages: [audioMessage("audio/ogg")] });

		expect(contents[0].parts).toContainEqual({ inlineData: { mimeType: "audio/ogg", data: AUDIO_B64 } });
	});

	it("responses sends an input_audio part even when the model takes no images", () => {
		const message = audioMessage("audio/mpeg");
		if (!Array.isArray(message.content)) throw new Error("expected array content");

		const converted = convertResponsesInputContent(message.content, false, false);

		expect(converted).toEqual([
			{ type: "input_text", text: "Transcribe this." },
			{ type: "input_audio", input_audio: { data: AUDIO_B64, format: "mp3" } },
		]);
	});

	it("completions sends an input_audio part instead of an image_url", async () => {
		const model = hearing({ ...gpt, api: "openai-completions" }) satisfies Model<"openai-completions">;
		let captured: { messages?: Array<{ content: unknown }> } | undefined;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const sse =
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n` +
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
				"data: [DONE]\n\n";
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as FetchImpl;

		const context: Context = { messages: [audioMessage("audio/mpeg")] };
		await streamOpenAICompletions(model, context, { apiKey: "test", fetch: fetchImpl }).result();

		expect(captured?.messages?.at(-1)?.content).toEqual([
			{ type: "input_audio", input_audio: { data: AUDIO_B64, format: "mp3" } },
			{ type: "text", text: "Transcribe this." },
		]);
	});
});
