import { describe, expect, it } from "bun:test";
import { FdStream, PtySession, type PtyRunResult, type RawExit, reapChild, spawnRaw } from "../native/index.js";

// A PTY control loop and a reapChild wait each last as long as their child. On
// Windows the addon caps Tokio's blocking pool at NAPI_TOKIO_MAX_BLOCKING_THREADS
// (8, crates/natives/src/lib.rs); with those waits on that pool, eight live
// children stop every later PTY or reap from even starting.
const BLOCKING_POOL_CAP = 8;
const EXIT_CODE = 7;
const DEADLINE_MS = 10_000;
const HOLDER_ARGS = ["-n", "60", "127.0.0.1"];

function within<T>(promise: Promise<T>, label: string): Promise<T> {
	const { promise: timedOut, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${DEADLINE_MS} ms`)), DEADLINE_MS);
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

function childEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

describe.skipIf(process.platform !== "win32")("PTY and reapChild waits at the blocking-pool cap", () => {
	it("finishes a further PTY while eight PTY sessions stay open", async () => {
		const holders: { session: PtySession; run: Promise<PtyRunResult> }[] = [];
		try {
			const started: Promise<number>[] = [];
			for (let i = 0; i < BLOCKING_POOL_CAP; i++) {
				const session = new PtySession();
				const { promise, resolve, reject } = Promise.withResolvers<number>();
				const run = session.startArgv(
					{ application: "ping.exe", args: HOLDER_ARGS, timeoutMs: 120_000, cols: 80, rows: 24 },
					undefined,
					(error, pid) => (error ? reject(error) : resolve(pid)),
				);
				run.catch(reject);
				holders.push({ session, run });
				started.push(promise);
			}
			await within(Promise.all(started), "starting the holder PTYs");

			const probe = new PtySession().startArgv({
				application: "cmd.exe",
				args: ["/c", `exit ${EXIT_CODE}`],
				timeoutMs: 30_000,
				cols: 80,
				rows: 24,
			});
			expect((await within(probe, "the further PTY")).exitCode).toBe(EXIT_CODE);
		} finally {
			for (const { session } of holders) session.kill();
			await Promise.allSettled(holders.map(holder => holder.run));
		}
	}, 60_000);

	it("reaps a further child while eight reapChild waits are pending", async () => {
		const env = childEnv();
		const cwd = process.cwd();
		const handles: number[] = [];
		const holders: { pid: number; reaped: Promise<RawExit> }[] = [];
		try {
			for (let i = 0; i < BLOCKING_POOL_CAP; i++) {
				const child = spawnRaw({ application: "ping.exe", args: HOLDER_ARGS, env, cwd });
				handles.push(child.stdin, child.stdout, child.stderr);
				holders.push({ pid: child.pid, reaped: reapChild(child.pid) });
			}
			// Alive long enough for reapChild to open it: once a child has exited and
			// spawnRaw has dropped its handle, its pid no longer names a process.
			const probe = spawnRaw({
				application: "cmd.exe",
				args: ["/c", `ping -n 2 127.0.0.1 >NUL & exit ${EXIT_CODE}`],
				env,
				cwd,
			});
			handles.push(probe.stdin, probe.stdout, probe.stderr);
			expect(await within(reapChild(probe.pid), "reaping the further child")).toEqual({
				exitCode: EXIT_CODE,
				signal: null,
			});
		} finally {
			for (const { pid } of holders) {
				try {
					process.kill(pid);
				} catch {}
			}
			await Promise.allSettled(holders.map(holder => holder.reaped));
			for (const handle of handles) new FdStream(handle).close();
		}
	}, 60_000);
});
