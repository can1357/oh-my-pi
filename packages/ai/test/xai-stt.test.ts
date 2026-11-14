import { describe, expect, it } from "bun:test";
import { ValidationError } from "@oh-my-pi/pi-ai/error";
import { isTranscriptionApi, TranscriptionApiError, transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x01]);

function xaiSttModel(): Model<Api> {
	return buildModel({
		id: "grok-voice-transcribe-2.0",
		name: "Grok Voice Transcribe 2.0",
		api: "xai-stt",
		provider: "xai-oauth",
		baseUrl: "https://api.x.ai/v1/",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
	});
}

interface Captured {
	url: string;
	method: string | undefined;
	authorization: string | null;
	contentType: string | null;
	fields: Array<[string, string]>;
	file: File;
}

function upstream(response: () => Response): { fetch: FetchImpl; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetch: FetchImpl = async (input, init) => {
		if (!(init?.body instanceof FormData)) throw new Error("expected multipart body");
		const fields: Array<[string, string]> = [];
		let file: File | undefined;
		const body = init.body;
		for (const key of body.keys()) {
			const value = body.get(key);
			if (value instanceof File) {
				file = value;
				fields.push([key, `<file ${value.name}>`]);
			} else fields.push([key, String(value)]);
		}
		if (!file) throw new Error("expected audio file");
		const headers = new Headers(init.headers);
		calls.push({
			url: String(input),
			method: init.method,
			authorization: headers.get("authorization"),
			contentType: headers.get("content-type"),
			fields,
			file,
		});
		return response();
	};
	return { fetch, calls };
}

describe("xai-stt transcription runner", () => {
	it("is a dispatchable transcription API", () => {
		expect(isTranscriptionApi("xai-stt")).toBe(true);
		expect(isTranscriptionApi("openai-transcriptions")).toBe(true);
		expect(isTranscriptionApi("xai-tts")).toBe(false);
	});

	it("posts model and language before the file and maps xAI words", async () => {
		const { fetch, calls } = upstream(() =>
			Response.json({
				text: "Hello brave world.",
				language: "en",
				duration: 1.62,
				words: [
					{ text: "Hello", start: 0.1, end: 0.42 },
					{ text: "brave", start: 0.42, end: 0.8, speaker: 0 },
					{ text: "world.", start: 0.8, end: 1.3 },
				],
			}),
		);

		const result = await transcribeAudio(
			xaiSttModel(),
			{ audio: AUDIO, mimeType: "audio/mpeg", fileName: "clip.mp3", language: "en", responseFormat: "json" },
			{ apiKey: "xai-token", fetch },
		);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe("https://api.x.ai/v1/stt");
		expect(call.method).toBe("POST");
		expect(call.authorization).toBe("Bearer xai-token");
		expect(call.contentType).toBeNull();
		expect(call.fields).toEqual([
			["model", "grok-voice-transcribe-2.0"],
			["language", "en"],
			["file", "<file clip.mp3>"],
		]);
		expect(call.file.type).toBe("audio/mpeg");
		expect(new Uint8Array(await call.file.arrayBuffer())).toEqual(AUDIO);

		expect(result).toMatchObject({
			text: "Hello brave world.",
			language: "en",
			duration: 1.62,
			words: [
				{ word: "Hello", start: 0.1, end: 0.42 },
				{ word: "brave", start: 0.42, end: 0.8, speaker: 0 },
				{ word: "world.", start: 0.8, end: 1.3 },
			],
			usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
		});
		expect(result.words?.[0]).not.toHaveProperty("text");
		expect(result.segments).toBeUndefined();
	});

	it("omits language when the caller sets none", async () => {
		const { fetch, calls } = upstream(() => Response.json({ text: "hi" }));
		const result = await transcribeAudio(
			xaiSttModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: "xai-token", fetch },
		);
		expect(calls[0].fields).toEqual([
			["model", "grok-voice-transcribe-2.0"],
			["file", "<file audio>"],
		]);
		expect(result.text).toBe("hi");
		expect(result.words).toBeUndefined();
	});

	it("rejects OpenAI-only options before dispatch", async () => {
		const { fetch, calls } = upstream(() => Response.json({ text: "unused" }));
		const base = { audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" as const };
		for (const extra of [
			{ prompt: "Names" },
			{ temperature: 0.2 },
			{ timestampGranularities: ["segment" as const] },
		]) {
			await expect(
				transcribeAudio(xaiSttModel(), { ...base, ...extra }, { apiKey: "xai-token", fetch }),
			).rejects.toBeInstanceOf(ValidationError);
		}
		expect(calls).toHaveLength(0);
	});

	it("surfaces upstream HTTP errors and malformed words", async () => {
		const failing = upstream(() => Response.json({ code: "forbidden", error: "no access" }, { status: 403 }));
		const error = await transcribeAudio(
			xaiSttModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: "xai-token", fetch: failing.fetch },
		).catch(err => err);
		expect(error).toBeInstanceOf(TranscriptionApiError);
		expect(error.status).toBe(403);
		expect(error.message).toBe("xai-oauth/grok-voice-transcribe-2.0 transcription API error (403): no access");
		expect(error.code).toBe("forbidden");

		const malformed = upstream(() => Response.json({ text: "x", words: [{ text: "x", start: "0" }] }));
		await expect(
			transcribeAudio(
				xaiSttModel(),
				{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
				{ apiKey: "xai-token", fetch: malformed.fetch },
			),
		).rejects.toThrow(/transcription response is malformed: word 0/);
	});
});
