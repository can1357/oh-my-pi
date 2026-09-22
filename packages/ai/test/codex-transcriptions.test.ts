import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { transcribeAudio } from "../src/transcription";

// A Codex bearer is a JWT whose auth claim carries the account id; the
// transport reads it from the key rather than a separate credential.
function codexKey(accountId: string): string {
	const claim = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode(claim)}.sig`;
}

const model = buildModel({
	provider: "openai-codex",
	id: "chatgpt-transcribe",
	name: "ChatGPT Transcribe",
	api: "openai-codex-transcriptions",
	baseUrl: "https://chatgpt.com/backend-api",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as ModelSpec);

const request = {
	audio: new Uint8Array([1, 2, 3, 4]),
	mimeType: "audio/wav",
	fileName: "dictation.wav",
	responseFormat: "json",
	language: "en",
	prompt: "omp, dictation",
} as const;

describe("ChatGPT subscription transcription", () => {
	test("posts only the audio file to the backend dictation route with Codex identity", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fetchImpl = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ text: "hello", asset_pointer: "sediment://x" }), { status: 200 });
		}) as unknown as typeof fetch;

		const result = await transcribeAudio(model, request, { apiKey: codexKey("acct-1"), fetch: fetchImpl });

		expect(result.text).toBe("hello");
		// The subscription pays; a non-zero tariff here would bill the user twice.
		expect(result.usage.cost.total).toBe(0);
		expect(seen?.url).toBe("https://chatgpt.com/backend-api/transcribe");
		const headers = seen?.init.headers as Headers;
		expect(headers.get("chatgpt-account-id")).toBe("acct-1");
		expect(headers.get("Authorization")).toBe(`Bearer ${codexKey("acct-1")}`);
		// fetch must own the multipart boundary.
		expect(headers.get("Content-Type")).toBeNull();
		const body = seen?.init.body as FormData;
		expect(body.has("file")).toBe(true);
		// The route rejects the platform fields; sending them 400s the upload.
		expect(body.has("model")).toBe(false);
		expect(body.has("language")).toBe(false);
		expect(body.has("prompt")).toBe(false);
		expect(body.has("response_format")).toBe(false);
	});

	test("surfaces the upstream status when the route rejects the upload", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 })) as unknown as typeof fetch;

		await expect(transcribeAudio(model, request, { apiKey: codexKey("acct-1"), fetch: fetchImpl })).rejects.toThrow(
			/404/,
		);
	});

	test("rejects a bearer without an account id instead of uploading", async () => {
		let called = false;
		const fetchImpl = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await expect(transcribeAudio(model, request, { apiKey: "sk-not-a-codex-jwt", fetch: fetchImpl })).rejects.toThrow(
			/account id/,
		);
		expect(called).toBe(false);
	});
});
