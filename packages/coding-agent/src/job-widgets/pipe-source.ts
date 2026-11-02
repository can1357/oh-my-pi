import type { PipeStreamInfo, PipeStreams } from "@oh-my-pi/pi-natives";
import { truncate } from "@oh-my-pi/pi-utils";
import type { JobTextChunk, JobTextSource } from "./types";

/** Longest pipe label: `producer → consumer` on one line. */
const MAX_LABEL_CHARS = 80;

/**
 * One tapped pipe of a bash run as a {@link JobTextSource} with id
 * `pipe:<n>`. Offsets are stream bytes; a streaming decoder keeps multi-byte
 * characters split across reads intact and restarts whenever a read does not
 * continue where the previous one ended (a gap, or a reread from the start).
 *
 * A pipe that carried a NUL byte (`git archive | tar -x`, `curl | gunzip`) is
 * binary from then on and reads as empty text: decoded, its runs between
 * newlines would count as lines and surface as mojibake in the widget's stage
 * and the author's samples. Every read is scanned, not just the stream's head:
 * a fast producer outruns the retained window, so the first read can open deep
 * inside an archived text file.
 */
export class PipeTextSource implements JobTextSource {
	readonly id: string;
	readonly label: string;
	readonly streamId: number;
	#decoder = new TextDecoder();
	/** Stream offset the decoder's state continues from. */
	#decodedTo = -1;
	/** The stream carried a NUL byte. */
	#binary = false;

	constructor(
		readonly streams: PipeStreams,
		info: PipeStreamInfo,
	) {
		this.id = `pipe:${info.id}`;
		this.streamId = info.id;
		// Stage source can span lines (`for …; do …; done`); the label keeps each side on one line.
		const [producer, consumer] = [info.producer, info.consumer].map(stage => stage.replace(/\s+/g, " ").trim());
		this.label = truncate(`${producer} → ${consumer}`, MAX_LABEL_CHARS);
	}

	read(from: number): JobTextChunk {
		const chunk = this.streams.read(this.streamId, from);
		if (!chunk) return { start: from, end: from, text: "", open: false };
		this.#binary ||= chunk.data.indexOf(0) !== -1;
		if (this.#binary) return { start: chunk.start, end: chunk.end, text: "", open: chunk.open };
		if (chunk.start !== this.#decodedTo) this.#decoder = new TextDecoder();
		const text = this.#decoder.decode(chunk.data, { stream: chunk.open });
		this.#decodedTo = chunk.end;
		return { start: chunk.start, end: chunk.end, text, open: chunk.open };
	}
}

/**
 * The pipes of one bash run as text sources, one stable {@link PipeTextSource}
 * per stream so each keeps its decoder across refreshes.
 */
export class PipeTextSources {
	readonly #sources = new Map<number, PipeTextSource>();

	constructor(readonly streams: PipeStreams) {}

	list(): PipeTextSource[] {
		const out: PipeTextSource[] = [];
		for (const info of this.streams.list()) {
			let source = this.#sources.get(info.id);
			if (!source) {
				source = new PipeTextSource(this.streams, info);
				this.#sources.set(info.id, source);
			}
			out.push(source);
		}
		return out;
	}
}
