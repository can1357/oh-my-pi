/**
 * The daemon store as its consumers see it: the offline reader (`omp ps`
 * without a daemon), env deduplication, and what a daemon restarted after a
 * crash makes of the units the dead one persisted.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GLOBAL_SCOPE } from "../../src/daemon/protocol";
import { readStoredUnits } from "../../src/daemon/store";
import { type DaemonConn, pidAlive, shProc, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;

let daemon: TestDaemon | undefined;

afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

async function startDaemon(): Promise<{ daemon: TestDaemon; conn: DaemonConn; root: string }> {
	const started = await TestDaemon.start();
	daemon = started.daemon;
	return { ...started, root: started.daemon.root };
}

function envRowCount(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM envs").get()?.count ?? 0;
	} finally {
		db.close();
	}
}

/** Highest `tick N` in `text`, or 0. */
function lastTick(text: string): number {
	let last = 0;
	for (const match of text.matchAll(/tick (\d+)/g)) last = Math.max(last, Number(match[1]));
	return last;
}

describe.skipIf(process.platform === "win32")("daemon store", () => {
	it(
		"readStoredUnits gives the offline reader each unit a running daemon persisted, with its launch env restored",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", OMP_STORE_MARK: "one" };
			const opened = await conn.openProc("stored", shProc("exec sleep 60", root, { env }), {
				label: "Stored service",
				owner: "store-owner",
				policy: { hold: "persist" },
			});

			const stored = readStoredUnits(d.dbPath).find(unit => unit.id === opened.unit.id);

			expect(stored).toMatchObject({
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "stored",
				label: "Stored service",
				owner: "store-owner",
				policy: { hold: "persist" },
				proc: { application: "/bin/sh", args: ["-c", "exec sleep 60"], env, cwd: root },
				pid: opened.unit.pids[0],
			});
			expect(stored?.snapshot.state).toBe("running");
		},
		TEST_TIMEOUT_MS,
	);

	it("readStoredUnits returns nothing instead of throwing when no daemon ever created a store", () => {
		const missing = path.join(os.tmpdir(), `omp-no-daemon-${crypto.randomUUID()}`, "daemon.db");
		expect(readStoredUnits(missing)).toEqual([]);
		expect(fs.existsSync(missing)).toBe(false);
	});

	it(
		"identical launch envs are stored once whatever their key order, and a different env gets its own row",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			const PATH = process.env.PATH ?? "/usr/bin:/bin";
			await conn.openProc("env-a", shProc("exec sleep 60", root, { env: { PATH, ALPHA: "1", BETA: "2" } }));
			await conn.openProc("env-b", shProc("exec sleep 60", root, { env: { BETA: "2", ALPHA: "1", PATH } }));
			expect(envRowCount(d.dbPath)).toBe(1);

			await conn.openProc("env-c", shProc("exec sleep 60", root, { env: { PATH, ALPHA: "other" } }));
			expect(envRowCount(d.dbPath)).toBe(2);

			const byKey = new Map(readStoredUnits(d.dbPath).map(unit => [unit.key, unit.proc?.env]));
			expect(byKey.get("env-b")).toEqual({ PATH, ALPHA: "1", BETA: "2" });
			expect(byKey.get("env-c")).toEqual({ PATH, ALPHA: "other" });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"after a daemon crash and restart, a live pipe unit is reported exited and its orphan killed, while a hold: detached unit is re-adopted with its log continuing",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			const session = await conn.openProc("session-svc", shProc("exec sleep 60", root));
			const detached = await conn.openProc(
				"detached-svc",
				shProc('i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 0.05; done', root),
				{ policy: { hold: "detached" } },
			);
			const ticksBefore = await until(async () => {
				const { text } = await conn.request({
					op: "logs",
					unit: "detached-svc",
					lines: 5,
					head: false,
					follow: false,
					timeoutMs: 0,
				});
				const tick = lastTick(text);
				return tick >= 3 ? tick : undefined;
			}, "detached output before the crash");

			await d.kill();
			const offline = new Map(readStoredUnits(d.dbPath).map(unit => [unit.key, unit.snapshot.state]));
			expect(offline.get("session-svc")).toBe("running");
			expect(offline.get("detached-svc")).toBe("running");

			const next = await d.spawn();
			const sessionAfter = await next.describe("session-svc");
			expect(sessionAfter.state).toBe("exited");
			expect(sessionAfter.exitReason).toBe("daemon exited");
			expect(sessionAfter.pids).toEqual([]);
			await until(() => (pidAlive(session.unit.pids[0]) ? undefined : true), "orphaned pipe unit to be killed");

			const detachedAfter = await next.describe("detached-svc");
			expect(detachedAfter.state).toBe("running");
			expect(detachedAfter.pids[0]).toBe(detached.unit.pids[0]);
			await until(async () => {
				const { text } = await next.request({
					op: "logs",
					unit: "detached-svc",
					lines: 5,
					head: false,
					follow: false,
					timeoutMs: 0,
				});
				return lastTick(text) > ticksBefore + 5 ? true : undefined;
			}, "detached output after the restart");
			const head = await next.request({
				op: "logs",
				unit: "detached-svc",
				lines: 1,
				head: true,
				follow: false,
				timeoutMs: 0,
			});
			expect(head.text.split("\n")[0]).toBe("tick 1");
		},
		TEST_TIMEOUT_MS,
	);
});
