import { afterEach, describe, expect, it, vi } from "bun:test";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { isCloudTranscriptionApi, transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Api, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { CODEX_BASE_URL, OPENAI_HEADERS, OPENAI_HEADER_VALUES, URL_PATHS } from "@oh-my-pi/pi-catalog/wire/codex";

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x57, 0x41, 0x56, 0x45]);

function codexModel(): Model<Api> {
	return buildModel({
		id: "transcribe",
		name: "Transcribe",
		api: "openai-codex-transcriptions",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
	} satisfies ModelSpec<Api>);
}

function codexToken(authClaims: Record<string, unknown> = { chatgpt_account_id: "acct-123" }): string {
	const payload = { "https://api.openai.com/auth": authClaims };
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64")}.signature`;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
	return fetchMock.mock.calls[0]! as [string, RequestInit];
}

afterEach(() => {
	setCodexAttestationProvider(undefined);
});

describe("transcribeAudio / openai-codex-transcriptions", () => {
	it("dispatches to the Codex transport and sends the subscription wire contract", async () => {
		const token = codexToken();
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ text: "transcribed" }), { status: 200 }));
		const result = await transcribeAudio(
			codexModel(),
			{ audio: AUDIO, mimeType: "audio/wav", fileName: "dictation.wav", responseFormat: "json" },
			{ apiKey: token, fetch: fetchMock as unknown as FetchImpl },
		);
		expect(result.text).toBe("transcribed");
		expect(result.usage).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = lastCall(fetchMock);
		expect(url).toBe(`${CODEX_BASE_URL}${URL_PATHS.TRANSCRIBE}`);
		expect(init.method).toBe("POST");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${token}`);
		expect(headers[OPENAI_HEADERS.ACCOUNT_ID]).toBe("acct-123");
		expect(headers[OPENAI_HEADERS.ORIGINATOR]).toBe(OPENAI_HEADER_VALUES.CODEX_DESKTOP.NAME);
		expect(headers["User-Agent"]).toBe(OPENAI_HEADER_VALUES.CODEX_DESKTOP.USER_AGENT);
		expect(headers[OPENAI_HEADERS.BETA]).toBe(OPENAI_HEADER_VALUES.BETA_RESPONSES);
		expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=----codex-transcribe-/);
		const body = init.body as Uint8Array;
		expect(headers["Content-Length"]).toBe(String(body.byteLength));
		const bodyText = new TextDecoder().decode(body);
		expect(bodyText).toContain('Content-Disposition: form-data; name="file"; filename="dictation.wav"');
		expect(bodyText).toContain("Content-Type: audio/wav\r\n\r\nRIFFWAVE");
		expect(bodyText.trimEnd().endsWith("----codex-transcribe-")).toBe(false);
	});

	it("declares workspace residency for region-pinned enterprise tokens", async () => {
		const token = codexToken({ chatgpt_account_id: "acct-123", chatgpt_data_residency: "eu" });
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "" }), { status: 200 }));
		await transcribeAudio(
			codexModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: token, fetch: fetchMock as unknown as FetchImpl },
		);
		const [, init] = lastCall(fetchMock);
		expect((init.headers as Record<string, string>)[OPENAI_HEADERS.RESIDENCY]).toBe("eu");
	});

	it("attaches the attestation header for the token's account when a provider is installed", async () => {
		setCodexAttestationProvider(async () => "attestation-value");
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "" }), { status: 200 }));
		await transcribeAudio(
			codexModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: codexToken(), fetch: fetchMock as unknown as FetchImpl },
		);
		const [, init] = lastCall(fetchMock);
		expect((init.headers as Record<string, string>)[OPENAI_HEADERS.ATTESTATION]).toBe("attestation-value");
	});

	it("sends neither account id nor attestation for tokens without a Codex account claim", async () => {
		setCodexAttestationProvider(async () => "attestation-value");
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "" }), { status: 200 }));
		await transcribeAudio(
			codexModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: "not-a-jwt", fetch: fetchMock as unknown as FetchImpl },
		);
		const headers = lastCall(fetchMock)[1].headers as Record<string, string>;
		expect(OPENAI_HEADERS.ACCOUNT_ID in headers).toBe(false);
		expect(OPENAI_HEADERS.ATTESTATION in headers).toBe(false);
	});

	it("surfaces upstream errors with status and detail", async () => {
		const fetchMock = vi.fn(
			() => new Response(JSON.stringify({ error: { message: "quota exhausted" } }), { status: 429 }),
		);
		const promise = transcribeAudio(
			codexModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: codexToken(), fetch: fetchMock as unknown as FetchImpl },
		);
		await expect(promise).rejects.toThrow("openai-codex/transcribe transcription API error (429): quota exhausted");
	});

	it("rejects responses without a text field", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const promise = transcribeAudio(
			codexModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: codexToken(), fetch: fetchMock as unknown as FetchImpl },
		);
		await expect(promise).rejects.toThrow("does not contain text");
	});

	it("identifies supported cloud transcription wire APIs", () => {
		expect(isCloudTranscriptionApi("openai-transcriptions")).toBe(true);
		expect(isCloudTranscriptionApi("openai-codex-transcriptions")).toBe(true);
		expect(isCloudTranscriptionApi("local-inference")).toBe(false);
		expect(isCloudTranscriptionApi(undefined)).toBe(false);
	});
});
