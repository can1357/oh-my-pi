/**
 * ovnfs checkouts as isolated subagent workspaces (experimental, `ovnfs.enabled`).
 *
 * Instead of cloning the repository, an isolated run works in an ovnfs checkout: a
 * copy-on-write view of the repository served by the ovnfs daemon, ready in
 * about a second whatever the checkout's size, with its own private git dir.
 * Capture and merge are unchanged: the runner diffs and commits the checkout like
 * a native copy, and the checkout is removed when the run ends (or kept, like a
 * native workspace, when its changes could not be captured).
 *
 * `ovnfs start --json` makes sure the daemon runs and reports its admin
 * socket; checkouts are then opened (`new`) and removed (`rm`) over that socket.
 * The protocol frames JSON objects with a little-endian u32 length: the client
 * says `{"hello": {...}}` and gets `{"welcome": {version, ops, ...}}`, then each
 * `{"id": N, "<op>": {args}}` is answered by `{"id": N, "ok": reply}` or
 * `{"id": N, "error": {code, message}}`.
 *
 * Each workspace keeps a record of its checkout ({@link OVNFS_CHECKOUT_FILE}) in the
 * run's task-isolation dir, beside the owner marker, so `omp worktree clear`
 * removes the checkouts of runs that crashed ({@link releaseOvnfsCheckout}).
 *
 * @example
 * // Picked by the task runner when `ovnfs.enabled` is on:
 * const open = ovnfsWorkspace("/work/ovnfs/bin/ovnfs");
 * const workspace = await open(repoRoot, "AuthRefactor"); // workspace.dir: /work/.tree/agents/omp-authrefactor-1a2b3c
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { IsolationWorkspace, OpenWorkspace, RetainedWorkspace } from "./isolation-runner";
import { vacateIsolationSlot } from "./isolation-runner";
import { writeIsolationOwner } from "./isolation-ownership";
import { taskIsolationBaseDir } from "./worktree";

/** The ovnfs admin protocol generation this client speaks. */
const PROTOCOL_VERSION = 4;

/** Record of the checkout an isolation dir stands for. */
export const OVNFS_CHECKOUT_FILE = ".omp-ovnfs-checkout.json";

/** Contents of {@link OVNFS_CHECKOUT_FILE}. */
interface CheckoutRecord {
	/** ovnfs executable that opened the checkout (it can start the daemon again). */
	command: string;
	checkout: string;
}

/** A failure the ovnfs daemon reported, e.g. `not_found` or `exists`. */
export class OvnfsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`ovnfs: ${code}: ${message}`);
		this.name = "OvnfsError";
	}
}

/** What `ovnfs start --json` reports (api.Status). */
interface DaemonStatus {
	version: number;
	pid: number;
	socket: string;
	mount: string;
}

/** The checkout part of ovnfs's `new` reply. */
interface NewReply {
	checkout: { name: string; path: string };
}

/** Daemons by ovnfs executable, started once per process. */
const daemons = new Map<string, Promise<DaemonStatus>>();

/** Start (or find) the daemon `command` manages, once per process; a failure is retried on the next call. */
function daemon(command: string): Promise<DaemonStatus> {
	let started = daemons.get(command);
	if (!started) {
		started = startDaemon(command);
		started.catch(() => daemons.delete(command));
		daemons.set(command, started);
	}
	return started;
}

/** Run `command --json start` and check the daemon speaks this client's protocol. */
async function startDaemon(command: string): Promise<DaemonStatus> {
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn([command, "--json", "start"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
	const status = JSON.parse(stdout) as DaemonStatus;
	if (status.version !== PROTOCOL_VERSION || !status.socket) {
		throw new Error(
			`${command} speaks admin protocol ${status.version}; omp needs ${PROTOCOL_VERSION}: update ovnfs`,
		);
	}
	return status;
}

/** Encode one protocol frame. */
function frame(value: object): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}

/** One operation on its own connection to the daemon at `socket`. */
function callSocket<T>(socket: string, op: string, args: object): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const conn = net.createConnection({ path: socket });
	let buffered = Buffer.alloc(0);
	let welcomed = false;
	let settled = false;
	const settle = (fn: () => void) => {
		if (settled) return;
		settled = true;
		conn.destroy();
		fn();
	};
	conn.on("connect", () => conn.write(frame({ hello: { client: "omp" } })));
	conn.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		while (buffered.length >= 4) {
			const length = buffered.readUInt32LE(0);
			if (buffered.length < 4 + length) return;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
			} catch (err) {
				settle(() => reject(err));
				return;
			}
			buffered = buffered.subarray(4 + length);
			if (!welcomed) {
				const welcome = message.welcome as { version?: number; ops?: string[] } | undefined;
				if (welcome?.version !== PROTOCOL_VERSION || !welcome.ops?.includes(op)) {
					settle(() =>
						reject(new Error(`ovnfs at ${socket} does not serve ${op} on protocol ${PROTOCOL_VERSION}`)),
					);
					return;
				}
				welcomed = true;
				conn.write(frame({ id: 1, [op]: args }));
				continue;
			}
			if (message.id !== 1) continue; // events, or a reply to nothing this client sent
			const error = message.error as { code: string; message: string } | undefined;
			settle(() => (error ? reject(new OvnfsError(error.code, error.message)) : resolve(message.ok as T)));
			return;
		}
	});
	conn.on("error", err => settle(() => reject(err)));
	conn.on("close", () => settle(() => reject(new Error(`ovnfs at ${socket} closed the connection during ${op}`))));
	return promise;
}

/** One operation on the daemon `command` manages, starting it again once if it went away. */
async function call<T>(command: string, op: string, args: object): Promise<T> {
	const { socket } = await daemon(command);
	try {
		return await callSocket<T>(socket, op, args);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err;
		daemons.delete(command);
		return callSocket<T>((await daemon(command)).socket, op, args);
	}
}

/** A checkout name ovnfs accepts (`[a-z0-9][a-z0-9._-]{0,63}`), recognisable as this agent's, unique per run. */
function checkoutName(agentId: string): string {
	const stem = agentId
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, 40);
	const suffix = Math.floor(Math.random() * 2 ** 24)
		.toString(16)
		.padStart(6, "0");
	return `omp-${stem || "task"}-${suffix}`;
}

/** Remove a checkout; one already gone counts as removed. */
async function removeCheckout(command: string, checkout: string): Promise<void> {
	try {
		await call(command, "rm", { checkout });
	} catch (err) {
		if (!(err instanceof OvnfsError && err.code === "not_found")) throw err;
	}
}

/**
 * Remove the ovnfs checkout a task-isolation dir records and report whether it
 * recorded one. Throws when the checkout cannot be removed (the record then stays
 * for a later retry); `omp worktree clear` calls this before deleting the dir.
 */
export async function releaseOvnfsCheckout(dir: string): Promise<boolean> {
	let record: CheckoutRecord;
	try {
		record = (await Bun.file(path.join(dir, OVNFS_CHECKOUT_FILE)).json()) as CheckoutRecord;
	} catch {
		return false;
	}
	await removeCheckout(record.command, record.checkout);
	return true;
}

/** An open ovnfs checkout and the isolation dir recording it. */
class OvnfsWorkspace implements IsolationWorkspace {
	constructor(
		readonly dir: string,
		private baseDir: string,
		private readonly command: string,
		private readonly checkout: string,
	) {}

	/** The checkout stays where it is; its record leaves the deterministic slot so a later run with this id keeps it. */
	async retain(): Promise<RetainedWorkspace> {
		this.baseDir = (await vacateIsolationSlot(this.baseDir)) ?? this.baseDir;
		return { dir: this.dir, sidecarOk: true };
	}

	/** Remove the checkout, then its record; a checkout that cannot be removed keeps its record for `omp worktree clear`. */
	async cleanup(): Promise<void> {
		try {
			await removeCheckout(this.command, this.checkout);
		} catch (err) {
			logger.warn("ovnfs checkout removal failed; `omp worktree clear` retries it", {
				checkout: this.checkout,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		await fs.rm(this.baseDir, { recursive: true, force: true });
	}
}

/**
 * Workspaces that are ovnfs checkouts of the repository, opened through the ovnfs
 * executable `command`. Failures say what is wrong with ovnfs; there is no
 * silent fallback to native isolation.
 */
export function ovnfsWorkspace(command: string): OpenWorkspace {
	return async (repoRoot, agentId) => {
		const baseDir = taskIsolationBaseDir(repoRoot, agentId);
		// An earlier run with this id that died leaves its record here: release
		// its checkout before the slot is reused, or nothing would remember it.
		await releaseOvnfsCheckout(baseDir).catch(err =>
			logger.warn("releasing a stale ovnfs checkout failed", {
				dir: baseDir,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
		await fs.rm(baseDir, { recursive: true, force: true });
		await fs.mkdir(baseDir, { recursive: true });
		await writeIsolationOwner(baseDir, agentId);
		const checkout = checkoutName(agentId);
		try {
			// Recorded before the checkout exists, so a crash mid-creation still names it.
			const record: CheckoutRecord = { command, checkout };
			await Bun.write(path.join(baseDir, OVNFS_CHECKOUT_FILE), JSON.stringify(record));
			const reply = await call<NewReply>(command, "new", { dir: repoRoot, name: checkout });
			return new OvnfsWorkspace(reply.checkout.path, baseDir, command, checkout);
		} catch (err) {
			await fs.rm(baseDir, { recursive: true, force: true });
			throw new Error(
				`ovnfs isolation failed: ${err instanceof Error ? err.message : String(err)} (turn off ovnfs.enabled to use native isolation)`,
			);
		}
	};
}
