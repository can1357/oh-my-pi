import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, withFileLock } from "@pk-nerdsaver-ai/pi-coding-agent/config/file-lock";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const { tryAcquireLock, releaseLock, readLockInfo, isLockStale, isProcessAlive, getLockPath } = __internalsForTesting;

const ROOTS: string[] = [];
const DEAD_PID = 2_147_483_647;

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

describe("file-lock token ownership (F1)", () => {
	test("releaseLock with the wrong token leaves the lock intact", async () => {
		const root = await mkRoot();
		const target = path.join(root, "data.json");
		const lockPath = getLockPath(target);

		const token = await tryAcquireLock(lockPath);
		expect(token).not.toBeNull();
		expect(typeof token).toBe("string");

		// A contender that lost a race calling release with a guessed/empty token
		// must NOT remove the rightful owner's lock.
		await releaseLock(lockPath, "not-the-real-token");

		const info = await readLockInfo(lockPath);
		expect(info).not.toBeNull();
		expect(info?.token).toBe(token!);

		// The rightful owner can still release.
		await releaseLock(lockPath, token!);
		expect(await readLockInfo(lockPath)).toBeNull();
	});

	test("isLockStale does NOT declare a freshly-created empty dir stale", async () => {
		const root = await mkRoot();
		const target = path.join(root, "race.json");
		const lockPath = getLockPath(target);

		// Simulate the precise window: mkdir succeeded for the winner but the
		// info file has not been written yet.
		await fs.mkdir(lockPath);

		const stale = await isLockStale(lockPath, 10_000);
		expect(stale).toBe(false);

		await removeWithRetries(lockPath);
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						// Widen the critical-section window so any concurrency leak
						// surfaces as a lost update.
						await Bun.sleep(2);
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);

	test("serializes contenders while taking over a stale lock", async () => {
		const root = await mkRoot();
		const target = path.join(root, "stale-counter.json");
		const lockPath = getLockPath(target);
		let active = 0;
		let peakActive = 0;

		for (let round = 0; round < 5; round += 1) {
			await fs.mkdir(lockPath);
			await Bun.write(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: DEAD_PID, timestamp: Date.now(), token: `dead-${round}` }),
			);

			await Promise.all(
				Array.from({ length: 48 }, () =>
					withFileLock(
						target,
						async () => {
							active += 1;
							peakActive = Math.max(peakActive, active);
							await Bun.sleep(2);
							active -= 1;
						},
						{ staleMs: 60_000, retries: 2_000, retryDelayMs: 1 },
					),
				),
			);
		}

		expect(peakActive).toBe(1);
	}, 60_000);

	test("serializes contenders while recovering a stale takeover breaker", async () => {
		const root = await mkRoot();
		const target = path.join(root, "stale-breaker.json");
		const lockPath = getLockPath(target);
		const breakerPath = `${lockPath}.break`;
		let active = 0;
		let peakActive = 0;

		for (let round = 0; round < 5; round += 1) {
			await fs.mkdir(lockPath);
			await Bun.write(
				path.join(lockPath, "info"),
				JSON.stringify({ pid: DEAD_PID, timestamp: Date.now(), token: `lock-${round}` }),
			);
			await fs.mkdir(breakerPath);
			await Bun.write(
				path.join(breakerPath, "info"),
				JSON.stringify({ pid: DEAD_PID, timestamp: Date.now(), token: `breaker-${round}` }),
			);

			await Promise.all(
				Array.from({ length: 48 }, () =>
					withFileLock(
						target,
						async () => {
							active += 1;
							peakActive = Math.max(peakActive, active);
							await Bun.sleep(2);
							active -= 1;
						},
						{ staleMs: 60_000, retries: 2_000, retryDelayMs: 1 },
					),
				),
			);
		}

		expect(peakActive).toBe(1);
	}, 60_000);

	test("does not bypass another stale-breaker reaper for the observed generation", async () => {
		const root = await mkRoot();
		const target = path.join(root, "fenced-stale-breaker.json");
		const lockPath = getLockPath(target);
		const breakerPath = `${lockPath}.break`;
		const breakerToken = "observed-breaker";
		const reaperPath = `${breakerPath}.reap.${breakerToken}`;
		await fs.mkdir(lockPath);
		await Bun.write(
			path.join(lockPath, "info"),
			JSON.stringify({ pid: DEAD_PID, timestamp: Date.now(), token: "stale-lock" }),
		);
		await fs.mkdir(breakerPath);
		await Bun.write(
			path.join(breakerPath, "info"),
			JSON.stringify({ pid: DEAD_PID, timestamp: Date.now(), token: breakerToken }),
		);
		await fs.mkdir(reaperPath);
		await Bun.write(
			path.join(reaperPath, "info"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "active-reaper" }),
		);

		let entered = false;
		await expect(
			withFileLock(
				target,
				async () => {
					entered = true;
				},
				{ staleMs: 60_000, retries: 1, retryDelayMs: 1 },
			),
		).rejects.toThrow("Failed to acquire lock");
		expect(entered).toBe(false);
	});

	test("recovers an old empty breaker left before its info was written", async () => {
		const root = await mkRoot();
		const target = path.join(root, "empty-breaker.json");
		const lockPath = getLockPath(target);
		const breakerPath = `${lockPath}.break`;
		await fs.mkdir(breakerPath);
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(breakerPath, old, old);

		let entered = false;
		await withFileLock(
			target,
			async () => {
				entered = true;
			},
			{ staleMs: 10, retries: 100, retryDelayMs: 1 },
		);

		expect(entered).toBe(true);
		expect(await Bun.file(breakerPath).exists()).toBe(false);
	});

	test("recovers an aged lock whose info JSON has an invalid shape", async () => {
		const root = await mkRoot();
		const target = path.join(root, "malformed-info.json");
		const lockPath = getLockPath(target);
		await fs.mkdir(lockPath);
		await Bun.write(path.join(lockPath, "info"), "{}");
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(lockPath, old, old);

		let entered = false;
		await withFileLock(
			target,
			async () => {
				entered = true;
			},
			{ staleMs: 10, staleWhileOwnerAlive: false, retries: 100, retryDelayMs: 1 },
		);

		expect(entered).toBe(true);
	});

	test("can keep a demonstrably live owner from expiring by age", async () => {
		const root = await mkRoot();
		const target = path.join(root, "long-running.json");
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let secondStarted = false;
		const options = {
			staleMs: 1,
			staleWhileOwnerAlive: false,
			retries: 500,
			retryDelayMs: 1,
		};

		const first = withFileLock(
			target,
			async () => {
				firstStarted.resolve();
				await releaseFirst.promise;
			},
			options,
		);
		await firstStarted.promise;
		await Bun.sleep(10);
		const second = withFileLock(
			target,
			async () => {
				secondStarted = true;
			},
			options,
		);
		await Bun.sleep(20);

		expect(secondStarted).toBe(false);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(secondStarted).toBe(true);
	});

	test("treats EPERM from a PID liveness probe as alive", () => {
		const throwCode = (code: string) => () => {
			throw Object.assign(new Error(code), { code });
		};

		expect(isProcessAlive(123, throwCode("EPERM"))).toBe(true);
		expect(isProcessAlive(123, throwCode("ESRCH"))).toBe(false);
	});
});
