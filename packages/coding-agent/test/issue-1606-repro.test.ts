/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/1606
 *
 * On Windows, `onnxruntime-node`'s NAPI finalizer segfaults Bun during
 * shutdown after `@huggingface/transformers` has loaded a tiny model in a
 * Worker thread. The agent used to host the tiny-model worker as a Worker
 * inside its own process; tearing the worker down ran the native destructor
 * in the parent's address space and crashed the CLI on exit.
 *
 * The fix relocates the worker to a child process: `title-client.ts` spawns
 * `process.execPath … __omp_tiny_inference`, `cli.ts` dispatches that flag into
 * `runTinyWorker`, and the parent `SIGKILL`s the child on dispose so the
 * native finalizer never runs in either address space. These tests pin the
 * three pieces of that contract so a future refactor cannot quietly land
 * the original crash again.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { createTinyTitleSubprocess } from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-client";

describe("issue #1606 — tiny model lives in an isolated subprocess", () => {
	it("ping/pongs through the spawned worker subprocess and tears it down cleanly", async () => {
		// `smokeTestTinyTitleWorker` is the runtime probe wired into
		// `omp --smoke-test`. Run it in a child Bun process instead of this
		// Bun-test worker: the test runner owns its own IPC channel and can
		// starve nested Bun subprocess IPC on some Bun builds.
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const script =
			'const { smokeTestTinyTitleWorker } = await import("@pk-nerdsaver-ai/pi-coding-agent/tiny/title-client"); await smokeTestTinyTitleWorker({ timeoutMs: 15000 });';
		const proc = Bun.spawn([process.execPath, "-e", script], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(`${stdout}${stderr}`).toBe("");
		expect(exitCode).toBe(0);
	}, 30_000);

	it("surfaces unexpected signal exits so in-flight callers don't await forever", async () => {
		// If the child dies from a signal we did NOT request — SIGSEGV from a
		// native crash (the original Windows shutdown bug, now relocated to
		// the child), an OOM SIGKILL, or an operator `kill -9` — the
		// subprocess wrapper must fault every in-flight request via the
		// `errors` channel. The original fix swallowed any `exitCode === null`
		// exit unconditionally, which left `TinyTitleClient.#pending`
		// promises hanging forever. Pin the new contract: an external
		// SIGKILL (no `intentionalExit` flip) MUST surface a worker error.
		const sub = createTinyTitleSubprocess();
		try {
			const { promise, resolve } = Promise.withResolvers<Error>();
			sub.errors.add(resolve);
			sub.proc.kill("SIGKILL");
			const err = await promise;
			expect(err.message).toMatch(/signal/i);
		} finally {
			// Ensure the child is reaped even on assertion failure.
			try {
				sub.proc.kill("SIGKILL");
			} catch {}
			await sub.proc.exited;
		}
	}, 15_000);

	it("does not surface intentional terminate() SIGKILLs as worker errors", async () => {
		// Inverse of the previous test: a SIGKILL issued by the wrapper's
		// own `terminate()` MUST NOT fault callers — terminate is the
		// shutdown path and the worker handle is already torn down by then.
		// Regression guard against an over-eager fix that surfaces every
		// signal exit indiscriminately.
		const sub = createTinyTitleSubprocess();
		let errored = false;
		sub.errors.add(() => {
			errored = true;
		});
		// Simulate what `wrapSubprocess.terminate()` does: flip the flag,
		// then SIGKILL. We test the primitive directly rather than going
		// through the wrapper to avoid coupling to `WorkerHandle` internals.
		sub.intentionalExit.value = true;
		sub.proc.kill("SIGKILL");
		await sub.proc.exited;
		// Give onExit a microtask to drain — Bun's exited promise resolves
		// after onExit fires, but be defensive.
		await Bun.sleep(20);
		expect(errored).toBe(false);
	}, 10_000);
});
