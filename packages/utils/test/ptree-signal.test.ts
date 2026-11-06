import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { AbortError, type ExecResult, exec, spawn } from "@oh-my-pi/pi-utils/ptree";

const BLOCK_FOREVER = `${JSON.stringify(process.execPath)} -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)'`;

describe("ptree signal abort handling", () => {
	it("does not trigger unhandledRejection when spawned with a pre-aborted signal", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const signal = AbortSignal.abort(new Error("pre-aborted"));
			using child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { signal });
			await child.nothrow().text();
			await child.proc.exited;

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not trigger unhandledRejection when exec is called with an aborted signal and allowAbort", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const signal = AbortSignal.abort(new Error("pre-aborted"));
			const result = await exec(["bun", "-e", "setInterval(() => {}, 1000)"], {
				signal,
				allowAbort: true,
			});

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(result.ok).toBe(false);
			expect(result.exitError).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("does not trigger unhandledRejection when signal aborts mid-execution", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			unhandled.push(err);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			const controller = new AbortController();
			using child = spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
				signal: controller.signal,
			});
			controller.abort(new Error("aborted mid-run"));
			await child.nothrow().text();
			await child.proc.exited;

			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(AbortError);
			expect(unhandled.length).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it.skipIf(process.platform === "win32").each([false, true])(
		"aborts a read started after the root exits (detached: %s)",
		async detached => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-output-"));
			const pidFile = path.join(dir, "pid");
			const controller = new AbortController();
			using child = spawn(["/bin/sh", "-c", `${BLOCK_FOREVER} 2>/dev/null & echo $! > '${pidFile}'; echo token`], {
				detached,
				signal: controller.signal,
			});
			let orphan: Process | null = null;
			let outcome: Promise<ExecResult> | undefined;
			try {
				await child.exited;
				orphan = Process.fromPid(Number.parseInt(await Bun.file(pidFile).text(), 10));
				if (!orphan) throw new Error("the fixture must expose its pipe-holding descendant");
				const nextTurn = Promise.withResolvers<void>();
				setImmediate(nextTurn.resolve);
				await nextTurn.promise;

				// Start collection only after root exit and stderr EOF have detached
				// the signal listener. The read must re-arm cancellation for inherited pipes.
				// Without a detached group, reader cutoff alone must release wait().
				outcome = child.wait({ allowAbort: true });
				controller.abort("abort inherited output");
				expect(child.exitReason).toBeInstanceOf(AbortError);

				const result = await outcome;
				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(result.stdout).toBe("token\n");
				if (detached) {
					expect(await orphan.waitForExit(), "the detached descendant must be terminated").toBe(true);
				}
			} finally {
				if (orphan) {
					orphan.killTree(9);
					await orphan.waitForExit();
				}
				await outcome?.catch(() => {});
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"aborts wait() when cancelled after root exit and stderr closure before wait() starts",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-before-wait-"));
			const pidFile = path.join(dir, "pid");
			const controller = new AbortController();
			using child = spawn(["/bin/sh", "-c", `${BLOCK_FOREVER} 2>/dev/null & echo $! > '${pidFile}'; echo token`], {
				detached: true,
				signal: controller.signal,
			});
			let orphan: Process | null = null;
			let outcome: Promise<ExecResult> | undefined;
			try {
				await child.exited;
				orphan = Process.fromPid(Number.parseInt(await Bun.file(pidFile).text(), 10));
				if (!orphan) throw new Error("the fixture must expose its pipe-holding descendant");
				const nextTurn = Promise.withResolvers<void>();
				setImmediate(nextTurn.resolve);
				await nextTurn.promise;

				// Cancel while no pipe reader is active, then start wait().
				controller.abort("abort before wait starts");
				outcome = child.wait({ allowAbort: true });
				expect(child.exitReason).toBeInstanceOf(AbortError);

				const result = await outcome;
				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(await orphan.waitForExit(), "the detached descendant must be terminated").toBe(true);
			} finally {
				if (orphan) {
					orphan.killTree(9);
					await orphan.waitForExit();
				}
				await outcome?.catch(() => {});
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")("aborts a byte read started after the root exits", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-bytes-"));
		const pidFile = path.join(dir, "pid");
		const controller = new AbortController();
		using child = spawn(["/bin/sh", "-c", `${BLOCK_FOREVER} 2>/dev/null & echo $! > '${pidFile}'; printf token`], {
			signal: controller.signal,
		});
		let orphan: Process | null = null;
		let outcome: Promise<Uint8Array> | undefined;
		try {
			await child.exited;
			orphan = Process.fromPid(Number.parseInt(await Bun.file(pidFile).text(), 10));
			if (!orphan) throw new Error("the fixture must expose its pipe-holding descendant");
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			outcome = child.bytes();
			controller.abort("abort inherited byte output");
			expect(child.exitReason).toBeInstanceOf(AbortError);
			const error = await outcome.then(
				() => undefined,
				(reason: unknown) => reason,
			);
			expect(error).toBeInstanceOf(AbortError);
		} finally {
			if (orphan) {
				orphan.killTree(9);
				await orphan.waitForExit();
			}
			await outcome?.catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("aborts a pipe holder after an earlier graceful stop finishes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-after-stop-"));
		const pidFile = path.join(dir, "pid");
		const controller = new AbortController();
		using child = spawn(
			[
				"/bin/sh",
				"-c",
				`(trap "" TERM; exec ${BLOCK_FOREVER}) & echo $! > '${pidFile}'; trap 'exit 0' TERM; echo token; wait`,
			],
			{ detached: true, signal: controller.signal },
		);
		let orphan: Process | null = null;
		let outcome: Promise<ExecResult> | undefined;
		try {
			// The root writes the pid before this output, so one real output chunk
			// confirms that its SIGTERM-ignoring descendant is ready.
			const readyReader = child.stdout.getReader();
			const ready = await readyReader.read();
			readyReader.releaseLock();
			expect(ready.done).toBe(false);
			orphan = Process.fromPid(Number.parseInt(await Bun.file(pidFile).text(), 10));
			if (!orphan) throw new Error("the fixture must expose its SIGTERM-ignoring descendant");
			outcome = child.wait({ allowAbort: true });

			// Force the direct-signal fallback. Its first graceful stop lets the root
			// exit cleanly but leaves the SIGTERM-ignoring descendant holding stdout.
			const lookup = spyOn(Process, "fromPid").mockReturnValue(null);
			try {
				child.kill(undefined, 1_000);
			} finally {
				lookup.mockRestore();
			}
			await child.exited;
			// Finish the direct-signal continuation after observing the root's clean exit.
			await Promise.resolve();

			controller.abort("abort after graceful stop");
			expect(child.exitReason).toBeInstanceOf(AbortError);

			const result = await outcome;
			expect(result.exitError).toBeInstanceOf(AbortError);
			expect(await orphan.waitForExit(), "cancellation must start a fresh descendant cleanup").toBe(true);
		} finally {
			if (orphan) {
				orphan.killTree(9);
				await orphan.waitForExit();
			}
			await outcome?.catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
