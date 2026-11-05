/**
 * Background self-update (`update.auto`).
 *
 * An interactive launch hands its update check to {@link runAutoUpdate}. When
 * the check finds a newer release, the launch spawns a detached worker
 * (`__omp_worker_auto_update`) that installs it exactly as `omp update` would,
 * through whatever owns the install (build-service binary, bun, npm, Homebrew,
 * mise), while the launch shows the progress after the welcome banner's version
 * label. The worker outlives the session, so quitting mid-download never
 * strands a half-run package manager; the next launch simply starts the new
 * build.
 *
 * One status file (`~/.omp/update/auto-update.json`) connects them. Only the
 * worker holding its lock writes it, and the OS drops that lock when the worker
 * exits, so "lock held" is how any launch knows a worker is running: it follows
 * that worker instead of starting another, and reads the outcome once the lock
 * is free. A finished attempt at a version holds off the next attempt at it for
 * {@link RETRY_AFTER_MS}; meanwhile a failed one falls back to the startup
 * notice.
 *
 * Running sessions keep their files: a binary install renames the running
 * `omp.exe` aside (Windows permits that for a mapped image, not an overwrite)
 * and leaves the backup to a later sweep, and the natives loader runs each
 * release's `.node` from a per-version copy under `~/.omp/natives/`, so bun and
 * npm can replace the `node_modules` copy an old session would otherwise lock.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VersionUpdate } from "@oh-my-pi/pi-tui/prompt/welcome";
import {
	APP_NAME,
	compareVersions,
	getUpdateStateDir,
	isEnoent,
	isFileLockHeld,
	isRecord,
	logger,
	tryAcquireFileLock,
	VERSION,
} from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { spawnDetached } from "../subprocess/shared-worker";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import {
	canSelfUpdate,
	runUpdateCommand,
	type UpdateOutcome,
	type UpdateProgress,
	verifyInstalledVersion,
} from "./update-cli";
import { AUTO_UPDATE_WORKER_ARG } from "./worker-selectors";

/** Env var carrying the version the spawning launch's check offered. */
const TARGET_ENV = "OMP_AUTO_UPDATE_TARGET";

/** How often a launch re-reads the status file while a worker runs. */
const POLL_MS = 250;

/** Least time between two progress writes in the same phase. */
const PROGRESS_WRITE_MS = 200;

/** A finished attempt at a version holds off the next attempt at that version this long. */
export const RETRY_AFTER_MS = 6 * 60 * 60_000;

/** Hard stop for a worker; a binary download alone gives up after 15 minutes. */
const WORKER_DEADLINE_MS = 30 * 60_000;

/** Worker phases; `done`, `current`, and `failed` end a run. */
export type AutoUpdatePhase = "checking" | "downloading" | "installing" | "done" | "current" | "failed";

/** Every worker phase, mapped to whether it ends a run. */
const PHASE_IS_FINAL: Record<AutoUpdatePhase, boolean> = {
	checking: false,
	downloading: false,
	installing: false,
	done: true,
	current: true,
	failed: true,
};

/** The worker's status file. */
export interface AutoUpdateState {
	phase: AutoUpdatePhase;
	/** Version the spawning launch's check offered; keys the retry hold-off. */
	target?: string;
	/** Version being installed, or (`done`) the version the PATH launcher now reports. */
	version?: string;
	/** Bytes downloaded so far of `total` (`downloading`). */
	received?: number;
	total?: number;
	/** Why the run failed. */
	error?: string;
	/** `Date.now()` at the write. */
	at: number;
}

/** A status write: everything but the stamp and the target, which the writer adds. */
type StateUpdate = Omit<AutoUpdateState, "at" | "target">;

/** Where {@link runAutoUpdate} reports. */
export interface AutoUpdateSinks {
	/** Show, or with `null` clear, the indicator after the welcome banner's version. */
	show(update: VersionUpdate | null): void;
	/** Fall back to the startup notice that tells the user to run `omp update`. */
	notify(version: string): void;
}

function statePath(): string {
	return path.join(getUpdateStateDir(), "auto-update.json");
}

function logPath(): string {
	return path.join(getUpdateStateDir(), "auto-update.log");
}

function isPhase(value: unknown): value is AutoUpdatePhase {
	return typeof value === "string" && Object.hasOwn(PHASE_IS_FINAL, value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Parse a status file; undefined when malformed (e.g. read mid-write). */
function parseState(text: string): AutoUpdateState | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || !isPhase(value.phase) || typeof value.at !== "number") return undefined;
	return {
		phase: value.phase,
		target: optionalString(value.target),
		version: optionalString(value.version),
		received: typeof value.received === "number" ? value.received : undefined,
		total: typeof value.total === "number" ? value.total : undefined,
		error: optionalString(value.error),
		at: value.at,
	};
}

/** The status file; undefined when absent, or unreadable while the worker rewrites it. */
async function readState(file: string): Promise<AutoUpdateState | undefined> {
	try {
		// node:fs rather than Bun.file: on Windows a rejected Bun.file read holds no loop handle (#13470).
		return parseState(await fs.readFile(file, "utf8"));
	} catch (err) {
		if (!isEnoent(err)) logger.debug("auto-update: status file unreadable", { file, error: String(err) });
		return undefined;
	}
}

/** What the welcome banner shows for a worker's `state`; null when nothing (no update, or no version to name). */
export function describeAutoUpdate(state: AutoUpdateState): VersionUpdate | null {
	const version = state.version ?? state.target;
	if (version === undefined) return null;
	switch (state.phase) {
		case "checking":
		case "installing":
			return { phase: "updating", version };
		case "downloading":
			return {
				phase: "updating",
				version,
				fraction: state.total ? (state.received ?? 0) / state.total : undefined,
			};
		case "done":
			return compareVersions(version, VERSION) > 0 ? { phase: "ready", version } : null;
		case "failed":
			return { phase: "failed", version };
		case "current":
			return null;
	}
}

/**
 * Whether a launch whose check offered `target` starts a worker, given the
 * status `last` left by the previous run: always for a new version, else once
 * that run is {@link RETRY_AFTER_MS} old, however it ended.
 */
export function shouldStartWorker(last: AutoUpdateState | undefined, target: string, now = Date.now()): boolean {
	if (last?.target !== target) return true;
	return now - last.at >= RETRY_AFTER_MS;
}

/**
 * Launch side of auto-update. Follows a worker another launch already runs;
 * otherwise, once `check` resolves to a newer version, starts a worker, unless
 * a recent attempt at that version finished: then it shows that attempt's
 * install as ready, or after a failure the startup notice. Where omp cannot
 * update itself (Tern, Nix, a source checkout) the check only feeds the notice.
 * Resolves when the worker ends or nothing needs doing; never throws.
 */
export async function runAutoUpdate(check: Promise<string | undefined>, sinks: AutoUpdateSinks): Promise<void> {
	try {
		if (!(await canSelfUpdate())) {
			const version = await check;
			if (version) sinks.notify(version);
			return;
		}
		const file = statePath();
		if (isFileLockHeld(file)) return await follow(file, sinks);
		const target = await check;
		// Another launch may have started a worker while this one was checking.
		if (isFileLockHeld(file)) return await follow(file, sinks);
		if (!target) return;
		const last = await readState(file);
		if (last && !shouldStartWorker(last, target)) {
			const shown = describeAutoUpdate(last);
			if (shown?.phase === "ready") sinks.show(shown);
			else if (last.phase !== "current") sinks.notify(target);
			return;
		}
		await fs.mkdir(path.dirname(file), { recursive: true });
		const { cmd, cwd } = resolveWorkerSpawnCmd(AUTO_UPDATE_WORKER_ARG);
		// Appending: a worker that loses the start race to a live one must not clobber its log.
		const { proc } = spawnDetached(cmd, cwd, workerEnvFromParent({ [TARGET_ENV]: target }), logPath(), {
			append: true,
		});
		await follow(file, sinks, { target, worker: proc });
	} catch (err) {
		logger.warn("auto-update: stopped", { error: err instanceof Error ? err.message : String(err) });
	}
}

/** A worker this launch spawned, with the version its check offered. */
interface SpawnedWorker {
	target: string;
	worker: Subprocess;
}

/**
 * Mirror the running worker's status into `sinks` until its lock is free (and
 * the worker this launch spawned, if any, has exited), then show how the run
 * ended. A run that ended without a final status (killed, crashed) shows as
 * failed; a failure also gets the startup notice, since the banner may have
 * scrolled into history or be hidden (`startup.quiet`).
 */
async function follow(file: string, sinks: AutoUpdateSinks, spawned?: SpawnedWorker): Promise<void> {
	const since = Date.now();
	let exited = spawned === undefined;
	void spawned?.worker.exited.then(() => {
		exited = true;
	});
	let live = false;
	let shown: string | undefined;
	const show = (update: VersionUpdate | null): void => {
		const key = JSON.stringify(update);
		if (key === shown) return;
		shown = key;
		sinks.show(update);
	};
	if (spawned) show({ phase: "updating", version: spawned.target });
	// The worker stops itself at its deadline; the margin covers its final write.
	while (Date.now() - since < WORKER_DEADLINE_MS + 60_000) {
		const held = isFileLockHeld(file);
		// Free lock and no spawned worker still starting up: the run is over.
		if (!held && exited) break;
		const state = held ? await readState(file) : undefined;
		// Under a held lock a final status is either the previous run's (the
		// worker has not written yet) or this run's just before release.
		if (state && !PHASE_IS_FINAL[state.phase]) {
			live = true;
			show(describeAutoUpdate(state));
		}
		await Bun.sleep(POLL_MS);
	}
	const final = await readState(file);
	let outcome: VersionUpdate | null;
	if (final && PHASE_IS_FINAL[final.phase] && (live || final.at >= since)) {
		outcome = describeAutoUpdate(final);
	} else if (live || spawned) {
		const version = final?.version ?? final?.target ?? spawned?.target;
		outcome = version === undefined ? null : { phase: "failed", version };
	} else {
		return;
	}
	show(outcome);
	if (outcome?.phase === "failed") sinks.notify(outcome.version);
}

/** Serialized status writes with download progress throttled; only the lock holder makes them. */
class StatusWriter {
	#queue: Promise<void> = Promise.resolve();
	#phase: AutoUpdatePhase | undefined;
	#writtenAt = 0;
	/** Version the install reported last, kept for a failure that names none. */
	version: string | undefined;

	constructor(
		private readonly file: string,
		private readonly target: string | undefined,
	) {}

	put(update: StateUpdate): Promise<void> {
		const state: AutoUpdateState = { ...update, target: this.target, at: Date.now() };
		this.#phase = state.phase;
		this.#writtenAt = state.at;
		const text = JSON.stringify(state);
		this.#queue = this.#queue
			.then(() => Bun.write(this.file, text))
			.then(
				() => {},
				err => logger.warn("auto-update: status write failed", { error: String(err) }),
			);
		return this.#queue;
	}

	progress(progress: UpdateProgress): void {
		this.version = progress.version;
		const complete = progress.phase === "downloading" && progress.received >= progress.total;
		if (progress.phase === this.#phase && !complete && Date.now() - this.#writtenAt < PROGRESS_WRITE_MS) return;
		void this.put(progress);
	}
}

/** The final status for `outcome`; an install counts once the PATH launcher reports a version newer than this build. */
async function settle(outcome: UpdateOutcome): Promise<StateUpdate> {
	switch (outcome.kind) {
		case "current":
		case "available":
			return { phase: "current" };
		case "unsupported":
			return { phase: "failed", error: outcome.reason };
		case "installed": {
			const { actual, path: launcher } = await verifyInstalledVersion(outcome.version);
			if (actual !== undefined && compareVersions(actual, VERSION) > 0) return { phase: "done", version: actual };
			return {
				phase: "failed",
				version: outcome.version,
				error: `${launcher ?? APP_NAME} still reports ${actual ?? "no version"}`,
			};
		}
	}
}

/**
 * Worker entry (`__omp_worker_auto_update`): install the newest release the
 * way `omp update` would, mirroring progress into the status file, and record
 * the outcome. Exits at once when another worker holds the status lock.
 */
export async function runAutoUpdateWorker(): Promise<never> {
	const file = statePath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	const lock = tryAcquireFileLock(file);
	if (!lock) process.exit(0);
	// Launches open the log for appending; the run that owns the lock starts it afresh.
	await fs.truncate(logPath(), 0).catch(() => {});
	const writer = new StatusWriter(file, process.env[TARGET_ENV] || undefined);
	const finish = async (update: StateUpdate): Promise<never> => {
		await writer.put(update);
		// stdout is the worker log (`auto-update.log`), after `omp update`'s own output.
		console.log(["auto-update:", update.phase, update.version, update.error].filter(Boolean).join(" "));
		lock.release();
		process.exit(update.phase === "failed" ? 1 : 0);
	};
	const deadline = setTimeout(() => {
		void finish({
			phase: "failed",
			version: writer.version,
			error: `gave up after ${WORKER_DEADLINE_MS / 60_000} minutes`,
		});
	}, WORKER_DEADLINE_MS);
	await writer.put({ phase: "checking" });
	let final: StateUpdate;
	try {
		final = await settle(
			await runUpdateCommand({ force: false, check: false, onProgress: progress => writer.progress(progress) }),
		);
	} catch (err) {
		final = { phase: "failed", version: writer.version, error: err instanceof Error ? err.message : String(err) };
	}
	clearTimeout(deadline);
	return finish(final);
}
