import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isPidAlive } from "@oh-my-pi/pi-utils";
import { AbortError, exec, spawn } from "@oh-my-pi/pi-utils/ptree";

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

	// Real processes: the abort has to reach a background process that outlived its parent, and the poll
	// waits on OS state (that process dying), which fake timers cannot drive.
	it.skipIf(process.platform === "win32")(
		"kills a detached group still holding the pipes when the signal aborts during the exit grace",
		async () => {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ptree-exit-grace-"));
			const pidFile = path.join(dir, "bg.pid");
			const controller = new AbortController();
			let pid = Number.NaN;
			try {
				using child = spawn(["sh", "-c", `sleep 30 & echo $! > "${pidFile}"`], {
					detached: true,
					signal: controller.signal,
					exitGraceMs: 5_000,
				});
				const result = child.wait({ allowAbort: true });
				await child.proc.exited;
				pid = Number((await Bun.file(pidFile).text()).trim());
				controller.abort(new Error("cancelled during the exit grace"));
				const { exitError } = await result;

				expect(exitError?.aborted).toBe(true);
				for (let i = 0; i < 40 && isPidAlive(pid); i++) await Bun.sleep(25);
				expect(isPidAlive(pid)).toBe(false);
			} finally {
				if (Number.isInteger(pid)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already gone.
					}
				}
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
		10_000,
	);
});
