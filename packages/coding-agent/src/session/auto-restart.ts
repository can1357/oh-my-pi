import * as fs from "node:fs";
import * as path from "node:path";

/** Optional additional artifact path for a wrapper or package manager to monitor. */
export const AUTO_RESTART_WATCH_PATH_ENV = "OMP_AUTO_RESTART_WATCH_PATH";

/** The parts of the running process that identify the artifacts worth watching. */
export interface AutoRestartProcess {
	argv: readonly string[];
	execPath: string;
	env: Readonly<Record<string, string | undefined>>;
}

/**
 * Return real on-disk artifacts whose replacement means the current process is
 * stale. Virtual Bun entrypoints have no host file and are intentionally omitted.
 */
export function defaultAutoRestartWatchPaths(processInfo: AutoRestartProcess): string[] {
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
