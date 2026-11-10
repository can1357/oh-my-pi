import { describe, expect, it } from "bun:test";
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

	it.skipIf(process.platform === "win32")(
		"keeps abort armed across the root's exit while a read is open",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-open-read-"));
			const pidFile = path.join(dir, "pid");
			const controller = new AbortController();
			// The root exits cleanly once its stdin closes; its descendant keeps stdout and stderr open, so no
			// later pipe event re-arms the signal after the root's exit.
			using child = spawn(["/bin/sh", "-c", `${BLOCK_FOREVER} & echo $! > '${pidFile}'; read _ || :`], {
				detached: true,
				signal: controller.signal,
				stdin: "pipe",
			});
			let orphan: Process | null = null;
			let outcome: Promise<ExecResult> | undefined;
			try {
				// The read is open before the root exits, so the abort listener must stay attached through that exit.
				outcome = child.wait({ allowAbort: true });
				child.stdin.end();
				expect(await child.exited).toBe(0);
				orphan = Process.fromPid(Number.parseInt(await Bun.file(pidFile).text(), 10));
				if (!orphan) throw new Error("the fixture must expose its pipe-holding descendant");

				controller.abort("abort while a read is open");
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
});
