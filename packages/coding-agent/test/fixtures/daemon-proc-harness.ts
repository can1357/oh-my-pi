/**
 * A real omp daemon isolated in a private temp dir, plus a raw protocol
 * connection to it, for tests of `proc` units, leases and the store.
 *
 * Nothing here touches `process.env` or `~/.omp`: the daemon runs as a child
 * process whose env names the temp dir (`OMP_DAEMON_DIR`), and connections dial
 * its endpoint and read its token directly. {@link TestDaemon.dispose} stops
 * every unit it saw (detached ones outlive the daemon), shuts the daemon down,
 * kills whatever survived, and deletes the dir.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { isSameProcess, processStartTime } from "../../src/daemon/children";
import {
	DAEMON_DIR_ENV,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_RESUME_ENV,
	DAEMON_TCP_ENV,
	DAEMON_WORKER_ARG,
	type DaemonEvent,
	type DaemonOp,
	type DaemonResponse,
	type DaemonResult,
	GLOBAL_SCOPE,
	type OpenRequest,
	type ProcSpec,
	type UnitSnapshot,
} from "../../src/daemon/protocol";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "src", "cli.ts");
const START_TIMEOUT_MS = 20_000;
const HELLO_TIMEOUT_MS = 5_000;

/** Poll `probe` until it returns a value other than undefined, or fail after `timeoutMs`. */
export async function until<T>(
	probe: () => T | undefined | Promise<T | undefined>,
	what: string,
	timeoutMs = 10_000,
	intervalMs = 25,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
		await Bun.sleep(intervalMs);
	}
}

/** Whether `pid` names a live process. */
export function pidAlive(pid: number): boolean {
	return isSameProcess(pid, undefined);
}

/** Settle `promise` and return its rejection message. */
export async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected the promise to reject");
}

/** A non-PTY `/bin/sh -c script` spec; `env` replaces the default minimal env when given. */
export function shProc(
	script: string,
	cwd: string,
	extra: { env?: Record<string, string>; ready?: ProcSpec["ready"]; notify?: string; pty?: boolean } = {},
): ProcSpec {
	return {
		application: "/bin/sh",
		args: ["-c", script],
		env: extra.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		cwd,
		pty: extra.pty ?? false,
		ready: extra.ready,
		notify: extra.notify,
	};
}

/** One control-mode connection speaking the daemon's line protocol. */
export class DaemonConn {
	/** Every event received, in order. */
	readonly events: DaemonEvent[] = [];
	readonly closed: Promise<void>;
	readonly #conn: IpcConnection;
	readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #onResult: (result: unknown) => void;
	readonly #welcome = Promise.withResolvers<void>();
	#welcomed = false;
	#isClosed = false;

	private constructor(conn: IpcConnection, onResult: (result: unknown) => void) {
		this.#conn = conn;
		this.#onResult = onResult;
		const closed = Promise.withResolvers<void>();
		this.closed = closed.promise;
		conn.start(
			line => this.#onLine(line),
			reason => {
				this.#isClosed = true;
				const error = new Error(`Daemon connection closed${reason ? `: ${reason}` : ""}`);
				if (!this.#welcomed) this.#welcome.reject(error);
				for (const pending of this.#pending.values()) pending.reject(error);
				this.#pending.clear();
				closed.resolve();
			},
		);
	}

	static async connect(endpoint: string, token: string, onResult: (result: unknown) => void): Promise<DaemonConn> {
		const conn = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 1_000 });
		const instance = new DaemonConn(conn, onResult);
		conn.send(
			JSON.stringify({
				v: DAEMON_PROTOCOL_VERSION,
				token,
				client: { pid: process.pid, build: "0.0.0-test", exe: [] },
			}),
		);
		const timer = setTimeout(() => conn.destroy(), HELLO_TIMEOUT_MS);
		try {
			await instance.#welcome.promise;
		} catch (error) {
			conn.destroy();
			throw error;
		} finally {
			clearTimeout(timer);
		}
		return instance;
	}

	get isClosed(): boolean {
		return this.#isClosed;
	}

	/** Send one operation; `id` lets a test `cancel` it. */
	request<O extends DaemonOp>(operation: O, id: string = crypto.randomUUID()): Promise<DaemonResult<O["op"]>> {
		if (this.#isClosed) return Promise.reject(new Error("Daemon connection closed"));
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#conn.send(JSON.stringify({ id, ...operation }));
		return promise as Promise<DaemonResult<O["op"]>>;
	}

	/** Find-or-start a `proc` unit in the global scope. */
	openProc(key: string, proc: ProcSpec, extra: Partial<OpenRequest> = {}): Promise<DaemonResult<"open">> {
		return this.request({ op: "open", kind: "proc", scope: GLOBAL_SCOPE, key, proc, ...extra });
	}

	describe(key: string): Promise<UnitSnapshot> {
		return this.request({ op: "describe", unit: key }).then(result => result.unit);
	}

	/** First received event matching `predicate`, waiting up to `timeoutMs`. */
	event<E extends DaemonEvent>(
		predicate: (event: DaemonEvent) => event is E,
		what: string,
		timeoutMs = 10_000,
	): Promise<E> {
		return until(() => this.events.find(predicate), what, timeoutMs);
	}

	close(): Promise<void> {
		if (!this.#isClosed) this.#conn.destroy();
		return this.closed;
	}

	#onLine(line: string): void {
		const message = JSON.parse(line) as Record<string, unknown>;
		if (!this.#welcomed) {
			this.#welcomed = true;
			// The daemon answers a refused hello with `{ error }` and closes.
			if (typeof message.error === "string") this.#welcome.reject(new Error(message.error));
			else this.#welcome.resolve();
			return;
		}
		if ("ev" in message) {
			this.events.push(message as unknown as DaemonEvent);
			return;
		}
		const response = message as unknown as DaemonResponse;
		const pending = this.#pending.get(response.id);
		if (!pending) return;
		this.#pending.delete(response.id);
		if (response.ok) {
			this.#onResult(response.result);
			pending.resolve(response.result);
		} else pending.reject(new Error(response.error));
	}
}

/** A daemon process running against a private runtime dir. */
export class TestDaemon {
	/** Temp root: `cwd` for units, stderr captures, and the daemon dir below it. */
	readonly root: string;
	/** `OMP_DAEMON_DIR` of the daemon. */
	readonly dir: string;
	readonly #env: Record<string, string>;
	readonly #conns = new Set<DaemonConn>();
	/** Every unit pid any answer named, with its start time, so nothing outlives the test. */
	readonly #pids = new Map<number, number>();
	#proc: Bun.Subprocess | undefined;
	#spawns = 0;

	private constructor(root: string, env: Record<string, string>) {
		this.root = root;
		this.dir = path.join(root, "daemon");
		this.#env = env;
	}

	/** Spawn a daemon in a fresh temp dir and return it with a first connection. */
	static async start(
		options: { env?: Record<string, string> } = {},
	): Promise<{ daemon: TestDaemon; conn: DaemonConn }> {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-dt-")));
		const daemon = new TestDaemon(root, options.env ?? {});
		try {
			const conn = await daemon.spawn();
			return { daemon, conn };
		} catch (error) {
			await daemon.dispose();
			throw error;
		}
	}

	get pid(): number {
		if (!this.#proc) throw new Error("Daemon was never spawned");
		return this.#proc.pid;
	}

	get exited(): Promise<number> {
		if (!this.#proc) throw new Error("Daemon was never spawned");
		return this.#proc.exited;
	}

	get running(): boolean {
		return this.#proc !== undefined && this.#proc.exitCode === null && this.#proc.signalCode === null;
	}

	get dbPath(): string {
		return path.join(this.dir, "daemon.db");
	}

	/** Start a daemon process on this dir (first start, or after {@link kill}) and connect to it. */
	async spawn(): Promise<DaemonConn> {
		if (this.running) throw new Error("Daemon is already running");
		const env: Record<string, string> = {};
		for (const name in process.env) {
			const value = process.env[name];
			if (typeof value === "string") env[name] = value;
		}
		delete env[DAEMON_TCP_ENV];
		delete env[DAEMON_RESUME_ENV];
		env[DAEMON_DIR_ENV] = this.dir;
		env.PI_TEST_RUNTIME = "1";
		env.PI_CODING_AGENT_DIR = path.join(this.root, "agent");
		Object.assign(env, this.#env);
		this.#spawns++;
		const proc = Bun.spawn([process.execPath, CLI_ENTRY, DAEMON_WORKER_ARG], {
			cwd: PACKAGE_ROOT,
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: Bun.file(path.join(this.root, `daemon-${this.#spawns}.stderr`)),
		});
		this.#proc = proc;
		const deadline = Date.now() + START_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null || proc.signalCode !== null) {
				throw new Error(
					`Daemon exited during startup (${proc.exitCode ?? proc.signalCode}): ${await this.#stderr()}`,
				);
			}
			try {
				return await this.connect();
			} catch (error) {
				lastError = error;
			}
			await Bun.sleep(25);
		}
		throw new Error(
			`Daemon did not answer within ${START_TIMEOUT_MS}ms: ${String(lastError)} ${await this.#stderr()}`,
		);
	}

	/** Another control connection to the running daemon. */
	async connect(): Promise<DaemonConn> {
		const token = (await fs.readFile(path.join(this.dir, "token"), "utf8")).trim();
		if (!token) throw new Error("Daemon token is not written yet");
		const conn = await DaemonConn.connect(ipcEndpoint(this.dir, "daemon"), token, result => this.#track(result));
		this.#conns.add(conn);
		void conn.closed.then(() => this.#conns.delete(conn));
		return conn;
	}

	/** Crash the daemon: SIGKILL, no shutdown path runs. */
	async kill(): Promise<void> {
		const proc = this.#proc;
		if (!proc || !this.running) return;
		proc.kill("SIGKILL");
		await proc.exited;
		await Promise.all([...this.#conns].map(conn => conn.closed));
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.#conns].map(conn => conn.close()));
		if (this.running) {
			try {
				const conn = await this.connect();
				const { units } = await conn.request({ op: "list" });
				for (const unit of units) {
					if (unit.state === "exited" || unit.state === "failed") continue;
					await conn.request({ op: "stop", unit: unit.id, timeoutMs: 1_000 }).catch(() => undefined);
				}
				await conn.request({ op: "shutdown" }).catch(() => undefined);
				await conn.close();
			} catch {
				// Unreachable: killed below.
			}
			const proc = this.#proc!;
			await Promise.race([proc.exited, Bun.sleep(5_000)]);
			if (this.running) {
				proc.kill("SIGKILL");
				await proc.exited;
			}
		}
		for (const [pid, startedAt] of this.#pids) {
			if (!isSameProcess(pid, startedAt)) continue;
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
		this.#pids.clear();
		await fs.rm(this.root, { recursive: true, force: true });
	}

	#track(result: unknown): void {
		if (typeof result !== "object" || result === null) return;
		const units: UnitSnapshot[] = [];
		if ("unit" in result && result.unit) units.push(result.unit as UnitSnapshot);
		if ("units" in result && Array.isArray(result.units)) units.push(...(result.units as UnitSnapshot[]));
		for (const unit of units) {
			for (const pid of unit.pids ?? []) {
				if (this.#pids.has(pid)) continue;
				const startedAt = processStartTime(pid);
				// Already gone: a later process may reuse the pid, so it is never killed.
				if (startedAt !== undefined) this.#pids.set(pid, startedAt);
			}
		}
	}

	async #stderr(): Promise<string> {
		try {
			return await fs.readFile(path.join(this.root, `daemon-${this.#spawns}.stderr`), "utf8");
		} catch {
			return "";
		}
	}
}
