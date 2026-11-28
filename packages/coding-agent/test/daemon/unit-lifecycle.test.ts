/**
 * What keeps a unit — and the daemon — alive, against a real daemon isolated
 * in a temp dir: explicit release, lease loss on disconnect and its reconnect
 * grace, `hold: "persist"`, `survive: "detached"` lease units across a daemon
 * crash, per-scope caps, idle daemon exit, and the unit env.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { Process } from "@oh-my-pi/pi-natives";
import { DAEMON_IDLE_EXIT_GRACE_ENV, DAEMON_RESUME_LEASE_GRACE_ENV } from "../../src/daemon/protocol";
import { type DaemonConn, pidAlive, rejection, shProc, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;
/**
 * Reconnect lease grace of the daemons whose tests wait it out (`DAEMON_RESUME_LEASE_GRACE_ENV`; 15 s by default):
 * long enough for a client to see the unit still held after its lease dropped or the daemon restarted.
 */
const LEASE_GRACE_MS = 750;
const LEASE_GRACE_ENV = { [DAEMON_RESUME_LEASE_GRACE_ENV]: String(LEASE_GRACE_MS) };
/**
 * Idle-exit grace of the daemon whose test waits it out (`DAEMON_IDLE_EXIT_GRACE_ENV`; 3 s by default):
 * long enough for the harness's first connect to land before the fresh daemon idles out.
 */
const IDLE_EXIT_GRACE_MS = 300;

let daemon: TestDaemon | undefined;

afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

async function startDaemon(
	env?: Record<string, string>,
): Promise<{ daemon: TestDaemon; conn: DaemonConn; root: string }> {
	const started = await TestDaemon.start({ env });
	daemon = started.daemon;
	return { ...started, root: started.daemon.root };
}

/** Prints `tick N` every 50 ms, forever. */
const TICKER = 'i=0; while :; do i=$((i+1)); echo "tick $i"; sleep 0.05; done';
const DETACHED_LEASES = { hold: "leases", survive: "detached", idleMs: 0 } as const;

async function lastTick(conn: DaemonConn, key: string): Promise<number> {
	const { text } = await conn.request({ op: "logs", unit: key, lines: 5, head: false, follow: false, timeoutMs: 0 });
	let last = 0;
	for (const match of text.matchAll(/tick (\d+)/g)) last = Math.max(last, Number(match[1]));
	return last;
}

async function liveKeys(conn: DaemonConn): Promise<string[]> {
	const { units } = await conn.request({ op: "list" });
	return units
		.filter(unit => unit.state !== "exited" && unit.state !== "failed")
		.map(unit => unit.key)
		.sort();
}

describe.skipIf(process.platform === "win32")("daemon unit lifecycle", () => {
	it(
		"releasing the last lease of an idleMs 0 unit stops it right away instead of leaking the process",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc("leased", shProc("exec sleep 30", root), { policy: { idleMs: 0 } });
			expect(opened.lease).toBeDefined();

			await conn.request({ op: "release", lease: opened.lease! });
			const exit = await conn.request({ op: "wait", unit: "leased", for: "exit", timeoutMs: 5_000 });

			expect(exit.matched).toBe(true);
			expect(exit.unit.state).toBe("exited");
			expect(exit.unit.exitReason).toBe("idle");
			await until(() => (pidAlive(opened.unit.pids[0]) ? undefined : true), "released process to exit");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a lease lost to a dropped connection keeps the unit for the reconnect grace, then the idle policy stops it",
		async () => {
			const { daemon: d, conn: holder, root } = await startDaemon(LEASE_GRACE_ENV);
			const observer = await d.connect();
			await holder.openProc("graced", shProc("exec sleep 60", root), { policy: { idleMs: 0 } });

			const closedAt = Date.now();
			await holder.close();
			const held = await until(async () => {
				const unit = await observer.describe("graced");
				return unit.leases === 0 ? unit : undefined;
			}, "the dropped lease");
			expect(held.state).toBe("running");
			expect(held.idleAt).toBeGreaterThanOrEqual(closedAt + LEASE_GRACE_MS);

			const exit = await observer.request({
				op: "wait",
				unit: "graced",
				for: "exit",
				timeoutMs: LEASE_GRACE_MS + 10_000,
			});
			expect(exit.matched).toBe(true);
			expect(exit.unit.exitedAt! - closedAt).toBeGreaterThanOrEqual(LEASE_GRACE_MS);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a client reconnecting within the grace adopts the same process instead of starting a new one",
		async () => {
			const { daemon: d, conn: first, root } = await startDaemon();
			const proc = shProc("exec sleep 60", root);
			const opened = await first.openProc("rejoin", proc, { policy: { idleMs: 0 } });
			await first.close();

			const second = await d.connect();
			const again = await second.openProc("rejoin", proc, { policy: { idleMs: 0 } });

			expect(again.created).toBe(false);
			expect(again.unit.pids).toEqual(opened.unit.pids);
			expect(again.unit.generation).toBe(opened.unit.generation);
			expect(again.unit.leases).toBe(1);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a hold: persist unit outlives every client and keeps the daemon up past its idle grace; once it stops the idle daemon exits",
		async () => {
			const {
				daemon: d,
				conn,
				root,
			} = await startDaemon({ [DAEMON_IDLE_EXIT_GRACE_ENV]: String(IDLE_EXIT_GRACE_MS) });
			const opened = await conn.openProc("keeper", shProc("exec sleep 60", root), { policy: { hold: "persist" } });
			await conn.close();

			// Negative contract: nothing may stop the unit or the daemon once the idle grace has passed. The idle timer
			// runs in the daemon process and has no observable event, so a real wait past it (plus timer slack) is the only probe.
			await Bun.sleep(IDLE_EXIT_GRACE_MS + 300);
			expect(d.running).toBe(true);
			const back = await d.connect();
			const unit = await back.describe("keeper");
			expect(unit.state).toBe("running");
			expect(unit.pids).toEqual(opened.unit.pids);
			expect(unit.leases).toBe(0);
			expect(unit.idleAt).toBeUndefined();

			await back.request({ op: "stop", unit: "keeper", timeoutMs: 1_000 });
			await back.close();
			const exited = await Promise.race([d.exited.then(() => true), Bun.sleep(15_000).then(() => false)]);
			expect(exited).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a hold: leases, survive: detached unit keeps its process and growing log across a daemon crash, and a returning client retakes its lease",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			const proc = shProc(TICKER, root);
			const opened = await conn.openProc("crash-leased", proc, { policy: DETACHED_LEASES });
			expect(opened.lease).toBeDefined();
			const ticksBefore = await until(async () => {
				const tick = await lastTick(conn, "crash-leased");
				return tick >= 3 ? tick : undefined;
			}, "output before the crash");

			await d.kill();
			expect(pidAlive(opened.unit.pids[0])).toBe(true);
			const next = await d.spawn();

			const after = await next.describe("crash-leased");
			expect(after.state).toBe("running");
			expect(after.pids[0]).toBe(opened.unit.pids[0]);
			await until(
				async () => ((await lastTick(next, "crash-leased")) > ticksBefore + 5 ? true : undefined),
				"output after the restart",
			);

			const again = await next.openProc("crash-leased", proc, { policy: DETACHED_LEASES });
			expect(again.created).toBe(false);
			expect(again.unit.pids).toEqual(opened.unit.pids);
			expect(again.unit.leases).toBe(1);
			expect(again.unit.idleAt).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a hold: leases, survive: detached unit no client retakes after a daemon crash is idle-stopped once the reconnect grace passes",
		async () => {
			const { daemon: d, conn, root } = await startDaemon(LEASE_GRACE_ENV);
			const opened = await conn.openProc("crash-orphan", shProc(TICKER, root), { policy: DETACHED_LEASES });

			await d.kill();
			const restartedAt = Date.now();
			const next = await d.spawn();
			const held = await next.describe("crash-orphan");
			expect(held.state).toBe("running");
			expect(held.pids[0]).toBe(opened.unit.pids[0]);
			expect(held.idleAt).toBeGreaterThanOrEqual(restartedAt + LEASE_GRACE_MS);

			const exit = await next.request({
				op: "wait",
				unit: "crash-orphan",
				for: "exit",
				timeoutMs: LEASE_GRACE_MS + 10_000,
			});
			expect(exit.matched).toBe(true);
			expect(exit.unit.exitReason).toBe("idle");
			expect(exit.unit.exitedAt! - restartedAt).toBeGreaterThanOrEqual(LEASE_GRACE_MS);
			await until(() => (pidAlive(opened.unit.pids[0]) ? undefined : true), "idle-stopped process to exit");
		},
		TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform !== "linux")(
		"disposes a detached unit whose PID was not recorded before the daemon crashed",
		async () => {
			const { daemon: d, conn, root } = await startDaemon();
			const connected = Promise.withResolvers<void>();
			const barrier = Bun.listen({
				unix: `${root}/hold.sock`,
				socket: {
					open: () => connected.resolve(),
					data() {},
				},
			});
			try {
				const lookup = spyOn(Process, "fromPid").mockReturnValueOnce(null);
				const opened = await conn
					.openProc(
						"untracked",
						{
							application: process.execPath,
							args: ["-e", 'import { createConnection } from "node:net"; createConnection("./hold.sock");'],
							env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
							cwd: root,
							pty: false,
						},
						{ policy: DETACHED_LEASES },
					)
					.finally(() => lookup.mockRestore());
				const pid = opened.unit.pids[0];
				const stdout = `/proc/${pid}/fd/1`;
				await connected.promise;
				await d.kill();
				const log = await fs.readlink(stdout);
				expect(log.startsWith(`${root}/daemon/units/`)).toBe(true);

				await d.dispose();
				daemon = undefined;
				expect(pidAlive(pid)).toBe(false);
				await expect(fs.readlink(stdout)).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				barrier.stop(true);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a survive: detached unit refuses a PTY at open and stdin data on send, yet takes signals",
		async () => {
			const { conn, root } = await startDaemon();
			const ptyError = await rejection(
				conn.openProc("detached-pty", shProc("exec sleep 30", root, { pty: true }), { policy: DETACHED_LEASES }),
			);
			expect(ptyError).toContain("cannot allocate a PTY");

			await conn.openProc("detached-stdin", shProc("exec sleep 30", root), { policy: DETACHED_LEASES });
			const sendError = await rejection(conn.request({ op: "send", unit: "detached-stdin", data: "hello\n" }));
			expect(sendError).toContain("has no stdin");

			await conn.request({ op: "send", unit: "detached-stdin", signal: "SIGTERM" });
			const exit = await conn.request({ op: "wait", unit: "detached-stdin", for: "exit", timeoutMs: 5_000 });
			expect(exit.matched).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"cap evicts the least recently used unleased unit of the scope, not merely the oldest one",
		async () => {
			const { conn, root } = await startDaemon();
			const proc = shProc("exec sleep 60", root);
			const policy = { cap: 2, hold: "persist" as const };
			// The daemon (another process) orders use by millisecond `Date.now()`: the short sleeps keep the opens distinct.
			await conn.openProc("old", proc, { lease: false, policy });
			await Bun.sleep(10);
			await conn.openProc("newer", proc, { lease: false, policy });
			await Bun.sleep(10);
			// Using `old` again makes `newer` the least recently used.
			expect((await conn.openProc("old", proc, { lease: false, policy })).created).toBe(false);
			await Bun.sleep(10);

			await conn.openProc("third", proc, { lease: false, policy });

			expect(await liveKeys(conn)).toEqual(["old", "third"]);
			const evicted = await conn.describe("newer");
			expect(evicted.state).toBe("exited");
			expect(evicted.exitReason).toBe("evicted");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"cap never evicts a leased unit, even when that leaves the scope over the cap",
		async () => {
			const { conn, root } = await startDaemon();
			const proc = shProc("exec sleep 60", root);
			for (const key of ["pinned-a", "pinned-b", "pinned-c"]) {
				const opened = await conn.openProc(key, proc, { policy: { cap: 2 } });
				expect(opened.lease).toBeDefined();
			}

			expect(await liveKeys(conn)).toEqual(["pinned-a", "pinned-b", "pinned-c"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a unit runs with exactly the env of its open request, never inheriting the daemon's env",
		async () => {
			const { conn, root } = await startDaemon({ OMP_UNIT_MARKER: "daemon", OMP_DAEMON_ONLY: "leak" });
			await conn.openProc(
				"env",
				// oxlint-disable-next-line no-template-curly-in-string -- shell parameter expansion, not a JS template
				shProc('echo "marker=$OMP_UNIT_MARKER only=${OMP_DAEMON_ONLY-unset}"; read hold', root, {
					env: { OMP_UNIT_MARKER: "request" },
				}),
			);

			const printed = await conn.request({
				op: "wait",
				unit: "env",
				for: "ready",
				pattern: "^marker=.*$",
				timeoutMs: 5_000,
			});
			expect(printed.match).toBe("marker=request only=unset");
		},
		TEST_TIMEOUT_MS,
	);
});
