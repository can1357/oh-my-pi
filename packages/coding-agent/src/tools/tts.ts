// Ported from NousResearch/hermes-agent (MIT) — tools/tts_tool.py L167-171, L896-959.
// The xAI Grok Voice path below is preserved intact; a local on-device neural TTS
// backend (Kokoro-82M via kokoro-js on the shared ONNX worker) is layered on behind
// the `providers.tts` switch.

import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ApiKey, type FetchImpl, withAuth } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { prompt, USER_AGENT } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import { resolveXAIHttpCredentials } from "../lib/xai-http";
import ttsDescription from "../prompts/tools/tts.md" with { type: "text" };
import { DEFAULT_TTS_LOCAL_MODEL_KEY, DEFAULT_TTS_VOICE, isTtsLocalModelKey, KOKORO_VOICES } from "../tts/models";
import { ttsClient } from "../tts/tts-client";
import { encodeWav } from "../tts/wav";
import { formatPathRelativeToCwd, resolveToCwd } from "./path-utils";

// Hermes tts_tool.py L167-171
const DEFAULT_XAI_VOICE_ID = "eve" as const;
const DEFAULT_XAI_SAMPLE_RATE = 24_000;
const DEFAULT_XAI_BIT_RATE = 128_000;
const XAI_MAX_TEXT_LENGTH = 15_000;

// Built-in voices per xAI Tier-1 docs (2026-05-16). xAI also accepts custom voice IDs,
// so the schema does NOT enum-restrict voice_id; this constant only drives the description.
const XAI_BUILTIN_VOICES = ["ara", "eve", "leo", "rex", "sal"] as const;

const formatVoiceList = (): string =>
	XAI_BUILTIN_VOICES.map(v => (v === DEFAULT_XAI_VOICE_ID ? `${v} (default)` : v)).join(", ");

type TtsCodec = "mp3" | "wav";
type TtsBackend = "local" | "xai" | "deepinfra";

const DEEPINFRA_TTS_URL = "https://api.deepinfra.com/v1/openai/audio/speech";
const DEFAULT_DEEPINFRA_TTS_MODEL = "hexgrad/Kokoro-82M";

const ttsSchema = type({
	text: "1 <= string <= 15000",
	// Optional (no schema default) so an explicit "eve" stays distinguishable
	// from an omitted voice: xAI applies its own default, DeepInfra forwards
	// the voice only when the caller actually set one.
	"voice_id?": "string",
	language: "string = 'en'",
	output_path: "string",
	sample_rate: "number.integer?",
	bit_rate: "number.integer?",
});

type TtsSchemaType = typeof ttsSchema.infer;

interface TtsToolDetails {
	bytes: number;
	voiceId: string;
	codec: TtsCodec;
	backend: TtsBackend;
}

/**
 * Pick the synthesis backend. Pure for testability.
 *
 * - `xai` / `local` are honored verbatim (the xAI path still surfaces its own
 *   "no credentials" error when creds are missing).
 * - `auto` prefers the local on-device backend, except when the caller asked for
 *   an `.mp3` and xAI credentials exist — only the cloud path can emit MP3, so we
 *   route there to satisfy the requested container rather than substituting WAV.
 */
export function resolveTtsBackend(opts: { preference: string; wantsMp3: boolean; hasXaiCreds: boolean }): TtsBackend {
	if (opts.preference === "xai") return "xai";
	if (opts.preference === "deepinfra") return "deepinfra";
	if (opts.preference === "local") return "local";
	if (opts.wantsMp3 && opts.hasXaiCreds) return "xai";
	return "local";
}

/**
 * Resolve the on-disk path for local synthesis. Local output is always WAV (no
 * MP3 encoder is bundled), so an `.mp3` (or any non-`.wav`) request is rewritten
 * to a sibling `.wav` and flagged so the tool result can note the substitution.
 */
export function resolveLocalWavPath(outputPath: string): { wavPath: string; substituted: boolean } {
	const lower = outputPath.toLowerCase();
	if (lower.endsWith(".wav")) return { wavPath: outputPath, substituted: false };
	const slash = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
	const dot = outputPath.lastIndexOf(".");
	const base = dot > slash ? outputPath.slice(0, dot) : outputPath;
	return { wavPath: `${base}.wav`, substituted: true };
}

function readStringSetting(key: "providers.tts" | "tts.localModel" | "tts.localVoice"): string | undefined {
	try {
		const value = settings.get(key);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Shared cloud-speech POST: bearer auth, JSON payload, 60 s timeout fence,
 * ProviderHttpError mapped to an error string. Returns the raw audio bytes.
 */
async function postSpeechRequest(options: {
	label: string;
	url: string;
	payload: Record<string, unknown>;
	apiKey: ApiKey;
	fetchImpl: FetchImpl;
	signal: AbortSignal | undefined;
}): Promise<Uint8Array | { errorText: string }> {
	const timeoutSignal = AbortSignal.timeout(60_000);
	const combinedSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	let response: Response;
	try {
		response = await withAuth(
			options.apiKey,
			async key => {
				const resp = await options.fetchImpl(options.url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${key}`,
						"Content-Type": "application/json",
						"User-Agent": USER_AGENT,
					},
					body: JSON.stringify(options.payload),
					signal: combinedSignal,
				});
				if (!resp.ok) {
					const detail = await resp.text();
					throw new ProviderHttpError(
						`${options.label} failed (${resp.status}): ${detail.slice(0, 300)}`,
						resp.status,
						{ headers: resp.headers },
					);
				}
				return resp;
			},
			{ signal: combinedSignal },
		);
	} catch (error) {
		const status = (error as { status?: unknown }).status;
		if (error instanceof Error && typeof status === "number") {
			return { errorText: error.message };
		}
		throw error;
	}
	return new Uint8Array(await response.arrayBuffer());
}

async function synthesizeXai(
	params: TtsSchemaType,
	ctx: CustomToolContext,
	outputPath: string,
	displayPath: string,
	codec: TtsCodec,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const creds = await resolveXAIHttpCredentials(ctx.modelRegistry);
	if (!creds) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: "No xAI credentials. Run /login → xAI Grok OAuth (SuperGrok or X Premium+) or set XAI_API_KEY.",
				},
			],
		};
	}

	const voiceId = params.voice_id ?? DEFAULT_XAI_VOICE_ID;
	const language = params.language;
	const sampleRate = params.sample_rate ?? DEFAULT_XAI_SAMPLE_RATE;
	const bitRate = params.bit_rate ?? DEFAULT_XAI_BIT_RATE;

	const payload: Record<string, unknown> = {
		text: params.text,
		voice_id: voiceId,
		language,
	};
	// Hermes tts_tool.py L926-940 — only send output_format when caller overrides a default.
	const codecOverridden = codec !== "mp3";
	const sampleRateOverridden = sampleRate !== DEFAULT_XAI_SAMPLE_RATE;
	const bitRateOverridden = codec === "mp3" && bitRate !== DEFAULT_XAI_BIT_RATE;
	if (codecOverridden || sampleRateOverridden || bitRateOverridden) {
		const fmt: Record<string, unknown> = { codec };
		if (sampleRate) fmt.sample_rate = sampleRate;
		if (codec === "mp3" && bitRate) fmt.bit_rate = bitRate;
		payload.output_format = fmt;
	}

	const sessionId = ctx.sessionManager.getSessionId();
	const apiKey: ApiKey = ctx.modelRegistry.resolver(creds.provider, {
		sessionId,
		baseUrl: creds.baseURL,
	});

	const bytes = await postSpeechRequest({
		label: "xAI TTS",
		url: `${creds.baseURL}/tts`,
		payload,
		apiKey,
		fetchImpl: ctx.fetch ?? fetch,
		signal,
	});
	if (!(bytes instanceof Uint8Array)) {
		return { isError: true, content: [{ type: "text", text: bytes.errorText }] };
	}
	await Bun.write(outputPath, bytes);
	return {
		content: [
			{
				type: "text",
				text: `Saved ${bytes.length} bytes to ${displayPath} (voice=${voiceId}, codec=${codec}, backend=xai).`,
			},
		],
		details: { bytes: bytes.length, voiceId, codec, backend: "xai" },
	};
}

async function synthesizeDeepInfra(
	params: TtsSchemaType,
	ctx: CustomToolContext,
	outputPath: string,
	displayPath: string,
	codec: TtsCodec,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const sessionId = ctx.sessionManager.getSessionId();
	const storedKey = await ctx.modelRegistry.getApiKeyForProvider("deepinfra", sessionId);
	if (!storedKey) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: "No DeepInfra credentials. Run /login → DeepInfra or set DEEPINFRA_API_KEY.",
				},
			],
		};
	}

	// Forward the voice only when the caller set one so DeepInfra's server
	// default applies otherwise (voice ids are model-specific).
	const payload: Record<string, unknown> = {
		model: DEFAULT_DEEPINFRA_TTS_MODEL,
		input: params.text,
		response_format: codec,
		...(params.voice_id ? { voice: params.voice_id } : {}),
	};

	const apiKey: ApiKey = ctx.modelRegistry.resolver("deepinfra", { sessionId });

	const bytes = await postSpeechRequest({
		label: "DeepInfra TTS",
		url: DEEPINFRA_TTS_URL,
		payload,
		apiKey,
		fetchImpl: ctx.fetch ?? fetch,
		signal,
	});
	if (!(bytes instanceof Uint8Array)) {
		return { isError: true, content: [{ type: "text", text: bytes.errorText }] };
	}
	await Bun.write(outputPath, bytes);
	const voiceLabel = params.voice_id ?? "default";
	return {
		content: [
			{
				type: "text",
				text: `Saved ${bytes.length} bytes to ${displayPath} (model=${DEFAULT_DEEPINFRA_TTS_MODEL}, voice=${voiceLabel}, codec=${codec}, backend=deepinfra).`,
			},
		],
		details: { bytes: bytes.length, voiceId: voiceLabel, codec, backend: "deepinfra" },
	};
}

async function synthesizeLocal(
	params: TtsSchemaType,
	cwd: string,
	outputPath: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const modelSetting = readStringSetting("tts.localModel");
	const modelKey = modelSetting && isTtsLocalModelKey(modelSetting) ? modelSetting : DEFAULT_TTS_LOCAL_MODEL_KEY;
	const voice = readStringSetting("tts.localVoice") || DEFAULT_TTS_VOICE;

	const audio = await ttsClient.synthesize(modelKey, params.text, { voice, signal });
	if (!audio) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Local TTS synthesis failed (model=${modelKey}). The on-device worker may be unavailable or the model download was interrupted.`,
				},
			],
		};
	}

	const { wavPath, substituted } = resolveLocalWavPath(outputPath);
	const wav = encodeWav(audio.pcm, audio.sampleRate);
	await Bun.write(wavPath, wav);
	const displayPath = formatPathRelativeToCwd(wavPath, cwd);
	const note = substituted
		? ` No local MP3 encoder is bundled, so WAV (PCM16) was written instead of the requested container.`
		: "";
	return {
		content: [
			{
				type: "text",
				text: `Saved ${wav.length} bytes to ${displayPath} (voice=${modelKey}/${voice}, codec=wav, backend=local, ${audio.sampleRate} Hz).${note}`,
			},
		],
		details: { bytes: wav.length, voiceId: `${modelKey}/${voice}`, codec: "wav", backend: "local" },
	};
}

export const ttsTool: CustomTool<typeof ttsSchema, TtsToolDetails> = {
	name: "tts",
	label: "Speech Generation",
	strict: false,
	approval: "write",
	description: prompt.render(ttsDescription, {
		localVoices: KOKORO_VOICES.map(v => (v.id === DEFAULT_TTS_VOICE ? `${v.id} (default)` : v.id)).join(", "),
		xaiVoices: formatVoiceList(),
		maxLength: XAI_MAX_TEXT_LENGTH.toLocaleString("en-US"),
	}),
	parameters: ttsSchema,
	async execute(
		_toolCallId: string,
		params: TtsSchemaType,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
		const cwd = ctx.sessionManager.getCwd();
		const outputPath = resolveToCwd(params.output_path, cwd);
		const displayPath = formatPathRelativeToCwd(outputPath, cwd);
		const codec: TtsCodec = outputPath.toLowerCase().endsWith(".wav") ? "wav" : "mp3";

		const preference = readStringSetting("providers.tts") ?? "auto";
		// Only resolve xAI creds when they can affect routing (skip for explicit local/deepinfra preferences).
		const hasXaiCreds =
			preference === "local" || preference === "deepinfra"
				? false
				: (await resolveXAIHttpCredentials(ctx.modelRegistry)) !== null;
		const backend = resolveTtsBackend({ preference, wantsMp3: codec === "mp3", hasXaiCreds });

		if (backend === "local") return synthesizeLocal(params, cwd, outputPath, signal);
		if (backend === "deepinfra") return synthesizeDeepInfra(params, ctx, outputPath, displayPath, codec, signal);
		return synthesizeXai(params, ctx, outputPath, displayPath, codec, signal);
	},
};
