/**
 * Start-up recovery of task-isolation sandboxes whose owner is dead.
 *
 * A sandbox is removed by the run that made it, after that run has captured
 * its changes. A run that never gets there — omp crashed, was killed, the host
 * went down — leaves its sandbox and every child's behind, about a checkout's
 * worth of disk each, and nothing removed them but a user who knew to run
 * `omp worktree clear`, which deletes without saving anything.
 *
 * This sweep runs in the background once a session has started. It looks only
 * at sandboxes `omp worktree clear` would call reclaimable — the owner marker's
 * process provably gone, no live lease, no unfinished writer — and takes each
 * one's sandbox lock without waiting, so two starting omp processes never both
 * act on one. For each it measures the same exact delta the owner would have,
 * from the baseline the owner recorded:
 *
 * - nothing beyond the base, or only what the owner already delivered: the
 *   sandbox is removed by the removal `clear` uses;
 * - changes nobody captured: they are written under `<root>/.recovered/` as a
 *   patch and a sidecar, synced and renamed into place, and only then is the
 *   sandbox removed;
 * - a capture or a save that fails, or a sandbox with no recorded baseline:
 *   the sandbox stays, with the reason written into it for `omp worktree list`.
 *
 * Nothing is removed that is the only copy of someone's work.
 */
import * as fs from "./isolation-fs";
import * as path from "node:path";
import type { NestedRepoPatch } from "@oh-my-pi/pi-tui/tools/task";
import { acquireFileLock, getWorktreesDir, logger } from "@oh-my-pi/pi-utils";
import { removeIsolationSandbox } from "../cli/worktree-cli";
import {
	decideIsolationReclaim,
	ISOLATION_CLEARING_PREFIX,
	ISOLATION_OWNER_FILE,
	ISOLATION_RECOVERED_DIR,
	ISOLATION_REMOVING_SUFFIX,
	recordIsolationKept,
	resolveSandboxIdentity,
	runHoldingSandboxLock,
	tryAcquireSandboxLock,
} from "./isolation-ownership";
import {
	baselineFromRecord,
	captureDeltaPatch,
	deltaFingerprint,
	type IsolationBaselineRecord,
	readIsolationBaselineRecord,
} from "./worktree";

/** How many sandboxes one start looks at; the rest wait for the next start. */
const RECOVERY_MAX_ENTRIES = 64;
/** How long one start keeps starting new sandboxes before it leaves the rest to the next. */
const RECOVERY_BUDGET_MS = 120_000;
/** How long the sweep waits after start-up, so it does not compete with the first frame. */
const RECOVERY_START_DELAY_MS = 1_000;
/** Mount directories a sandbox's checkout can be under, current name first. */
const MERGED_DIR_NAMES = ["m", "merged"] as const;

/** Changes saved from one dead owner's sandbox. */
export interface RecoveredIsolationPatch {
	/** The root-repo patch. */
	patchPath: string;
	/** The sidecar describing whose work it is and how to apply it. */
	sidecarPath: string;
	/** One patch per nested repository that changed. */
	nestedPatchPaths: string[];
	/** The sandbox the changes came from, removed after they were saved. */
	from: string;
}

/** What one sweep did. */
export interface IsolationRecoveryReport {
	/** The worktree root that was swept. */
	root: string;
	/** Where recovered patches are saved. */
	recoveredDir: string;
	recovered: RecoveredIsolationPatch[];
	/** Sandboxes removed (with or without a recovered patch). */
	removed: string[];
	/** Dead owners' sandboxes kept, and why. */
	kept: Array<{ dir: string; reason: string }>;
	/** Sandboxes not looked at because the sweep reached its bound. */
	deferred: number;
}

/** The sidecar written beside each recovered patch. */
export interface RecoveredPatchSidecar {
	version: 1;
	sourceRepo: string;
	baseCommit: string;
	ownerSessionId?: string;
	taskId: string;
	branch?: string;
	recoveredFrom: string;
	recoveredAt: string;
	patch: string;
	nested: Array<{ relativePath: string; baseCommit: string; patch: string }>;
	apply: string;
}

export interface IsolationRecoveryOptions {
	/** Root to sweep; defaults to the configured worktree root. */
	root?: string;
	maxEntries?: number;
	budgetMs?: number;
	/** Clock for the patch names. */
	now?: () => Date;
}

/** Sweep the worktree root once. Never throws for one sandbox; each is decided on its own. */
export async function recoverDeadIsolations(options: IsolationRecoveryOptions = {}): Promise<IsolationRecoveryReport> {
	const root = options.root ?? getWorktreesDir();
	const report: IsolationRecoveryReport = {
		root,
		recoveredDir: path.join(root, ISOLATION_RECOVERED_DIR),
		recovered: [],
		removed: [],
		kept: [],
		deferred: 0,
	};
	const listing = await fs.readdirLookup(root);
	if (listing.kind === "absent") return report;
	if (listing.kind === "unknown") {
		logger.warn("isolation start-up recovery could not list the worktree root", { root, reason: listing.reason });
		return report;
	}
	const maxEntries = options.maxEntries ?? RECOVERY_MAX_ENTRIES;
	const deadline = Date.now() + (options.budgetMs ?? RECOVERY_BUDGET_MS);
	const now = options.now ?? (() => new Date());
	const candidates: string[] = [];
	for (const name of listing.value.sort()) {
		if (await isSandboxCandidate(root, name)) candidates.push(name);
	}
	let looked = 0;
	for (const name of candidates) {
		if (looked >= maxEntries || Date.now() >= deadline) {
			report.deferred = candidates.length - looked;
			break;
		}
		looked += 1;
		try {
			await recoverEntry(path.join(root, name), report, now);
		} catch (error) {
			// One sandbox's failure is that sandbox's: it is kept, and the
			// sweep goes on to the next.
			logger.warn("isolation start-up recovery could not decide a sandbox", {
				dir: path.join(root, name),
				error: errorMessage(error),
			});
		}
	}
	if (report.deferred > 0) {
		logger.warn("isolation start-up recovery reached its bound; the rest waits for the next start", {
			root,
			deferred: report.deferred,
		});
	}
	return report;
}

/** Whether `name` under `root` is a top-level task-isolation sandbox, by the marks `clear` uses. */
async function isSandboxCandidate(root: string, name: string): Promise<boolean> {
	if (name === ISOLATION_RECOVERED_DIR || name.startsWith(".")) return false;
	// Halfway through somebody's removal: the removal owns it.
	if (name.includes(ISOLATION_REMOVING_SUFFIX) || name.startsWith(ISOLATION_CLEARING_PREFIX)) return false;
	const dir = path.join(root, name);
	const stat = await fs.lstatLookup(dir);
	if (stat.kind !== "found" || !stat.value.isDirectory()) return false;
	// A PR checkout is a git worktree, not a sandbox.
	if ((await fs.lstatLookup(path.join(dir, ".git"))).kind !== "absent") return false;
	if ((await fs.lstatLookup(path.join(dir, ISOLATION_OWNER_FILE))).kind !== "absent") return true;
	for (const merged of MERGED_DIR_NAMES) {
		if ((await fs.lstatLookup(path.join(dir, merged))).kind !== "absent") return true;
	}
	return false;
}

/** Decide one sandbox, holding its lock if — and only if — nobody else does. */
async function recoverEntry(scanned: string, report: IsolationRecoveryReport, now: () => Date): Promise<void> {
	// Its identity, as everything that locks or removes a sandbox resolves it;
	// a name that leads out of the worktree root is refused there.
	const dir = await resolveSandboxIdentity(scanned);
	const lock = tryAcquireSandboxLock(dir);
	// Someone is building, tearing down, retaining or recovering it right now:
	// theirs to decide.
	if (!lock) return;
	try {
		await runHoldingSandboxLock(dir, lock, async () => await recoverHeld(dir, report, now));
	} finally {
		lock.release();
	}
}

async function recoverHeld(dir: string, report: IsolationRecoveryReport, now: () => Date): Promise<void> {
	// The decision `omp worktree clear` makes without `--all`, asked under the
	// lock: a live owner, a live lease, a writer, an unreadable marker or a
	// sandbox already kept for a reason all leave it alone.
	const decision = await decideIsolationReclaim(dir);
	if (!decision.reclaimable) return;
	// A sandbox its owner retired is one whose changes that owner captured
	// before it let go; what is left is a removal that did not finish.
	const marker = await fs.readJsonLookup(path.join(dir, ISOLATION_OWNER_FILE));
	if (marker.kind === "found" && isRecord(marker.value) && marker.value.retired === true) {
		await removeSandbox(dir, report);
		return;
	}
	const merged = await findMergedDir(dir);
	if (merged.kind === "unknown") {
		await keep(dir, report, `its checkout could not be read (${merged.reason})`);
		return;
	}
	// No checkout was ever made in it — a start that failed, or a test that
	// mocked the backend — so it cannot hold anybody's work.
	if (merged.kind === "absent") {
		await removeSandbox(dir, report);
		return;
	}
	const record = await readIsolationBaselineRecord(dir);
	if (record.kind === "absent") {
		await keep(
			dir,
			report,
			"no baseline was recorded for it (it predates start-up recovery), so its own changes cannot be told " +
				"from the ones it was copied with",
		);
		return;
	}
	if (record.kind === "unknown") {
		await keep(dir, report, `its baseline record could not be read (${record.reason})`);
		return;
	}
	let rootPatch: string;
	let nestedPatches: NestedRepoPatch[];
	try {
		({ rootPatch, nestedPatches } = await captureDeltaPatch(merged.value, baselineFromRecord(record.value)));
	} catch (error) {
		await keep(dir, report, `its changes could not be captured: ${errorMessage(error)}`);
		return;
	}
	const nothingNew =
		(rootPatch.trim().length === 0 && nestedPatches.length === 0) ||
		deltaFingerprint(rootPatch, nestedPatches) === record.value.deliveredFingerprint;
	if (!nothingNew) {
		let saved: RecoveredIsolationPatch;
		try {
			saved = await saveRecoveredPatch(dir, record.value, rootPatch, nestedPatches, report.recoveredDir, now());
		} catch (error) {
			await keep(dir, report, `its changes could not be saved to ${report.recoveredDir}: ${errorMessage(error)}`);
			return;
		}
		report.recovered.push(saved);
	}
	await removeSandbox(dir, report);
}

/** The sandbox's checkout directory, by the names a backend uses. */
async function findMergedDir(dir: string): Promise<fs.Lookup<string>> {
	for (const name of MERGED_DIR_NAMES) {
		const candidate = path.join(dir, name);
		const found = await fs.lstatLookup(candidate);
		if (found.kind === "absent") continue;
		if (found.kind === "unknown") return found;
		// A symlink there names something outside this sandbox; nothing is
		// captured through it, and nothing removes the sandbox on its account.
		if (!found.value.isDirectory()) return fs.UNKNOWN(`${candidate} is not a directory`);
		return fs.FOUND(candidate);
	}
	return fs.ABSENT;
}

async function removeSandbox(dir: string, report: IsolationRecoveryReport): Promise<void> {
	try {
		const removal = await removeIsolationSandbox(dir);
		if (removal.removed) report.removed.push(dir);
		else report.kept.push({ dir, reason: removal.reason });
	} catch (error) {
		report.kept.push({ dir, reason: `it could not be removed: ${errorMessage(error)}` });
	}
}

/** Keep the sandbox, saying why in it and in the report. */
async function keep(dir: string, report: IsolationRecoveryReport, reason: string): Promise<void> {
	report.kept.push({ dir, reason });
	logger.warn("isolation start-up recovery kept a dead owner's sandbox", { dir, reason });
	try {
		await recordIsolationKept(dir, reason);
	} catch (error) {
		logger.warn("isolation start-up recovery could not record why it kept a sandbox", {
			dir,
			error: errorMessage(error),
		});
	}
}

/**
 * Save one sandbox's delta under `recoveredDir`: every file written under a
 * temporary name and synced, then renamed into place — the sidecar last, so a
 * listed patch always has one — and the directory synced. Raises when any step
 * fails, after taking back what it had placed, so the caller keeps the tree.
 */
async function saveRecoveredPatch(
	from: string,
	record: IsolationBaselineRecord,
	rootPatch: string,
	nestedPatches: readonly NestedRepoPatch[],
	recoveredDir: string,
	at: Date,
): Promise<RecoveredIsolationPatch> {
	await fs.mkdir(recoveredDir, { recursive: true });
	// Names are chosen and taken under one lock, so two processes saving at
	// the same second for the same task cannot rename onto each other.
	const lock = await acquireFileLock(recoveredDir, { retries: 200, retryDelayMs: 50 });
	try {
		const stem = await freeStem(
			recoveredDir,
			`${fileSafe(record.ownerSessionId ?? "unknown-session")}-${fileSafe(record.branch ?? record.taskId)}-${utcStamp(at)}`,
		);
		const patchPath = path.join(recoveredDir, `${stem}.patch`);
		const sidecarPath = path.join(recoveredDir, `${stem}.json`);
		const nested = nestedPatches.map((entry, index) => ({
			entry,
			file: path.join(recoveredDir, `${stem}.nested-${index}-${fileSafe(entry.relativePath)}.patch`),
		}));
		const sidecar: RecoveredPatchSidecar = {
			version: 1,
			sourceRepo: record.sourceRepo,
			baseCommit: record.root.headCommit,
			...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId } : {}),
			taskId: record.taskId,
			...(record.branch ? { branch: record.branch } : {}),
			recoveredFrom: from,
			recoveredAt: at.toISOString(),
			patch: patchPath,
			nested: nested.map(({ entry, file }) => ({
				relativePath: entry.relativePath,
				baseCommit: record.nested.find(repo => repo.relativePath === entry.relativePath)?.headCommit ?? "",
				patch: file,
			})),
			apply:
				`cd ${record.sourceRepo} && git apply --3way ${patchPath} (the patch is against commit ` +
				`${record.root.headCommit} plus the uncommitted changes the checkout had when the task started)`,
		};
		// Patches first, the sidecar last: whoever lists the directory sees a
		// patch only once it is complete, and a sidecar only once all of them are.
		const files = [
			{ final: patchPath, contents: rootPatch },
			...nested.map(({ entry, file }) => ({ final: file, contents: entry.patch })),
			{ final: sidecarPath, contents: `${JSON.stringify(sidecar, null, 2)}\n` },
		].map(file => ({ ...file, temporary: `${file.final}.${process.pid}.tmp` }));
		const placed: string[] = [];
		try {
			for (const file of files) await fs.writeFileDurably(file.temporary, file.contents);
			for (const file of files) {
				await fs.rename(file.temporary, file.final);
				placed.push(file.final);
			}
			await fs.syncDirectory(recoveredDir);
		} catch (error) {
			await Promise.all(
				[...files.map(file => file.temporary), ...placed].map(file =>
					fs.rm(file, { force: true }).catch(() => undefined),
				),
			);
			throw error;
		}
		return { patchPath, sidecarPath, nestedPatchPaths: nested.map(({ file }) => file), from };
	} finally {
		lock.release();
	}
}

/** `stem`, or `stem-2`, `stem-3`, …: the first whose patch and sidecar are both free. */
async function freeStem(dir: string, stem: string): Promise<string> {
	for (let attempt = 1; ; attempt += 1) {
		const candidate = attempt === 1 ? stem : `${stem}-${attempt}`;
		const patch = await fs.lstatLookup(path.join(dir, `${candidate}.patch`));
		const sidecar = await fs.lstatLookup(path.join(dir, `${candidate}.json`));
		if (patch.kind === "unknown") throw new Error(`${candidate}.patch could not be read (${patch.reason})`);
		if (sidecar.kind === "unknown") throw new Error(`${candidate}.json could not be read (${sidecar.reason})`);
		if (patch.kind === "absent" && sidecar.kind === "absent") return candidate;
	}
}

/** `yyyymmddThhmmssZ` in UTC. */
function utcStamp(at: Date): string {
	return `${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** A name part with nothing a file name cannot hold. */
function fileSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "unnamed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One line for the user about a sweep that did something, or `undefined` when it did nothing. */
export function describeIsolationRecovery(
	report: IsolationRecoveryReport,
): { level: "info" | "warning"; message: string } | undefined {
	const parts: string[] = [];
	if (report.recovered.length > 0) {
		parts.push(
			`saved the uncaptured changes of ${count(report.recovered.length, "tree")} as patches in ${report.recoveredDir}`,
		);
	}
	const cleanRemovals = report.removed.length - report.recovered.length;
	if (cleanRemovals > 0) parts.push(`removed ${count(cleanRemovals, "tree")} with nothing left to save`);
	if (report.kept.length > 0) {
		parts.push(`kept ${count(report.kept.length, "tree")} it could not save (\`omp worktree list\` shows why)`);
	}
	if (parts.length === 0) return undefined;
	return {
		level: report.recovered.length > 0 || report.kept.length > 0 ? "warning" : "info",
		message: `Isolated task trees left by an omp that exited: ${parts.join("; ")}.`,
	};
}

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Run the sweep in the background, after a short delay, and tell the session
 * what it did. Never awaited by start-up: the first prompt does not wait for it.
 */
export function startIsolationRecovery(notify: (level: "info" | "warning", message: string) => void): void {
	void (async () => {
		await fs.sleep(RECOVERY_START_DELAY_MS);
		const report = await recoverDeadIsolations();
		const notice = describeIsolationRecovery(report);
		if (!notice) return;
		logger.warn(notice.message, {
			recovered: report.recovered.map(patch => patch.patchPath),
			removed: report.removed.length,
			kept: report.kept,
		});
		notify(notice.level, notice.message);
	})().catch(error => {
		logger.warn("isolation start-up recovery failed", { error: errorMessage(error) });
	});
}
