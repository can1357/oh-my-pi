import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ValidationError } from "@oh-my-pi/pi-ai/error";
import {
	GEMINI_CLI_TRANSCRIBE_INSTRUCTION,
	isTranscriptionApi,
	TranscriptionApiError,
	transcribeAudio,
	unwrapTranscript,
} from "@oh-my-pi/pi-ai/transcription";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { googleAntigravityModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/google";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const CREDENTIAL = JSON.stringify({ token: "access-token", projectId: "proj-123" });

function transcribeModel(): Model<Api> {
	return buildModel({
		id: "gemini-2.5-flash-transcribe",
		name: "Gemini 2.5 Flash (transcribe)",
		api: "google-gemini-cli-transcribe",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		kind: "stt",
		requestModelId: "gemini-2.5-flash",
	});
}

interface CapturedPart {
	text?: string;
	inlineData?: { mimeType: string; data: string };
}
interface CapturedBody {
	model: string;
	project: string;
	request: {
		contents: { role: string; parts: CapturedPart[] }[];
		systemInstruction?: { parts: { text: string }[] };
		generationConfig?: { temperature?: number; thinkingConfig?: unknown };
		tools?: unknown;
	};
}

function sse(text: string): Response {
	const chunk = {
		response: {
			candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 15, totalTokenCount: 165 },
		},
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function upstream(respond: () => Response): { fetch: FetchImpl; bodies: CapturedBody[]; urls: string[] } {
	const bodies: CapturedBody[] = [];
	const urls: string[] = [];
	const fetch: FetchImpl = async (input, init) => {
		urls.push(String(input));
		if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
		return respond();
	};
	return { fetch, bodies, urls };
}

describe("google-gemini-cli-transcribe runner", () => {
	it("is dispatchable, with bundled Antigravity and Gemini CLI rows mapped to chat SKUs", () => {
		expect(isTranscriptionApi("google-gemini-cli-transcribe")).toBe(true);
		expect(getBundledModel("google-antigravity", "gemini-3-flash-transcribe")).toMatchObject({
			api: "google-gemini-cli-transcribe",
			kind: "stt",
			requestModelId: "gemini-3-flash",
		});
		expect(getBundledModel("google-gemini-cli", "gemini-2.5-flash-transcribe")).toMatchObject({
			api: "google-gemini-cli-transcribe",
			kind: "stt",
			requestModelId: "gemini-2.5-flash",
		});
	});

	it("sends the audio inline ahead of a verbatim instruction on the chat SKU and unwraps the reply", async () => {
		const { fetch, bodies, urls } = upstream(() => sse("\u201cSay hello, brave world.\u201d"));
		const result = await transcribeAudio(
			transcribeModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json", language: "en", prompt: "Kubernetes" },
			{ apiKey: CREDENTIAL, fetch },
		);
		expect(result.text).toBe("Say hello, brave world.");
		expect(result.usage.input).toBe(150);
		expect(result.usage.output).toBe(15);

		expect(urls).toHaveLength(1);
		expect(urls[0]).toStartWith("https://cloudcode-pa.googleapis.com/");
		const [body] = bodies;
		expect(body.model).toBe("gemini-2.5-flash");
		expect(body.project).toBe("proj-123");
		expect(body.request.systemInstruction?.parts.map(part => part.text)).toEqual([GEMINI_CLI_TRANSCRIBE_INSTRUCTION]);
		expect(body.request.tools).toBeUndefined();
		expect(body.request.generationConfig?.temperature).toBe(0);
		expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
		expect(body.request.contents).toHaveLength(1);
		const [audio, instruction] = body.request.contents[0].parts;
		expect(audio.inlineData).toEqual({ mimeType: "audio/wav", data: AUDIO.toBase64() });
		expect(instruction.text).toContain("Transcribe this audio.");
		expect(instruction.text).toContain("most likely en");
		expect(instruction.text).toContain("Kubernetes");
	});

	it("surfaces an HTTP failure as a TranscriptionApiError with its status", async () => {
		const { fetch } = upstream(() => Response.json({ error: { code: 404, message: "not found" } }, { status: 404 }));
		const error = await transcribeAudio(
			transcribeModel(),
			{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "json" },
			{ apiKey: CREDENTIAL, fetch },
		).catch(e => e);
		expect(error).toBeInstanceOf(TranscriptionApiError);
		expect(error.status).toBe(404);
	});

	it("rejects non-audio input and timestamp requests before sending", async () => {
		const { fetch, urls } = upstream(() => sse("x"));
		await expect(
			transcribeAudio(
				transcribeModel(),
				{ audio: AUDIO, mimeType: "image/png", responseFormat: "json" },
				{ apiKey: CREDENTIAL, fetch },
			),
		).rejects.toBeInstanceOf(ValidationError);
		await expect(
			transcribeAudio(
				transcribeModel(),
				{ audio: AUDIO, mimeType: "audio/wav", responseFormat: "verbose_json", timestampGranularities: ["word"] },
				{ apiKey: CREDENTIAL, fetch },
			),
		).rejects.toBeInstanceOf(ValidationError);
		expect(urls).toHaveLength(0);
	});

	it("strips wrapper quotes and fences but keeps quoted speech", () => {
		expect(unwrapTranscript('  "Hello there."  ')).toBe("Hello there.");
		expect(unwrapTranscript("```text\nHello there.\n```")).toBe("Hello there.");
		expect(unwrapTranscript("\u00ab'Bonjour.'\u00bb")).toBe("Bonjour.");
		expect(unwrapTranscript('"Yes" and "no".')).toBe('"Yes" and "no".');
		expect(unwrapTranscript('"He said "hi" twice"')).toBe('"He said "hi" twice"');
		expect(unwrapTranscript("")).toBe("");
	});

	it("keeps the Antigravity transcribe rows through an authoritative roster refresh", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-transcribe-"));
		const fetcher = Object.assign(
			(input: string | URL | Request) =>
				Promise.resolve(
					String(input).includes(":fetchAvailableModels")
						? Response.json({ models: { "gemini-2.5-flash": { maxTokens: 1_048_576, maxOutputTokens: 65_536 } } })
						: new Response("version: 2.26.0\n"),
				),
			{ preconnect: fetch.preconnect },
		);
		try {
			const options = googleAntigravityModelManagerOptions({
				resolveAccounts: async () => [{ accessToken: "token" }],
				endpoint: "https://cca.test",
				fetch: fetcher,
			});
			const result = await resolveProviderModels({ ...options, cacheDbPath: path.join(dir, "models.db") }, "online");
			const runners = result.models.filter(model => model.api === "google-gemini-cli-transcribe");
			expect(runners.map(model => [model.id, model.kind, model.requestModelId]).sort()).toEqual([
				["gemini-2.5-flash-transcribe", "stt", "gemini-2.5-flash"],
				["gemini-3-flash-transcribe", "stt", "gemini-3-flash"],
			]);
			expect(result.models.some(model => model.id === "gemini-2.5-flash" && model.api === "google-gemini-cli")).toBe(
				true,
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
