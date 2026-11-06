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
import { isRecord } from "@oh-my-pi/pi-utils";
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

/** Daemons by command, as `start` or `status` reported them; a pending entry is a `start` in flight. */
const daemons = new Map<string, Promise<Daemon>>();

/** The last `status` query by command (pending or settled) and when it was asked. */
const queries = new Map<string, { found: Promise<Daemon | undefined>; at: number }>();

/** Run `command --json <verb>`; rejects when it cannot run, fails, or speaks another admin protocol. */
async function report(command: string, verb: "start" | "status"): Promise<Daemon> {
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn([command, "--json", verb], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	} catch (err) {
		throw new Error(
			`cannot run ${command} (${err instanceof Error ? err.message : String(err)}); set ovnfs.path to the ovnfs binary`,
		);
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
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
	const parent = await fs.realpath(dir).catch(() => dir);
	return { socket: status.socket, mount: path.join(parent, path.basename(status.mount)) };
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

/** The daemon `command` manages if it runs, without starting one; undefined when none answers. */
export async function runningDaemon(command: string): Promise<Daemon | undefined> {
	const known = daemons.get(command);
	if (known) return known.catch(() => undefined);
	const last = queries.get(command);
	if (last && Date.now() - last.at < RECHECK_MS) return last.found;
	const found = report(command, "status").then(
		daemon => {
			if (!daemons.has(command)) daemons.set(command, Promise.resolve(daemon));
			return daemon;
		},
		() => undefined,
	);
	queries.set(command, { found, at: Date.now() });
	return found;
}

/** Forget `command`'s daemon after its socket stopped answering, so the next call asks the command again. */
export function forgetDaemon(command: string): void {
	daemons.delete(command);
	queries.delete(command);
}
