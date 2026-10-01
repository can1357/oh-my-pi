/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/4324
 *
 * The Kokoro TTS worker crash-loops with `exit code 7`, but every worker
 * subprocess was spawned with `stderr: "ignore"` — so the native crash message
 * (ONNX Runtime traceback, glibc assertion, segfault details) was discarded
 * and the parent only ever logged `tts subprocess exited with code 7`, with no
 * way to diagnose what actually blew up.
 *
 * The fix pipes stderr without starting a live read while the worker is idle;
 * after `onExit`, it drains the pipe, keeps the last 16 KiB in a bounded ring,
 * and appends that tail to the `Error` surfaced to `onError` handlers. These
 * tests pin that contract so the exit-code-7 crash (and the next one) actually
 * shows up in `~/.omp/logs/omp.log` without regressing idle-worker shutdown.
 */
import { describe, expect, it } from "bun:test";
import { createWorkerSubprocess, type SpawnedSubprocess } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";

interface FakeWorkerOutbound {
	type: "pong";
	id: string;
}

/** Build a spawn command that emits `stderr` verbatim then exits with `exitCode`. */
function stderrExitCommand(stderr: string, exitCode: number): { cmd: string[] } {
	const script = `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exitCode});`;
	return { cmd: [process.execPath, "-e", script] };
}

/**
 * Resolve the first worker-error handler fires with. The subprocess wires the
 * error surface off `stderrDrained` so this always resolves after the stderr
 * tail has fully drained — no wall-clock races.
 */
function firstWorkerError(sub: SpawnedSubprocess<FakeWorkerOutbound>): Promise<Error> {
	const { promise, resolve } = Promise.withResolvers<Error>();
	sub.errors.add(resolve);
	return promise;
}

describe("issue #4324 — worker subprocess stderr survives to the exit error", () => {
	it("surfaces stderr in the onExit error when the worker exits non-zero", async () => {
		const stderr =
			"onnxruntime[Native]: Non-zero status code returned while executing Add node.\n" +
			"terminate called after throwing an instance of 'std::runtime_error'\n" +
			"  what():  cudaMemcpy failed\n";
		const sub = createWorkerSubprocess<FakeWorkerOutbound>({
			spawnCommand: stderrExitCommand(stderr, 7),
			env: {},
			exitLabel: "tts subprocess",
		});
		const err = await firstWorkerError(sub);
		// The exit-code prefix is preserved so existing log parsers keep working.
		expect(err.message).toStartWith("tts subprocess exited with code 7");
		// The actual native crash reason must now be part of the error.
		expect(err.message).toContain("onnxruntime[Native]");
		expect(err.message).toContain("cudaMemcpy failed");
	}, 15_000);

	it("truncates a large stderr to the last ~16 KiB so a chatty runtime can't blow the parent up", async () => {
		// Write well past the 16 KiB tail limit. A recognisable trailer must
		// still land at the end so the diagnostic tail is what survives.
		const filler = "A".repeat(64 * 1024);
		const trailer = "FATAL: onnxruntime session run failed\n";
		const sub = createWorkerSubprocess<FakeWorkerOutbound>({
			spawnCommand: stderrExitCommand(filler + trailer, 7),
			env: {},
			exitLabel: "tts subprocess",
		});
		const err = await firstWorkerError(sub);
		// Trailer wins.
		expect(err.message).toContain("FATAL: onnxruntime session run failed");
		// Truncation happened — we did not append the whole 64 KiB.
		expect(err.message.length).toBeLessThan(20_000);
	}, 15_000);

	it("does not surface intentional terminate() SIGKILLs as worker errors", async () => {
		// Regression guard: piping stderr must not change the semantics of an
		// intentional teardown. The wrapper's `terminate()` flips
		// `intentionalExit` then SIGKILLs — the error channel must stay quiet.
		const sub = createWorkerSubprocess<FakeWorkerOutbound>({
			// A sleeping child so we get to SIGKILL it before it exits on its own.
			spawnCommand: {
				cmd: [process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);"],
			},
			env: {},
			exitLabel: "tts subprocess",
		});
		let errored = false;
		sub.errors.add(() => {
			errored = true;
		});
		sub.intentionalExit.value = true;
		sub.proc.kill("SIGKILL");
		// Wait for both process reap AND stderr drain so any latent error
		// path has had its shot at firing before we assert silence.
		await sub.proc.exited;
		await sub.stderrDrained;
		expect(errored).toBe(false);
	}, 15_000);
});
