import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { TranscriptionApiError, transcribeAudio } from "@oh-my-pi/pi-ai/transcription";

const AUDIO = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x01, 0x02, 0x03, 0x04]);

const model: Model<Api> = buildModel({
	id: "codex-transcribe",
	name: "Codex Dictation",
	api: "openai-codex-transcriptions",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: null,
	maxTokens: null,
	kind: "stt",
} satisfies ModelSpec<Api>);

/** Unsigned JWT carrying the ChatGPT account claim the Codex backend routes on. */
function codexToken(accountId: string): string {
	const payload = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }));
	return `header.${payload}.signature`;
}

describe("openai-codex-transcriptions transport", () => {
	it("posts audio to the ChatGPT dictation endpoint as the Codex Desktop client", async () => {
		const seen: Array<{ url: string; method?: string; headers: Headers; form: FormData }> = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			if (!(init?.body instanceof FormData)) throw new Error("Expected multipart body");
			seen.push({ url: String(input), method: init.method, headers: new Headers(init.headers), form: init.body });
			return Response.json({
				text: "Ask not.",
				asset_pointer: "sediment://x",
				asset_ttl: "30d",
				asset_format: "flac",
			});
		};

		const result = await transcribeAudio(
			model,
			{
				audio: AUDIO,
				mimeType: "audio/flac",
				fileName: "jfk.flac",
				language: "en",
				prompt: "ignored",
				temperature: 0.2,
				responseFormat: "verbose_json",
				timestampGranularities: ["word"],
			},
			{ apiKey: codexToken("acct-1"), fetch: fetchImpl },
		);

		expect(result.text).toBe("Ask not.");
		expect(result.usage.cost.total).toBe(0);
		expect(seen).toHaveLength(1);
		const [request] = seen;
		expect(request?.url).toBe("https://chatgpt.com/backend-api/transcribe");
		expect(request?.method).toBe("POST");
		// Cloudflare 403s the backend unless it sees the Codex Desktop identity.
		expect(request?.headers.get("authorization")).toBe(`Bearer ${codexToken("acct-1")}`);
		expect(request?.headers.get("chatgpt-account-id")).toBe("acct-1");
		expect(request?.headers.get("originator")).toBe("Codex Desktop");
		expect(request?.headers.get("user-agent")).toStartWith("Codex Desktop/");
		// The endpoint takes only `file` and `language`; OpenAI-only fields are dropped.
		expect([...(request?.form.keys() ?? [])]).toEqual(["file", "language"]);
		const file = request?.form.get("file");
		if (!(file instanceof File)) throw new Error("Expected audio file part");
		expect(file.name).toBe("jfk.flac");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO);
		expect(request?.form.get("language")).toBe("en");
	});

	it("renames an upload whose extension the endpoint cannot decode after its declared container", async () => {
		// The backend answers 500 for Ogg/Opus unless the upload is named `*.ogg`; `.oga` and bare names fail.
		let uploaded: string | undefined;
		const fetchImpl: FetchImpl = async (_input, init) => {
			const file = init?.body instanceof FormData ? init.body.get("file") : null;
			uploaded = file instanceof File ? file.name : undefined;
			return Response.json({ text: "ok" });
		};
		await transcribeAudio(
			model,
			{ audio: AUDIO, mimeType: "audio/ogg", fileName: "voice.oga", responseFormat: "json" },
			{ apiKey: codexToken("acct-1"), fetch: fetchImpl },
		);
		expect(uploaded).toBe("audio.ogg");
	});

	it("surfaces backend ASR failures as TranscriptionApiError with the upstream detail", async () => {
		const fetchImpl: FetchImpl = async () => Response.json({ detail: "Error in ASR API" }, { status: 500 });
		const failure = transcribeAudio(
			model,
			{ audio: AUDIO, mimeType: "audio/ogg", fileName: "clip.ogg", responseFormat: "json" },
			{ apiKey: codexToken("acct-1"), fetch: fetchImpl },
		);
		await expect(failure).rejects.toBeInstanceOf(TranscriptionApiError);
		await expect(failure).rejects.toMatchObject({
			status: 500,
			message: "openai-codex/codex-transcribe transcription API error (500): Error in ASR API",
		});
	});

	it("bounds an HTML error page from Cloudflare instead of embedding it whole in the message", async () => {
		const page = `<html>${"x".repeat(20_000)}</html>`;
		const fetchImpl: FetchImpl = async () => new Response(page, { status: 403 });
		const failure = transcribeAudio(
			model,
			{ audio: AUDIO, mimeType: "audio/wav", fileName: "dictation.wav", responseFormat: "json" },
			{ apiKey: codexToken("acct-1"), fetch: fetchImpl },
		);
		await expect(failure).rejects.toMatchObject({
			status: 403,
			message: `openai-codex/codex-transcribe transcription API error (403): ${page.slice(0, 500)}`,
		});
	});

	it("retries a 401 with the resolver's next credential and that credential's account", async () => {
		const accounts: Array<string | null> = [];
		const fetchImpl: FetchImpl = async (_input, init) => {
			const headers = new Headers(init?.headers);
			accounts.push(headers.get("chatgpt-account-id"));
			if (accounts.length === 1) return Response.json({ detail: "Unauthorized" }, { status: 401 });
			return Response.json({ text: "after refresh" });
		};
		const result = await transcribeAudio(
			model,
			{ audio: AUDIO, mimeType: "audio/wav", fileName: "dictation.wav", responseFormat: "json" },
			{
				apiKey: ctx => (ctx.error === undefined ? codexToken("acct-old") : codexToken("acct-new")),
				fetch: fetchImpl,
			},
		);
		expect(result.text).toBe("after refresh");
		expect(accounts).toEqual(["acct-old", "acct-new"]);
	});
});
