import * as fs from "node:fs";
import * as path from "node:path";

/** Session file injected into the replacement process during an automatic handoff. */
export const AUTO_RESTART_SESSION_FILE_ENV = "OMP_AUTO_RESTART_SESSION_FILE";
/** Process id of the handoff parent, so only its direct replacement accepts the session file. */
export const AUTO_RESTART_PARENT_PID_ENV = "OMP_AUTO_RESTART_PARENT_PID";
/** Optional stable launcher path supplied by wrappers that need custom Bun preloads. */
export const AUTO_RESTART_COMMAND_ENV = "OMP_AUTO_RESTART_COMMAND";
/** Optional additional artifact path for a wrapper or package manager to monitor. */
export const AUTO_RESTART_WATCH_PATH_ENV = "OMP_AUTO_RESTART_WATCH_PATH";

/** Environment entries that hand one persisted session to a replacement process. */
export function autoRestartHandoffEnv(sessionFile: string, parentPid: number): Record<string, string> {
	return {
		[AUTO_RESTART_SESSION_FILE_ENV]: sessionFile,
		[AUTO_RESTART_PARENT_PID_ENV]: String(parentPid),
	};
}

/**
 * Take the one-shot handoff token addressed to this process. The token travels
 * in the environment, which every descendant of the replacement inherits, so it
 * is bound to the spawning process id: a nested `omp`, a tool subprocess, or a
 * long-lived daemon started from the replacement sees a token addressed to
 * someone else and must not be hijacked into resuming that session. Both keys
 * are removed either way so nothing further down the tree observes them.
 */
export function consumeAutoRestartHandoff(
	env: Record<string, string | undefined>,
	parentPid: number,
): string | undefined {
	const sessionFile = env[AUTO_RESTART_SESSION_FILE_ENV];
	const handoffParent = env[AUTO_RESTART_PARENT_PID_ENV];
	delete env[AUTO_RESTART_SESSION_FILE_ENV];
	delete env[AUTO_RESTART_PARENT_PID_ENV];
	if (!sessionFile) return undefined;
	return handoffParent === String(parentPid) ? sessionFile : undefined;
}

export interface AutoRestartProcess {
	argv: readonly string[];
	execPath: string;
	execArgv: readonly string[];
	env: Readonly<Record<string, string | undefined>>;
}

export interface AutoRestartableArgs {
	resume?: string | true;
	continue?: boolean;
	fork?: string;
	fromClaude?: boolean;
	fromCodex?: boolean;
	noSession?: boolean;
	messages: string[];
	fileArgs: string[];
}

/**
 * Force a new process to reopen the current persisted session without replaying
 * positional prompt or file arguments from the original launch.
 */
export function prepareAutoRestartArgs(args: AutoRestartableArgs, sessionFile: string): void {
	args.resume = sessionFile;
	args.continue = false;
	args.fork = undefined;
	args.fromClaude = false;
	args.fromCodex = false;
	args.noSession = false;
	args.messages = [];
	args.fileArgs = [];
}

/**
 * Build a direct argv for the replacement process. A wrapper can supply an
 * explicit command when it needs to recreate launch-time preloads. Compiled
 * Bun binaries have a virtual script path, which must never be passed back as
 * an executable argument.
 */
export function buildAutoRestartCommand(processInfo: AutoRestartProcess): string[] {
	const launchArgs = processInfo.argv.slice(2);
	const wrapper = processInfo.env[AUTO_RESTART_COMMAND_ENV]?.trim();
	if (wrapper) return [wrapper, ...launchArgs];

	const entry = processInfo.argv[1];
	if (entry && path.isAbsolute(entry) && !entry.startsWith("/$bunfs/")) {
		return [processInfo.execPath, ...processInfo.execArgv, entry, ...launchArgs];
	}
	return [processInfo.execPath, ...launchArgs];
}

/**
 * A replacement process launched during an automatic executable handoff.
 */
export interface AutoRestartChild {
	exited: Promise<number>;
}

/**
 * Keep the handoff parent alive until its replacement exits. The shell remains
 * an external parent of the foreground process group, so the replacement can
 * change terminal attributes without tcsetattr() failing with EIO.
 */
export async function handoffAutoRestart(
	spawn: () => AutoRestartChild,
	quit: (exitCode: number) => Promise<void>,
): Promise<void> {
	const child = spawn();
	await quit(await child.exited);
}

/**
 * Return real on-disk artifacts whose replacement means the current process is
 * stale. Virtual Bun entrypoints have no host file and are intentionally omitted.
 */
export function defaultAutoRestartWatchPaths(
	processInfo: Pick<AutoRestartProcess, "argv" | "execPath" | "env">,
): string[] {
	const candidates = [processInfo.execPath, processInfo.argv[1], processInfo.env[AUTO_RESTART_WATCH_PATH_ENV]];
	return [
		...new Set(
			candidates.filter((candidate): candidate is string => Boolean(candidate && path.isAbsolute(candidate))),
		),
	].filter(candidate => !candidate.startsWith("/$bunfs/"));
}

export async function fingerprintExecutable(pathname: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.stat(pathname);
		if (!stat.isFile()) return undefined;
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
}

export interface ExecutableUpdateMonitorOptions {
	paths: readonly string[];
	isEnabled: () => boolean;
	onUpdate: () => void;
	snapshot?: (pathname: string) => Promise<string | undefined>;
	intervalMs?: number;
}

/**
 * Detect a completed replacement of the process image or entrypoint. A changed
 * fingerprint must appear twice before it is accepted, so an in-place build
 * cannot restart a session against a partially written executable.
 */
export class ExecutableUpdateMonitor {
	readonly #paths: readonly string[];
	readonly #isEnabled: () => boolean;
	readonly #onUpdate: () => void;
	readonly #snapshot: (pathname: string) => Promise<string | undefined>;
	readonly #intervalMs: number;
	#baseline: readonly (string | undefined)[] | undefined;
	#candidate: readonly (string | undefined)[] | undefined;
	#timer: NodeJS.Timeout | undefined;
	#polling = false;
	#updatePending = false;

	constructor(options: ExecutableUpdateMonitorOptions) {
		this.#paths = [...new Set(options.paths)];
		this.#isEnabled = options.isEnabled;
		this.#onUpdate = options.onUpdate;
		this.#snapshot = options.snapshot ?? fingerprintExecutable;
		this.#intervalMs = options.intervalMs ?? 1_000;
	}

	get updatePending(): boolean {
		return this.#updatePending;
	}

	async prime(): Promise<void> {
		if (!this.#isEnabled() || this.#paths.length === 0) return;
		this.#baseline = await this.#capture();
		this.#candidate = undefined;
	}

	start(): void {
		if (this.#timer || this.#updatePending || this.#paths.length === 0) return;
		this.#timer = setInterval(() => void this.poll(), this.#intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async poll(): Promise<void> {
		if (this.#polling || this.#updatePending) return;
		this.#polling = true;
		try {
			if (!this.#isEnabled()) {
				this.#baseline = undefined;
				this.#candidate = undefined;
				return;
			}
			const next = await this.#capture();
			if (!this.#baseline) {
				this.#baseline = next;
				return;
			}
			if (sameFingerprintSet(next, this.#baseline)) {
				this.#candidate = undefined;
				return;
			}
			if (!sameFingerprintSet(next, this.#candidate)) {
				this.#candidate = next;
				return;
			}
			this.#updatePending = true;
			this.stop();
			this.#onUpdate();
		} finally {
			this.#polling = false;
		}
	}

	async #capture(): Promise<readonly (string | undefined)[]> {
		return await Promise.all(this.#paths.map(pathname => this.#snapshot(pathname)));
	}
}

function sameFingerprintSet(
	left: readonly (string | undefined)[] | undefined,
	right: readonly (string | undefined)[] | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}
