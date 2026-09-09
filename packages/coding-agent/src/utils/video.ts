/**
 * Video attachments via system ffmpeg/ffprobe.
 *
 * Vision models only see images, so videos enter context as a PNG contact
 * sheet (evenly spaced frames tiled into one image) plus a text block with
 * the usual metadata (resolution, codecs, duration, fps). A `:selector`
 * suffix extracts a single frame instead: a bare number is a frame index,
 * anything timestamp-shaped is a seek position.
 */
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { $which, TempDir, untilAborted } from "@oh-my-pi/pi-utils";

/** Container extensions treated as video. Mirrors the video subset of the local-protocol binary list. */
const VIDEO_EXTENSION_LOOKUP: Record<string, true> = {
	".mp4": true,
	".mov": true,
	".mkv": true,
	".webm": true,
	".m4v": true,
	".avi": true,
	".wmv": true,
};

const VIDEO_MIME_BY_EXT: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".webm": "video/webm",
	".m4v": "video/x-m4v",
	".avi": "video/x-msvideo",
	".wmv": "video/x-ms-wmv",
};

/** True when the path names a video container we handle through ffmpeg. */
export function isVideoPath(filePath: string): boolean {
	return VIDEO_EXTENSION_LOOKUP[path.extname(filePath).toLowerCase()] === true;
}

/** Container MIME for a video path, or undefined for non-video. */
export function videoMimeForPath(filePath: string): string | undefined {
	return VIDEO_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

/** Frame (`clip.mp4:412`) or timestamp (`clip.mp4:1h5m42s`) subread selector. */
export type VideoSelector = { kind: "frame"; frame: number } | { kind: "time"; seconds: number; raw: string };

const FRAME_SELECTOR_RE = /^(?:f|frame)?(\d+)$/i;
const COLON_TIMESTAMP_RE = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/;
const UNIT_TIMESTAMP_RE = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i;
const BARE_SECONDS_RE = /^\d+\.\d+$/;

/**
 * Parse a read-selector suffix for a video path. Bare integers are frame
 * indices; colon/unit timestamps and fractional seconds are seek positions.
 * Returns null when the suffix is not video-selector-shaped.
 */
export function parseVideoSelector(sel: string | undefined): VideoSelector | null {
	if (sel === undefined || sel.length === 0) return null;
	const trimmed = sel.trim();
	const frameMatch = FRAME_SELECTOR_RE.exec(trimmed);
	// A bare integer is always a frame index — timestamps need a unit, a colon,
	// or a fraction, so `:412` means frame 412 while `:42s` seeks to 42 seconds.
	if (frameMatch && !trimmed.includes(":") && !trimmed.toLowerCase().endsWith("s")) {
		const frame = Number.parseInt(frameMatch[1]!, 10);
		return Number.isSafeInteger(frame) ? { kind: "frame", frame } : null;
	}
	const seconds = parseVideoTimestamp(trimmed);
	return seconds === null ? null : { kind: "time", seconds, raw: trimmed };
}

/** Parse a timestamp suffix into seconds, or null when not timestamp-shaped. */
export function parseVideoTimestamp(value: string): number | null {
	const colon = COLON_TIMESTAMP_RE.exec(value);
	if (colon) {
		const hours = colon[1] === undefined ? 0 : Number.parseInt(colon[1], 10);
		const minutes = Number.parseInt(colon[2]!, 10);
		const seconds = Number.parseFloat(colon[3]!);
		return hours * 3600 + minutes * 60 + seconds;
	}
	const unit = UNIT_TIMESTAMP_RE.exec(value);
	if (unit && (unit[1] !== undefined || unit[2] !== undefined || unit[3] !== undefined)) {
		const hours = unit[1] === undefined ? 0 : Number.parseFloat(unit[1]);
		const minutes = unit[2] === undefined ? 0 : Number.parseFloat(unit[2]);
		const seconds = unit[3] === undefined ? 0 : Number.parseFloat(unit[3]);
		if (value.toLowerCase().endsWith("m") && unit[3] === undefined) return hours * 3600 + minutes * 60;
		return hours * 3600 + minutes * 60 + seconds;
	}
	if (BARE_SECONDS_RE.test(value)) return Number.parseFloat(value);
	return null;
}

/**
 * Split a trailing video selector off a raw read path (`clip.mp4:1h5m42s`).
 * Pure string split — the caller checks the base resolves to a video file so
 * real filenames containing colons keep precedence.
 */
const VIDEO_PATH_SELECTOR_RE = /^(.*\.(?:mp4|mov|mkv|webm|m4v|avi|wmv)):(.+)$/is;

export function splitVideoReadTarget(rawPath: string): { path: string; sel: string } | null {
	const match = VIDEO_PATH_SELECTOR_RE.exec(rawPath);
	if (!match) return null;
	const base = match[1]!;
	const sel = match[2]!;
	if (!isVideoPath(base) || parseVideoSelector(sel) === null) return null;
	return { path: base, sel };
}

/** Stream-level facts surfaced in the text details block. */
export interface VideoMetadata {
	readonly durationSec: number | undefined;
	readonly videoCodec: string | undefined;
	readonly audioCodec: string | undefined;
	readonly width: number | undefined;
	readonly height: number | undefined;
	readonly fps: number | undefined;
	readonly formatName: string | undefined;
}

/** Raised when ffmpeg/ffprobe is missing or a video operation fails. Message is user-facing. */
export class VideoError extends Error {}

/**
 * Original local source path stored on a generated contact-sheet image. Symbol
 * metadata stays out of serialized/model-bound image data while traveling with
 * the draft object until AgentSession creates its hidden companion message.
 */
const kVideoPreviewSource = Symbol("video.previewSource");

/** A contact-sheet image tagged with the original local video path. */
export type VideoPreviewImage = ImageContent & {
	readonly [kVideoPreviewSource]: string;
};

/** Create a model-ready contact-sheet image tagged with its original video path. */
export function createVideoPreviewImage(preview: ImageContent, sourcePath: string): VideoPreviewImage {
	return {
		type: "image",
		data: preview.data,
		mimeType: preview.mimeType,
		[kVideoPreviewSource]: sourcePath,
	};
}

/** Return the original video path associated with a generated contact-sheet image. */
export function videoPreviewSource(preview: ImageContent): string | undefined {
	if (!(kVideoPreviewSource in preview)) return undefined;
	const sourcePath = preview[kVideoPreviewSource];
	return typeof sourcePath === "string" ? sourcePath : undefined;
}

let cachedFpsModeFlag: string[] | null = null;

/**
 * Frame-passthrough flag across the ffmpeg 5.1 rename (`-vsync 0` became
 * `-fps_mode passthrough`, and ffmpeg 9 removed `-vsync` entirely). Probed
 * once from `ffmpeg -version`; unknown output keeps the modern spelling.
 */
async function framePassthroughFlag(): Promise<string[]> {
	if (cachedFpsModeFlag) return cachedFpsModeFlag;
	try {
		const ffmpeg = requireMediaBinary("ffmpeg");
		const child = Bun.spawn([ffmpeg, "-version"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, ,] = await Promise.all([readStream(child.stdout), readStream(child.stderr), child.exited]);
		const major = Number.parseInt(stdout.split("\n")[0]?.split("version")[1]?.trim().split(".")[0] ?? "", 10);
		cachedFpsModeFlag = Number.isFinite(major) && major < 5 ? ["-vsync", "0"] : ["-fps_mode", "passthrough"];
	} catch {
		cachedFpsModeFlag = ["-fps_mode", "passthrough"];
	}
	return cachedFpsModeFlag;
}

/** Resolve a system binary or throw a user-facing install hint. */
function requireMediaBinary(name: "ffmpeg" | "ffprobe"): string {
	const found = $which(name);
	if (!found) {
		throw new VideoError(
			`Reading video requires ${name}, which was not found on PATH. Install it (e.g. \`brew install ffmpeg\`) and retry.`,
		);
	}
	return found;
}

interface FfprobeStream {
	codec_type?: string;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
}

interface FfprobeFormat {
	duration?: string;
	format_name?: string;
}

function parseFrameRate(value: string | undefined): number | undefined {
	if (!value || value === "0/0") return undefined;
	const slash = value.indexOf("/");
	if (slash === -1) {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	const num = Number.parseFloat(value.slice(0, slash));
	const den = Number.parseFloat(value.slice(slash + 1));
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return undefined;
	return num / den;
}

/**
 * Probe container metadata with ffprobe. Never throws on unparseable output —
 * unknown fields come back undefined so the read still yields a contact sheet.
 */
export async function probeVideo(absolutePath: string, signal?: AbortSignal): Promise<VideoMetadata> {
	const ffprobe = requireMediaBinary("ffprobe");
	if (signal?.aborted) throw new VideoError("Video operation aborted.");
	const child = Bun.spawn(
		[
			ffprobe,
			"-v",
			"error",
			"-show_entries",
			"format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate",
			"-of",
			"json",
			absolutePath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const killOnAbort = () => {
		child.kill();
	};
	signal?.addEventListener("abort", killOnAbort, { once: true });
	let stdout: string;
	let stderr: string;
	let exitCode: number;
	try {
		[stdout, stderr, exitCode] = await untilAborted(
			signal,
			Promise.all([readStream(child.stdout), readStream(child.stderr), child.exited]),
		);
	} catch (error) {
		if (signal?.aborted) throw new VideoError("Video operation aborted.");
		throw error;
	} finally {
		signal?.removeEventListener("abort", killOnAbort);
	}
	if (exitCode !== 0) {
		throw new VideoError(
			`Could not probe video '${path.basename(absolutePath)}': ${stderr.trim().slice(-300) || `ffprobe exited ${exitCode}`}`,
		);
	}
	let parsed: { streams?: FfprobeStream[]; format?: FfprobeFormat };
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new VideoError(`Could not probe video '${path.basename(absolutePath)}': unexpected ffprobe output.`);
	}
	const video = parsed.streams?.find(stream => stream.codec_type === "video");
	const audio = parsed.streams?.find(stream => stream.codec_type === "audio");
	const duration = parsed.format?.duration === undefined ? undefined : Number.parseFloat(parsed.format.duration);
	return {
		durationSec: duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : undefined,
		videoCodec: video?.codec_name,
		audioCodec: audio?.codec_name,
		width: video?.width,
		height: video?.height,
		fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
		formatName: parsed.format?.format_name,
	};
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/** Format seconds as `1h5m42s` (or `m:ss` below an hour) for details blocks. */
export function formatVideoTimestamp(totalSeconds: number): string {
	const floored = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(floored / 3600);
	const minutes = Math.floor((floored % 3600) / 60);
	const seconds = floored % 60;
	if (hours > 0) return `${hours}h${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationLong(totalSeconds: number): string {
	const floored = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(floored / 3600);
	const minutes = Math.floor((floored % 3600) / 60);
	const seconds = floored % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(" ");
}

/**
 * One-line text details for a video: name, container, duration, resolution,
 * fps, codecs, file size. Shared by reads and @mention/CLI attachments.
 */
export function formatVideoDetails(
	displayPath: string,
	meta: VideoMetadata,
	fileSize: number,
	mimeType: string | undefined,
): string {
	const lines = [`Video: ${displayPath}`];
	if (mimeType) lines.push(`- Container: ${mimeType}${meta.formatName ? ` (${meta.formatName})` : ""}`);
	else if (meta.formatName) lines.push(`- Container: ${meta.formatName}`);
	lines.push(
		`- Duration: ${meta.durationSec !== undefined ? `${formatDurationLong(meta.durationSec)} (${meta.durationSec.toFixed(1)}s)` : "unknown"}`,
		`- Resolution: ${meta.width !== undefined && meta.height !== undefined ? `${meta.width}x${meta.height}` : "unknown"}`,
		`- FPS: ${meta.fps !== undefined ? meta.fps.toFixed(2) : "unknown"}`,
		`- Video codec: ${meta.videoCodec ?? "unknown"}`,
		`- Audio codec: ${meta.audioCodec ?? "none"}`,
		`- Size: ${formatByteSize(fileSize)}`,
	);
	return lines.join("\n");
}

function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${kib.toFixed(1)} KiB`;
	const mib = kib / 1024;
	if (mib < 1024) return `${mib.toFixed(1)} MiB`;
	return `${(mib / 1024).toFixed(1)} GiB`;
}

/** Base64 PNG bytes plus its MIME, ready to attach as an image block. */
export interface VideoPng {
	readonly data: string;
	readonly mimeType: "image/png";
}

async function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
	const ffmpeg = requireMediaBinary("ffmpeg");
	if (signal?.aborted) throw new VideoError("Video operation aborted.");
	const child = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const killOnAbort = () => {
		child.kill();
	};
	signal?.addEventListener("abort", killOnAbort, { once: true });
	let stderr: string;
	let exitCode: number;
	try {
		[, stderr, exitCode] = await untilAborted(
			signal,
			Promise.all([readStream(child.stdout), readStream(child.stderr), child.exited]),
		);
	} catch (error) {
		if (signal?.aborted) throw new VideoError("Video operation aborted.");
		throw error;
	} finally {
		signal?.removeEventListener("abort", killOnAbort);
	}
	if (exitCode !== 0) throw new VideoError(`ffmpeg failed (exit ${exitCode}): ${stderr.trim().slice(-300)}`);
}

/**
 * Extract one frame as PNG: timestamp selectors seek (`-ss` before `-i`),
 * frame indices use the `select` filter from the start.
 */
export async function extractVideoFramePng(
	absolutePath: string,
	selector: VideoSelector,
	signal?: AbortSignal,
): Promise<VideoPng> {
	const tmp = await TempDir.create("omp-video-frame-");
	try {
		const out = tmp.join("frame.png");
		if (selector.kind === "time") {
			await runFfmpeg(["-ss", String(selector.seconds), "-i", absolutePath, "-frames:v", "1", out], signal);
		} else {
			await runFfmpeg(
				[
					"-i",
					absolutePath,
					"-vf",
					`select='eq(n\\,${selector.frame})'`,
					...(await framePassthroughFlag()),
					"-frames:v",
					"1",
					out,
				],
				signal,
			);
		}
		const bytes = await Bun.file(out)
			.bytes()
			.catch(() => null);
		if (!bytes || bytes.length === 0) {
			const at = selector.kind === "time" ? `timestamp ${selector.raw}` : `frame ${selector.frame}`;
			throw new VideoError(`No frame at ${at} — it may be past the end of the video.`);
		}
		return { data: Buffer.from(bytes).toBase64(), mimeType: "image/png" };
	} finally {
		await tmp.remove().catch(() => {});
	}
}

/** Contact-sheet layout: thumbnails, grid columns/rows. */
export interface ContactSheet {
	readonly png: VideoPng;
	readonly thumbs: number;
	readonly cols: number;
	readonly rows: number;
}

const CONTACT_SHEET_THUMBS = 6;
const CONTACT_SHEET_COLS = 3;
const CONTACT_SHEET_THUMB_WIDTH = 320;

/**
 * Build a contact-sheet preview: evenly spaced frames across the duration,
 * tiled into one PNG. Input seeks keep each extraction cheap even on long
 * files; the tile pass only ever sees thumbnail-sized inputs.
 */
export async function buildVideoContactSheetPng(
	absolutePath: string,
	meta: VideoMetadata,
	signal?: AbortSignal,
): Promise<ContactSheet> {
	const thumbs = CONTACT_SHEET_THUMBS;
	const cols = CONTACT_SHEET_COLS;
	const rows = Math.ceil(thumbs / cols);
	const tmp = await TempDir.create("omp-video-sheet-");
	try {
		const duration = meta.durationSec;
		const times: number[] =
			duration !== undefined && duration > 0
				? Array.from({ length: thumbs }, (_, i) => (duration * (i + 0.5)) / thumbs)
				: Array.from({ length: thumbs }, (_, i) => i);
		const thumbPaths = times.map((_, i) => tmp.join(`thumb-${i}.png`));
		await Promise.all(
			times.map((time, i) =>
				runFfmpeg(
					[
						"-ss",
						String(time),
						"-i",
						absolutePath,
						"-frames:v",
						"1",
						"-vf",
						`scale=${CONTACT_SHEET_THUMB_WIDTH}:-1`,
						thumbPaths[i]!,
					],
					signal,
				).catch(error => {
					// Past-the-end seeks on short/odd files leave a hole; the tile
					// pass runs over whatever thumbs materialized instead. Cancellation
					// is not a missing frame and must still stop every worker promptly.
					if (signal?.aborted) throw error;
				}),
			),
		);
		const available = thumbPaths.filter(thumb => Bun.file(thumb).size > 0);
		if (available.length === 0) throw new VideoError("Could not extract any preview frames from this video.");
		const sheet = tmp.join("sheet.png");
		const inputs = available.flatMap(thumb => ["-i", thumb]);
		// Tile lays out consecutive frames of one stream, so concat the stills
		// first — without it only the first thumb fills the grid.
		const concat = available.map((_, i) => `[${i}:v]`).join("");
		await runFfmpeg(
			[
				...inputs,
				"-filter_complex",
				`${concat}concat=n=${available.length}:v=1:a=0,tile=${cols}x${rows}`,
				"-frames:v",
				"1",
				sheet,
			],
			signal,
		);
		const bytes = await Bun.file(sheet)
			.bytes()
			.catch(() => null);
		if (!bytes || bytes.length === 0) throw new VideoError("Could not build a video preview grid for this file.");
		return {
			png: { data: Buffer.from(bytes).toBase64(), mimeType: "image/png" },
			thumbs: available.length,
			cols,
			rows,
		};
	} finally {
		await tmp.remove().catch(() => {});
	}
}
