/**
 * Runs a real omp daemon in a private runtime dir for one test.
 *
 * `OMP_DAEMON_DIR` is the only seam the client and server share, so it is set
 * (and `OMP_DAEMON_TCP` cleared) for the duration of one test and restored by
 * `dispose()`, which also shuts the daemon down, kills any process the test
 * tracked, and removes the dir.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { closeDaemonClient, probeDaemon } from "../../src/daemon/client";
import { daemonLockPath } from "../../src/daemon/paths";
import { DAEMON_DIR_ENV, DAEMON_TCP_ENV } from "../../src/daemon/protocol";

const TEARDOWN_TIMEOUT_MS = 10_000;

/** Poll `probe` until it returns a truthy value; throws naming `what` after `timeoutMs`. */
export async function waitFor<T>(
	probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
	what: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
		await Bun.sleep(25);
	}
}

/** Whether `pid` names a live (or not yet reaped) process. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether a daemon currently holds this runtime dir's single-instance lock. */
export function daemonLockHeld(): boolean {
	return FileLock.isHeld(daemonLockPath());
}

export class IsolatedDaemon {
	readonly dir: string;
	readonly #previousDir: string | undefined;
	readonly #previousTcp: string | undefined;
	readonly #pids = new Set<number>();

	private constructor(dir: string, previousDir: string | undefined, previousTcp: string | undefined) {
		this.dir = dir;
		this.#previousDir = previousDir;
		this.#previousTcp = previousTcp;
	}

	static async create(): Promise<IsolatedDaemon> {
		// Short base: the endpoint is a Unix socket under this dir.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dmn-"));
		const previousDir = process.env[DAEMON_DIR_ENV];
		const previousTcp = process.env[DAEMON_TCP_ENV];
		await closeDaemonClient();
		process.env[DAEMON_DIR_ENV] = dir;
		delete process.env[DAEMON_TCP_ENV];
		return new IsolatedDaemon(dir, previousDir, previousTcp);
	}

	/** Processes to kill on teardown if they are still alive (daemon, units). */
	track(...pids: number[]): void {
		for (const pid of pids) this.#pids.add(pid);
	}

	async dispose(): Promise<void> {
		try {
			await closeDaemonClient();
			// A dispose that outlived its test must never reach another test's daemon,
			// or the user's: the probe follows the env, so only probe while it is ours.
			const probe = process.env[DAEMON_DIR_ENV] === this.dir ? await probeDaemon() : undefined;
			if (probe) {
				this.#pids.add(probe.welcome.daemon.pid);
				try {
					await probe.request({ op: "shutdown" });
				} catch {
					// Killed below.
				} finally {
					probe.close();
				}
			}
			const deadline = Date.now() + TEARDOWN_TIMEOUT_MS;
			while (process.env[DAEMON_DIR_ENV] === this.dir && daemonLockHeld() && Date.now() < deadline) {
				await Bun.sleep(25);
			}
			for (const pid of this.#pids) {
				if (pid !== process.pid && isAlive(pid)) {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Exited meanwhile.
					}
				}
			}
		} finally {
			if (process.env[DAEMON_DIR_ENV] === this.dir) {
				if (this.#previousDir === undefined) delete process.env[DAEMON_DIR_ENV];
				else process.env[DAEMON_DIR_ENV] = this.#previousDir;
				if (this.#previousTcp !== undefined) process.env[DAEMON_TCP_ENV] = this.#previousTcp;
			}
			await fs.rm(this.dir, { recursive: true, force: true });
		}
	}
}
