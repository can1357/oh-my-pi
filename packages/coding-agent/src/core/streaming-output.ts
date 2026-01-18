import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell";
import { truncateTail } from "./tools/truncate";

interface OutputFileSink {
	write(data: string): number | Promise<number>;
	end(): void;
}

export function createSanitizer(): TransformStream<Uint8Array, string> {
	const decoder = new TextDecoder();
	return new TransformStream({
		transform(chunk, controller) {
			const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(chunk, { stream: true }))).replace(/\r/g, "");
			controller.enqueue(text);
		},
	});
}

export async function pumpStream(readable: ReadableStream<Uint8Array>, writer: WritableStreamDefaultWriter<string>) {
	const reader = readable.pipeThrough(createSanitizer()).getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await writer.write(value);
		}
	} finally {
		reader.releaseLock();
	}
}

export function createOutputSink(
	spillThreshold: number,
	maxBuffer: number,
	onChunk?: (text: string) => void,
): WritableStream<string> & {
	dump: (annotation?: string) => { output: string; truncated: boolean; fullOutputPath?: string };
} {
	const chunks: string[] = [];
	let chunkBytes = 0;
	let totalBytes = 0;
	let fullOutputPath: string | undefined;
	let fullOutputStream: OutputFileSink | undefined;

	const sink = new WritableStream<string>({
		write(text) {
			totalBytes += text.length;

			if (totalBytes > spillThreshold && !fullOutputPath) {
				fullOutputPath = join(tmpdir(), `omp-${nanoid()}.buffer`);
				const stream = Bun.file(fullOutputPath).writer();
				chunks.forEach((chunk) => {
					stream.write(chunk);
				});
				fullOutputStream = stream;
			}
			fullOutputStream?.write(text);

			chunks.push(text);
			chunkBytes += text.length;
			while (chunkBytes > maxBuffer && chunks.length > 1) {
				chunkBytes -= chunks.shift()!.length;
			}

			onChunk?.(text);
		},
		close() {
			fullOutputStream?.end();
		},
	});

	return Object.assign(sink, {
		dump(annotation?: string) {
			if (annotation) {
				chunks.push(`\n\n${annotation}`);
			}
			const full = chunks.join("");
			const { content, truncated } = truncateTail(full);
			return { output: truncated ? content : full, truncated, fullOutputPath };
		},
	});
}
