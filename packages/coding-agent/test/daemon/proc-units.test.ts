/**
 * `proc` units against a real daemon isolated in a temp dir: find-or-start,
 * readiness, logs, wait/cancel, send, stop generations, restart backoff, mode
 * transitions, and completion/notify delivery to the owner.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DaemonCompletionEvent, DaemonEvent, DaemonNotifyEvent, DaemonOp } from "../../src/daemon/protocol";
import { type DaemonConn, pidAlive, rejection, shProc, TestDaemon, until } from "../fixtures/daemon-proc-harness";

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

type LogsOptions = Partial<Omit<Extract<DaemonOp, { op: "logs" }>, "op" | "unit">>;

function logs(conn: DaemonConn, key: string, options: LogsOptions = {}) {
	return conn.request({ op: "logs", unit: key, lines: 100, head: false, follow: false, timeoutMs: 0, ...options });
}

function visibleLines(text: string): string[] {
	return text.split("\n").filter(line => line.length > 0);
}

function completionOf(key: string) {
	return (event: DaemonEvent): event is DaemonCompletionEvent => event.ev === "completed" && event.unit.key === key;
}

function notifyOf(key: string) {
	return (event: DaemonEvent): event is DaemonNotifyEvent => event.ev === "notify" && event.unit.key === key;
}

describe.skipIf(process.platform === "win32")("daemon proc units", () => {
	it(
		"two concurrent opens of one identity converge on one process instead of launching a duplicate service",
		async () => {
			const { daemon: d, conn: a, root } = await startDaemon();
			const b = await d.connect();
			const launches = path.join(root, "launches");
			const proc = shProc(`echo launched >> "${launches}"; echo up; exec sleep 30`, root, {
				ready: { log: "^up$", timeoutMs: 5_000 },
			});

			const [first, second] = await Promise.all([a.openProc("svc", proc), b.openProc("svc", proc)]);

			expect([first.created, second.created].sort()).toEqual([false, true]);
			expect(second.unit.id).toBe(first.unit.id);
			expect(second.unit.pids).toEqual(first.unit.pids);
			expect(visibleLines(await fs.readFile(launches, "utf8"))).toEqual(["launched"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"open waits for the readiness log pattern and reports the matched line, so callers never talk to a half-started service",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc(
				"web",
				shProc('echo booting; sleep 0.2; echo "listening on 8123"; exec sleep 30', root, {
					ready: { log: "listening on (\\d+)", timeoutMs: 5_000 },
				}),
			);

			expect(opened.unit.state).toBe("ready");
			expect(opened.unit.readyMatch).toBe("listening on 8123");
			expect(opened.unit.readyPending).toBeUndefined();
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"open returns a still-starting unit naming the unmet readiness condition when the readiness timeout passes, without killing it",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc(
				"slow",
				shProc("echo booting; exec sleep 30", root, { ready: { log: "^never$", timeoutMs: 300 } }),
			);

			expect(opened.unit.state).toBe("starting");
			expect(opened.unit.readyAt).toBeUndefined();
			expect(opened.unit.readyPending).toEqual(["log"]);
			expect(pidAlive(opened.unit.pids[0])).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"logs serve the head, the tail, grep-filtered lines, and a byte cursor equal to the output written",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc(
				"counter",
				shProc('i=1; while [ $i -le 20 ]; do echo "line $i"; i=$((i+1)); done; exec sleep 30', root, {
					ready: { log: "^line 20$", timeoutMs: 5_000 },
				}),
			);
			const written = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join("");

			const head = await logs(conn, "counter", { lines: 3, head: true });
			expect(visibleLines(head.text).slice(0, 3)).toEqual(["line 1", "line 2", "line 3"]);
			expect(head.text).not.toContain("line 4");
			expect(head.cursor).toBe(Buffer.byteLength(written));

			const tail = visibleLines((await logs(conn, "counter", { lines: 3 })).text);
			expect(tail).toEqual(["line 18", "line 19", "line 20"]);

			const grep = await logs(conn, "counter", { grep: "^line 1\\d$" });
			expect(visibleLines(grep.text)).toEqual(Array.from({ length: 10 }, (_, index) => `line ${index + 10}`));
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"follow-logs from a cursor returns as soon as new output lands, and returns the unchanged cursor when nothing arrives in time",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc(
				"chat",
				shProc('echo ready; while read line; do echo "got:$line"; done', root, {
					ready: { log: "^ready$", timeoutMs: 5_000 },
				}),
			);
			const { cursor } = await logs(conn, "chat");

			const quiet = await logs(conn, "chat", { follow: true, cursor, timeoutMs: 200 });
			expect(quiet.cursor).toBe(cursor);

			const following = logs(conn, "chat", { follow: true, cursor, timeoutMs: 10_000 });
			await conn.request({ op: "send", unit: "chat", data: "ping\n" });
			const next = await following;
			expect(next.cursor).toBeGreaterThan(cursor);
			expect(next.text).toContain("got:ping");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"wait reports a pattern match, a timeout as unmatched while the unit runs, and the exit with its code",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc("exiter", shProc('echo "port=4321"; read go; exit 4', root));

			const pattern = await conn.request({
				op: "wait",
				unit: "exiter",
				for: "ready",
				pattern: "port=(\\d+)",
				timeoutMs: 5_000,
			});
			expect(pattern).toMatchObject({ matched: true, match: "port=4321" });

			const timedOut = await conn.request({
				op: "wait",
				unit: "exiter",
				for: "ready",
				pattern: "^never$",
				timeoutMs: 150,
			});
			expect(timedOut.matched).toBe(false);
			expect(timedOut.unit.state).toBe("running");

			await conn.request({ op: "send", unit: "exiter", data: "go\n" });
			const exit = await conn.request({ op: "wait", unit: "exiter", for: "exit", timeoutMs: 5_000 });
			expect(exit.matched).toBe(true);
			expect(exit.unit.state).toBe("failed");
			expect(exit.unit.exitCode).toBe(4);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"cancel aborts an in-flight wait and follow-logs instead of leaving them parked until their timeout",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc("quiet", shProc("exec sleep 30", root));
			const waiting = conn.request(
				{ op: "wait", unit: "quiet", for: "ready", pattern: "^never$", timeoutMs: 60_000 },
				"wait-1",
			);
			const following = conn.request(
				{ op: "logs", unit: "quiet", lines: 10, head: false, follow: true, timeoutMs: 60_000 },
				"follow-1",
			);

			expect(await conn.request({ op: "cancel", requestId: "wait-1" })).toEqual({ cancelled: true });
			expect(await rejection(waiting)).toContain("wait cancelled");
			expect(await conn.request({ op: "cancel", requestId: "follow-1" })).toEqual({ cancelled: true });
			expect(await rejection(following)).toContain("logs request cancelled");
			expect(await conn.request({ op: "cancel", requestId: "wait-1" })).toEqual({ cancelled: false });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"send writes data to the unit's stdin and delivers a signal to its process; an exited unit rejects input",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc("echoer", shProc('read line; echo "got:$line"; exec sleep 30', root));
			await conn.request({ op: "send", unit: "echoer", data: "hello\n" });
			const echoed = await conn.request({
				op: "wait",
				unit: "echoer",
				for: "ready",
				pattern: "^got:hello$",
				timeoutMs: 5_000,
			});
			expect(echoed.matched).toBe(true);

			await conn.openProc(
				"trapper",
				shProc("trap 'echo caught-term; exit 7' TERM; echo armed; while :; do sleep 0.05; done", root, {
					ready: { log: "^armed$", timeoutMs: 5_000 },
				}),
			);
			await conn.request({ op: "send", unit: "trapper", signal: "SIGTERM" });
			const exit = await conn.request({ op: "wait", unit: "trapper", for: "exit", timeoutMs: 5_000 });
			expect(exit.unit.exitCode).toBe(7);
			expect((await logs(conn, "trapper")).text).toContain("caught-term");

			expect(await rejection(conn.request({ op: "send", unit: "trapper", data: "late\n" }))).toContain(
				`is ${exit.unit.state}`,
			);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stop naming a stale generation leaves the relaunched process running; the current generation stops it",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc("gen", shProc("exec sleep 30", root));
			const restarted = await conn.request({ op: "restart", unit: "gen" });
			expect(restarted.unit.generation).not.toBe(opened.unit.generation);
			const pid = restarted.unit.pids[0];

			const stale = await conn.request({
				op: "stop",
				unit: "gen",
				timeoutMs: 1_000,
				generation: opened.unit.generation,
			});
			expect(stale.unit.state).toBe("running");
			expect(pidAlive(pid)).toBe(true);

			const current = await conn.request({
				op: "stop",
				unit: "gen",
				timeoutMs: 1_000,
				generation: restarted.unit.generation,
			});
			expect(current.unit.state).toBe("exited");
			expect(current.unit.exitReason).toBe("stopped");
			await until(() => (pidAlive(pid) ? undefined : true), "stopped process to exit");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"restart on-failure relaunches a crashing unit with a growing backoff, and stop during the backoff ends it for good",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc("flaky", shProc("echo attempt; exit 3", root), { policy: { restart: "on-failure" } });

			await until(
				async () => ((await conn.describe("flaky")).restartCount >= 2 ? true : undefined),
				"two restarts",
				15_000,
				50,
			);
			const { text } = await logs(conn, "flaky");
			const delays = [...text.matchAll(/restarting in (\d+)ms/g)].map(match => Number(match[1]));
			expect(delays.length).toBeGreaterThanOrEqual(2);
			expect(delays[1]).toBeGreaterThan(delays[0]);
			expect(text).toContain("exited with code 3");

			const stopped = await conn.request({ op: "stop", unit: "flaky", timeoutMs: 1_000 });
			expect(stopped.unit.state).toBe("exited");
			const settled = await conn.request({ op: "wait", unit: "flaky", for: "exit", timeoutMs: 100 });
			expect(settled.unit.state).toBe("exited");
			expect(settled.unit.restartCount).toBe(stopped.unit.restartCount);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"restart on-failure leaves a cleanly exiting unit exited instead of relaunching it",
		async () => {
			const { conn, root } = await startDaemon();
			await conn.openProc("oneshot", shProc("echo done; exit 0", root), { policy: { restart: "on-failure" } });
			const exit = await conn.request({ op: "wait", unit: "oneshot", for: "exit", timeoutMs: 5_000 });

			expect(exit.unit.state).toBe("exited");
			expect(exit.unit.exitCode).toBe(0);
			expect(exit.unit.restartCount).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"mode persist keeps a released unit running, and mode session hands it back to the idle policy that stops it",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc("moded", shProc("exec sleep 30", root));
			const persisted = await conn.request({ op: "mode", unit: "moded", mode: "persist" });
			expect(persisted.unit.policy.hold).toBe("persist");

			await conn.request({ op: "release", lease: opened.lease! });
			const held = await conn.request({ op: "wait", unit: "moded", for: "exit", timeoutMs: 500 });
			expect(held.matched).toBe(false);
			expect(held.unit.state).toBe("running");

			const session = await conn.request({ op: "mode", unit: "moded", mode: "session" });
			expect(session.unit.policy.hold).toBe("leases");
			const exit = await conn.request({ op: "wait", unit: "moded", for: "exit", timeoutMs: 5_000 });
			expect(exit.matched).toBe(true);
			expect(exit.unit.state).toBe("exited");
			await until(() => (pidAlive(opened.unit.pids[0]) ? undefined : true), "idle-stopped process to exit");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"mode detached relaunches the unit as a detached process whose output still reaches logs, and refuses to go back to session",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc("bg", shProc("while :; do echo tick; sleep 0.1; done", root));
			const detached = await conn.request({ op: "mode", unit: "bg", mode: "detached" });

			expect(detached.unit.policy).toMatchObject({ hold: "detached", survive: "detached" });
			expect(detached.unit.pids[0]).not.toBe(opened.unit.pids[0]);
			await until(() => (pidAlive(opened.unit.pids[0]) ? undefined : true), "pipe launch to exit");

			const { cursor } = await logs(conn, "bg");
			const next = await logs(conn, "bg", { follow: true, cursor, timeoutMs: 5_000 });
			expect(next.cursor).toBeGreaterThan(cursor);
			expect(next.text).toContain("tick");

			expect(await rejection(conn.request({ op: "mode", unit: "bg", mode: "session" }))).toContain(
				"must remain persistent",
			);
		},
		TEST_TIMEOUT_MS,
	);
	it(
		"an unreadable detached log degrades that unit's refresh instead of failing describe and stop",
		async () => {
			const { conn, root } = await startDaemon();
			const opened = await conn.openProc(
				"stucklog",
				shProc("echo up; exec sleep 30", root, { ready: { log: "^up$", timeoutMs: 5_000 } }),
				{ policy: { hold: "detached" } },
			);
			expect(opened.unit.state).toBe("ready");

			// Replace the log file with a directory: stat succeeds, but reading it
			// fails on every platform and even when tests run as root.
			const logPath = path.join(root, "daemon", "units", opened.unit.id, "output.log");
			await fs.rm(logPath);
			await fs.mkdir(logPath);
			// Degradation is per file: a readable previous log must still serve.
			await fs.writeFile(path.join(path.dirname(logPath), "output.previous.log"), "earlier-output\n");
			const after = await logs(conn, "stucklog");
			expect(after.text).toContain("earlier-output");

			const described = await conn.describe("stucklog");
			expect(described.state).toBe("ready");

			const stopped = await conn.request({ op: "stop", unit: "stucklog", timeoutMs: 5_000 });
			expect(["stopped", "exited"]).toContain(stopped.unit.state);
			await until(() => (pidAlive(opened.unit.pids[0]) ? undefined : true), "detached child to exit");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a detached unit asking for a PTY is rejected at open and never reaches the board",
		async () => {
			const { conn, root } = await startDaemon();
			const message = await rejection(
				conn.openProc("ptybg", shProc("exec sleep 30", root, { pty: true }), { policy: { hold: "detached" } }),
			);

			expect(message).toContain("A detached service cannot allocate a PTY");
			const { units } = await conn.request({ op: "list" });
			expect(units.some(unit => unit.key === "ptybg")).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a completion reaches the owner's subscriber, is redelivered until acked (replay and resubscribe), and blocks reuse of the name while pending",
		async () => {
			const { daemon: d, conn: opener, root } = await startDaemon();
			const first = await d.connect();
			await first.request({ op: "subscribe", subscriptionId: "sub-1", owners: ["owner-a"] });
			await opener.openProc("job", shProc("echo finished", root), { owner: "owner-a" });

			const delivered = await first.event(completionOf("job"), "completion on the subscriber");
			expect(delivered.owner).toBe("owner-a");
			expect(delivered.unit).toMatchObject({ state: "exited", exitCode: 0 });
			expect(opener.events.some(completionOf("job"))).toBe(false);

			expect(await rejection(opener.openProc("job", shProc("exec sleep 30", root), { owner: "owner-a" }))).toContain(
				"unacknowledged completion",
			);

			await first.request({ op: "subscribe", subscriptionId: "sub-1", owners: ["owner-a"], replays: ["owner-a"] });
			await until(
				() => (first.events.filter(completionOf("job")).length >= 2 ? true : undefined),
				"replayed completion",
			);
			expect(new Set(first.events.filter(completionOf("job")).map(event => event.completionId))).toEqual(
				new Set([delivered.completionId]),
			);

			await first.close();
			const second = await d.connect();
			await second.request({ op: "subscribe", subscriptionId: "sub-2", owners: ["owner-a"] });
			const redelivered = await second.event(completionOf("job"), "completion after resubscribe");
			expect(redelivered.completionId).toBe(delivered.completionId);

			await second.request({ op: "subscribe", subscriptionId: "sub-2", owners: [], acks: [delivered.completionId] });
			const reopened = await opener.openProc("job", shProc("exec sleep 30", root), { owner: "owner-a" });
			expect(reopened.created).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"output lines matching the notify regex are reported to the owner's subscriber, and non-matching lines are not",
		async () => {
			const { daemon: d, conn: opener, root } = await startDaemon();
			const watcher = await d.connect();
			await watcher.request({ op: "subscribe", subscriptionId: "sub-n", owners: ["owner-n"] });
			await opener.openProc(
				"noisy",
				shProc('echo "ok one"; echo "ERROR disk full"; echo "ok two"; exec sleep 30', root, { notify: "ERROR" }),
				{ owner: "owner-n" },
			);

			const notice = await watcher.event(notifyOf("noisy"), "notify event");
			expect(notice.owner).toBe("owner-n");
			expect(notice.pattern).toBe("ERROR");
			expect(notice.lines.some(line => line.includes("ERROR disk full"))).toBe(true);
			expect(notice.lines.some(line => line.includes("ok"))).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
