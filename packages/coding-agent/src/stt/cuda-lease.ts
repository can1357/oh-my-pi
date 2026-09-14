import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import { STT_WORKER_ARG } from "./worker-config";
const POLL_MS = 25;
const BUSY_WAIT_MS = 15_000;
/**
 * Maximum time to wait for a killed worker to disappear from the process table.
 * If the OS takes longer than this to clean up the zombie process, the claim
 * fails and the new instance gracefully falls back to CPU execution.
 */
const EVICTION_WAIT_MS = 2_000;

export interface CudaLeaseProcessIdentity {
	pid: number;
	startTimeTicks: number;
}

interface CudaLeaseOwner extends CudaLeaseProcessIdentity {
	busy?: boolean;
}

export interface CudaLeaseHost {
	readonly pid: number;
	readonly busyWaitMs: number;
	getSttWorkerIdentity(pid: number): Promise<CudaLeaseProcessIdentity | null>;
	killSttWorker(owner: CudaLeaseProcessIdentity): Promise<boolean>;
	wait(ms: number): Promise<void>;
}

function sameProcess(left: CudaLeaseProcessIdentity, right: CudaLeaseProcessIdentity): boolean {
	return left.pid === right.pid && left.startTimeTicks === right.startTimeTicks;
}

/** Parse Linux `/proc/<pid>/stat` field 22 without splitting the parenthesized command name. */
export function parseProcStatStartTime(stat: string): number | null {
	const commandEnd = stat.lastIndexOf(") ");
	if (commandEnd < 0) return null;
	const fields = stat
		.slice(commandEnd + 2)
		.trim()
		.split(/\s+/);
	if (!/^[A-Za-z]$/.test(fields[0] ?? "")) return null;
	const rawStartTime = fields[19];
	if (!rawStartTime || !/^\d+$/.test(rawStartTime)) return null;
	const startTimeTicks = Number(rawStartTime);
	return Number.isSafeInteger(startTimeTicks) && startTimeTicks > 0 ? startTimeTicks : null;
}

async function readSttWorkerIdentity(pid: number): Promise<CudaLeaseProcessIdentity | null> {
	if (pid <= 1 || process.platform !== "linux") return null;
	try {
		const [stat, commandLine] = await Promise.all([
			Bun.file(`/proc/${pid}/stat`).text(),
			Bun.file(`/proc/${pid}/cmdline`).text(),
		]);
		if (!commandLine.split("\0").includes(STT_WORKER_ARG)) return null;
		const startTimeTicks = parseProcStatStartTime(stat);
		return startTimeTicks === null ? null : { pid, startTimeTicks };
	} catch {
		return null;
	}
}

const processHost: CudaLeaseHost = {
	pid: process.pid,
	busyWaitMs: BUSY_WAIT_MS,
	getSttWorkerIdentity: readSttWorkerIdentity,
	async killSttWorker(owner) {
		const current = await readSttWorkerIdentity(owner.pid);
		if (!current || !sameProcess(current, owner)) return false;
		try {
			// onnxruntime-node's finalizer can crash Bun. Match the existing
			// worker shutdown path and let the OS reclaim CUDA without running it.
			process.kill(owner.pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
		}
		return true;
	},
	wait: Bun.sleep,
};

async function readOwner(leasePath: string): Promise<CudaLeaseOwner | null> {
	try {
		const value = (await Bun.file(leasePath).json()) as Partial<CudaLeaseOwner>;
		if (
			!Number.isSafeInteger(value.pid) ||
			value.pid! <= 1 ||
			!Number.isSafeInteger(value.startTimeTicks) ||
			value.startTimeTicks! <= 0
		) {
			return null;
		}
		return { pid: value.pid!, startTimeTicks: value.startTimeTicks!, busy: !!value.busy };
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) return null;
		throw error;
	}
}

async function writeOwner(leasePath: string, owner: CudaLeaseOwner): Promise<void> {
	await Bun.write(leasePath, JSON.stringify(owner));
}

/**
 * Cross-process ownership for the CUDA-backed STT worker. The most recent
 * claimant evicts a verified idle STT worker before taking ownership. Busy
 * owners are allowed up to 15 seconds to finish; after that, the claimant
 * leaves them running and falls back to CPU.
 */
export class CudaSttLease {
	readonly #leasePath: string;
	readonly #host: CudaLeaseHost;
	#identity: CudaLeaseProcessIdentity | undefined;

	constructor(cacheDir: string, host: CudaLeaseHost = processHost) {
		this.#leasePath = path.join(cacheDir, "stt-cuda-owner.json");
		this.#host = host;
	}

	async claim(busy = false): Promise<boolean> {
		await fs.mkdir(path.dirname(this.#leasePath), { recursive: true, mode: 0o700 });
		const claimant = await this.#host.getSttWorkerIdentity(this.#host.pid);
		if (!claimant) return false;
		const busyDeadline = Date.now() + this.#host.busyWaitMs;
		for (;;) {
			const outcome = await withFileLock(this.#leasePath, async () => {
				const owner = await readOwner(this.#leasePath);
				if (owner && sameProcess(owner, claimant)) {
					if (busy && !owner.busy) await writeOwner(this.#leasePath, { ...claimant, busy: true });
					this.#identity = claimant;
					return "claimed";
				}
				if (owner && owner.pid !== claimant.pid) {
					const current = await this.#host.getSttWorkerIdentity(owner.pid);
					if (current && sameProcess(current, owner)) {
						if (owner.busy) return "busy";
						let evicted: boolean;
						try {
							evicted = await this.#host.killSttWorker(owner);
						} catch (error) {
							if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
							evicted = true;
						}
						if (evicted) {
							const evictionDeadline = Date.now() + EVICTION_WAIT_MS;
							while (Date.now() < evictionDeadline) {
								const observed = await this.#host.getSttWorkerIdentity(owner.pid);
								if (!observed || !sameProcess(observed, owner)) break;
								await this.#host.wait(POLL_MS);
							}
							const observed = await this.#host.getSttWorkerIdentity(owner.pid);
							if (observed && sameProcess(observed, owner)) return "unavailable";
						}
					}
				}
				await writeOwner(this.#leasePath, busy ? { ...claimant, busy: true } : claimant);
				this.#identity = claimant;
				return "claimed";
			});

			if (outcome === "claimed") return true;
			if (outcome === "unavailable" || Date.now() >= busyDeadline) return false;
			await this.#host.wait(Math.min(POLL_MS, busyDeadline - Date.now()));
		}
	}

	/** Mark this lease as busy (mid-transcription). Other instances will wait. */
	markBusy(): Promise<boolean> {
		return this.#writeBusyState(true);
	}

	/** Mark this lease as idle (transcription finished). */
	markIdle(): Promise<boolean> {
		return this.#writeBusyState(false);
	}

	async #writeBusyState(busy: boolean): Promise<boolean> {
		const identity = this.#identity;
		if (!identity) return false;
		try {
			return await withFileLock(this.#leasePath, async () => {
				const owner = await readOwner(this.#leasePath);
				if (!owner || !sameProcess(owner, identity)) return false;
				await writeOwner(this.#leasePath, busy ? { ...identity, busy: true } : identity);
				return true;
			});
		} catch {
			// Lease metadata is advisory. Never reject otherwise healthy STT
			// inference or replace a successfully computed transcript.
			return false;
		}
	}

	async release(): Promise<void> {
		const identity = this.#identity;
		if (!identity) return;
		await withFileLock(this.#leasePath, async () => {
			const owner = await readOwner(this.#leasePath);
			if (owner && sameProcess(owner, identity)) {
				await Bun.file(this.#leasePath).delete();
			}
			if (this.#identity === identity) this.#identity = undefined;
		});
	}
}
