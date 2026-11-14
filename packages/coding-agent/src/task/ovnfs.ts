/**
 * ovnfs checkouts as isolated subagent workspaces, used when `isolation.backend`
 * is auto and the ovnfs binary is found.
 *
 * Instead of cloning the repository, an isolated run works in an ovnfs checkout: a
 * copy-on-write view of the repository served by the ovnfs daemon, ready in
 * milliseconds once the daemon has captured the folder, with its own private git
 * dir. The checkout's capture is the state the run started from, so no baseline
 * is taken when it opens: its patch is ovnfs's `diff` against that capture, and a
 * branch commit reads its baseline from a second checkout on the same capture
 * (`new {base}`), opened only then. A repository with nested repos or
 * submodules, or a daemon without those features, gets the runner's ordinary
 * baseline instead. The checkout is removed when the run ends (or kept, like a
 * native workspace, when its changes could not be captured).
 *
 * `ovnfs start --json` makes sure the daemon runs and reports its admin
 * socket; checkouts are then opened (`new`) and removed (`rm`) over that socket
 * (protocol: {@link callSocket}).
 *
 * Each workspace keeps a record of its checkout ({@link OVNFS_CHECKOUT_FILE}) in the
 * run's task-isolation dir, beside the owner marker, so `omp worktree clear`
 * removes the checkouts of runs that crashed ({@link releaseOvnfsCheckout}).
 * The record stays until removal is confirmed: a failed removal keeps it, and
 * reusing the slot moves it aside instead of deleting it.
 *
 * @example
 * // Picked by the task runner when ovnfs is found and `isolation.backend` is auto:
 * const open = ovnfsWorkspace("/work/ovnfs/bin/ovnfs");
 * const workspace = await open(repoRoot, "AuthRefactor"); // workspace.dir: /work/.tree/agents/omp-authrefactor-1a2b3c
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { callSocket, OvnfsError, socketFeatures } from "../ovnfs/client";
import { forgetDaemon, startDaemon } from "../ovnfs/daemon";
import type { IsolationWorkspace, OpenWorkspace, RetainedWorkspace, WorkspaceStart } from "./isolation-runner";
import { vacateIsolationSlot } from "./isolation-runner";
import { writeIsolationOwner } from "./isolation-ownership";
import { captureIsolationBaseline, taskIsolationBaseDir, type WorktreeBaseline } from "./worktree";

/** Record of the checkout an isolation dir stands for. */
export const OVNFS_CHECKOUT_FILE = ".omp-ovnfs-checkout.json";

/** Contents of {@link OVNFS_CHECKOUT_FILE}. */
interface CheckoutRecord {
	/** ovnfs executable that opened the checkout (it can start the daemon again). */
	command: string;
	checkout: string;
	/** The checkout on the same capture a branch commit reads its baseline from, while it exists. */
	start?: string;
}

/** The parts of ovnfs's `new` reply used here. */
interface NewReply {
	checkout: { name: string; path: string; base: string };
	/** How the folder was captured; absent for a checkout from a snapshot. */
	capture?: { root: string; repos: string[] | null };
}

/** The part of ovnfs's `diff` reply used here. */
interface DiffReply {
	patch?: string;
	/** Set by a daemon that wrote `patch` as `git diff --binary` does. */
	binary?: boolean;
}

/** Daemon features a checkout needs to keep its own starting state (`api.Features`). */
const START_FEATURES = ["new.base", "diff.binary"];

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
 * Remove every checkout `dir` records (`checkout` when it records none), then
 * delete `dir`. A removal that cannot be confirmed keeps `dir` and the checkout
 * record in it, so `omp worktree clear` can retry.
 */
async function releaseCheckoutRecord(dir: string, command: string, checkout: string): Promise<void> {
	try {
		if (!(await releaseOvnfsCheckout(dir))) await removeCheckout(command, checkout);
	} catch (err) {
		logger.warn("ovnfs checkout removal failed; `omp worktree clear` retries it", {
			dir,
			checkout,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}
	await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Remove the ovnfs checkouts a task-isolation dir records and report whether it
 * recorded one. Throws when a checkout cannot be removed (the record then stays
 * for a later retry); `omp worktree clear` calls this before deleting the dir.
 */
export async function releaseOvnfsCheckout(dir: string): Promise<boolean> {
	let record: CheckoutRecord;
	try {
		record = (await Bun.file(path.join(dir, OVNFS_CHECKOUT_FILE)).json()) as CheckoutRecord;
	} catch {
		return false;
	}
	if (record.start) await removeCheckout(record.command, record.start);
	await removeCheckout(record.command, record.checkout);
	return true;
}

/** Whether paths `a` and `b` name the same folder (case-insensitively on Windows). */
function sameFolder(a: string, b: string): boolean {
	const [x, y] = [path.resolve(a), path.resolve(b)];
	return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** An open ovnfs checkout and the isolation dir recording it. */
class OvnfsWorkspace implements IsolationWorkspace {
	readonly start?: WorkspaceStart;

	constructor(
		readonly dir: string,
		private baseDir: string,
		private readonly command: string,
		private readonly checkout: string,
		/** The checkout's capture when it is the run's starting state; then no baseline is taken at start. */
		capture: { base: string; repoRoot: string } | undefined,
	) {
		if (capture) {
			this.start = {
				rootPatch: () => this.#rootPatch(),
				baseline: () => this.#baseline(capture.base, capture.repoRoot),
			};
		}
	}

	/**
	 * The checkout's changes since its capture, as `git diff --binary` writes them;
	 * `undefined` when ovnfs leaves storing them to git (a filter, ident or encoding).
	 */
	async #rootPatch(): Promise<string | undefined> {
		let reply: DiffReply;
		try {
			reply = await call<DiffReply>(this.command, "diff", { checkout: this.checkout, binary: true });
		} catch (err) {
			if (err instanceof OvnfsError && err.code === "unsupported") return undefined;
			throw err;
		}
		if (!reply.binary) throw new Error("ovnfs diff did not return a git patch");
		return reply.patch ?? "";
	}

	/**
	 * Read the baseline the run started from in a second checkout on the same
	 * capture, recorded beside the first until it is removed again.
	 */
	async #baseline(base: string, repoRoot: string): Promise<WorktreeBaseline> {
		const start = `${this.checkout}-start`;
		const recordPath = path.join(this.baseDir, OVNFS_CHECKOUT_FILE);
		const record: CheckoutRecord = { command: this.command, checkout: this.checkout };
		await Bun.write(recordPath, JSON.stringify({ ...record, start }));
		// A start checkout an earlier, interrupted call left behind.
		await removeCheckout(this.command, start);
		try {
			const reply = await call<NewReply>(this.command, "new", { base, name: start });
			return await captureIsolationBaseline(reply.checkout.path, repoRoot);
		} finally {
			try {
				await removeCheckout(this.command, start);
				await Bun.write(recordPath, JSON.stringify(record));
			} catch (err) {
				logger.warn("ovnfs start checkout removal failed; `omp worktree clear` retries it", {
					checkout: start,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	/** The checkout stays where it is; its record leaves the deterministic slot so a later run with this id keeps it. */
	async retain(): Promise<RetainedWorkspace> {
		this.baseDir = (await vacateIsolationSlot(this.baseDir)) ?? this.baseDir;
		return { dir: this.dir, sidecarOk: true };
	}

	/** Remove the checkouts, then their record; a checkout that cannot be removed keeps the record for `omp worktree clear`. */
	async cleanup(): Promise<void> {
		await releaseCheckoutRecord(this.baseDir, this.command, this.checkout);
	}
}

/**
 * The checkout's capture when the run can start from it without a baseline: the
 * daemon serves the needed features, and the capture is of exactly `repoRoot`,
 * one repository without nested repos or submodules (their changes need patches
 * of their own).
 */
async function startingCapture(
	command: string,
	repoRoot: string,
	reply: NewReply,
): Promise<{ base: string; repoRoot: string } | undefined> {
	const capture = reply.capture;
	if (!capture || !sameFolder(capture.root, repoRoot)) return undefined;
	if (capture.repos?.length !== 1 || capture.repos[0] !== "") return undefined;
	const features = await socketFeatures((await startDaemon(command)).socket);
	if (!START_FEATURES.every(feature => features.has(feature))) return undefined;
	return { base: reply.checkout.base, repoRoot };
}

/**
 * Create task-isolation dir `baseDir` and report true, or report false when it
 * already exists (a previous run's slot, to release and empty first). One
 * `mkdir` in the usual case, where no run used the slot before.
 */
async function claimFreeSlot(baseDir: string): Promise<boolean> {
	try {
		await fs.mkdir(baseDir);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		if (code !== "ENOENT") throw err;
	}
	// The isolation root itself is missing.
	await fs.mkdir(path.dirname(baseDir), { recursive: true });
	return claimFreeSlot(baseDir);
}

/**
 * Workspaces that are ovnfs checkouts of the repository, opened through the ovnfs
 * executable `command`. Failures say what is wrong with ovnfs; there is no
 * silent fallback to native isolation.
 */
export function ovnfsWorkspace(command: string): OpenWorkspace {
	return async (repoRoot, agentId) => {
		const baseDir = taskIsolationBaseDir(repoRoot, agentId);
		if (!(await claimFreeSlot(baseDir))) {
			// A dead run with this id may still record a checkout. Reusing the slot
			// deletes that record, so a removal that fails has to move the record
			// and its owner marker aside first — or leave them and refuse the slot.
			try {
				await releaseOvnfsCheckout(baseDir);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const preserved = await vacateIsolationSlot(baseDir);
				if (!preserved) {
					logger.warn("releasing a stale ovnfs checkout failed", {
						dir: baseDir,
						error: message,
					});
					throw new Error(
						`ovnfs isolation failed: could not release the previous checkout (${message}); its record was kept for \`omp worktree clear\` (set isolation.backend to a native backend to bypass ovnfs)`,
					);
				}
				logger.warn("moved a stale ovnfs checkout record aside after removal failed", {
					dir: baseDir,
					preserved,
					error: message,
				});
			}
			await fs.rm(baseDir, { recursive: true, force: true });
			await fs.mkdir(baseDir, { recursive: true });
		}
		await writeIsolationOwner(baseDir, agentId);
		const checkout = checkoutName(agentId);
		// The record is written once the daemon is reachable and before `new`
		// returns, so a crash or a lost reply still names the checkout. It is
		// deleted only after removal is confirmed.
		let recorded = false;
		try {
			await startDaemon(command);
			const record: CheckoutRecord = { command, checkout };
			await Bun.write(path.join(baseDir, OVNFS_CHECKOUT_FILE), JSON.stringify(record));
			recorded = true;
			const reply = await call<NewReply>(command, "new", { dir: repoRoot, name: checkout });
			const capture = await startingCapture(command, repoRoot, reply);
			return new OvnfsWorkspace(reply.checkout.path, baseDir, command, checkout, capture);
		} catch (err) {
			// `exists` refused the name: that checkout predates this attempt, so
			// only the new local record goes — removing the checkout would
			// delete the older run's work.
			const refusedExisting = err instanceof OvnfsError && err.code === "exists";
			if (recorded && !refusedExisting) await releaseCheckoutRecord(baseDir, command, checkout);
			else await fs.rm(baseDir, { recursive: true, force: true });
			throw new Error(
				`ovnfs isolation failed: ${err instanceof Error ? err.message : String(err)} (set isolation.backend to a native backend to bypass ovnfs)`,
			);
		}
	};
}
