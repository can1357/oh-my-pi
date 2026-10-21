/**
 * Timestamped transcripts of audio files and video soundtracks for `read`,
 * from a chat model that hears audio: one whose catalog input includes audio
 * on a transport that carries it inline (Google's GenerateContent, or an
 * `input_audio` part on Chat Completions and Responses). ffmpeg extracts the
 * first audio stream as mono speech audio; the model answers one
 * `[m:ss.s] text` line per sentence.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { type Api, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { audioInputMimeType } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { resolveThinkingLevelForModel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { extractTextContent } from "../commit/utils";
import { cfgImagesBlockImages } from "../modes/settings";
import type { ToolSession } from "../tools";
import { findPerceptionModel } from "./image-question";
import { runFfmpeg } from "./video";

const AUDIO_MIME_BY_EXT: Record<string, string> = {
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".wma": "audio/x-ms-wma",
	".aif": "audio/aiff",
	".aiff": "audio/aiff",
	".caf": "audio/x-caf",
};

/** Container MIME for an audio path, or undefined for non-audio. */
export function audioMimeForPath(filePath: string): string | undefined {
	return AUDIO_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

/** A chat model that hears audio its transport carries; see {@link audioInputMimeType}. */
export function hearsAudio(model: Model<Api>): boolean {
	return modelKind(model) === "chat" && audioInputMimeType(model) !== undefined;
}

/**
 * The model `read` transcribes with, chosen the way image questions choose theirs; undefined when
 * none hears audio or `images.blockImages` keeps media from providers.
 */
export function resolveTranscriptModel(session: ToolSession): Model<Api> | undefined {
	if (cfgImagesBlockImages.get(session.settings)) return undefined;
	return findPerceptionModel(session, hearsAudio)?.model;
}

/** One transcript line: seconds from the start of the recording. */
export interface TranscriptSegment {
	start: number;
	end: number;
	text: string;
}

export interface MediaTranscript {
	segments: TranscriptSegment[];
	/** Where the transcript stops early because the model hit its output limit. */
	cutAtSec: number | undefined;
}

// One request carries at most an hour: at 24 kbit/s that is ~11 MB of audio, ~14 MB inline, under
// Gemini's 20 MB inline limit, and its sentence lines stay well inside the model's output limit.
const WINDOW_SEC = 3600;

const TRANSCRIBE_INSTRUCTION =
	"Transcribe all speech in this recording verbatim, without skipping or summarizing anything. Write one line per sentence (split a sentence longer than about 10 seconds at a clause), never one line per word, formatted exactly as `[m:ss.s] text` where the time is when that line starts in this recording. Output only those lines; if there is no speech, output only `(no speech)`.";

/**
 * Transcribe the first audio stream of `absolutePath` with `model`, one request per hour of audio.
 * A failed request throws a {@link ToolError} naming the model.
 */
export async function transcribeRecording(
	session: ToolSession,
	model: Model<Api>,
	absolutePath: string,
	durationSec: number | undefined,
	signal: AbortSignal | undefined,
	completeImpl: typeof completeSimple = completeSimple,
): Promise<MediaTranscript> {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) throw new ToolError("Model registry is unavailable for transcripts.");
	const mimeType = audioInputMimeType(model);
	if (!mimeType) throw new ToolError(`${model.provider}/${model.id} does not hear audio.`);
	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const total = durationSec ?? 0;
	const segments: TranscriptSegment[] = [];
	for (let offset = 0; offset === 0 || offset < total; offset += WINDOW_SEC) {
		const window = total > WINDOW_SEC ? { start: offset, end: Math.min(total, offset + WINDOW_SEC) } : undefined;
		const audio = await extractSpeechAudio(absolutePath, mimeType, window, signal);
		const response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: ["You transcribe recordings. Report only what is said in them."],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: audio, mimeType },
							{ type: "text", text: TRANSCRIBE_INSTRUCTION },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: modelRegistry.resolver(model, session.getSessionId?.() ?? undefined),
				signal,
				// Transcribing is perception, not reasoning; and a long recording takes longer
				// than a chat turn to produce its first token.
				reasoning: toReasoningEffort(resolveThinkingLevelForModel(model, ThinkingLevel.Minimal)),
				streamFirstEventTimeoutMs: 300_000,
			},
			{ telemetry, oneshotKind: "media_transcript", completeImpl },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new ToolError(
				`${model.provider}/${model.id} could not transcribe the recording: ${response.errorMessage ?? response.stopReason}`,
			);
		}
		const text = extractTextContent(response).trim();
		if (!text) throw new ToolError(`${model.provider}/${model.id} returned no transcript text.`);
		const start = window?.start ?? 0;
		const lines = parseTranscriptLines(text, (window?.end ?? total) - start || undefined);
		if (lines.length === 0 && !/no speech/i.test(text)) {
			throw new ToolError(`${model.provider}/${model.id} answered without timestamped lines: ${text.slice(0, 200)}`);
		}
		for (const line of lines) segments.push({ start: line.start + start, end: line.end + start, text: line.text });
		if (response.stopReason === "length") {
			// The answer stopped mid-line, so the transcript reaches only where its last line starts.
			const last = lines.length > 0 ? segments.pop() : undefined;
			return { segments, cutAtSec: last?.start ?? start };
		}
	}
	return { segments, cutAtSec: undefined };
}

/** Mono 16 kHz, 24 kbit/s speech audio of the first audio stream (or a window of it), base64. */
async function extractSpeechAudio(
	absolutePath: string,
	mimeType: "audio/ogg" | "audio/mpeg",
	window: { start: number; end: number } | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-transcript-"));
	const opus = mimeType === "audio/ogg";
	const out = path.join(dir, opus ? "speech.ogg" : "speech.mp3");
	try {
		const range = window ? ["-ss", window.start.toFixed(3), "-to", window.end.toFixed(3)] : [];
		await runFfmpeg(
			[
				"-v",
				"error",
				"-y",
				...range,
				"-i",
				absolutePath,
				"-map",
				"0:a:0",
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				opus ? "libopus" : "libmp3lame",
				"-b:a",
				"24k",
				out,
			],
			signal,
		);
		return Buffer.from(await Bun.file(out).arrayBuffer()).toBase64();
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2}(?:[.,]\d+)?)`;
// `[m:ss.s] text`, `[m:ss.s - m:ss.s] text`, `**[0:01]** text`, `- (0:01, 0:04) text`, `00:00:01,000 --> 00:00:04,000 text`.
const TRANSCRIPT_LINE_RE = new RegExp(
	String.raw`^[\s*\-•>]*[\[(]?\s*${TIME}(?:\s*(?:-->|-|–|—|,|to)\s*${TIME})?\s*[\])]?[\s*:\-–—|]*(.*)$`,
);
// Seconds, which some models answer with whatever the instruction says: `[0.96] text` (bracketed,
// so prose that starts with a number is not a time) or `1.06-7.61 | SPEAKER_00: text` (a range).
const SECONDS_LINE_RE =
	/^[\s*\-•>]*(?:[[(]\s*(\d+\.\d+)s?\s*(?:(?:-->|-|–|—|to)\s*(\d+\.\d+)s?\s*)?[\])]|(\d+\.\d+)\s*(?:-->|-|–|—|to)\s*(\d+\.\d+))[\s*:\-–—|]*(.*)$/;

function timeOf(hours: string | undefined, minutes: string, seconds: string): number {
	return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds.replace(",", "."));
}

/**
 * Parse a model's timestamped lines. A line without an end time ends where the next one starts
 * (the last at `durationSec`). Models sometimes answer one word per line despite the
 * instruction; those fold back into sentences so a transcript costs what its speech does.
 */
export function parseTranscriptLines(text: string, durationSec: number | undefined): TranscriptSegment[] {
	const parsed: { start: number; end: number | undefined; text: string }[] = [];
	for (const line of text.split("\n")) {
		const match = TRANSCRIPT_LINE_RE.exec(line);
		if (match) {
			const body = match[7]?.replace(/\*+$/, "").trim();
			if (!body) continue;
			const end = match[5] === undefined ? undefined : timeOf(match[4], match[5], match[6]);
			parsed.push({ start: timeOf(match[1], match[2], match[3]), end, text: body });
			continue;
		}
		const seconds = SECONDS_LINE_RE.exec(line);
		const body = seconds?.[5]?.trim();
		if (!seconds || !body) continue;
		const end = seconds[2] ?? seconds[4];
		parsed.push({
			start: Number(seconds[1] ?? seconds[3]),
			end: end === undefined ? undefined : Number(end),
			text: body,
		});
	}
	const segments = parsed.map((line, i) => ({
		start: line.start,
		end: line.end ?? parsed[i + 1]?.start ?? durationSec ?? line.start,
		text: line.text,
	}));
	const wordCounts = segments.map(segment => segment.text.split(/\s+/).length).sort((a, b) => a - b);
	if (wordCounts.length === 0 || wordCounts[wordCounts.length >> 1] >= 3) return segments;
	const merged: TranscriptSegment[] = [];
	for (const segment of segments) {
		const last = merged.at(-1);
		if (
			last &&
			!/[.?!…]["')\]]?$/.test(last.text) &&
			segment.start - last.end <= 1.5 &&
			segment.end - last.start <= 12
		) {
			last.text = `${last.text} ${segment.text}`;
			last.end = segment.end;
		} else {
			merged.push({ ...segment });
		}
	}
	return merged;
}

/** `m:ss.s` (or `h:mm:ss.s`): what video frame selectors accept. */
export function formatTranscriptTime(seconds: number): string {
	const tenths = Math.max(0, Math.round(seconds * 10));
	const hours = Math.floor(tenths / 36_000);
	const minutes = Math.floor((tenths % 36_000) / 600);
	const secs = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/** One `[start-end] text` line per segment. */
export function formatTranscriptLines(segments: readonly TranscriptSegment[]): string {
	return segments
		.map(segment => `[${formatTranscriptTime(segment.start)}-${formatTranscriptTime(segment.end)}] ${segment.text}`)
		.join("\n");
}
