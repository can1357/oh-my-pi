/**
 * Timestamped transcripts of audio and video files on the on-device speech
 * worker: probe the file, stream its audio track through ffmpeg in one pass,
 * cut it into model-sized windows at quiet points, transcribe each window and
 * shift its segment times by the window's offset in the track.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { isVideoPath } from "@oh-my-pi/pi-tui/prompt/video";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveLocalRoleModelId } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { decodeAudioPcm, isAudioPath } from "../utils/audio";
import { probeVideo } from "../utils/video";
import { sttClient } from "./asr-client";
import { isSttModelCached } from "./downloader";
import { DEFAULT_ENDPOINTER_CONFIG } from "./endpointer";
import { resolveSttModelSpec, type SttModel } from "./models";
import { type AudioChunk, AudioChunker, type SttSegment, trimSegmentsToSpeech } from "./transcript";

/** The speech models take 16 kHz mono input. */
const TRANSCRIBE_SAMPLE_RATE = 16_000;

/** A file that cannot be transcribed for a reason the agent can act on. Message is user-facing. */
export class MediaTranscriptError extends Error {}

export interface MediaTranscript {
	segments: SttSegment[];
	/** Container duration from ffprobe, when known. */
	durationSec: number | undefined;
}

export interface MediaTranscriptOptions {
	model: SttModel;
	language?: string;
	signal?: AbortSignal;
}

/**
 * The model `omp setup speech` downloads: the first on-device entry of the
 * dictation role, or the default tier when no registry is available.
 */
export function resolveTranscriptModel(settings: Settings, registry: ModelBrowserRegistry | undefined): SttModel {
	if (!registry) return resolveSttModelSpec(undefined);
	let modelId: string;
	try {
		modelId = resolveLocalRoleModelId("dictation", settings, registry);
	} catch (error) {
		throw new MediaTranscriptError(
			`${error instanceof Error ? error.message : String(error)} Transcripts run on-device and need a local speech model in the \`dictation\` role chain: add one (e.g. parakeet-tdt-0.6b-v3) to the role or to \`retry.fallbackChains.dictation\`, then run \`omp setup speech\`.`,
		);
	}
	return resolveSttModelSpec(modelId);
}

const TRANSCRIPT_TARGET_RE = /^(.*?):transcript(?::(.+))?$/is;

/**
 * Split a `:transcript` read mode off a raw audio/video read path
 * (`clip.mp4:transcript`, `clip.mp4:transcript:40-80`). Pure string split; the
 * caller checks the base resolves to a file so literal names keep precedence.
 */
export function splitTranscriptReadTarget(rawPath: string): { path: string; sel: string } | null {
	const match = TRANSCRIPT_TARGET_RE.exec(rawPath);
	if (!match) return null;
	const base = match[1]!;
	if (!isAudioPath(base) && !isVideoPath(base)) return null;
	return { path: base, sel: match[2] === undefined ? "transcript" : `transcript:${match[2]}` };
}

/** The line selector after a `transcript` read mode, or null when `sel` is not transcript mode. */
export function parseTranscriptSel(sel: string | undefined): { lineSel: string | undefined } | null {
	if (sel === undefined) return null;
	const match = /^transcript(?::(.+))?$/is.exec(sel.trim());
	return match ? { lineSel: match[1] } : null;
}

// Transcripts are slow to produce and small to keep; memoize so paging a long
// one (`talk.mp3:400-800`) does not run speech recognition again. Concurrent
// reads of the same file (parallel page reads in one turn) join the in-flight
// job instead of decoding and recognizing it a second time.
const transcriptCache = new LRUCache<string, MediaTranscript>({ max: 16 });

interface TranscriptJob {
	promise: Promise<MediaTranscript>;
	/** Aborts the shared work; fired only once every joined read has aborted. */
	controller: AbortController;
	readers: number;
}

const inFlightTranscripts = new Map<string, TranscriptJob>();

/**
 * Transcribe the first audio stream of an audio or video file. Throws
 * {@link MediaTranscriptError} when the file has no audio stream or the speech
 * model is not downloaded (reads never download the ~hundreds-of-MB model).
 */
export async function transcribeMediaFile(
	absolutePath: string,
	options: MediaTranscriptOptions,
): Promise<MediaTranscript> {
	const { model, language, signal } = options;
	signal?.throwIfAborted();
	const stat = await fs.stat(absolutePath);
	const cacheKey = [absolutePath, stat.size, stat.mtimeMs, model.key, language ?? ""].join("\0");
	const cached = transcriptCache.get(cacheKey);
	if (cached) return cached;

	let job = inFlightTranscripts.get(cacheKey);
	if (!job) {
		const controller = new AbortController();
		const started: TranscriptJob = {
			controller,
			readers: 0,
			promise: produceTranscript(absolutePath, model, language, controller.signal)
				.then(transcript => {
					transcriptCache.set(cacheKey, transcript);
					return transcript;
				})
				.finally(() => {
					if (inFlightTranscripts.get(cacheKey) === started) inFlightTranscripts.delete(cacheKey);
				}),
		};
		inFlightTranscripts.set(cacheKey, started);
		job = started;
	}
	return joinTranscriptJob(cacheKey, job, signal);
}

/**
 * Wait on a shared transcript job under this read's own abort signal. A read
 * that aborts rejects at once; the shared work stops only when no reader is
 * left waiting on it.
 */
function joinTranscriptJob(
	cacheKey: string,
	job: TranscriptJob,
	signal: AbortSignal | undefined,
): Promise<MediaTranscript> {
	job.readers += 1;
	let joined = true;
	const leave = (): void => {
		if (!joined) return;
		joined = false;
		job.readers -= 1;
	};
	if (!signal) return job.promise.finally(leave);
	const { promise, resolve, reject } = Promise.withResolvers<MediaTranscript>();
	const onAbort = (): void => {
		leave();
		if (job.readers === 0) {
			if (inFlightTranscripts.get(cacheKey) === job) inFlightTranscripts.delete(cacheKey);
			job.controller.abort(signal.reason);
		}
		reject(signal.reason);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	job.promise.then(
		transcript => {
			signal.removeEventListener("abort", onAbort);
			leave();
			resolve(transcript);
		},
		(error: unknown) => {
			signal.removeEventListener("abort", onAbort);
			leave();
			reject(error);
		},
	);
	return promise;
}

async function produceTranscript(
	absolutePath: string,
	model: SttModel,
	language: string | undefined,
	signal: AbortSignal,
): Promise<MediaTranscript> {
	const meta = await probeVideo(absolutePath, signal);
	if (meta.audioCodec === undefined) {
		throw new MediaTranscriptError(`'${path.basename(absolutePath)}' has no audio stream to transcribe.`);
	}
	if (!(await isSttModelCached(model.key))) {
		throw new MediaTranscriptError(
			`Speech model ${model.label} (${model.key}, ${model.sizeHint}) is not downloaded. Run \`omp setup speech\` to download it, then read again.`,
		);
	}

	const segments: SttSegment[] = [];
	const transcribeChunk = async (chunk: AudioChunk): Promise<void> => {
		const offset = chunk.offset / TRANSCRIBE_SAMPLE_RATE;
		const timed = await sttClient.transcribe(model.key, chunk.audio, { language, signal });
		const trimmed = trimSegmentsToSpeech(timed, chunk.audio, TRANSCRIBE_SAMPLE_RATE, DEFAULT_ENDPOINTER_CONFIG);
		for (const segment of trimmed) {
			segments.push({ start: segment.start + offset, end: segment.end + offset, text: segment.text });
		}
	};
	const chunker = new AudioChunker({ sampleRate: TRANSCRIBE_SAMPLE_RATE });
	for await (const samples of decodeAudioPcm(absolutePath, TRANSCRIBE_SAMPLE_RATE, signal)) {
		for (const chunk of chunker.push(samples)) await transcribeChunk(chunk);
	}
	const tail = chunker.flush();
	if (tail) await transcribeChunk(tail);
	return { segments, durationSec: meta.durationSec };
}
