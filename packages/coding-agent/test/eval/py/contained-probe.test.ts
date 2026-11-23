import { describe, expect, it } from "bun:test";
import { containedProbeRunner } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import type { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";

const CHUNK = new Uint8Array(16 * 1024);
/** A finite, noisy probe: 4 MiB of output, far above the bound the probe runner reads. */
const TOTAL_CHUNKS = 256;

describe("containedProbeRunner output bound", () => {
	it("cancels a noisy probe's stdout once the bound is read instead of buffering all of it", async () => {
		let produced = 0;
		let cancelled = false;
		const finished = Promise.withResolvers<void>();
		const stdout = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (produced === TOTAL_CHUNKS) {
					controller.close();
					finished.resolve();
					return;
				}
				produced++;
				controller.enqueue(CHUNK);
			},
			cancel() {
				cancelled = true;
				finished.resolve();
			},
		});
		const stderr = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const sandbox = {
			spawn: async () => ({
				pid: 1,
				stdin: { write() {}, flush() {}, end() {} },
				stdout,
				stderr,
				// The "interpreter" exits once its stdout is cancelled or fully read.
				exited: finished.promise.then(() => 0),
				exitCode: null,
				kill() {},
			}),
		} as unknown as SandboxRuntime;

		const result = await containedProbeRunner(
			sandbox,
			process.cwd(),
			[],
		)(["python3", "-c", "pass"], {
			cwd: process.cwd(),
			env: {},
			timeoutMs: 5_000,
		});

		expect(result).toEqual({ exitCode: 0, timedOut: false, aborted: false });
		expect(cancelled).toBe(true);
		expect(produced).toBeLessThan(TOTAL_CHUNKS);
	}, 10_000);
});
