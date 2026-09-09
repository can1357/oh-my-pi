/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/3031
 *
 * Mnemopi's local embedding provider used to `import("onnxruntime-node")` and
 * `import("fastembed")` directly inside `fastembed-runtime.ts`. With
 * `memory.backend: mnemopi` enabled on Windows that crashed Bun in two ways:
 *   - Standalone binary: NAPI `process.dlopen` constructor segfault at
 *     session start, before any prompt rendered.
 *   - NPM install: NAPI finalizer segfault at process teardown.
 *
 * The fix relocates the embeddings stack into a Bun.spawn child process. The
 * agent's main process hands `mnemopi.setLocalModelInitializer` a wrapper that
 * round-trips through `__omp_worker_mnemopi_embed`, and `SIGKILL`s the child
 * on dispose so the destructor never runs in either address space. These tests
 * pin the three pieces of that contract so a future refactor cannot quietly
 * re-introduce the crash.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	createMnemopiEmbedSubprocess,
	MnemopiEmbedClient,
	type MnemopiEmbedWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedWorkerInbound,
	MnemopiEmbedWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";

describe("issue #3031 — mnemopi embeddings live in an isolated subprocess", () => {
	it("ping/pongs through the spawned worker subprocess and tears it down cleanly", async () => {
		// `smokeTestMnemopiEmbedWorker` is the runtime probe wired into
		// `omp --smoke-test`. Run it in a child Bun process instead of this
		// Bun-test worker: the test runner owns its own IPC channel and can
		// starve nested Bun subprocess IPC on some Bun builds.
		const repoRoot = path.resolve(import.meta.dir, "../../..");
		const script =
			'const { smokeTestMnemopiEmbedWorker } = await import("@oh-my-pi/pi-coding-agent/mnemopi/embed-client"); await smokeTestMnemopiEmbedWorker({ timeoutMs: 15000 });';
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
		// If the child dies from a signal we did NOT request — SIGSEGV from
		// onnxruntime's NAPI fault (the original Windows shutdown bug, now
		// relocated to the child), an OOM SIGKILL, or an operator `kill -9`
		// — the subprocess wrapper must fault every in-flight request via
		// the `errors` channel. Without this contract a `TinyTitleClient`-
		// style swallow would leave callers waiting forever on `await embed`.
		const sub = createMnemopiEmbedSubprocess();
		try {
			const { promise, resolve } = Promise.withResolvers<Error>();
			sub.errors.add(resolve);
			sub.proc.kill("SIGKILL");
			const err = await promise;
			expect(err.message).toMatch(/signal/i);
		} finally {
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
		const sub = createMnemopiEmbedSubprocess();
		let errored = false;
		sub.errors.add(() => {
			errored = true;
		});
		// Simulate what `wrapSubprocess.terminate()` does: flip the flag,
		// then SIGKILL. We test the primitive directly rather than going
		// through the wrapper to avoid coupling to `WorkerHandle` internals.
		// `proc.exited` resolves only after the `onExit` handler runs, so by
		// the time the await returns the error channel reflects the truth —
		// no real-clock sleep needed.
		sub.intentionalExit.value = true;
		sub.proc.kill("SIGKILL");
		await sub.proc.exited;
		expect(errored).toBe(false);
	}, 10_000);

	it("carries (model, cacheDir) on every embed so a respawned worker can self-init", async () => {
		// Without this contract: after `shutdownMnemopiEmbedClient()` runs on
		// session dispose, mnemopi still holds the cached `LocalEmbeddingModel`
		// wrapper. The next embed re-spawns a fresh subprocess that has never
		// seen `init`, and a bare `embed` request would trip the "embed before
		// init" guard and break local embeddings for the rest of the process.
		// Drive the protocol with a fake worker so the assertion runs without
		// fastembed/onnxruntime; we only care about the IPC the client emits.
		const sentMessages: MnemopiEmbedWorkerInbound[] = [];
		let messageHandler: ((message: MnemopiEmbedWorkerOutbound) => void) | undefined;
		const spawnCount = { value: 0 };
		const spawn = (): MnemopiEmbedWorkerHandle => {
			spawnCount.value += 1;
			return {
				send(message) {
					sentMessages.push(message);
					// Synthesize the worker's reply on the next tick so the
					// client's awaited promise resolves before the test asserts.
					queueMicrotask(() => {
						if (message.type === "ping") messageHandler?.({ type: "pong", id: message.id });
						else if (message.type === "init") messageHandler?.({ type: "ready", id: message.id });
						else if (message.type === "embed") {
							messageHandler?.({ type: "vectors", id: message.id, vectors: [[0, 0, 0]] });
						}
					});
				},
				onMessage(handler) {
					messageHandler = handler;
					return () => {
						if (messageHandler === handler) messageHandler = undefined;
					};
				},
				onError() {
					return () => {};
				},
				async terminate() {
					messageHandler = undefined;
				},
			};
		};

		const client = new MnemopiEmbedClient(spawn);
		const wrapper = await client.initialize("fast-bge-base-en-v1.5", "/tmp/cache");
		expect(wrapper).not.toBeNull();

		// Drain the wrapper once normally and snapshot the embed message.
		for await (const _ of wrapper!.embed(["hello"])) {
			/* drain */
		}
		// Tear down the worker as the session-dispose path does, then drive
		// the SAME cached wrapper again — the client must re-spawn and the
		// embed message must still carry (model, cacheDir).
		await client.terminate();
		for await (const _ of wrapper!.embed(["world"])) {
			/* drain */
		}

		expect(spawnCount.value).toBe(2);
		const embeds = sentMessages.filter(
			(m): m is Extract<MnemopiEmbedWorkerInbound, { type: "embed" }> => m.type === "embed",
		);
		expect(embeds.length).toBe(2);
		for (const embed of embeds) {
			expect(embed.model).toBe("fast-bge-base-en-v1.5");
			expect(embed.cacheDir).toBe("/tmp/cache");
		}

		await client.terminate();
	});
});
