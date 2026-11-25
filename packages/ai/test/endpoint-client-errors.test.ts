import { describe, expect, it } from "bun:test";
import { embed } from "@oh-my-pi/pi-ai/embeddings";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import { pollVideo } from "@oh-my-pi/pi-ai/video";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function model(api: Api, id: string, kind: "embedding" | "stt" | "video"): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind,
	} satisfies ModelSpec<Api>);
}

/** An upstream that answers every request with `body` and a 400. */
function failing(body: string): FetchImpl {
	return async () => new Response(body, { status: 400, statusText: "Bad Request" });
}

const embedWith = (body: string) =>
	embed(
		model("openai-embeddings", "text-embedding-3-small", "embedding"),
		{ input: "hi", encodingFormat: "float" },
		{ apiKey: "k", fetch: failing(body) },
	);

describe("endpoint client errors", () => {
	it("embeddings surface the nested envelope's message and code", async () => {
		const body = JSON.stringify({
			error: { message: "quota exceeded", code: "insufficient_quota", type: "billing" },
		});
		await expect(embedWith(body)).rejects.toMatchObject({
			message: "openrouter/text-embedding-3-small embeddings API error (400): quota exceeded",
			code: "insufficient_quota",
			status: 400,
		});
	});

	it("embeddings surface a flat string error instead of the JSON body", async () => {
		await expect(embedWith('{"error":"model overloaded"}')).rejects.toThrow(
			"embeddings API error (400): model overloaded",
		);
	});

	it("transcription surfaces a top-level message instead of the JSON body", async () => {
		const run = transcribeAudio(
			model("openai-transcriptions", "whisper-1", "stt"),
			{ audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: "k", fetch: failing('{"message":"unsupported audio"}') },
		);
		await expect(run).rejects.toThrow("transcription API error (400): unsupported audio");
	});

	it("an empty envelope message falls back to the status text, not the JSON body", async () => {
		await expect(embedWith('{"error":{"message":"","type":"server_error"}}')).rejects.toThrow(
			"embeddings API error (400): Bad Request",
		);
		const poll = pollVideo(model("openrouter-video", "veo", "video"), "job-1", {
			apiKey: "k",
			fetch: failing('{"error":""}'),
		});
		await expect(poll).rejects.toThrow("video API error (400): Bad Request");
	});

	it("a usable top-level message wins over an error that carries no text", async () => {
		await expect(embedWith('{"error":"","message":"The input file is unsupported"}')).rejects.toThrow(
			"embeddings API error (400): The input file is unsupported",
		);
		await expect(
			embedWith('{"error":{"code":"bad_input","message":null},"message":"The input file is unsupported"}'),
		).rejects.toMatchObject({
			message: "openrouter/text-embedding-3-small embeddings API error (400): The input file is unsupported",
			code: "bad_input",
		});
	});

	it("a flat quota rejection keeps its code, so the request moves to a sibling credential", async () => {
		const keys: string[] = [];
		const upstream: FetchImpl = async (_input, init) => {
			const key = new Headers(init?.headers).get("authorization");
			keys.push(String(key));
			if (key === "Bearer exhausted") {
				return new Response('{"message":"Request rejected","code":"insufficient_quota"}', { status: 429 });
			}
			return Response.json({
				object: "list",
				data: [{ object: "embedding", index: 0, embedding: [0.5] }],
				model: "text-embedding-3-small",
				usage: { prompt_tokens: 1, total_tokens: 1 },
			});
		};
		const result = await embed(
			model("openai-embeddings", "text-embedding-3-small", "embedding"),
			{ input: "hi", encodingFormat: "float" },
			{ apiKey: ctx => (ctx.error === undefined ? "exhausted" : "sibling"), fetch: upstream },
		);
		expect(result.embeddings).toEqual([{ index: 0, embedding: [0.5] }]);
		expect(keys).toEqual(["Bearer exhausted", "Bearer sibling"]);
	});
	it("a body that is not an envelope is reported as-is", async () => {
		await expect(embedWith("upstream timed out")).rejects.toThrow("embeddings API error (400): upstream timed out");
	});
});
