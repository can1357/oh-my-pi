import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	AbortError,
	createLinuxSubreaperScript,
	exec,
	NonZeroExitError,
	OutputLimitError,
	spawn,
	TimeoutError,
} from "@oh-my-pi/pi-utils/ptree";

async function supportsLinuxMountNamespaces(): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		const probe = Bun.spawn(
			[
				"unshare",
				"--user",
				"--map-root-user",
				"--mount",
				"--propagation",
				"private",
				"/bin/sh",
				"-c",
				"mount -t tmpfs tmpfs /proc",
			],
			{
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		return (await probe.exited) === 0;
	} catch {
		return false;
	}
}

const linuxMountNamespacesAvailable = await supportsLinuxMountNamespaces();

/**
 * Collect the descendants these fixtures deliberately strand.
 *
 * A descendant that outlives its root is no longer signalled — a reaped root's
 * pid and the group id that pid named can both belong to a stranger by then — so
 * every fixture that creates one has to state its pid and reap it here, or the
 * suite leaves a `sleep` running behind it. The marker is matched exactly:
 * killing whatever an unrecognized line happens to parse as would be the same
 * mistake under test.
 */
function reapMarkedOrphans(output: string): void {
	for (const [, pid] of output.matchAll(/^orphan (\d+)$/gm)) Process.fromPid(Number(pid))?.killTree(9);
}

/**
 * Whether a pid still exists, probed with signal 0 rather than a tree lookup.
 *
 * The process this asks about is deliberately out of every tree the command can
 * reach, so an enumeration-based answer would be reporting on the wrong thing.
 */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("ptree timeout", () => {
	it("contains the lifecycle rejection when the caller does not observe exited", async () => {
		const unhandled = new Set<unknown>();
		const onUnhandled = (reason: unknown) => {
			unhandled.add(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			// Bun's subprocess timeout uses the platform clock; fake timers cannot drive this lifecycle.
			using child = spawn(["bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {
				timeout: 20,
			});
			await child.nothrow().text();
			await child.proc.exited;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(TimeoutError);
			expect(unhandled.has(child.exitReason)).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it.skipIf(process.platform !== "linux")(
		"kills descendants adopted while an AbortSignal races the timeout sweep",
		async () => {
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-subreaper-race-"));
			const pidFile = path.join(testRoot, "worker.pid");
			const launcher = path.join(testRoot, "launcher.sh");
			await Bun.write(
				launcher,
				`#!/bin/sh
setsid sleep 30 </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > ${JSON.stringify(pidFile)}
sleep 30
`,
			);
			await fs.chmod(launcher, 0o755);

			const controller = new AbortController();
			using child = spawn([launcher], {
				signal: controller.signal,
				subreaper: true,
			});
			const cleanupProcesses: Process[] = [];

			try {
				// A BunFile handle caches a negative `exists()`; stat fresh each poll.
				const pidFileExists = () =>
					fs.stat(pidFile).then(
						() => true,
						() => false,
					);
				const setupDeadline = Date.now() + 2_000;
				while (!(await pidFileExists()) && Date.now() < setupDeadline) await Bun.sleep(10);
				expect(await pidFileExists(), "the launcher must create its worker").toBe(true);

				const workerPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				const subreaper = Process.fromPid(child.pid);
				const command = subreaper?.children()[0];
				const worker = Process.fromPid(workerPid);
				if (!subreaper || !command || !worker) throw new Error("failed to capture the subreaper process tree");
				cleanupProcesses.push(worker, command, subreaper);
				expect(worker.ppid, "the worker must initially belong to the supervised command").toBe(command.pid);

				const killOnly = (pid: number): number => {
					try {
						process.kill(pid, "SIGKILL");
						return 1;
					} catch {
						return 0;
					}
				};
				const commandSnapshot = {
					killTree: () => killOnly(command.pid),
				} as unknown as Process;
				const pendingAdoption = {
					killTree: () => 0,
				} as unknown as Process;
				let snapshots = 0;
				let observedAdoption = false;
				const controlledSubreaper = {
					children: (): Process[] => {
						snapshots++;
						if (snapshots === 1) return [commandSnapshot];
						if (subreaper.status() !== ProcessStatus.Running || worker.status() !== ProcessStatus.Running)
							return [];
						if (worker.ppid !== subreaper.pid) return [pendingAdoption];
						observedAdoption = true;
						return [worker];
					},
					killTree: () => killOnly(subreaper.pid),
					terminate: () => Promise.resolve(killOnly(subreaper.pid) > 0),
				} as unknown as Process;
				const nativeFromPid = Process.fromPid.bind(Process);
				const fromPid = spyOn(Process, "fromPid").mockImplementation(pid =>
					pid === child.pid ? controlledSubreaper : nativeFromPid(pid),
				);

				try {
					child.kill(new TimeoutError(1, ""), -1);
					controller.abort("concurrent abort");

					const result = await child.wait({ allowAbort: true });
					expect(result.exitError).toBeInstanceOf(TimeoutError);
					expect(observedAdoption, "the worker must reparent to the live subreaper during cleanup").toBe(true);
					expect(worker.status(), `adopted descendant ${worker.pid} survived cleanup`).not.toBe(
						ProcessStatus.Running,
					);
				} finally {
					fromPid.mockRestore();
				}
			} finally {
				for (const processHandle of cleanupProcesses) processHandle.killTree(9);
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform !== "linux")("falls back after the first libc soname is unavailable", async () => {
		const script = createLinuxSubreaperScript(["libc.so.omp-missing", "libc.so.6", "libc.so"]);
		const child = Bun.spawn([process.execPath, "-e", script], {
			env: {
				...Bun.env,
				BUN_BE_BUN: "1",
				OMP_PTREE_SUBREAPER_COMMAND: JSON.stringify([
					process.execPath,
					"-e",
					'process.stdout.write("libc-fallback-ok")',
				]),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("libc-fallback-ok");
	});

	it.skipIf(process.platform !== "linux")("does not leak supervisor-only environment into the command", async () => {
		const result = await exec(["/bin/sh", "-c", `printf %s "\${BUN_BE_BUN-unset}"`], {
			subreaper: true,
		});

		expect(result.stdout).toBe("unset");
	});

	it.skipIf(process.platform !== "linux")("preserves caller-supplied BUN_BE_BUN for the command", async () => {
		const result = await exec(["/bin/sh", "-c", `printf %s "\${BUN_BE_BUN-unset}"`], {
			subreaper: true,
			env: { ...Bun.env, BUN_BE_BUN: "1" },
		});

		expect(result.stdout).toBe("1");
	});

	it.skipIf(!linuxMountNamespacesAvailable)("supervises commands without a mounted procfs", async () => {
		const script = `
const mountExit = await Bun.spawn(["mount", "-t", "tmpfs", "tmpfs", "/proc"], {
	stdout: "ignore",
	stderr: "inherit",
}).exited;
if (mountExit !== 0) throw new Error("failed to hide procfs");
${createLinuxSubreaperScript()}
`;
		const child = Bun.spawn(
			[
				"unshare",
				"--user",
				"--map-root-user",
				"--mount",
				"--propagation",
				"private",
				process.execPath,
				"-e",
				script,
			],
			{
				cwd: "/tmp",
				env: {
					...Bun.env,
					BUN_BE_BUN: "1",
					OMP_PTREE_SUBREAPER_COMMAND: JSON.stringify(["/bin/sh", "-c", "printf procfs-free-ok"]),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("procfs-free-ok");
	});

	it("clears the timeout timer once the child exits so a fast command does not hold the event loop", async () => {
		// Real subprocess timing: the probe (a static-import fixture) resolves a
		// quick command under a 10 s ptree timeout and then must exit on its own;
		// if the timeout timer were left pending it would hold the probe's event
		// loop for the full 10 s.
		const probe = `${import.meta.dir}/fixtures/ptree-timeout-probe.ts`;

		const start = performance.now();
		const child = spawn([process.execPath, probe], { timeout: 15_000 });
		const text = await child.text();
		const elapsedMs = performance.now() - start;

		expect(text).toContain("probe-done");
		expect(elapsedMs).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")(
		"keeps reading inherited stdout until the configured command deadline",
		async () => {
			// Real subprocess timing: fake timers cannot advance the child clock.
			// The root exits immediately, but its child writes after the legacy
			// 100 ms drain grace and before the 1 s command deadline.
			const result = await exec(["/bin/sh", "-c", "(sleep .2; printf token) &"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});

			expect(result.ok).toBe(true);
			expect(result.stdout).toBe("token");
		},
	);

	it.skipIf(process.platform === "win32")("rejects text when the deadline fires after the root exits", async () => {
		// The orphan states its pid on stderr because the rejected read discards
		// stdout, and it survives the deadline by design: nothing may signal a
		// reaped root's group, so this test collects it instead.
		using child = spawn(["/bin/sh", "-c", `sleep 30 & printf 'orphan %s\\n' "$!" >&2; echo token`], {
			detached: true,
			timeout: 250,
		});
		let threw: unknown;
		try {
			await child.text();
		} catch (error) {
			threw = error;
		}
		reapMarkedOrphans(child.peekStderr());

		expect(threw).toBeInstanceOf(TimeoutError);
	});

	for (const outputMethod of ["blob", "json", "arrayBuffer", "bytes"] as const) {
		it.skipIf(process.platform === "win32")(
			`rejects ${outputMethod} when the deadline fires after the root exits`,
			async () => {
				using child = spawn(
					["/bin/sh", "-c", `sleep 30 2>/dev/null & printf 'orphan %s\\n' "$!" >&2; printf '"token"'`],
					{
						detached: true,
						timeout: 250,
					},
				);
				let threw: unknown;
				try {
					await child[outputMethod]();
				} catch (error) {
					threw = error;
				}
				reapMarkedOrphans(child.peekStderr());

				expect(threw).toBeInstanceOf(TimeoutError);
			},
		);
	}

	it.skipIf(process.platform === "win32")("keeps reading inherited stdout until EOF without a timeout", async () => {
		const result = await exec(["/bin/sh", "-c", "(sleep .2; printf token) &"], {
			allowNonZero: true,
			allowAbort: true,
		});

		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("token");
	});

	it.skipIf(process.platform === "win32")(
		"never signals an unverifiable group id when a detached root has already exited",
		async () => {
			// The root exits after printing its child's pid, so by the deadline the
			// group's original leader is gone. The surviving child holds stdout, but a
			// held pipe only proves some writer exists -- not that the writer is still
			// in that group. A descendant that calls setsid keeps the pipe and leaves
			// the group, which can leave the group empty and its id free for an
			// unrelated group to reuse, so signalling the old id could kill a stranger.
			//
			// Without ownership tracking that id is unverifiable, so nothing is
			// signalled: the command still ends at its deadline and the caller is
			// still released, and the escaped descendant is left for the owner that
			// can prove it (`subreaper: true` on Linux, the retained handle on
			// Windows). The Linux subreaper cases cover that reaping.
			const killSpy = spyOn(process, "kill");
			let orphanPid: number | undefined;
			try {
				const started = Date.now();
				const result = await exec(["/bin/sh", "-c", "sleep 30 & echo $!"], {
					detached: true,
					timeout: 250,
					allowNonZero: true,
					allowAbort: true,
				});
				orphanPid = Number.parseInt(result.stdout.trim(), 10);

				expect(result.exitError).toBeInstanceOf(TimeoutError);
				expect(Date.now() - started).toBeLessThan(5_000);
				// The security property, asserted structurally rather than inferred: no
				// signal was aimed at a process group at all.
				const groupSignals = killSpy.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
				expect(groupSignals, "a dead leader's group id must never be signalled").toEqual([]);
				// And the outcome that follows from it, which also catches a sweep the
				// spy cannot see: the orphan is still there to be collected by hand.
				expect(Process.fromPid(orphanPid)?.status(), `orphan ${orphanPid} was swept`).toBe(ProcessStatus.Running);
			} finally {
				killSpy.mockRestore();
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"sweeps its own group when the deadline finds the detached root still alive",
		async () => {
			// The counterpart to the dead-leader case, and the reason failing closed
			// there costs nothing here: the root is still unreaped when the deadline
			// fires, so the pid the group is named after is provably this command's and
			// the group is swept as it always was.
			//
			// The descendant's state is read once, with no polling: signalling a group
			// only queues the signal, and `wait()` promises the caller the tree is gone
			// before it reports. A poll would turn a report that arrived too early into
			// a pass.
			const result = await exec(["/bin/sh", "-c", `sleep 30 & printf 'orphan %s\\n' "$!"; wait`], {
				detached: true,
				timeout: 250,
				allowNonZero: true,
				allowAbort: true,
			});

			expect(result.exitError).toBeInstanceOf(TimeoutError);
			const marked = /^orphan (\d+)$/m.exec(result.stdout);
			expect(marked, `stdout was: ${result.stdout}`).not.toBeNull();
			const memberPid = Number(marked?.[1]);
			try {
				expect(
					Process.fromPid(memberPid)?.status() ?? ProcessStatus.Exited,
					`member ${memberPid} survived`,
				).not.toBe(ProcessStatus.Running);
			} finally {
				Process.fromPid(memberPid)?.killTree(9);
			}
		},
		30_000,
	);

	it.skipIf(process.platform !== "win32")(
		"terminates a pipe-holding descendant after the Windows root exits",
		async () => {
			// Windows has no process groups. The probe exits after starting a
			// child that inherits stdout, so the retained root handle must anchor
			// the Toolhelp tree walk when the command deadline expires.
			const probe = `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`;
			let descendantPid: number | undefined;
			try {
				const result = await exec([process.execPath, probe], {
					timeout: 250,
					allowNonZero: true,
					allowAbort: true,
				});
				descendantPid = Number.parseInt(result.stdout.trim(), 10);

				expect(result.exitError).toBeInstanceOf(TimeoutError);
				const deadline = Date.now() + 500;
				let status = Process.fromPid(descendantPid)?.status();
				while (status === ProcessStatus.Running && Date.now() < deadline) {
					await Bun.sleep(10);
					status = Process.fromPid(descendantPid)?.status();
				}
				expect(status).not.toBe(ProcessStatus.Running);
			} finally {
				if (descendantPid) Process.fromPid(descendantPid)?.killTree(9);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"throws NonZeroExitError by default when the child exits nonzero",
		async () => {
			// wait()'s default contract: without allowNonZero, a nonzero exit rejects
			// instead of returning an unsuccessful result.
			let threw: unknown;
			try {
				await exec(["sh", "-c", "exit 3"]);
			} catch (err) {
				threw = err;
			}
			expect(threw).toBeInstanceOf(NonZeroExitError);
		},
	);

	it.skipIf(process.platform === "win32")("completes when an orphan holds stdout past the root's exit", async () => {
		// `sleep 30 & echo token $!`: the root exits at once but the background
		// sleep inherits the pipe, so an EOF-based read would stall for the
		// orphan's lifetime, far past the timeout budget. The orphan's pid is
		// printed so the fixture can clean it up instead of leaking it.
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 & echo token $!"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /^token (\d+)$/.exec(result.stdout.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(result.ok).toBe(true);
			expect(match, `stdout was: ${result.stdout}`).not.toBeUndefined();
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	it.skipIf(process.platform === "win32")("completes when an orphan holds stderr past the root's exit", async () => {
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 >&2 & echo token2 $!"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /^token2 (\d+)$/.exec(result.stdout.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(result.ok).toBe(true);
			expect(match, `stdout was: ${result.stdout}`).not.toBeUndefined();
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	it.skipIf(process.platform === "win32")("completes when a nonzero exit races an orphan holding stderr", async () => {
		// `sleep 30 >&2 & exit 1`: the nonzero-exit normalization awaits the
		// stderr drain, so a grace keyed on the normalized exit promise would
		// deadlock until the orphan closes stderr. The grace must key on the
		// raw process exit.
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 >&2 & echo $! >&2; exit 1"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /(\d+)\s*$/.exec(result.stderr.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(result.exitCode).toBe(1);
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	it.skipIf(process.platform === "win32")(
		"preserves the timeout reason when nonzero normalization waits for stderr",
		async () => {
			// The root exits nonzero while its child holds stderr open. The deadline
			// releases the reads exit normalization is waiting on, and that timeout must
			// outrank the earlier exit code. The child outlives the deadline — a reaped
			// root's group is never signalled — so its pid comes back on the same stderr
			// and it is collected here.
			let threw: unknown;
			try {
				await exec(["/bin/sh", "-c", `sleep 30 >&2 & printf 'orphan %s\\n' "$!" >&2; exit 7`], {
					detached: true,
					timeout: 250,
					allowNonZero: true,
				});
			} catch (err) {
				threw = err;
			}
			if (threw instanceof TimeoutError) reapMarkedOrphans(threw.stderr);

			expect(threw).toBeInstanceOf(TimeoutError);
		},
	);
});

/**
 * The same read path the deadline cuts off also enforces a capture cap, so a
 * command that streams without end cannot grow this process's heap first. Every
 * case asserts on what was captured and on the command being stopped, never on
 * the command finishing.
 */
describe("ptree maxOutputBytes", () => {
	it("stops the command at the cap instead of buffering past it", async () => {
		const limit = 64 * 1024;
		// Two orders of magnitude past the cap, written as fast as the pipe takes
		// it: an unbounded read would hold all of it.
		const result = await exec(
			["bun", "-e", `const c = "a".repeat(1024 * 1024); for (let i = 0; i < 8; i++) process.stdout.write(c);`],
			{ maxOutputBytes: limit, allowAbort: true, allowNonZero: true },
		);

		expect(Buffer.byteLength(result.stdout)).toBe(limit);
		expect(result.exitError).toBeInstanceOf(OutputLimitError);
		expect(result.exitError?.aborted).toBe(true);
		expect(result.ok).toBe(false);
	});

	it("throws the limit error unless the caller allows an abort", async () => {
		const error = await exec(["bun", "-e", `process.stdout.write("a".repeat(4096))`], { maxOutputBytes: 16 }).catch(
			err => err,
		);

		expect(error).toBeInstanceOf(OutputLimitError);
	});

	it("counts bytes rather than characters", async () => {
		// Four bytes of UTF-8 per copy, one code point each: a cap read as
		// characters would keep four times this much.
		const result = await exec(["bun", "-e", `process.stdout.write("\\u{1f600}".repeat(64))`], {
			maxOutputBytes: 8,
			allowAbort: true,
			allowNonZero: true,
		});

		expect(Buffer.byteLength(result.stdout)).toBe(8);
		expect(result.stdout).toBe("\u{1f600}\u{1f600}");
		expect(result.exitError).toBeInstanceOf(OutputLimitError);
	});

	it("never returns more bytes than the cap when it falls mid-character", async () => {
		// 9 bytes across four-byte characters: the cap lands inside the third. A
		// retained partial sequence flushed as U+FFFD would return 11 bytes.
		const result = await exec(["bun", "-e", `process.stdout.write("\\u{1f600}".repeat(64))`], {
			maxOutputBytes: 9,
			allowAbort: true,
			allowNonZero: true,
		});

		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(9);
		expect(result.stdout).toBe("\u{1f600}\u{1f600}");
		expect(result.stdout).not.toContain("\ufffd");
		expect(result.exitError).toBeInstanceOf(OutputLimitError);
	});

	it("holds the cap against input that is not valid UTF-8", async () => {
		// Every stray byte decodes to a three-byte replacement character, so a cap
		// counted on input bytes would return three times the promised bound.
		const result = await exec(["bun", "-e", `process.stdout.write(Buffer.alloc(4096, 0xff))`], {
			maxOutputBytes: 9,
			allowAbort: true,
			allowNonZero: true,
		});

		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(9);
		expect(result.exitError).toBeInstanceOf(OutputLimitError);
	});

	it("holds the cap when a multibyte character straddles two chunks", async () => {
		// The first write ends mid-character, so the decoder carries the tail into
		// the next chunk; the budget still has to cover the completed character.
		const result = await exec(
			[
				"bun",
				"-e",
				`const b = Buffer.from("\\u{1f600}".repeat(4)); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 50);`,
			],
			{ maxOutputBytes: 6, allowAbort: true, allowNonZero: true },
		);

		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(6);
		expect(result.stdout).not.toContain("\ufffd");
	});

	it("keeps the decoder's retained tail from crossing the cap", async () => {
		// One write both overflows the cap and ends mid-character, so the decoder is
		// still holding a partial sequence when the read stops. Flushing that
		// remainder appends U+FFFD -- three bytes -- after the budget is spent.
		const result = await exec(
			[
				"bun",
				"-e",
				`const c = Buffer.from("\\u{1f600}"); process.stdout.write(Buffer.concat([c, c, c, c, c.subarray(0, 2)]));`,
			],
			{ maxOutputBytes: 4, allowAbort: true, allowNonZero: true },
		);

		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(4);
		expect(result.stdout).not.toContain("\ufffd");
	});

	it("reports a cap reached only by the decoder's EOF remainder", async () => {
		// One whole character fills the cap exactly, then a single stray byte of the
		// next one ends the stream. Nothing overflows while reading -- the decoder
		// holds that byte -- so the limit is reached only when the remainder is
		// flushed at EOF. Dropping it quietly would return a bounded read as a
		// clean success, hiding that output was cut.
		const result = await exec(
			[
				"bun",
				"-e",
				`const c = Buffer.from("\\u{1f600}"); process.stdout.write(Buffer.concat([c, c.subarray(0, 1)]));`,
			],
			{ maxOutputBytes: 4, allowAbort: true, allowNonZero: true },
		);

		expect(result.stdout).toBe("\u{1f600}");
		expect(Buffer.byteLength(result.stdout)).toBe(4);
		expect(result.stdout).not.toContain("\ufffd");
		expect(result.exitError).toBeInstanceOf(OutputLimitError);
	});

	it("leaves output that fits exactly untouched and successful", async () => {
		const result = await exec(["bun", "-e", `process.stdout.write("a".repeat(4096))`], { maxOutputBytes: 4096 });

		expect(result.stdout.length).toBe(4096);
		expect(result.exitError).toBeUndefined();
		expect(result.ok).toBe(true);
	});

	it("does not disturb a command whose output stays under the cap", async () => {
		const result = await exec(["bun", "-e", `process.stdout.write("ok")`], { maxOutputBytes: 1024 });

		expect(result.stdout).toBe("ok");
		expect(result.exitCode).toBe(0);
		expect(result.exitError).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"terminates a descendant holding the pipe once the cap is reached",
		async () => {
			// `yes` writes until the pipe closes, from a child that outlives its
			// parent shell, so only tree termination ends it. Reaching the cap has
			// to do that rather than leave it streaming into a cancelled reader.
			const result = await exec(["/bin/sh", "-c", "yes ping & wait"], {
				maxOutputBytes: 4096,
				detached: true,
				allowAbort: true,
				allowNonZero: true,
				timeout: 30_000,
			});

			expect(Buffer.byteLength(result.stdout)).toBe(4096);
			expect(result.exitError).toBeInstanceOf(OutputLimitError);
		},
		45_000,
	);

	it.skipIf(process.platform !== "linux")(
		"sweeps a descendant that left the original group when the cap is reached",
		async () => {
			// `setsid` puts the worker in its own session, so no process-group kill
			// can reach it: only the subreaper's hard sweep collects it, and that
			// sweep runs only when the overflow terminates like a deadline does.
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-cap-sweep-"));
			const pidFile = path.join(testRoot, "worker.pid");
			const launcher = path.join(testRoot, "launcher.sh");
			await Bun.write(
				launcher,
				`#!/bin/sh
setsid sleep 30 </dev/null >/dev/null 2>&1 &
printf '%s\\n' "$!" > ${JSON.stringify(pidFile)}
yes flood
`,
			);
			await fs.chmod(launcher, 0o755);

			const cleanupProcesses: Process[] = [];
			try {
				const result = await exec([launcher], {
					maxOutputBytes: 4096,
					detached: true,
					subreaper: true,
					allowAbort: true,
					allowNonZero: true,
				});

				expect(Buffer.byteLength(result.stdout)).toBe(4096);
				expect(result.exitError).toBeInstanceOf(OutputLimitError);

				const workerPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				const worker = Process.fromPid(workerPid);
				if (worker) cleanupProcesses.push(worker);
				expect(worker?.status() ?? ProcessStatus.Exited, `worker ${workerPid} survived the cap`).not.toBe(
					ProcessStatus.Running,
				);
			} finally {
				for (const processHandle of cleanupProcesses) processHandle.killTree(9);
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
		45_000,
	);

	it.skipIf(process.platform === "win32")(
		"honors an abort that arrives after the root exited, without a deadline to fall back on",
		async () => {
			// The root exits at once while its child keeps the pipes open. Detaching
			// the abort listener at root exit left this command with nothing to stop
			// it: with no timeout configured, `wait()` would never return.
			//
			// The child is not reaped here, and that is the contract, not a gap: the
			// group's leader is gone, so its id cannot be shown to still denote this
			// group, and signalling it could reach a stranger. What must hold is that
			// the abort is still delivered and the caller is released.
			const killSpy = spyOn(process, "kill");
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-dead-root-"));
			const pidFile = path.join(testRoot, "worker.pid");
			const controller = new AbortController();
			const cleanupProcesses: Process[] = [];
			try {
				using child = spawn(
					["/bin/sh", "-c", `sleep 30 & printf '%s\\n' "$!" > ${JSON.stringify(pidFile)}; exit 0`],
					{ signal: controller.signal, detached: true },
				);

				// The worker starting and the root exiting both happen in other
				// processes: there is no promise to await and no clock to advance, so
				// the only observable is the file and the exit code themselves.
				const setupDeadline = Date.now() + 5_000;
				let workerStarted = false;
				while (!workerStarted && Date.now() < setupDeadline) {
					workerStarted = await fs.stat(pidFile).then(
						() => true,
						() => false,
					);
					if (!workerStarted) await Bun.sleep(10);
				}
				expect(workerStarted, "the launcher must create its worker").toBe(true);
				while (child.exitCode === null && Date.now() < setupDeadline) await Bun.sleep(10);
				expect(child.exitCode, "the root must exit before the abort").toBe(0);

				const workerPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				const worker = Process.fromPid(workerPid);
				if (worker) cleanupProcesses.push(worker);
				// Without a live handle the status assertion below would pass on a
				// missing process rather than on a reaped one.
				expect(worker, `worker ${workerPid} must be observable before the abort`).not.toBeUndefined();
				expect(worker?.status(), "the worker must still hold the pipes at abort").toBe(ProcessStatus.Running);

				const aborted = Date.now();
				controller.abort("caller abandoned the command");
				const result = await child.wait({ allowAbort: true, allowNonZero: true });

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(Date.now() - aborted).toBeLessThan(5_000);
				const groupSignals = killSpy.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
				expect(groupSignals, "a dead leader's group id must never be signalled").toEqual([]);
				// The outcome that follows, which a native sweep could not hide either:
				// the worker is still here to be collected below.
				expect(worker?.status(), `worker ${workerPid} was swept`).toBe(ProcessStatus.Running);
			} finally {
				killSpy.mockRestore();
				for (const processHandle of cleanupProcesses) processHandle.killTree(9);
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"releases the caller when an abort cannot reach the tree holding the pipes",
		async () => {
			// Not detached, so there is no group to sweep, and the root has already been
			// reaped, so its pid may name a stranger by now and must not be resolved at
			// all -- a tree kill through it would sweep whatever inherited the number.
			// Releasing the pipe reads is the only thing that can end this wait, which
			// has no deadline to fall back on. The descendant is unreachable by design
			// and is cleaned up here rather than by the abort.
			const fromPidSpy = spyOn(Process, "fromPid");
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-unreachable-"));
			const pidFile = path.join(testRoot, "worker.pid");
			const controller = new AbortController();
			const cleanupProcesses: Process[] = [];
			try {
				using child = spawn(
					["/bin/sh", "-c", `sleep 30 & printf '%s\\n' "$!" > ${JSON.stringify(pidFile)}; exit 0`],
					{
						signal: controller.signal,
					},
				);

				// The worker starting and the root exiting both happen in other
				// processes: there is no promise to await and no clock to advance, so
				// the only observable is the file and the exit code themselves. The
				// poll ends on that condition, never on a guessed duration.
				const setupDeadline = Date.now() + 5_000;
				let workerStarted = false;
				while (!workerStarted && Date.now() < setupDeadline) {
					workerStarted = await fs.stat(pidFile).then(
						() => true,
						() => false,
					);
					if (!workerStarted) await Bun.sleep(10);
				}
				expect(workerStarted, "the launcher must create its worker").toBe(true);
				while (child.exitCode === null && Date.now() < setupDeadline) await Bun.sleep(10);
				expect(child.exitCode, "the root must exit before the abort").toBe(0);

				const workerPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				const worker = Process.fromPid(workerPid);
				if (worker) cleanupProcesses.push(worker);
				expect(worker?.status(), "the worker must still hold the pipes at abort").toBe(ProcessStatus.Running);

				const aborted = Date.now();
				controller.abort("caller abandoned the command");
				const result = await child.wait({ allowAbort: true, allowNonZero: true });

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(Date.now() - aborted).toBeLessThan(5_000);
				expect(worker?.status(), `worker ${workerPid} was swept`).toBe(ProcessStatus.Running);
				// Structural, because a recycled pid cannot be arranged on demand: the
				// reaped root's pid was never looked up, so nothing could be signalled
				// through it. The test's own lookups are the worker's.
				expect(
					fromPidSpy.mock.calls.filter(([pid]) => pid === child.pid),
					"a reaped root's pid must never be resolved",
				).toEqual([]);
			} finally {
				fromPidSpy.mockRestore();
				for (const processHandle of cleanupProcesses) processHandle.killTree(9);
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"returns at the cap while an out-of-tree descendant still holds stderr",
		async () => {
			// Not detached and no timeout: at the overflow the kill reaches the root's
			// own tree, an out-of-tree holder keeps stderr open, and there is no
			// deadline behind the command. Releasing the pipe reads at the cap is the
			// only thing that can end the stderr collection `wait()` is waiting on --
			// without it this call never returns.
			//
			// The holder is put out of reach on purpose and both halves of that are
			// arranged, not hoped for. It is started from a subshell that exits at
			// once, so it reparents away and the root's descendant walk cannot find
			// it; the command is not detached, so no group id may be signalled either.
			// And it blocks on a FIFO nothing ever writes, so nothing but this test's
			// own cleanup ends it -- no timer decides how long the shape holds.
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-cap-stderr-holder-"));
			const pidFile = path.join(testRoot, "holder.pid");
			const fifo = path.join(testRoot, "holder.fifo");
			const launcher = path.join(testRoot, "launcher.sh");
			const mkfifo = await exec(["mkfifo", fifo], { allowNonZero: true });
			expect(mkfifo.exitCode, "mkfifo must create the holder's FIFO").toBe(0);
			await Bun.write(
				launcher,
				`#!/bin/sh
(
	cat ${JSON.stringify(fifo)} >/dev/null &
	printf '%s\\n' "$!" > ${JSON.stringify(`${pidFile}.partial`)}
	mv ${JSON.stringify(`${pidFile}.partial`)} ${JSON.stringify(pidFile)}
)
# The pid file is renamed into place, so a complete one is the holder's readiness:
# nothing may overflow the cap before this shape exists.
until [ -s ${JSON.stringify(pidFile)} ]; do :; done
exec yes flood
`,
			);
			await fs.chmod(launcher, 0o755);

			const killSpy = spyOn(process, "kill");
			let holderPid: number | undefined;
			try {
				const started = Date.now();
				const pending = exec([launcher], {
					maxOutputBytes: 4096,
					allowAbort: true,
					allowNonZero: true,
				});

				// The handshake, before the result is collected: the holder exists and
				// is running while the command is still in flight. Its creation happens
				// in other processes, so the renamed pid file is the only observable --
				// there is no promise to await and no clock to advance.
				const setupDeadline = Date.now() + 10_000;
				let pidText = "";
				while (pidText === "" && Date.now() < setupDeadline) {
					pidText = await Bun.file(pidFile)
						.text()
						.then(text => text.trim())
						.catch(() => "");
					if (pidText === "") await Bun.sleep(10);
				}
				holderPid = Number.parseInt(pidText, 10);
				expect(Number.isSafeInteger(holderPid), "the launcher must publish its holder").toBe(true);
				expect(pidExists(holderPid), `holder ${holderPid} must run before the cap fires`).toBe(true);

				const result = await pending;

				expect(Buffer.byteLength(result.stdout)).toBe(4096);
				expect(result.exitError).toBeInstanceOf(OutputLimitError);
				expect(Date.now() - started).toBeLessThan(10_000);
				// The point of the shape: stderr was still held when the call returned,
				// so the return cannot be explained by the holder having exited.
				expect(pidExists(holderPid), `holder ${holderPid} must still hold stderr`).toBe(true);
				// Nothing was aimed at a process group either: this command has no group
				// of its own to signal, and the root's pid is not one after it is reaped.
				const groupSignals = killSpy.mock.calls.filter(([pid]) => typeof pid === "number" && pid < 0);
				expect(groupSignals, "an undetached command must never signal a group").toEqual([]);
			} finally {
				killSpy.mockRestore();
				// Signalled by pid, not through a tree lookup: this holder is out of every
				// tree on purpose, so an enumeration miss would leave it running.
				if (holderPid !== undefined && pidExists(holderPid)) process.kill(holderPid, "SIGKILL");
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
		45_000,
	);

	it.skipIf(process.platform === "win32")(
		"delivers an abort that arrives before the caller starts collecting stdout",
		async () => {
			// The shell closes its own stderr before forking, so the stderr pipe has no
			// holder and reaches EOF well before the root exits -- a deterministic
			// ordering, not a raced one. The descendant then holds stdout alone, and no
			// read is in flight yet because the caller has not called wait().
			//
			// A reader count is zero at that moment, so treating it as "collected"
			// declared the command finished and released the abort listener at the
			// root's exit. The abort that follows had nothing to run, and the wait
			// after it never returned: nothing would ever end a read on a pipe an
			// unreachable descendant is holding.
			const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-utils-abort-precollect-"));
			const pidFile = path.join(testRoot, "worker.pid");
			const controller = new AbortController();
			const cleanupProcesses: Process[] = [];
			try {
				using child = spawn(
					[
						"/bin/sh",
						"-c",
						`exec 2>/dev/null; sleep 30 & printf '%s\\n' "$!" > ${JSON.stringify(pidFile)}; exit 0`,
					],
					{ signal: controller.signal, detached: true },
				);

				// The worker starting and the root exiting both happen in other
				// processes: there is no promise to await and no clock to advance, so
				// the only observable is the file and the exit code themselves. The poll
				// ends on that condition, never on a guessed duration.
				const setupDeadline = Date.now() + 5_000;
				let workerStarted = false;
				while (!workerStarted && Date.now() < setupDeadline) {
					workerStarted = await fs.stat(pidFile).then(
						() => true,
						() => false,
					);
					if (!workerStarted) await Bun.sleep(10);
				}
				expect(workerStarted, "the launcher must create its worker").toBe(true);
				while (child.exitCode === null && Date.now() < setupDeadline) await Bun.sleep(10);
				expect(child.exitCode, "the root must exit before the abort").toBe(0);

				const workerPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
				const worker = Process.fromPid(workerPid);
				if (worker) cleanupProcesses.push(worker);
				expect(worker?.status(), "the worker must still hold stdout at abort").toBe(ProcessStatus.Running);

				// Nothing has read stdout yet, which is the whole point: the abort lands
				// before the first collection, and the wait comes after it.
				const aborted = Date.now();
				controller.abort("caller abandoned the command");
				const result = await child.wait({ allowAbort: true, allowNonZero: true });

				expect(result.exitError).toBeInstanceOf(AbortError);
				expect(Date.now() - aborted).toBeLessThan(5_000);
			} finally {
				for (const processHandle of cleanupProcesses) processHandle.killTree(9);
				await fs.rm(testRoot, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
