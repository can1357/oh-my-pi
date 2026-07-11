import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, withFileLock } from "@pk-nerdsaver-ai/pi-coding-agent/config/file-lock";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

const { tryAcquireLock, releaseLock, readLockInfo, isLockStale, getLockPath } = __internalsForTesting;

const ROOTS: string[] = [];

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
});
