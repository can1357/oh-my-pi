import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localDay } from "../src/dirs";
import { tryAcquireFileLock } from "../src/file-lock";
import { debug, setTransports } from "../src/logger";
import { __internalsForTesting, pruneStaleProcessLogs } from "../src/logger/prune";

const MAX_RETAINED_STALE_PROCESS_LOGS = 64;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	__internalsForTesting.setNativesLoader(undefined);
	vi.restoreAllMocks();
	setTransports({ console: false, file: false });
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

async function makeLogsDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-logger-prune-"));
	roots.push(dir);
	return dir;
}

function localDayBefore(base: Date, daysAgo: number): string {
	const date = new Date(base.getTime());
	date.setDate(date.getDate() - daysAgo);
	return localDay(date);
}

async function writeDatedLog(dir: string, name: string, mtimeSeconds: number): Promise<void> {
	const filePath = path.join(dir, name);
	await Bun.write(filePath, `${name}\n`);
	await fs.promises.utimes(filePath, mtimeSeconds, mtimeSeconds);
}

async function listProcessLogs(dir: string): Promise<string[]> {
	return (await fs.promises.readdir(dir)).filter(name => name.startsWith("omp.")).sort();
}

async function spawnSleepingChild(): Promise<number> {
	const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	cleanups.push(async () => {
		try {
			child.stdin.end();
		} catch {}
		try {
			child.kill();
		} catch {}
		await child.exited;
	});
	return child.pid;
}

function nextImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("pruneStaleProcessLogs", () => {
	it("preserves expired logs owned by the current PID or a live PID while removing dead expired logs without consuming retained slots", async () => {
		const logsDir = await makeLogsDir();
		const now = new Date("2026-06-15T12:00:00");
		const today = localDayBefore(now, 0);
		const expiredDay = localDayBefore(now, 5);
		const liveChildPid = await spawnSleepingChild();
		const expiredDeadPid = 9_100_001;

		const liveExpiredLogs = [
			`omp.${expiredDay}.${process.pid}.log`,
			`omp.${expiredDay}.${liveChildPid}.log`,
			`omp.${expiredDay}.${liveChildPid}.log.1`,
		];
		for (const name of liveExpiredLogs) {
			await writeDatedLog(logsDir, name, 1);
		}
		await writeDatedLog(logsDir, `omp.${expiredDay}.${expiredDeadPid}.log`, 10_000);
		await writeDatedLog(logsDir, `omp.${expiredDay}.${expiredDeadPid}.log.1`, 10_000);

		const inWindowExpected: string[] = [];
		for (let i = 0; i < MAX_RETAINED_STALE_PROCESS_LOGS; i++) {
			const name = `omp.${today}.${9_200_000 + i}.log`;
			inWindowExpected.push(name);
			await writeDatedLog(logsDir, name, 1_000 + i);
		}

		const probedPids: number[] = [];
		const realKill = process.kill.bind(process);
		spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			probedPids.push(pid);
			return realKill(pid, signal);
		}) as typeof process.kill);

		pruneStaleProcessLogs(logsDir, { now, force: true });

		expect(probedPids).not.toContain(process.pid);
		expect(probedPids.filter(pid => pid === liveChildPid)).toHaveLength(1);
		expect(probedPids.filter(pid => pid === expiredDeadPid)).toHaveLength(1);
		expect(await listProcessLogs(logsDir)).toEqual([...liveExpiredLogs, ...inWindowExpected].sort());
	});

	it("preserves future-dated logs owned by the current PID or a live PID while removing dead future-dated logs", async () => {
		const logsDir = await makeLogsDir();
		const now = new Date("2026-06-15T20:00:00");
		const today = localDayBefore(now, 0);
		const tomorrow = localDayBefore(now, -1);
		const liveChildPid = await spawnSleepingChild();
		const futureDeadPid = 9_150_001;

		const liveFutureLogs = [
			`omp.${tomorrow}.${process.pid}.log`,
			`omp.${tomorrow}.${liveChildPid}.log`,
			`omp.${tomorrow}.${liveChildPid}.log.1`,
		];
		for (const name of liveFutureLogs) {
			await writeDatedLog(logsDir, name, 1);
		}
		await writeDatedLog(logsDir, `omp.${tomorrow}.${futureDeadPid}.log`, 10_000);
		await writeDatedLog(logsDir, `omp.${tomorrow}.${futureDeadPid}.log.1`, 10_000);

		const inWindowDead: string[] = [];
		for (let i = 0; i < MAX_RETAINED_STALE_PROCESS_LOGS; i++) {
			const name = `omp.${today}.${9_250_000 + i}.log`;
			inWindowDead.push(name);
			await writeDatedLog(logsDir, name, 1_000 + i);
		}

		const probedPids: number[] = [];
		const realKill = process.kill.bind(process);
		spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			probedPids.push(pid);
			return realKill(pid, signal);
		}) as typeof process.kill);

		pruneStaleProcessLogs(logsDir, { now, force: true });

		expect(probedPids).not.toContain(process.pid);
		expect(probedPids).toContain(liveChildPid);
		expect(probedPids).toContain(futureDeadPid);
		expect(await listProcessLogs(logsDir)).toEqual([...liveFutureLogs, ...inWindowDead].sort());
	});

	it("preserves all live-PID and current-PID logs even when dead-PID logs exceed the cap", async () => {
		const logsDir = await makeLogsDir();
		const now = new Date("2026-06-15T12:00:00");
		const today = localDayBefore(now, 0);
		const oldestRetainedDay = localDayBefore(now, 4);
		const liveChildPid = await spawnSleepingChild();

		// Give live-PID logs the oldest day and oldest mtime so ranking them with dead-PID logs would evict them first.
		const liveLogs = [
			`omp.${oldestRetainedDay}.${liveChildPid}.log`,
			`omp.${oldestRetainedDay}.${liveChildPid}.log.1`,
			`omp.${today}.${liveChildPid}.log`,
			`omp.${oldestRetainedDay}.${process.pid}.log`,
			`omp.${today}.${process.pid}.log`,
			`omp.${today}.${process.pid}.log.1`,
		];
		for (const name of liveLogs) {
			await writeDatedLog(logsDir, name, 1);
		}

		const deadCount = MAX_RETAINED_STALE_PROCESS_LOGS + 12;
		const deadLogsNewestFirst: string[] = [];
		for (let i = 0; i < deadCount; i++) {
			const pid = 9_300_000 + i;
			const name = `omp.${today}.${pid}.log`;
			await writeDatedLog(logsDir, name, 1_000 + i);
			deadLogsNewestFirst.unshift(name);
		}

		pruneStaleProcessLogs(logsDir, { now, force: true });

		const remaining = await listProcessLogs(logsDir);
		for (const liveName of liveLogs) {
			expect(remaining).toContain(liveName);
		}
		const expectedDead = deadLogsNewestFirst.slice(0, MAX_RETAINED_STALE_PROCESS_LOGS);
		const evictedDead = deadLogsNewestFirst.slice(MAX_RETAINED_STALE_PROCESS_LOGS);
		for (const kept of expectedDead) {
			expect(remaining).toContain(kept);
		}
		for (const evicted of evictedDead) {
			expect(remaining).not.toContain(evicted);
		}
		expect(remaining).toHaveLength(liveLogs.length + MAX_RETAINED_STALE_PROCESS_LOGS);
	});

	it("bounds dead-PID logs within the 5-day window to 64 newest entries", async () => {
		const logsDir = await makeLogsDir();
		const now = new Date("2026-06-15T12:00:00");
		const day0 = localDayBefore(now, 0);
		const day1 = localDayBefore(now, 1);
		const day2 = localDayBefore(now, 2);
		const day3 = localDayBefore(now, 3);
		const day4 = localDayBefore(now, 4);

		const expectedKept: string[] = [];

		// Day 0: 20 dead processes, including one process with size rollovers (.log, .log.1, .log.2).
		const rolloverPid = 9_400_000;
		await writeDatedLog(logsDir, `omp.${day0}.${rolloverPid}.log`, 5_000);
		await writeDatedLog(logsDir, `omp.${day0}.${rolloverPid}.log.1`, 5_000);
		await writeDatedLog(logsDir, `omp.${day0}.${rolloverPid}.log.2`, 5_000);
		expectedKept.push(`omp.${day0}.${rolloverPid}.log.2`);
		for (let i = 1; i < 20; i++) {
			const name = `omp.${day0}.${9_400_000 + i}.log`;
			await writeDatedLog(logsDir, name, 5_000 + i);
			expectedKept.push(name);
		}

		// Day 1: 25 dead processes (total so far: 45).
		for (let i = 0; i < 25; i++) {
			const name = `omp.${day1}.${9_410_000 + i}.log`;
			await writeDatedLog(logsDir, name, 4_000 + i);
			expectedKept.push(name);
		}

		// Day 2: 30 dead processes — straddles the cap (64 - 45 = 19 kept, 11 oldest evicted).
		// Include an equal-mtime boundary pair at the cutoff to verify deterministic filename/PID tie-breaking.
		const day2Entries: string[] = [];
		for (let i = 0; i < 30; i++) {
			const name = `omp.${day2}.${9_420_000 + i}.log`;
			const mtime = i === 10 || i === 11 ? 3_010 : 3_000 + i;
			await writeDatedLog(logsDir, name, mtime);
			day2Entries.push(name);
		}
		expectedKept.push(...day2Entries.slice(30 - (MAX_RETAINED_STALE_PROCESS_LOGS - 45)));

		// Days 3 and 4: within the 5-day window, even given artificially high mtimes, older days lose to newer days.
		for (let i = 0; i < 10; i++) {
			await writeDatedLog(logsDir, `omp.${day3}.${9_430_000 + i}.log`, 9_000 + i);
			await writeDatedLog(logsDir, `omp.${day4}.${9_440_000 + i}.log`, 9_500 + i);
		}

		pruneStaleProcessLogs(logsDir, { now, force: true });

		expect(await listProcessLogs(logsDir)).toEqual(expectedKept.sort());
	});

	it("throttles repeated startup scans via .prune-stamp until 5 minutes elapse or force is set", async () => {
		const logsDir = await makeLogsDir();
		const liveNow = new Date(Math.floor(Date.now() / 1000) * 1000);
		const t0 = new Date(liveNow.getTime() - PRUNE_INTERVAL_MS * 2);
		const seedDay = localDay(t0);
		const expiredDay = localDayBefore(t0, 10);

		// A current-PID-only directory stays clean without creating .prune-stamp or unlinking an active .lock sidecar.
		const ownLog = `omp.${seedDay}.${process.pid}.log`;
		const lockSidecarPath = path.join(logsDir, ".prune-stamp.lock");
		await Bun.write(lockSidecarPath, "");
		const sidecarInodeBefore = (await fs.promises.stat(lockSidecarPath)).ino;
		await writeDatedLog(logsDir, ownLog, 1_000);
		pruneStaleProcessLogs(logsDir, { now: t0 });
		expect((await fs.promises.stat(lockSidecarPath)).ino).toBe(sidecarInodeBefore);
		expect((await fs.promises.readdir(logsDir)).filter(name => name !== ".prune-stamp.lock")).toEqual([ownLog]);
		await fs.promises.rm(lockSidecarPath);
		await fs.promises.rm(path.join(logsDir, ownLog));

		const retainedSeed = `omp.${seedDay}.9500001.log`;
		const firstExpired = `omp.${expiredDay}.9500002.log`;
		await writeDatedLog(logsDir, retainedSeed, 1_000);
		await writeDatedLog(logsDir, firstExpired, 1_000);

		pruneStaleProcessLogs(logsDir, { now: t0 });
		expect(await listProcessLogs(logsDir)).toEqual([retainedSeed]);
		expect(await fs.promises.readdir(logsDir)).toContain(".prune-stamp");

		// Seed a newly expired file while .prune-stamp is fresh.
		const secondExpired = `omp.${expiredDay}.9500003.log`;
		await writeDatedLog(logsDir, secondExpired, 1_000);

		const readdirSpy = spyOn(fs, "readdirSync");
		pruneStaleProcessLogs(logsDir, { now: new Date(t0.getTime() + PRUNE_INTERVAL_MS - 1) });
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(await listProcessLogs(logsDir)).toEqual([secondExpired, retainedSeed].sort());

		// force: true bypasses the active throttle immediately.
		pruneStaleProcessLogs(logsDir, { now: new Date(t0.getTime() + 1_000), force: true });
		expect(readdirSpy).toHaveBeenCalledTimes(1);
		expect(await listProcessLogs(logsDir)).toEqual([retainedSeed]);

		// Initialize local transports once so setTransports({ file: logsDir }) schedules startup pruning immediately.
		setTransports({ console: false, file: false });
		debug("init-transports");

		// Fresh .prune-stamp skips rescanning on the real startup transport path.
		pruneStaleProcessLogs(logsDir, { now: liveNow, force: true });
		const thirdExpired = `omp.${localDayBefore(liveNow, 10)}.9500004.log`;
		await writeDatedLog(logsDir, thirdExpired, 1_000);
		readdirSpy.mockClear();

		setTransports({ console: false, file: logsDir });
		await nextImmediate();
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(await listProcessLogs(logsDir)).toEqual([thirdExpired, retainedSeed].sort());

		// Once .prune-stamp ages past the 5-minute window, the startup transport path rescans and removes the expired file.
		setTransports({ console: false, file: false });
		const staleStampSec = Math.floor((Date.now() - PRUNE_INTERVAL_MS - 5_000) / 1000);
		await fs.promises.utimes(path.join(logsDir, ".prune-stamp"), staleStampSec, staleStampSec);
		readdirSpy.mockClear();

		setTransports({ console: false, file: logsDir });
		await nextImmediate();
		expect(readdirSpy).toHaveBeenCalledTimes(1);
		expect(await listProcessLogs(logsDir)).toEqual([retainedSeed]);
	});

	it("skips non-forced scans when another process holds the prune lock while allowing force: true", async () => {
		const logsDir = await makeLogsDir();
		const now = new Date("2026-06-15T12:00:00");
		const today = localDayBefore(now, 0);
		const expiredDay = localDayBefore(now, 10);

		const retainedName = `omp.${today}.9600001.log`;
		const firstExpired = `omp.${expiredDay}.9600002.log`;
		await writeDatedLog(logsDir, retainedName, 1_000);
		await writeDatedLog(logsDir, firstExpired, 1_000);

		const stampPath = path.join(logsDir, ".prune-stamp");
		const heldLock = tryAcquireFileLock(stampPath);
		if (!heldLock) throw new Error("expected test to acquire initial prune lock");
		cleanups.push(() => heldLock.release());

		const readdirSpy = spyOn(fs, "readdirSync");
		const probedPids: number[] = [];
		const realKill = process.kill.bind(process);
		spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
			probedPids.push(pid);
			return realKill(pid, signal);
		}) as typeof process.kill);

		// Contended non-forced scan returns immediately without reading the directory or probing PIDs.
		pruneStaleProcessLogs(logsDir, { now });
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(probedPids).toEqual([]);
		expect(await listProcessLogs(logsDir)).toEqual([firstExpired, retainedName].sort());

		// Explicit force: true still scans deterministically even while another caller holds the lock.
		pruneStaleProcessLogs(logsDir, { now, force: true });
		expect(readdirSpy).toHaveBeenCalledTimes(1);
		expect(await listProcessLogs(logsDir)).toEqual([retainedName]);

		// Once the holder releases and .prune-stamp is stale, a non-forced scan acquires, prunes, and releases cleanly.
		heldLock.release();
		const staleStampSec = Math.floor((now.getTime() - PRUNE_INTERVAL_MS - 5_000) / 1000);
		await fs.promises.utimes(stampPath, staleStampSec, staleStampSec);
		const secondExpired = `omp.${expiredDay}.9600003.log`;
		await writeDatedLog(logsDir, secondExpired, 1_000);
		readdirSpy.mockClear();

		pruneStaleProcessLogs(logsDir, { now });
		expect(readdirSpy).toHaveBeenCalledTimes(1);
		expect(await listProcessLogs(logsDir)).toEqual([retainedName]);

		const reacquired = tryAcquireFileLock(stampPath);
		expect(reacquired).not.toBeNull();
		reacquired?.release();
	});

	it("imports logger/postmortem and runs scheduled pruning under bun --no-addons without crashing", async () => {
		const logsDir = await makeLogsDir();
		const expiredLog = "omp.2020-01-01.9700001.log";
		await writeDatedLog(logsDir, expiredLog, 1_000);

		const script = [
			'import * as logger from "@oh-my-pi/pi-utils/logger";',
			'import * as postmortem from "@oh-my-pi/pi-utils/postmortem";',
			"void postmortem;",
			`logger.setTransports({ console: false, file: ${JSON.stringify(logsDir)} });`,
			'logger.warn("no-addons-probe");',
			"const { promise, resolve } = Promise.withResolvers();",
			"setImmediate(resolve);",
			"await promise;",
			"logger.setTransports({ console: false, file: false });",
		].join("\n");

		const proc = Bun.spawn([process.execPath, "--no-addons", "-e", script], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toBe("");

		const remaining = await listProcessLogs(logsDir);
		expect(remaining).not.toContain(expiredLog);
		expect(remaining.some(name => name.endsWith(`.${proc.pid}.log`))).toBe(true);
	});

	it("falls back to unlocked pruning when a stale native addon lacks FileLock", async () => {
		const logsDir = await makeLogsDir();
		const expiredLog = "omp.2020-01-01.9700002.log";
		const secondExpiredLog = "omp.2020-01-01.9700004.log";
		const retainedLog = "omp.2026-06-15.9700003.log";
		await writeDatedLog(logsDir, expiredLog, 1_000);
		await writeDatedLog(logsDir, retainedLog, 2_000);

		const staleFileLockStub = new Proxy(
			{},
			{
				get(_target, key) {
					if (key === "tryAcquire") {
						throw new Error("@oh-my-pi/pi-natives export `FileLock.tryAcquire` is missing");
					}
					return undefined;
				},
			},
		);
		__internalsForTesting.setNativesLoader(() => ({ FileLock: staleFileLockStub }));

		pruneStaleProcessLogs(logsDir, { now: new Date("2026-06-15T12:00:00") });
		expect(await listProcessLogs(logsDir)).toEqual([retainedLog]);

		await fs.promises.rm(path.join(logsDir, ".prune-stamp"), { force: true });
		await writeDatedLog(logsDir, secondExpiredLog, 1_000);
		__internalsForTesting.setNativesLoader(() => ({}));

		pruneStaleProcessLogs(logsDir, { now: new Date("2026-06-15T12:00:00") });
		expect(await listProcessLogs(logsDir)).toEqual([retainedLog]);
	});
});
