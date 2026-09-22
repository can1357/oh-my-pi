// Ported from NousResearch/hermes-agent (MIT) — tools/tts_tool.py L167-171, L896-959.
// Speech backends are catalog models selected through the speech role chain.

import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { DEFAULT_XAI_VOICE_ID, synthesizeSpeech, XAI_MAX_TEXT_LENGTH } from "@oh-my-pi/pi-ai/speech";
import { prompt } from "@oh-my-pi/pi-utils";
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

async function synthesizeCloud(
	model: Model,
	params: TtsSchemaType,
	ctx: CustomToolContext,
	outputPath: string,
	displayPath: string,
	codec: TtsCodec,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<TtsToolDetails, TtsSchemaType>> {
	const sessionId = ctx.sessionManager.getSessionId();
	const result = await synthesizeSpeech(
		model,
		{
			text: params.text,
			format: codec,
			...(params.voice_id !== undefined ? { voice: params.voice_id } : {}),
			...(model.api === "xai-tts" && params.sample_rate !== undefined ? { sampleRate: params.sample_rate } : {}),
			...(model.api === "xai-tts" && params.bit_rate !== undefined ? { bitRate: params.bit_rate } : {}),
		},
		{
			apiKey: ctx.modelRegistry.resolver(model, sessionId),
			fetch: ctx.fetch,
			signal,
		},
	);
	await Bun.write(outputPath, result.audio);
	const voiceId = params.voice_id ?? (model.api === "xai-tts" ? DEFAULT_XAI_VOICE_ID : "default");
	const backend: Exclude<TtsBackend, "local-inference"> = model.api === "xai-tts" ? "xai-tts" : "openai-speech";
	return {
		content: [
			{
				type: "text",
				text: `Saved ${result.audio.length} bytes to ${displayPath} (model=${model.provider}/${model.id}, voice=${voiceId}, codec=${codec}).`,
			},
		],
		details: { bytes: result.audio.length, voiceId, codec, backend },
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
				if (model.api === "xai-tts" || model.api === "openai-speech") {
					return await synthesizeCloud(model, params, ctx, outputPath, displayPath, codec, signal);
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
