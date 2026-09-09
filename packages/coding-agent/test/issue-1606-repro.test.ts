/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1606
 *
 * On Windows, `onnxruntime-node`'s NAPI finalizer segfaults Bun during
 * shutdown after `@huggingface/transformers` has loaded a tiny model in a
 * Worker thread. The agent used to host the tiny-model worker as a Worker
 * inside its own process; tearing the worker down ran the native destructor
 * in the parent's address space and crashed the CLI on exit.
 *
 * The fix relocates the worker to its own process: `title-client.ts` spawns
 * `process.execPath … __omp_worker_tiny_inference` (detached, owning a
 * per-model socket), `cli.ts` dispatches that flag into `runTinyWorker`, and
 * the omp process only ever holds a socket to it — the native finalizer never
 * runs in an omp address space. These tests pin that contract so a future
 * refactor cannot quietly land the original crash again.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	connectTinyWorker,
	onnxLaunch,
	smokeTestTinyTitleWorker,
	TINY_WORKER_CLOSED,
} from "@oh-my-pi/pi-coding-agent/tiny/title-client";

describe("issue #1606 — tiny model lives in an isolated process", () => {
	it("ping/pongs through the spawned worker process and tears it down cleanly", async () => {
		await smokeTestTinyTitleWorker({ timeoutMs: 15_000 });
	}, 30_000);

	it("surfaces the worker going away so in-flight callers don't await forever, but not our own terminate()", async () => {
		// The worker exits on `shutdown` exactly like an idle exit, an OOM kill,
		// or an operator `kill -9` would look to us: the socket closes. That MUST
		// fault callers via the `onError` channel — an earlier fix swallowed
		// unexpected exits and left `TinyTitleClient.#pending` hanging forever —
		// while a `terminate()` we issued ourselves MUST NOT.
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-1606-"));
		try {
			const launch = onnxLaunch("lfm2.5-230m", {});
			const quiet = await connectTinyWorker(launch, "lfm2.5-230m", runtimeDir);
			let quietErrors = 0;
			quiet.onError(() => {
				quietErrors += 1;
			});
			await quiet.terminate();

			const noisy = await connectTinyWorker(launch, "lfm2.5-230m", runtimeDir);
			const { promise, resolve } = Promise.withResolvers<Error>();
			noisy.onError(resolve);
			noisy.send({ type: "shutdown", id: "1" });
			const error = await promise;

			expect(error.message).toStartWith(TINY_WORKER_CLOSED);
			expect(quietErrors).toBe(0);
		} finally {
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	}, 30_000);
});
