import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

describe("ptree.ChildProcess.killAndWait()", () => {
	it.skipIf(process.platform === "win32")(
		"terminates a dead root's descendant that holds only raw stdout open",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 2>/dev/null & echo $!"], { detached: true, stderr: "full" });
			let reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				await child.proc.exited;
				await Bun.readableStreamToText(child.stderr!);
				await Bun.sleep(0);
				expect(descendant.status()).toBe(ProcessStatus.Running);
				reader.releaseLock();
				reader = child.stdout.getReader();
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
				expect((await reader.read()).done).toBe(true);
			} finally {
				descendant?.killTree(9);
				await reader.cancel();
				child.kill(undefined, -1);
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"terminates a dead root's descendant while its stdout consumer is paused",
		async () => {
			// The descendant emits a second chunk once the pid has been read and then
			// keeps stdout open, so the consumer is parked over unread output on an
			// uncancelled stream when the kill arrives.
			const child = spawn(
				["/bin/sh", "-c", `/bin/sh -c 'echo $$; sleep 0.05; echo filler; exec sleep 30' 2>/dev/null &`],
				{ detached: true, stderr: "full" },
			);
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const first = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(first.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				await child.proc.exited;
				await Bun.readableStreamToText(child.stderr!);
				await Bun.sleep(150);
				expect(descendant.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
				// Proves the consumer really was parked over buffered output rather
				// than sitting at EOF, and that the kill did not discard it.
				expect(new TextDecoder().decode((await reader.read()).value)).toBe("filler\n");
			} finally {
				descendant?.killTree(9);
				await reader.cancel();
				child.kill(undefined, -1);
			}
		},
	);

	for (const finish of ["eof", "cancel"] as const) {
		it.skipIf(process.platform === "win32")(
			`reaps a dead root's group after its stdout consumer reached ${finish}`,
			async () => {
				// The "eof" descendant redirects stdout away, so it holds no pipe of
				// ours at all and group membership is the only thing connecting it to
				// the child being killed.
				const script = finish === "eof" ? "sleep 30 >/dev/null 2>&1 & echo $!" : "sleep 30 2>/dev/null & echo $!";
				const child = spawn(["/bin/sh", "-c", script], { detached: true, stderr: "full" });
				const reader = child.stdout.getReader();
				let descendant: Process | null = null;
				try {
					const output = await reader.read();
					descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
					if (!descendant) throw new Error("Descendant exited before termination");
					await child.proc.exited;
					await Bun.readableStreamToText(child.stderr!);
					if (finish === "eof") expect((await reader.read()).done).toBe(true);
					else await reader.cancel();
					await Bun.sleep(0);
					// Whether a reader is still attached no longer decides this. The
					// pinned leader's identity check is what keeps the group kill off a
					// recycled pgid, so a survivor is reaped either way.
					await child.killAndWait(undefined, -1);
					expect(descendant.status()).toBe(ProcessStatus.Exited);
				} finally {
					descendant?.killTree(9);
					await reader.cancel();
					child.kill(undefined, -1);
				}
			},
		);
	}

	it.skipIf(process.platform === "win32")(
		"terminates a dead root's descendant when stdout was never read",
		async () => {
			// The descendant reports itself out of band and closes stderr, so neither
			// pipe carries any evidence and no stdout reader is ever created — the
			// distinguishing condition here.
			const pidFile = path.join(os.tmpdir(), `omp-ptree-unread-${process.pid}-${Date.now()}`);
			const child = spawn(["/bin/sh", "-c", `/bin/sh -c 'echo $$ > ${pidFile}; exec sleep 30' 2>/dev/null &`], {
				detached: true,
			});
			let descendant: Process | null = null;
			try {
				for (let attempt = 0; attempt < 200 && !descendant; attempt++) {
					const reported = Number.parseInt(
						(
							await Bun.file(pidFile)
								.text()
								.catch(() => "")
						).trim(),
						10,
					);
					descendant = Number.isFinite(reported) ? Process.fromPid(reported) : null;
					if (!descendant) await Bun.sleep(10);
				}
				if (!descendant) throw new Error("Descendant never reported its pid");
				await child.proc.exited;
				// Let the internal stderr drain reach EOF, which is what used to leave
				// this child with no pipe evidence and skip the group cleanup entirely.
				await Bun.sleep(100);
				expect(descendant.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await Bun.file(pidFile)
					.unlink()
					.catch(() => {});
			}
		},
	);

	it("waits for a pipe-holding descendant after its root exits", async () => {
		const command =
			process.platform === "win32"
				? [process.execPath, `${import.meta.dir}/fixtures/ptree-dead-root-probe.ts`]
				: ["/bin/sh", "-c", "sleep 30 & echo $!"];
		const child = spawn(command, { detached: true });
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
		"terminates a detached group before Bun reports the leader's exit",
		async () => {
			const child = spawn(["/bin/sh", "-c", "sleep 30 & echo $!"], { detached: true });
			const reader = child.stdout.getReader();
			let descendant: Process | null = null;
			try {
				const output = await reader.read();
				descendant = Process.fromPid(Number.parseInt(new TextDecoder().decode(output.value), 10));
				if (!descendant) throw new Error("Descendant exited before termination");
				// The window under test: the leader is already gone, but Bun's reaper
				// has not run yet, so exitCode still reads null. Asserted rather than
				// assumed — without it this silently becomes the exited-root case above.
				expect(child.proc.exitCode).toBe(null);
				expect(Process.fromPid(child.pid)?.status()).toBe(ProcessStatus.Exited);
				expect(descendant.status()).toBe(ProcessStatus.Running);
				await child.killAndWait(undefined, -1);
				expect(descendant.status()).toBe(ProcessStatus.Exited);
			} finally {
				descendant?.killTree(9);
				child.kill(undefined, -1);
				await reader.cancel();
			}
		},
	);

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
