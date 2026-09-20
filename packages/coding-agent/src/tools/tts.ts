// Ported from NousResearch/hermes-agent (MIT) — tools/tts_tool.py L167-171, L896-959.
// Speech backends are catalog models selected through the speech role chain.

import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ApiKey, type FetchImpl, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { prompt, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain, type RoleChainCandidate } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { settings, type Settings } from "../config/settings";
import type { CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import ttsDescription from "../prompts/tools/tts.md" with { type: "text" };
import { DEFAULT_TTS_VOICE, KOKORO_VOICES } from "../tts/models";
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
type TtsBackend = "local-inference" | "xai-tts" | "openai-speech";

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

/** Resolve speech candidates while preserving every explicitly configured slot. */
export function resolveSpeechCandidates(
	settingsInstance: Settings,
	modelRegistry: ModelRegistry,
	wantsMp3: boolean,
): RoleChainCandidate[] {
	const pool = roleCandidatePool("speech", settingsInstance, modelRegistry);
	const candidates = resolveRoleChain("speech", settingsInstance, pool);
	if (!wantsMp3) return candidates;

	const nonExplicit = candidates.filter(candidate => !candidate.explicit);
	const cloudFirst = [
		...nonExplicit.filter(candidate => candidate.model.api !== "local-inference"),
		...nonExplicit.filter(candidate => candidate.model.api === "local-inference"),
	];
	let next = 0;
	return candidates.map(candidate => (candidate.explicit ? candidate : cloudFirst[next++]!));
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

function readLocalVoice(settingsInstance: Settings): string {
	try {
		const value = settingsInstance.get("tts.localVoice");
		return typeof value === "string" && value ? value : DEFAULT_TTS_VOICE;
	} catch {
		return DEFAULT_TTS_VOICE;
	}
}

/** Shared cloud-speech POST with a 60 s timeout fence. */
async function postSpeechRequest(options: {
	label: string;
	url: string;
	payload: Record<string, unknown>;
	apiKey: ApiKey;
	resolveHeaders?: () => Promise<Record<string, string> | undefined>;
	fetchImpl: FetchImpl;
	signal: AbortSignal | undefined;
}): Promise<Uint8Array> {
	const timeoutSignal = AbortSignal.timeout(60_000);
	const combinedSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const response = await withAuth(
		options.apiKey,
		async key => {
			const configuredHeaders = await options.resolveHeaders?.();
			const resp = await options.fetchImpl(options.url, {
				method: "POST",
				headers: {
					...configuredHeaders,
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
	return new Uint8Array(await response.arrayBuffer());
}

async function synthesizeXai(
	model: Model,
	params: TtsSchemaType,
	ctx: CustomToolContext,
	outputPath: string,
	displayPath: string,
	codec: TtsCodec,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const voiceId = params.voice_id ?? DEFAULT_XAI_VOICE_ID;
	const sampleRate = params.sample_rate ?? DEFAULT_XAI_SAMPLE_RATE;
	const bitRate = params.bit_rate ?? DEFAULT_XAI_BIT_RATE;
	const payload: Record<string, unknown> = {
		text: params.text,
		voice_id: voiceId,
		language: params.language,
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
	const apiKey: ApiKey = ctx.modelRegistry.resolver(model, sessionId);
	const bytes = await postSpeechRequest({
		label: `${model.provider}/${model.id}`,
		url: `${model.baseUrl.replace(/\/+$/, "")}/tts`,
		payload,
		apiKey,
		resolveHeaders: () => ctx.modelRegistry.resolveModelHeaders(model, signal),
		fetchImpl: ctx.fetch ?? fetch,
		signal,
	});
	await Bun.write(outputPath, bytes);
	return {
		content: [
			{
				type: "text",
				text: `Saved ${bytes.length} bytes to ${displayPath} (model=${model.provider}/${model.id}, voice=${voiceId}, codec=${codec}).`,
			},
		],
		details: { bytes: bytes.length, voiceId, codec, backend: "xai-tts" },
	};
}

async function synthesizeOpenAiSpeech(
	model: Model,
	params: TtsSchemaType,
	ctx: CustomToolContext,
	outputPath: string,
	displayPath: string,
	codec: TtsCodec,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const payload: Record<string, unknown> = {
		model: model.id,
		input: params.text,
		response_format: codec,
		...(params.voice_id ? { voice: params.voice_id } : {}),
	};
	const sessionId = ctx.sessionManager.getSessionId();
	const apiKey: ApiKey = ctx.modelRegistry.resolver(model, sessionId);
	const bytes = await postSpeechRequest({
		label: `${model.provider}/${model.id}`,
		url: `${model.baseUrl.replace(/\/+$/, "")}/audio/speech`,
		payload,
		apiKey,
		resolveHeaders: () => ctx.modelRegistry.resolveModelHeaders(model, signal),
		fetchImpl: ctx.fetch ?? fetch,
		signal,
	});
	await Bun.write(outputPath, bytes);
	const voiceLabel = params.voice_id ?? "default";
	return {
		content: [
			{
				type: "text",
				text: `Saved ${bytes.length} bytes to ${displayPath} (model=${model.provider}/${model.id}, voice=${voiceLabel}, codec=${codec}).`,
			},
		],
		details: { bytes: bytes.length, voiceId: voiceLabel, codec, backend: "openai-speech" },
	};
}

async function synthesizeLocal(
	model: Model,
	params: TtsSchemaType,
	settingsInstance: Settings,
	cwd: string,
	outputPath: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const voice = readLocalVoice(settingsInstance);
	const audio = await ttsClient.synthesize(model.id, params.text, { voice, signal });
	if (!audio) {
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: `Local TTS synthesis failed (model=${model.id}). The on-device worker may be unavailable or the model download was interrupted.`,
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
				text: `Saved ${wav.length} bytes to ${displayPath} (voice=${model.id}/${voice}, codec=wav, backend=local, ${audio.sampleRate} Hz).${note}`,
			},
		],
		details: { bytes: wav.length, voiceId: `${model.id}/${voice}`, codec: "wav", backend: "local-inference" },
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

		const settingsInstance = ctx.settings ?? settings;
		const candidates = resolveSpeechCandidates(settingsInstance, ctx.modelRegistry, codec === "mp3");
		if (candidates.length === 0) {
			return {
				isError: true,
				content: [{ type: "text", text: "No available speech model matches the speech role." }],
			};
		}

		const failures: string[] = [];
		for (const { model } of candidates) {
			try {
				if (model.api === "local-inference") {
					return await synthesizeLocal(model, params, settingsInstance, cwd, outputPath, signal);
				}
				if (model.api === "xai-tts") {
					return await synthesizeXai(model, params, ctx, outputPath, displayPath, codec, signal);
				}
				if (model.api === "openai-speech") {
					return await synthesizeOpenAiSpeech(model, params, ctx, outputPath, displayPath, codec, signal);
				}
				throw new Error(`Unsupported speech model API: ${model.api}`);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (error instanceof MissingApiKeyError || error instanceof ProviderHttpError) {
					failures.push(`${model.provider}/${model.id}: ${error.message}`);
					continue;
				}
				throw error;
			}
		}

		return {
			isError: true,
			content: [{ type: "text", text: `Speech synthesis failed for every candidate: ${failures.join("; ")}` }],
		};
	},
};
