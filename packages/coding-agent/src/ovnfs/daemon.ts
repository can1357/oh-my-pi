/**
 * The ovnfs daemons this process knows, one per ovnfs command (`ovnfs.path`):
 * each one's admin socket and the mount its checkouts appear in.
 *
 * Only the command says where its daemon is: `ovnfs --json start` and
 * `ovnfs --json status` both print api.Status. Nothing is read from the mount
 * itself; a path is the daemon's to serve when it lies below its mount. A
 * known daemon is kept until its socket stops answering ({@link forgetDaemon});
 * `status` finding none is believed for {@link RECHECK_MS}, so a daemon started
 * later by someone else is still noticed.
 *
 * @example
 * const daemon = await runningDaemon("ovnfs");
 * if (daemon) await callSocket(daemon.socket, "ls", {});
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, untilAborted } from "@oh-my-pi/pi-utils";
import { PROTOCOL_VERSION } from "./client";

/** A running ovnfs daemon. */
export interface Daemon {
	/** Admin socket, for `callSocket`. */
	socket: string;
	/** The folder its checkouts appear in, with its parent's symlinks resolved. */
	mount: string;
}

/** How long `status` finding no daemon is believed before the command is asked again. */
const RECHECK_MS = 10_000;

/** How long `status` may run before it is killed and treated as no daemon. */
const STATUS_TIMEOUT_MS = 5_000;

/** Daemons by command, as `start` or `status` reported them; a pending entry is a `start` in flight. */
const daemons = new Map<string, Promise<Daemon>>();

interface StatusQuery {
	found: Promise<Daemon | undefined>;
	at: number;
	waiters: number;
	settled: boolean;
	abort: () => void;
}

/** The last `status` query by command (pending or settled) and when it was asked. */
const queries = new Map<string, StatusQuery>();

/** Run `command --json <verb>`; rejects when it cannot run, fails, or speaks another admin protocol. */
async function report(command: string, verb: "start" | "status", signal?: AbortSignal): Promise<Daemon> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const timer =
		verb === "status"
			? setTimeout(() => controller.abort(new Error(`${command} status timed out`)), STATUS_TIMEOUT_MS)
			: undefined;
	timer?.unref?.();
	try {
		controller.signal.throwIfAborted();
		const detached = verb === "status" && process.platform !== "win32";
		let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			// windowsHide: a console-less omp host (background, IDE) would otherwise
			// flash a fresh conhost window for every `status` recheck.
			child = Bun.spawn([command, "--json", verb], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				detached,
			});
		} catch (err) {
			throw new Error(
				`cannot run ${command} (${err instanceof Error ? err.message : String(err)}); set ovnfs.path to the ovnfs binary`,
			);
		}
		const kill = () => {
			if (detached) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
			}
			try {
				child.kill("SIGKILL");
			} catch {}
		};
		if (controller.signal.aborted) kill();
		else controller.signal.addEventListener("abort", kill, { once: true });
		let stdout: string;
		let stderr: string;
		let code: number;
		try {
			[stdout, stderr, code] = await untilAborted(
				controller.signal,
				Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
			);
		} finally {
			controller.signal.removeEventListener("abort", kill);
		}
		controller.signal.throwIfAborted();
		if (code !== 0) throw new Error(`${command} ${verb} failed: ${stderr.trim() || `exit status ${code}`}`);
		const status: unknown = JSON.parse(stdout);
		const version = isRecord(status) ? status.version : undefined;
		if (
			!isRecord(status) ||
			version !== PROTOCOL_VERSION ||
			typeof status.socket !== "string" ||
			typeof status.mount !== "string"
		) {
			throw new Error(`${command} speaks admin protocol ${version}; omp needs ${PROTOCOL_VERSION}: update ovnfs`);
		}
		// Searches compare real paths. Resolving only the parent, as the daemon
		// does (macOS /tmp is /private/tmp), never looks inside the mount.
		const dir = path.dirname(status.mount);
		const parent = await untilAborted(controller.signal, () => fs.realpath(dir).catch(() => dir));
		return { socket: status.socket, mount: path.join(parent, path.basename(status.mount)) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** The daemon `command` manages, started unless it runs; a failure is retried on the next call. */
export function startDaemon(command: string): Promise<Daemon> {
	let daemon = daemons.get(command);
	if (!daemon) {
		const started = report(command, "start");
		started.catch(() => {
			if (daemons.get(command) === started) daemons.delete(command);
		});
		daemons.set(command, started);
		daemon = started;
	}
	return daemon;
}

/**
 * The daemon `command` manages if it runs, without starting one; undefined when
 * none answers, or rejects with `signal.reason` once `signal` aborts.
 */
export async function runningDaemon(command: string, signal?: AbortSignal): Promise<Daemon | undefined> {
	signal?.throwIfAborted();
	const known = daemons.get(command);
	if (known) {
		return untilAborted(signal, () => known.catch(() => undefined)).catch(err => {
			throw signal?.aborted ? signal.reason : err;
		});
	}
	let query = queries.get(command);
	if (!query || Date.now() - query.at >= RECHECK_MS) {
		const controller = new AbortController();
		const next: StatusQuery = {
			found: Promise.resolve(undefined),
			at: Date.now(),
			waiters: 0,
			settled: false,
			abort: () => {
				if (queries.get(command) === next) queries.delete(command);
				controller.abort();
			},
		};
		next.found = report(command, "status", controller.signal).then(
			daemon => {
				next.settled = true;
				if (!daemons.has(command)) daemons.set(command, Promise.resolve(daemon));
				return daemon;
			},
			() => {
				next.settled = true;
				if (controller.signal.aborted && queries.get(command) === next) queries.delete(command);
				return undefined;
			},
		);
		queries.set(command, next);
		query = next;
	}
	if (query.settled) return query.found;
	const active = query;
	active.waiters++;
	return untilAborted(signal, active.found).then(
		daemon => {
			active.waiters--;
			return daemon;
		},
		err => {
			active.waiters--;
			if (!active.settled && active.waiters === 0) active.abort();
			throw signal?.aborted ? signal.reason : err;
		},
	);
}

/** Forget `command`'s daemon after its socket stopped answering, so the next call asks the command again. */
export function forgetDaemon(command: string): void {
	daemons.delete(command);
	const query = queries.get(command);
	if (query && !query.settled) query.abort();
	else queries.delete(command);
}
