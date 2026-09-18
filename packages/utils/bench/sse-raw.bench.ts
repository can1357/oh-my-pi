/**
 * Benchmark: SSE `raw` capture on the token path (agent finding F4).
 *
 * Streams 20k data frames through readSseEvents with capture off (new
 * default) vs forced on. Each captured frame pays an array allocation plus
 * one string slice per line; the diagnostic observer is the only reader.
 *
 * Run: bun packages/utils/bench/sse-raw.bench.ts
 */
import { readSseEvents } from "../src/stream";

const FRAMES = 20_000;
const payload = `data: {"id":"chatcmpl-1234567890","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}\n\n`;
const bytes = new TextEncoder().encode(payload.repeat(FRAMES));

function body(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

async function run(captureRaw: boolean): Promise<{ ms: number; slices: number }> {
	// Count string-slice-equivalent work deterministically: captureRaw ? 1
	// slice per line per frame : 0. Wall-clock medians are reported alongside
	// but the slice count is the stable signal (it is noise-free).
	const start = Bun.nanoseconds();
	let n = 0;
	let slices = 0;
	for await (const event of readSseEvents(body(), undefined, captureRaw ? { captureRaw: true } : undefined)) {
		n += event.data.length;
		slices += event.raw.length;
		if (n < 0) console.log("unreachable");
	}
	return { ms: (Bun.nanoseconds() - start) / 1e6, slices };
}

await run(false); // warmup
const RUNS = 5;
const off: number[] = [];
const on: number[] = [];
for (let i = 0; i < RUNS; i++) {
	off.push(await run(false));
	on.push(await run(true));
}
off.sort((a, b) => a.ms - b.ms);
on.sort((a, b) => a.ms - b.ms);
console.log(`${FRAMES} SSE frames x${RUNS} runs (1 data line per frame)`);
console.log(`capture off (new default): median ${off[2]!.ms.toFixed(1)}ms, raw slices ${off[2]!.slices}`);
console.log(`capture on (observer path): median ${on[2]!.ms.toFixed(1)}ms, raw slices ${on[2]!.slices}`);
