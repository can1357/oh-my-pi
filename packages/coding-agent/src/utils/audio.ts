/**
 * Audio files via system ffmpeg: extension classification and streaming PCM
 * decode of a media file's audio track (audio files and video soundtracks).
 */
import * as path from "node:path";
import { requireMediaBinary, VideoError } from "./video";

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

/** True when the path names an audio container we decode through ffmpeg. */
export function isAudioPath(filePath: string): boolean {
	return audioMimeForPath(filePath) !== undefined;
}

/**
 * Decode the first audio stream of a media file to mono float32 PCM at
 * `sampleRate`, yielding samples as ffmpeg produces them. Decoding is one
 * sequential pass (never seeks), so sample `n` is exactly `n / sampleRate`
 * seconds into the track. ffmpeg is killed when the consumer stops early or
 * the signal aborts; a non-zero exit throws a user-facing {@link VideoError}.
 */
export async function* decodeAudioPcm(
	absolutePath: string,
	sampleRate: number,
	signal?: AbortSignal,
): AsyncGenerator<Float32Array> {
	const ffmpeg = requireMediaBinary("ffmpeg");
	signal?.throwIfAborted();
	const child = Bun.spawn(
		[
			ffmpeg,
			"-nostdin",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			absolutePath,
			"-map",
			"0:a:0",
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(sampleRate),
			"-f",
			"f32le",
			"pipe:1",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const kill = (): void => {
		child.kill();
	};
	signal?.addEventListener("abort", kill, { once: true });
	const stderr = new Response(child.stderr).text();
	// f32le frames can straddle pipe reads; carry the partial sample forward.
	let carry = new Uint8Array(0);
	try {
		for await (const bytes of child.stdout) {
			let joined = bytes;
			if (carry.length > 0) {
				joined = new Uint8Array(carry.length + bytes.length);
				joined.set(carry);
				joined.set(bytes, carry.length);
			}
			const usable = joined.length - (joined.length % 4);
			carry = joined.slice(usable);
			if (usable === 0) continue;
			const samples = new Float32Array(usable / 4);
			new Uint8Array(samples.buffer).set(joined.subarray(0, usable));
			yield samples;
		}
		const exitCode = await child.exited;
		signal?.throwIfAborted();
		if (exitCode !== 0) {
			throw new VideoError(
				`ffmpeg could not decode audio from '${path.basename(absolutePath)}' (exit ${exitCode}): ${(await stderr).trim().slice(-300)}`,
			);
		}
	} finally {
		signal?.removeEventListener("abort", kill);
		if (child.exitCode === null) child.kill();
	}
}
