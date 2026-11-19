/**
 * Fake speech worker for `test/daemon/speech-module.test.ts`: speaks the
 * binary frame protocol of `src/daemon/modules/speech-frames.ts` on stdio.
 *
 * - `ping` -> `pong`
 * - `stream_start { tag }` -> `stream_started`; the stream stays open
 * - `stream_push { chunks }` (open stream) -> `chunks` x `stream_chunk { tag, index }`
 *   with PCM payload `[index & 0xff, tag char code]`, then `stream_done`
 * - `transcribe` with a PCM payload -> `transcription` echoing the payload byte for byte
 *
 * Every received header is appended as one JSON line to `FAKE_FRAME_LOG`.
 * Exits when stdin closes.
 */
import * as fs from "node:fs";
import { encodeFrame, FrameDecoder, type SpeechFrame } from "../../src/daemon/modules/speech-frames";

const logPath = process.env.FAKE_FRAME_LOG;
const tags = new Map<string, string>();

function send(header: Record<string, unknown>, payload?: Uint8Array): void {
	process.stdout.write(encodeFrame(header, payload));
}

function handle({ header, payload }: SpeechFrame): void {
	if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(header)}\n`);
	const id = header.id as string;
	switch (header.type) {
		case "ping":
			send({ type: "pong", id });
			return;
		case "stream_start":
			tags.set(id, String(header.tag));
			send({ type: "stream_started", id });
			return;
		case "stream_push": {
			const tag = tags.get(id) ?? "?";
			const chunks = Number(header.chunks);
			for (let index = 0; index < chunks; index++) {
				send({ type: "stream_chunk", id, tag, index }, Uint8Array.of(index & 0xff, tag.charCodeAt(0)));
			}
			tags.delete(id);
			send({ type: "stream_done", id });
			return;
		}
		case "transcribe":
			send({ type: "transcription", id, $pcm: header.$pcm }, payload ?? new Uint8Array());
			return;
		default:
			return;
	}
}

const decoder = new FrameDecoder();
for await (const chunk of Bun.stdin.stream()) decoder.push(chunk, handle);
process.exit(0);
