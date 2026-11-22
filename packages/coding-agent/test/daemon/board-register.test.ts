/**
 * `register`/`unregister` of client-owned processes (`external` units) and the
 * `registerOnBoard` helper, against a real daemon isolated in a temp dir.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { closeDaemonClient, daemonClient, registerOnBoard } from "../../src/daemon/client";
import {
	DAEMON_DIR_ENV,
	DAEMON_TCP_ENV,
	type DaemonEvent,
	type DaemonUnitEvent,
	type UnitScope,
} from "../../src/daemon/protocol";
import { type DaemonConn, rejection, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;
const SCOPE: UnitScope = { kind: "session", id: "board-test-session" };

let daemon: TestDaemon | undefined;
let child: Bun.Subprocess | undefined;
let restoreEnv: (() => void) | undefined;

afterEach(async () => {
	await closeDaemonClient();
	restoreEnv?.();
	restoreEnv = undefined;
	child?.kill("SIGKILL");
	child = undefined;
	await daemon?.dispose();
	daemon = undefined;
});

async function startDaemon(): Promise<{ daemon: TestDaemon; conn: DaemonConn }> {
	const started = await TestDaemon.start();
	daemon = started.daemon;
	return started;
}

/** A live process to list: never this test runner, which the harness would kill on dispose. */
function spawnListedProcess(): number {
	child = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	return child.pid;
}

/** Point this process's shared daemon client at `target` until the test ends. */
function useSharedClient(target: TestDaemon): void {
	const previousDir = process.env[DAEMON_DIR_ENV];
	const previousTcp = process.env[DAEMON_TCP_ENV];
	process.env[DAEMON_DIR_ENV] = target.dir;
	delete process.env[DAEMON_TCP_ENV];
	restoreEnv = () => {
		if (previousDir === undefined) delete process.env[DAEMON_DIR_ENV];
		else process.env[DAEMON_DIR_ENV] = previousDir;
		if (previousTcp !== undefined) process.env[DAEMON_TCP_ENV] = previousTcp;
	};
}

async function listedKeys(conn: DaemonConn): Promise<string[]> {
	const { units } = await conn.request({ op: "list", scope: SCOPE });
	return units.map(unit => unit.key);
}

function unitEvent(key: string, removed: boolean) {
	return (event: DaemonEvent): event is DaemonUnitEvent =>
		event.ev === "unit" && event.unit.key === key && (event.removed === true) === removed;
}

describe.skipIf(process.platform === "win32")("daemon board registrations", () => {
	it(
		"lists a registered process unsupervised and removes it on unregister",
		async () => {
			const { conn } = await startDaemon();
			const pid = spawnListedProcess();

			const { unit } = await conn.request({
				op: "register",
				kind: "external",
				scope: SCOPE,
				key: "js-eval:1",
				label: "js eval",
				pid,
			});
			const { units } = await conn.request({ op: "list", scope: SCOPE });
			const listed = units.find(candidate => candidate.id === unit.id);
			expect(listed).toMatchObject({
				kind: "external",
				scope: SCOPE,
				key: "js-eval:1",
				label: "js eval",
				pids: [pid],
				supervised: false,
			});

			expect(await conn.request({ op: "unregister", unit: unit.id })).toEqual({ removed: true });
			expect(await listedKeys(conn)).not.toContain("js-eval:1");
			// Already gone: resolves quietly.
			expect(await conn.request({ op: "unregister", unit: unit.id })).toEqual({ removed: false });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"drops a registration when its connection closes and refuses other connections' unregister",
		async () => {
			const { daemon: d, conn: observer } = await startDaemon();
			const owner = await d.connect();
			const pid = spawnListedProcess();
			const { unit } = await owner.request({
				op: "register",
				kind: "external",
				scope: SCOPE,
				key: "pty:1",
				label: "pty: vim",
				pid,
			});

			expect(await rejection(observer.request({ op: "unregister", unit: unit.id }))).toContain(
				"not registered by this connection",
			);
			expect(await listedKeys(observer)).toContain("pty:1");

			await owner.close();
			await until(async () => ((await listedKeys(observer)).includes("pty:1") ? undefined : true), "unit removed");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"registerOnBoard lists the process and takes it off on dispose",
		async () => {
			const { daemon: d, conn } = await startDaemon();
			useSharedClient(d);
			await daemonClient();
			const pid = spawnListedProcess();

			const entry = registerOnBoard({ kind: "external", scope: SCOPE, key: "python-eval:1", label: "py", pid });
			await until(async () => ((await listedKeys(conn)).includes("python-eval:1") ? true : undefined), "listed");
			entry.dispose();
			await until(async () => ((await listedKeys(conn)).includes("python-eval:1") ? undefined : true), "removed");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"registerOnBoard unregisters a registration whose reply arrives after dispose",
		async () => {
			const { daemon: d, conn: watcher } = await startDaemon();
			await watcher.request({ op: "watch" });
			useSharedClient(d);
			await daemonClient();
			const pid = spawnListedProcess();

			const entry = registerOnBoard({ kind: "external", scope: SCOPE, key: "late:1", label: "late", pid });
			// Let the `register` line go out; its reply needs an I/O turn, so dispose lands first.
			for (let tick = 0; tick < 50; tick++) await Promise.resolve();
			entry.dispose();

			const added = await watcher.event(unitEvent("late:1", false), "registration reached the daemon");
			const removed = await watcher.event(unitEvent("late:1", true), "late registration removed");
			expect(removed.unit.id).toBe(added.unit.id);
			expect(await listedKeys(watcher)).not.toContain("late:1");
		},
		TEST_TIMEOUT_MS,
	);
});
