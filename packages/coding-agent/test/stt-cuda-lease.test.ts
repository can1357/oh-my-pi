import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CudaSttLease,
	type CudaLeaseHost,
	type CudaLeaseProcessIdentity,
	parseProcStatStartTime,
} from "@oh-my-pi/pi-coding-agent/stt/cuda-lease";

interface TestHost extends CudaLeaseHost {
	readonly killed: number[];
}

function identity(pid: number, startTimeTicks = pid * 100): CudaLeaseProcessIdentity {
	return { pid, startTimeTicks };
}

function owner(pid: number, busy = false): CudaLeaseProcessIdentity & { busy?: boolean } {
	return busy ? { ...identity(pid), busy: true } : identity(pid);
}

function createHost(pid: number, liveWorkers: Set<number>, busyWaitMs = 100): TestHost {
	const killed: number[] = [];
	return {
		pid,
		killed,
		busyWaitMs,
		getSttWorkerIdentity: async candidate => (liveWorkers.has(candidate) ? identity(candidate) : null),
		async killSttWorker(candidate) {
			const current = liveWorkers.has(candidate.pid) ? identity(candidate.pid) : null;
			if (!current || current.startTimeTicks !== candidate.startTimeTicks) return false;
			killed.push(candidate.pid);
			liveWorkers.delete(candidate.pid);
			return true;
		},
		wait: async () => {},
	};
}

describe("CUDA STT lease", () => {
	let cacheDir = "";

	beforeEach(async () => {
		cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stt-cuda-lease-"));
	});

	afterEach(async () => {
		await fs.rm(cacheDir, { recursive: true, force: true });
	});

	it("parses process start time when the proc stat command contains spaces and parentheses", () => {
		const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "987654", "0"];
		expect(parseProcStatStartTime(`321 (worker (cuda) name) ${fields.join(" ")}`)).toBe(987654);
		expect(parseProcStatStartTime("321 malformed")).toBeNull();
	});

	it("evicts the prior verified STT worker and transfers ownership to the latest claimant", async () => {
		const liveWorkers = new Set([101, 202]);
		const firstHost = createHost(101, liveWorkers);
		const secondHost = createHost(202, liveWorkers);
		const first = new CudaSttLease(cacheDir, firstHost);
		const second = new CudaSttLease(cacheDir, secondHost);

		expect(await first.claim()).toBe(true);
		expect(await second.claim()).toBe(true);
		expect(secondHost.killed).toEqual([101]);
		expect(await Bun.file(path.join(cacheDir, "stt-cuda-owner.json")).json()).toEqual(owner(202));

		await first.release();
		expect(await Bun.file(path.join(cacheDir, "stt-cuda-owner.json")).json()).toEqual(owner(202));
	});

	it("never terminates a legacy owner without a verified process incarnation", async () => {
		await Bun.write(path.join(cacheDir, "stt-cuda-owner.json"), JSON.stringify({ pid: 303 }));
		const liveWorkers = new Set([303, 404]);
		const host = createHost(404, liveWorkers);
		const lease = new CudaSttLease(cacheDir, host);

		expect(await lease.claim()).toBe(true);
		expect(host.killed).toEqual([]);
		expect(liveWorkers.has(303)).toBe(true);
		expect(await Bun.file(path.join(cacheDir, "stt-cuda-owner.json")).json()).toEqual(owner(404));
	});

	it("does not terminate a new STT worker that reused the recorded PID", async () => {
		const liveWorkers = new Set([101, 202]);
		const first = new CudaSttLease(cacheDir, createHost(101, liveWorkers));
		expect(await first.claim()).toBe(true);

		const secondHost = createHost(202, liveWorkers);
		secondHost.getSttWorkerIdentity = async candidate => {
			if (!liveWorkers.has(candidate)) return null;
			return candidate === 101 ? identity(101, 999_999) : identity(candidate);
		};
		const second = new CudaSttLease(cacheDir, secondHost);

		expect(await second.claim()).toBe(true);
		expect(secondHost.killed).toEqual([]);
		expect(liveWorkers.has(101)).toBe(true);
		expect(await Bun.file(path.join(cacheDir, "stt-cuda-owner.json")).json()).toEqual(owner(202));
	});

	it("treats an owner that vanishes before SIGKILL as already evicted", async () => {
		const liveWorkers = new Set([101, 202]);
		const first = new CudaSttLease(cacheDir, createHost(101, liveWorkers));
		expect(await first.claim()).toBe(true);

		const host = createHost(202, liveWorkers);
		host.killSttWorker = async candidate => {
			liveWorkers.delete(candidate.pid);
			const error = new Error("No such process") as NodeJS.ErrnoException;
			error.code = "ESRCH";
			throw error;
		};
		const second = new CudaSttLease(cacheDir, host);

		expect(await second.claim()).toBe(true);
		expect(await Bun.file(path.join(cacheDir, "stt-cuda-owner.json")).json()).toEqual(owner(202));
	});

	it("waits for a busy owner to finish before evicting", async () => {
		const liveWorkers = new Set([101, 202]);
		const firstHost = createHost(101, liveWorkers);
		const first = new CudaSttLease(cacheDir, firstHost);
		expect(await first.claim()).toBe(true);
		expect(await first.markBusy()).toBe(true);

		const ownerFile = path.join(cacheDir, "stt-cuda-owner.json");
		expect(await Bun.file(ownerFile).json()).toEqual(owner(101, true));

		let polls = 0;
		const secondHost = createHost(202, liveWorkers, 500);
		secondHost.wait = async () => {
			polls++;
			if (polls === 3) await first.markIdle();
		};
		const second = new CudaSttLease(cacheDir, secondHost);
		expect(await second.claim()).toBe(true);
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(secondHost.killed).toEqual([101]);
		expect(await Bun.file(ownerFile).json()).toEqual(owner(202));
	});

	it("falls back without evicting when a busy owner exceeds the wait deadline", async () => {
		const liveWorkers = new Set([101, 202]);
		const firstHost = createHost(101, liveWorkers);
		const first = new CudaSttLease(cacheDir, firstHost);
		expect(await first.claim(true)).toBe(true);

		const secondHost = createHost(202, liveWorkers);
		const second = new CudaSttLease(cacheDir, secondHost);
		expect(await second.claim()).toBe(false);
		expect(secondHost.killed).toEqual([]);
		expect(await Bun.file(path.join(cacheDir, "stt-cuda-owner.json")).json()).toEqual(owner(101, true));
	});

	it("makes state updates non-throwing when lease metadata becomes unavailable", async () => {
		const host = createHost(999, new Set([999]));
		const lease = new CudaSttLease(cacheDir, host);
		expect(await lease.claim()).toBe(true);

		await fs.rm(cacheDir, { recursive: true, force: true });
		await Bun.write(cacheDir, "not a directory");

		expect(await lease.markBusy()).toBe(false);
		expect(await lease.markIdle()).toBe(false);
	});

	it("resolves concurrent claims cleanly for three windows", async () => {
		const liveWorkers = new Set([10, 20, 30]);
		const host10 = createHost(10, liveWorkers);
		const host20 = createHost(20, liveWorkers);
		const host30 = createHost(30, liveWorkers);
		const lease10 = new CudaSttLease(cacheDir, host10);
		const lease20 = new CudaSttLease(cacheDir, host20);
		const lease30 = new CudaSttLease(cacheDir, host30);

		const results = await Promise.all([lease10.claim(), lease20.claim(), lease30.claim()]);
		expect(results).toEqual([true, true, true]);

		const finalOwner = (await Bun.file(
			path.join(cacheDir, "stt-cuda-owner.json"),
		).json()) as CudaLeaseProcessIdentity;
		expect([10, 20, 30]).toContain(finalOwner.pid);
		const totalKills = host10.killed.length + host20.killed.length + host30.killed.length;
		expect(totalKills).toBe(2);
		expect(liveWorkers.has(finalOwner.pid)).toBe(true);
		expect(liveWorkers.size).toBe(1);
	});
});
