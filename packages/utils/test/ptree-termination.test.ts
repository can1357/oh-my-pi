import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { ChildProcess, spawn } from "@oh-my-pi/pi-utils/ptree";

/**
 * Spin until the pinned root has exited, without yielding to the loop.
 *
 * Bun's reaper only runs on a loop turn, so a synchronous spin holds the
 * process in the unreaped window it needs to be observed in. Polling a pinned
 * handle rather than reopening the pid keeps the loop from allocating a pidfd
 * per iteration.
 */
function spinUntilUnreapedExit(child: ChildProcess): void {
	const root = Process.fromPid(child.pid);
	if (!root) throw new Error(`Root ${child.pid} vanished before it could be pinned`);
	const deadline = Date.now() + 5_000;
	while (root.status() === ProcessStatus.Running) {
		if (Date.now() > deadline) throw new Error(`Root ${child.pid} never exited`);
	}
}

/** Poll a file the survivor wrote its own pid into, for the never-read case. */
async function readReportedPid(file: string): Promise<number> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		// One read, and a missing file is one of the outcomes it polls for: asking
		// whether the file exists and then reading it lets the answer change in
		// between, which throws out of a loop whose job is to keep waiting.
		let text = "";
		try {
			text = await Bun.file(file).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const reported = Number.parseInt(text.trim() || "0", 10);
		if (reported > 0) return reported;
		if (Date.now() > deadline) throw new Error(`Descendant never reported its pid to ${file}`);
		await Bun.sleep(10);
	}
}

describe("ptree.ChildProcess.killAndWait()", () => {
	for (const readerState of ["raw", "paused", "eof", "cancel", "unread"] as const) {
		it.skipIf(process.platform === "win32")(`sweeps a dead root's group with its stdout ${readerState}`, async () => {
			// How far a stdout consumer got is not a condition anywhere in the
			// fallback: a survivor of a caller that never read — or finished
			// reading — has to be swept like any other. The root parks on a file so
			// each reader state is established while it is alive, then the exit is
			// triggered synchronously to land in the unreaped window, where a dead
			// leader's group is attributable on every platform.
			const stamp = `${process.pid}-${Date.now()}-${readerState}`;
			const goFile = path.join(os.tmpdir(), `omp-ptree-go-${stamp}`);
			const pidFile = path.join(os.tmpdir(), `omp-ptree-pid-${stamp}`);
			const report = readerState === "unread" ? `echo $! > ${pidFile}` : "echo $!";
			const filler = readerState === "paused" ? "sleep 0.05; echo filler;" : "";
			// The survivor keeps the root's stdout for the raw case, which is the one
			// whose point is a descendant still holding that pipe once the root is
			// gone. The states that need an EOF cannot afford a second writer.
			const survivorPipes = readerState === "raw" ? "2>/dev/null" : ">/dev/null 2>&1";
			// Closing both pipes while the root is still alive is what lets the stdout
			// consumer see EOF and lets the internal stderr drain run out of input, so
			// these are the states with nothing left reading rather than ones whose
			// reads merely had not finished yet.
			const close = readerState === "eof" || readerState === "unread" ? "exec 1>&- 2>&-;" : "";
			// Written last, so observing it in the drained tail is evidence that every
			// write before it — including the buffered filler — has landed and been
			// consumed, instead of waiting a fixed time and assuming so. It says
			// nothing about the drain having reached EOF, which is one read further
			// on and is not what any assertion here depends on.
			const sentinel = "stderr-drained";
			const script = `sleep 30 ${survivorPipes} & ${report}; ${filler} echo ${sentinel} >&2; ${close} while [ ! -f ${goFile} ]; do sleep 0.01; done`;
			const child = spawn(["/bin/sh", "-c", script], { detached: true });
			// Declared by inference rather than annotation: Bun's reader carries an
			// extra `readMany`, so the DOM lib type is not assignable to it.
			let reader = readerState === "unread" ? undefined : child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				if (reader) {
					const first = new TextDecoder().decode((await reader.read()).value);
					descendant = Process.fromPid(Number.parseInt(first, 10));
				} else {
					descendant = Process.fromPid(await readReportedPid(pidFile));
				}
				if (!descendant) throw new Error("Descendant exited before termination");
				if (readerState === "eof") expect((await reader?.read())?.done).toBe(true);
				if (readerState === "cancel") {
					await reader?.cancel();
					reader = undefined;
				}
				const drained = Date.now() + 5_000;
				while (!child.peekStderr().includes(sentinel)) {
					if (Date.now() > drained) throw new Error("Internal stderr drain never reported");
					await Bun.sleep(5);
				}
				expect(descendant.status()).toBe(ProcessStatus.Running);

				await Bun.write(goFile, "");
				spinUntilUnreapedExit(child);
				expect(child.proc.exitCode).toBeNull();
				await child.killAndWait(undefined, -1);

				expect(descendant.status()).toBe(ProcessStatus.Exited);
				// Proves the consumer was parked over buffered output rather than
				// sitting at EOF, and that the kill did not discard it.
				if (readerState === "paused")
					expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("filler\n");
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await reader?.cancel();
				await fs.rm(goFile, { force: true });
				await fs.rm(pidFile, { force: true });
			}
		});
	}

	it.skipIf(process.platform === "win32")("reads the root's liveness from the pin, not from its number", async () => {
		// `exitCode` stays null for a child killed by a signal — Bun reports
		// `signalCode` instead — so the liveness predicate cannot lean on it and
		// has to ask a handle. Asking by number is the bug: once the leader is
		// reaped its pid is free, and whoever holds it next answers "running",
		// which reads as a live root and skips the dead-leader group sweep
		// entirely. The pinned handle keeps answering for the process it was
		// opened on.
		//
		// Pid reuse cannot be arranged, so the reopen is what gets stubbed: the
		// stand-in is this test process, which is unambiguously running and is
		// never signalled on either path.
		// The root has to be *signalled* dead, not allowed to exit: a normal exit
		// sets `exitCode`, the predicate short-circuits on it, and the number is
		// never consulted at all. Only a signal leaves `exitCode` null.
		const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!; exec sleep 30"], {
			detached: true,
		});
		const reader = child.stdout.getReader();
		let descendant: Process | null = null;
		const fromPid = Process.fromPid;
		let spy: ReturnType<typeof spyOn> | undefined;
		try {
			const output = await reader.read();
			descendant = fromPid.call(Process, Number.parseInt(new TextDecoder().decode(output.value), 10));
			if (!descendant) throw new Error("Descendant exited before termination");
			expect(descendant.status()).toBe(ProcessStatus.Running);
			process.kill(child.pid, "SIGKILL");
			await child.proc.exited;
			expect(child.proc.exitCode).toBeNull();

			spy = spyOn(Process, "fromPid").mockImplementation((pid: number) =>
				pid === child.pid ? fromPid.call(Process, process.pid) : fromPid.call(Process, pid),
			);
			expect(Process.fromPid(child.pid)?.status()).toBe(ProcessStatus.Running);

			const outcome = await child.killAndWait(undefined, -1).then(
				() => "swept",
				(error: unknown) => String(error),
			);

			// Same two arms as the reaped-leader case below, for the same reason:
			// which one runs is the kernel's pidfd group scope. What neither may do
			// is report a completed sweep while the survivor is still running,
			// which is what believing the recycled number produces.
			if (outcome === "swept") {
				expect(descendant.status()).toBe(ProcessStatus.Exited);
			} else {
				expect(outcome).toContain("cannot be proven to still be ours");
				expect(descendant.status()).toBe(ProcessStatus.Running);
			}
		} finally {
			spy?.mockRestore();
			descendant?.killTree(9);
			await reader.cancel();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"aims the subreaper hard sweep by identity rather than by number",
		async () => {
			// The costliest version of the same defect: this path hard-kills a whole
			// tree, so believing a recycled number sweeps a stranger's descendants
			// rather than merely missing our own. A subreaper root leads no group,
			// so the pin is the only identity available and the constructor has to
			// have taken one.
			//
			// The stand-in is a sacrificial process, not this one: on the unfixed
			// path the sweep lands on whatever the stub names.
			const bystander = spawn(["/bin/sh", "-c", "exec sleep 30"]);
			const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!; exec sleep 30"], {
				subreaper: true,
			});
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			const fromPid = Process.fromPid;
			let spy: ReturnType<typeof spyOn> | undefined;
			try {
				const output = await reader.read();
				descendant = fromPid.call(Process, Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				expect(descendant.status()).toBe(ProcessStatus.Running);
				process.kill(child.pid, "SIGKILL");
				await child.proc.exited;
				expect(child.proc.exitCode).toBeNull();

				spy = spyOn(Process, "fromPid").mockImplementation((pid: number) =>
					pid === child.pid ? fromPid.call(Process, bystander.pid) : fromPid.call(Process, pid),
				);
				const outcome = await child.killAndWait(undefined, -1).then(
					() => "swept",
					(error: unknown) => String(error),
				);

				// Refused, because a dead subreaper root's adopted descendants are
				// reachable through nothing this object holds. Believing the number
				// instead would have reported a sweep — of the stand-in's tree.
				expect(outcome).toContain("Subreaper tree unreachable");
			} finally {
				spy?.mockRestore();
				descendant?.killTree(9);
				bystander.kill(undefined, -1);
				await bystander.proc.exited;
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform === "win32")("never hides a reaped root's unswept group behind success", async () => {
		// Which arm runs depends on the kernel: with a process-group scope for
		// pidfds the retained leader reaches the group with no ownership proof at
		// all, and without one the pgid number is the only handle left and cannot
		// be attributed. The native side pins each arm on the measured scope; what
		// this covers is that neither outcome reaches the caller as a success over
		// a process that is still running.
		const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!"], { detached: true });
		const reader = child.stdout.getReader();
		let descendant: Process | null = null;
		try {
			const output = await reader.read();
			descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
			if (!descendant) throw new Error("Descendant exited before termination");
			await child.proc.exited;
			expect(Process.fromPid(child.pid)).toBeNull();
			const outcome = await child.killAndWait(undefined, -1).then(
				() => "swept",
				(error: unknown) => String(error),
			);
			if (outcome === "swept") {
				expect(descendant.status()).toBe(ProcessStatus.Exited);
			} else {
				expect(outcome).toContain("cannot be proven to still be ours");
				expect(descendant.status()).toBe(ProcessStatus.Running);
			}
		} finally {
			descendant?.killTree(9);
			await reader.cancel();
		}
	});

	it.skipIf(process.platform === "win32")("leaves buffered stdout readable after the kill", async () => {
		// The consumer is parked over unread output when the kill arrives, which
		// it has to survive: the stream belongs to the caller, not to kill().
		const child = spawn(["/bin/sh", "-c", "echo first; sleep 0.05; echo filler; exec sleep 30"], {
			detached: true,
		});
		const reader = child.stdout.getReader();
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
			await Bun.sleep(150);
			await child.killAndWait(undefined, -1);
			expect(new TextDecoder().decode((await reader.read()).value)).toBe("filler\n");
		} finally {
			await reader.cancel();
			child.kill(undefined, -1);
		}
	});

	it.skipIf(process.platform !== "win32")("waits for a pipe-holding descendant after its root exits", async () => {
		// Windows keeps the dead root's pid reserved through the retained handle, so
		// the Toolhelp descendant walk stays identity-safe after the root exits and
		// needs no unreaped-leader window.
		const child = spawn([process.execPath, `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`], {
			detached: true,
		});
		const reader = child.stdout.getReader();
		let descendant: Process | null = null;
		try {
			const output = await reader.read();
			const pid = Number.parseInt(new TextDecoder().decode(output.value), 10);
			descendant = Process.fromPid(pid);
			if (!descendant) throw new Error("Descendant exited before termination");
			await child.proc.exited;
			expect(descendant.status()).toBe(ProcessStatus.Running);
			await child.killAndWait(undefined, -1);
			expect(descendant.status()).toBe(ProcessStatus.Exited);
		} finally {
			descendant?.killTree(9);
			child.kill(undefined, -1);
			await reader.cancel();
		}
	});

	it.skipIf(process.platform === "win32")(
		"reports synchronous group-termination errors without interrupting kill",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!"], { detached: true });
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			const killOwnGroupAndWait = Process.prototype.killOwnGroupAndWait;
			const spy = spyOn(Process.prototype, "killOwnGroupAndWait").mockImplementation(
				function (this: Process, options) {
					if (this.pid === child.pid) throw new Error("Cannot observe process group");
					return killOwnGroupAndWait.call(this, options);
				},
			);
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				await child.proc.exited;
				child.kill(undefined, -1);
				await expect(child.killAndWait(undefined, -1)).rejects.toThrow("Cannot observe process group");
			} finally {
				spy.mockRestore();
				descendant?.killTree(9);
				await child.killAndWait(undefined, -1);
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"hard-kills a descendant orphaned when the root dies to the polite signal",
		async () => {
			// The descendant reports its pid only after ignoring TERM, and SIG_IGN
			// survives the exec, so the root exits to the polite signal first and
			// reparents the survivor out of the hard wave's descendant walk.
			const child = spawn(["/bin/sh", "-c", `/bin/sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait`]);
			const root = Process.fromPid(child.pid);
			if (!root) throw new Error("Root exited before termination");
			const reader = child.stdout.getReader();
			let orphan: Process | null = null;
			try {
				const output = await reader.read();
				orphan = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!orphan) throw new Error("Descendant exited before termination");
				expect(orphan.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, 100);
				expect(root.status()).toBe(ProcessStatus.Exited);
				expect(orphan.status()).toBe(ProcessStatus.Exited);
			} finally {
				orphan?.killTree(9);
				child.kill(undefined, -1);
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"waits for subreaper descendants during immediate hard termination",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], { subreaper: true });
			const root = Process.fromPid(child.pid);
			if (!root) throw new Error("Subreaper exited before termination");
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				expect(descendant.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
				expect(root.status()).toBe(ProcessStatus.Exited);
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await child.proc.exited;
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"never reports a dead subreaper root's adopted descendant as swept",
		async () => {
			// The hard-kill fast path used to enter on Bun's `exitCode`, which stays
			// null for at least a loop turn after the root is gone. A walk rooted at
			// a pid whose process has exited comes back empty and *complete* — the
			// survivors were reparented away — so the sweep hard-killed nothing and
			// reported the tree gone. Nothing pinned here can reach them once the
			// root is dead, so the only honest answer is a refusal.
			const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!"], { subreaper: true });
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				expect(descendant.status()).toBe(ProcessStatus.Running);
				// Killed rather than left to finish: the subreaper entrypoint waits on
				// its adopted children, so a root allowed to exit on its own has no
				// survivors to miss and cannot exercise this at all.
				process.kill(child.pid, "SIGKILL");
				spinUntilUnreapedExit(child);
				expect(child.proc.exitCode).toBeNull();
				const outcome = await child.killAndWait(undefined, -1).then(
					() => "swept",
					(error: unknown) => String(error),
				);
				expect(outcome).toContain("Subreaper tree unreachable");
				expect(descendant.status()).toBe(ProcessStatus.Running);
			} finally {
				descendant?.killTree(9);
				// The root is killed mid-test, but only once the reads above have
				// succeeded; a parse or pin failure before that leaves the wrapper
				// holding its 30s sleep.
				child.kill(undefined, -1);
				await child.proc.exited;
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"refuses a dead subreaper root it cannot enumerate even with nothing left running",
		async () => {
			// The deliberate cost of the refusal above, pinned so it cannot be
			// weakened by accident. This root leaves no survivors — the subreaper
			// entrypoint waits on its adopted children before exiting — but that is
			// not something the caller can establish after the fact: the walk that
			// would show it empty is the same walk that answers empty for a tree
			// full of reparented survivors. Reporting the difference would mean
			// claiming knowledge the exited root took with it.
			const child = spawn(["/bin/sh", "-c", "exit 0"], { subreaper: true });
			try {
				await child.proc.exited;
				expect(child.proc.exitCode).toBe(0);
				const outcome = await child.killAndWait(undefined, -1).then(
					() => "swept",
					(error: unknown) => String(error),
				);
				expect(outcome).toContain("Subreaper tree unreachable");
			} finally {
				await child.proc.exited;
			}
		},
	);

	it.skipIf(process.platform !== "linux")(
		"sweeps a dead subreaper root's group instead of hard-killing its empty tree",
		async () => {
			// Same unreaped window, but this shape pinned a group leader. The fast
			// path must yield to it: entering on a lagging `exitCode` preempted the
			// group sweep with a walk that could no longer see anything.
			const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!"], {
				detached: true,
				subreaper: true,
			});
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				process.kill(child.pid, "SIGKILL");
				spinUntilUnreapedExit(child);
				const outcome = await child.killAndWait(undefined, -1).then(
					() => "swept",
					(error: unknown) => String(error),
				);
				// Two arms for the same reason as the reaped-root group case above:
				// which one runs is the kernel's pidfd group scope. Both are named,
				// because "anything but the refusal" would also accept a group sweep
				// that silently reached nothing.
				if (outcome === "swept") {
					expect(descendant.status()).toBe(ProcessStatus.Exited);
				} else {
					expect(outcome).toContain("cannot be proven to still be ours");
					expect(descendant.status()).toBe(ProcessStatus.Running);
				}
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await child.proc.exited;
				await reader.cancel();
			}
		},
	);

	it.skipIf(process.platform === "win32")("never reports a termination it had no reference to attempt", async () => {
		// A host that refuses `pidfd_open`, or has no `/proc`, hands kill() nothing
		// to signal through while the child is still running. Awaiting only the
		// root's own exit promise there reports whatever the child does next as the
		// termination's own outcome: success if it happens to exit, and otherwise
		// no answer at all.
		const child = spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		const fromPid = Process.fromPid;
		const spy = spyOn(Process, "fromPid").mockImplementation((pid: number) =>
			pid === child.pid ? null : fromPid.call(Process, pid),
		);
		try {
			// Raced against a bound, because the failure this covers is as much "no
			// answer" as "the wrong answer": with nothing signalled and nothing
			// rejected, the call waits on an exit that is never coming.
			const outcome = await Promise.race([
				child.killAndWait(undefined, -1).then(
					() => "reported success",
					(error: unknown) => String(error),
				),
				Bun.sleep(2_000).then(() => "never settled"),
			]);
			expect(outcome).toContain("Process tree termination unattempted");
			expect(child.proc.exitCode).toBeNull();
		} finally {
			spy.mockRestore();
			child.kill(undefined, -1);
			await child.proc.exited;
		}
	});

	it.skipIf(process.platform === "win32")("never reports success for a detached group it could not pin", async () => {
		// A detached child leads a group that outlives it, so its exit says
		// nothing about the group. If the leader could not be pinned when it was
		// spawned — a host that refuses `pidfd_open` — nothing can reach that
		// group afterwards, and the root going away must not read as the tree
		// going away.
		const fromPid = Process.fromPid;
		let child: ChildProcess | undefined;
		const spy = spyOn(Process, "fromPid").mockImplementation((pid: number) =>
			child === undefined ? null : fromPid.call(Process, pid),
		);
		let descendant: Process | null = null;
		try {
			// The spy answers null while the constructor runs, so the leader is
			// never pinned; it answers normally afterwards so the test can watch.
			child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!"], { detached: true });
			const reader = child.stdout.getReader();
			const first = new TextDecoder().decode((await reader.read()).value);
			await reader.cancel();
			descendant = fromPid.call(Process, Number.parseInt(first, 10));
			if (!descendant) throw new Error("Descendant exited before termination");
			await child.proc.exited;

			const outcome = await child.killAndWait(undefined, -1).then(
				() => "reported success",
				(error: unknown) => String(error),
			);
			expect(outcome).toContain("Process tree termination unattempted");
			expect(descendant.status()).toBe(ProcessStatus.Running);
		} finally {
			spy.mockRestore();
			descendant?.killTree(9);
		}
	});

	it.skipIf(process.platform === "win32")("reports a child Bun has already reaped as terminated", async () => {
		// The complement, and the reason the refusal above is not simply "no
		// terminator": a caller that kills after the root is gone has nothing left
		// to reach, and every graceful stop in the mux arrives exactly there.
		const child = spawn(["/bin/sh", "-c", "exit 0"]);
		await child.proc.exited;
		expect(Process.fromPid(child.pid)).toBeNull();
		await child.killAndWait(undefined, -1);
	});

	for (const failure of ["timeout", "error"] as const) {
		it(`surfaces native termination ${failure} even after the root exits`, async () => {
			const child = spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
			const terminate = Process.prototype.terminate;
			const spy = spyOn(Process.prototype, "terminate").mockImplementation(async function (this: Process, options) {
				const result = await terminate.call(this, options);
				if (this.pid !== child.pid) return result;
				if (failure === "error") throw new Error("Native termination failed");
				return false;
			});
			try {
				await expect(child.killAndWait(undefined, -1)).rejects.toThrow(
					failure === "timeout" ? "Process tree termination timed out" : "Native termination failed",
				);
			} finally {
				spy.mockRestore();
				child.kill(undefined, -1);
				await child.proc.exited;
			}
		});
	}
});
