/**
 * `proc` units over processes the daemon did not launch (`o2ctl services add`): adoption keeps the
 * process (same pid), lists it, links the file its stdout writes as the unit log, and `stop`
 * kills it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GLOBAL_SCOPE } from "../../src/daemon/protocol";
import { pidAlive, rejection, TestDaemon, until } from "../fixtures/daemon-proc-harness";

const TEST_TIMEOUT_MS = 30_000;

let daemon: TestDaemon | undefined;
let child: Bun.Subprocess | undefined;

afterEach(async () => {
	child?.kill("SIGKILL");
	await child?.exited;
	child = undefined;
	await daemon?.dispose();
	daemon = undefined;
});

describe.skipIf(process.platform === "win32")("daemon adopted proc units", () => {
	it(
		"adopts a running process in place with its stdout file as the log, refuses a taken name, and stop kills it",
		async () => {
			const started = await TestDaemon.start();
			daemon = started.daemon;
			const { conn } = started;
			const root = daemon.root;
			const out = path.join(root, "nohup.out");
			const go = path.join(root, "go");
			child = Bun.spawn(
				["/bin/sh", "-c", `echo before; while [ ! -e "${go}" ]; do sleep 0.05; done; echo after; exec sleep 30`],
				{ cwd: root, stdin: "ignore", stdout: Bun.file(out), stderr: "ignore" },
			);
			const pid = child.pid;
			await until(
				async () => ((await fs.readFile(out, "utf8").catch(() => "")).includes("before") ? true : undefined),
				"first output",
			);

			const adopt = {
				op: "open",
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "web",
				adopt: pid,
				policy: { hold: "persist" },
				lease: false,
				awaitReady: false,
			} as const;
			const opened = await conn.request(adopt);
			expect(opened.unit.pids).toEqual([pid]);
			expect(opened.unit.adopted).toBe(true);
			expect(opened.unit.state).toBe("running");
			expect((await conn.request({ op: "list" })).units.map(unit => unit.key)).toContain("web");
			expect(await fs.readlink(path.join(daemon.dir, "units", opened.unit.id, "output.log"))).toBe(out);

			expect(await rejection(conn.request({ ...adopt, adopt: pid }))).toContain("already exists");

			await fs.writeFile(go, "");
			const tail = await until(async () => {
				const logs = await conn.request({
					op: "logs",
					unit: "web",
					lines: 10,
					head: false,
					follow: false,
					timeoutMs: 0,
				});
				return logs.text.includes("after") ? logs.text : undefined;
			}, "output written after adoption");
			expect(tail).toContain("before");
			expect(pidAlive(pid)).toBe(true);

			const stopped = await conn.request({ op: "stop", unit: "web", timeoutMs: 2_000 });
			expect(stopped.unit.state).toBe("exited");
			await child.exited;
			expect(pidAlive(pid)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
