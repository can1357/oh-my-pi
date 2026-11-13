/**
 * The ovnfs daemons this process started, one per ovnfs command (`ovnfs.path`),
 * by admin socket.
 *
 * Only the command says where its daemon is: `ovnfs --json start` prints
 * api.Status. A known daemon is kept until its socket stops answering
 * ({@link forgetDaemon}).
 *
 * @example
 * const daemon = await startDaemon("ovnfs");
 * await callSocket(daemon.socket, "ls", {});
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { PROTOCOL_VERSION } from "./client";

/** A running ovnfs daemon. */
export interface Daemon {
	/** Admin socket, for `callSocket`. */
	socket: string;
}

/** Daemons by command, as `start` reported them; a pending entry is a `start` in flight. */
const daemons = new Map<string, Promise<Daemon>>();

/** Run `command --json start`; rejects when it cannot run, fails, or speaks another admin protocol. */
async function start(command: string): Promise<Daemon> {
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		// windowsHide: a console-less omp host (background, IDE) would otherwise
		// flash a fresh conhost window.
		child = Bun.spawn([command, "--json", "start"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
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
	if (code !== 0) throw new Error(`${command} start failed: ${stderr.trim() || `exit status ${code}`}`);
	const status: unknown = JSON.parse(stdout);
	const version = isRecord(status) ? status.version : undefined;
	if (!isRecord(status) || version !== PROTOCOL_VERSION || typeof status.socket !== "string") {
		throw new Error(`${command} speaks admin protocol ${version}; omp needs ${PROTOCOL_VERSION}: update ovnfs`);
	}
	return { socket: status.socket };
}

/** The daemon `command` manages, started unless it runs; a failure is retried on the next call. */
export function startDaemon(command: string): Promise<Daemon> {
	let daemon = daemons.get(command);
	if (!daemon) {
		const started = start(command);
		started.catch(() => {
			if (daemons.get(command) === started) daemons.delete(command);
		});
		daemons.set(command, started);
		daemon = started;
	}
	return daemon;
}

/** Forget `command`'s daemon after its socket stopped answering, so the next call starts or finds it again. */
export function forgetDaemon(command: string): void {
	daemons.delete(command);
}
