import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { createLinuxSubreaperScript, exec, NonZeroExitError, spawn, TimeoutError } from "@oh-my-pi/pi-utils/ptree";

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
				const pidFileHandle = Bun.file(pidFile);
				const setupDeadline = Date.now() + 2_000;
				while (!(await pidFileHandle.exists()) && Date.now() < setupDeadline) await Bun.sleep(10);
				expect(await pidFileHandle.exists(), "the launcher must create its worker").toBe(true);

				const workerPid = Number.parseInt((await pidFileHandle.text()).trim(), 10);
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
		using child = spawn(["/bin/sh", "-c", "sleep 30 & echo token"], {
			detached: true,
			timeout: 250,
		});
		let threw: unknown;
		try {
			await child.text();
		} catch (error) {
			threw = error;
		}

		expect(threw).toBeInstanceOf(TimeoutError);
	});

	for (const outputMethod of ["blob", "json", "arrayBuffer", "bytes"] as const) {
		it.skipIf(process.platform === "win32")(
			`rejects ${outputMethod} when the deadline fires after the root exits`,
			async () => {
				using child = spawn(["/bin/sh", "-c", `sleep 30 2>/dev/null & printf '"token"'`], {
					detached: true,
					timeout: 250,
				});
				let threw: unknown;
				try {
					await child[outputMethod]();
				} catch (error) {
					threw = error;
				}

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
		"terminates a detached group that holds stdout past the command deadline",
		async () => {
			// The root exits after printing its child's pid. The child keeps the
			// group and stdout alive past the deadline, so timeout must terminate
			// the group even though its original leader is already gone.
			let orphanPid: number | undefined;
			try {
				const result = await exec(["/bin/sh", "-c", "sleep 30 & echo $!"], {
					detached: true,
					timeout: 250,
					allowNonZero: true,
					allowAbort: true,
				});
				orphanPid = Number.parseInt(result.stdout.trim(), 10);

				expect(result.exitError).toBeInstanceOf(TimeoutError);
				// Real process state: SIGKILL delivery is synchronous, but pidfd
				// exit observation may settle on the next scheduler turn.
				const deadline = Date.now() + 500;
				let status = Process.fromPid(orphanPid)?.status();
				while (status === ProcessStatus.Running && Date.now() < deadline) {
					await Bun.sleep(10);
					status = Process.fromPid(orphanPid)?.status();
				}
				expect(status).not.toBe(ProcessStatus.Running);
			} finally {
				if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
			}
		},
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
			// The root exits nonzero while its child holds stderr open. The
			// deadline kills the detached group while exit normalization awaits
			// the drain, and that timeout must outrank the earlier exit code.
			let threw: unknown;
			try {
				await exec(["/bin/sh", "-c", "sleep 30 >&2 & exit 7"], {
					detached: true,
					timeout: 250,
					allowNonZero: true,
				});
			} catch (err) {
				threw = err;
			}

			expect(threw).toBeInstanceOf(TimeoutError);
		},
	);
});
