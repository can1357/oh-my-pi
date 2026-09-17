import * as fs from "node:fs/promises";
import path from "node:path";
import type { JobExecutorContext } from "./runner";
import type { OperationalStore } from "./store";

interface LockOwner {
	jobId: string;
	leaseOwner: string;
}

async function readOwner(lockPath: string): Promise<LockOwner> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
		if (
			value &&
			typeof value.jobId === "string" &&
			value.jobId &&
			typeof value.leaseOwner === "string" &&
			value.leaseOwner
		)
			return { jobId: value.jobId, leaseOwner: value.leaseOwner };
	} catch {
		/* Missing/malformed metadata is never a stealable lock. */
	}
	throw new Error("Recovery requires reconciliation: integration lock owner is missing or malformed.");
}

export async function acquireNativeTaskIntegrationLock(options: {
	store: OperationalStore;
	artifactsDir: string;
	repoRoot: string;
	ctx: JobExecutorContext;
}): Promise<() => Promise<void>> {
	const { store, ctx, artifactsDir } = options;
	const canonical = await fs.realpath(options.repoRoot);
	const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
	const key = new Bun.CryptoHasher("sha256").update(normalized).digest("hex");
	const parent = path.join(artifactsDir, "integration-locks");
	const lockPath = path.join(parent, key);
	const owner = { jobId: ctx.job.id, leaseOwner: ctx.job.leaseOwner };
	if (!owner.leaseOwner) throw new Error("Native task integration requires a lease owner.");
	await fs.mkdir(parent, { recursive: true });
	for (;;) {
		ctx.signal.throwIfAborted();
		if (!ctx.heartbeat()) throw new Error("Native task lost its execution lease.");
		try {
			await fs.mkdir(lockPath);
			await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx" });
			break;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
		let currentOwner: LockOwner;
		try {
			currentOwner = await readOwner(lockPath);
		} catch (error) {
			// A completed owner atomically retires its directory before deleting metadata.
			// Only a disappeared directory is a retry; a present malformed lock reconciles.
			try {
				await fs.stat(lockPath);
			} catch (statError) {
				if (statError instanceof Error && "code" in statError && statError.code === "ENOENT") continue;
				throw statError;
			}
			throw error;
		}
		const job = store.getJob(currentOwner.jobId);
		const checkpoint = store.getCheckpoint(currentOwner.jobId)?.data;
		const live =
			job?.status === "running" &&
			job.leaseOwner === currentOwner.leaseOwner &&
			(job.leaseExpiresAt ?? 0) > Date.now();
		if (!live) {
			if (
				checkpoint &&
				!Array.isArray(checkpoint) &&
				typeof checkpoint === "object" &&
				checkpoint.phase === "integrating"
			) {
				throw new Error("Recovery requires reconciliation: prior integration may have mutated the repository.");
			}
			// Elect one stale-lock reaper; recheck current metadata/store after acquiring it.
			try {
				await fs.mkdir(path.join(lockPath, "reaping"));
			} catch (error) {
				if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EEXIST")) {
					await Bun.sleep(25);
					continue;
				}
				throw error;
			}
			const verified = await readOwner(lockPath);
			const latest = store.getJob(verified.jobId);
			const latestCheckpoint = store.getCheckpoint(verified.jobId)?.data;
			if (
				latestCheckpoint &&
				!Array.isArray(latestCheckpoint) &&
				typeof latestCheckpoint === "object" &&
				latestCheckpoint.phase === "integrating"
			)
				throw new Error("Recovery requires reconciliation: interrupted integration lock.");
			if (
				latest?.status === "running" &&
				latest.leaseOwner === verified.leaseOwner &&
				(latest.leaseExpiresAt ?? 0) > Date.now()
			) {
				await fs.rmdir(path.join(lockPath, "reaping"));
			} else {
				const retired = `${lockPath}.retired-${crypto.randomUUID()}`;
				await fs.rename(lockPath, retired);
				await fs.rm(retired, { recursive: true });
				continue;
			}
		}
		await new Promise<void>((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				ctx.signal.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				clearTimeout(timer);
				reject(ctx.signal.reason ?? new Error("Aborted"));
			};
			const timer = setTimeout(done, 25);
			ctx.signal.addEventListener("abort", abort, { once: true });
		});
	}
	return async () => {
		const current = await readOwner(lockPath);
		if (current.jobId !== owner.jobId || current.leaseOwner !== owner.leaseOwner)
			throw new Error("Recovery requires reconciliation: integration lock ownership changed.");
		const retired = `${lockPath}.retired-${crypto.randomUUID()}`;
		await fs.rename(lockPath, retired);
		await fs.rm(retired, { recursive: true });
	};
}
