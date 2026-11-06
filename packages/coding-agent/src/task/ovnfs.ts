/**
 * ovnfs checkouts as isolated subagent workspaces, used when `isolation.backend`
 * is auto and the ovnfs binary is found.
 *
 * Instead of cloning the repository, an isolated run works in an ovnfs checkout: a
 * copy-on-write view of the repository served by the ovnfs daemon, ready in
 * about a second whatever the checkout's size, with its own private git dir.
 * Capture and merge are unchanged: the runner diffs and commits the checkout like
 * a native copy, and the checkout is removed when the run ends (or kept, like a
 * native workspace, when its changes could not be captured).
 *
 * `ovnfs start --json` makes sure the daemon runs and reports its admin
 * socket; checkouts are then opened (`new`) and removed (`rm`) over that socket
 * (protocol: {@link callSocket}).
 *
 * Each workspace keeps a record of its checkout ({@link OVNFS_CHECKOUT_FILE}) in the
 * run's task-isolation dir, beside the owner marker, so `omp worktree clear`
 * removes the checkouts of runs that crashed ({@link releaseOvnfsCheckout}).
 *
 * @example
 * // Picked by the task runner when ovnfs is found and `isolation.backend` is auto:
 * const open = ovnfsWorkspace("/work/ovnfs/bin/ovnfs");
 * const workspace = await open(repoRoot, "AuthRefactor"); // workspace.dir: /work/.tree/agents/omp-authrefactor-1a2b3c
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { callSocket, OvnfsError } from "../ovnfs/client";
import { forgetDaemon, startDaemon } from "../ovnfs/daemon";
import type { IsolationWorkspace, OpenWorkspace, RetainedWorkspace } from "./isolation-runner";
import { vacateIsolationSlot } from "./isolation-runner";
import { writeIsolationOwner } from "./isolation-ownership";
import { taskIsolationBaseDir } from "./worktree";

/** Record of the checkout an isolation dir stands for. */
export const OVNFS_CHECKOUT_FILE = ".omp-ovnfs-checkout.json";

/** Contents of {@link OVNFS_CHECKOUT_FILE}. */
interface CheckoutRecord {
	/** ovnfs executable that opened the checkout (it can start the daemon again). */
	command: string;
	checkout: string;
}

/** The checkout part of ovnfs's `new` reply. */
interface NewReply {
	checkout: { name: string; path: string };
}

/** One operation on the daemon `command` manages, starting it again once if it went away. */
async function call<T>(command: string, op: string, args: object): Promise<T> {
	const { socket } = await startDaemon(command);
	try {
		return await callSocket<T>(socket, op, args);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err;
		forgetDaemon(command);
		return callSocket<T>((await startDaemon(command)).socket, op, args);
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
				`ovnfs isolation failed: ${err instanceof Error ? err.message : String(err)} (set isolation.backend to a native backend to bypass ovnfs)`,
			);
		}
	};
}
