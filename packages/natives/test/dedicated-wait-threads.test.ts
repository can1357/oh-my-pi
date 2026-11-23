import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { PtySession, reapChild, spawnRaw } from "../native/index.js";

// A PTY control loop and a reapChild wait each last as long as their child.
// On Tokio's bounded blocking pool (8 threads on Windows) a few of them
// starve every later spawn_blocking task, so each runs on its own named thread.
const PTY_CONTROL_THREAD = "pi-pty-ctrl";
const REAP_THREAD = "pi-reap";
const THREAD_WAIT_MS = 1_000;

function threadNames(): string[] {
	return fs.readdirSync("/proc/self/task").flatMap(tid => {
		try {
			return [fs.readFileSync(`/proc/self/task/${tid}/comm`, "utf8").trim()];
		} catch {
			return [];
		}
	});
}

async function waitForThread(name: string): Promise<string[]> {
	const deadline = Date.now() + THREAD_WAIT_MS;
	let names = threadNames();
	while (!names.includes(name) && Date.now() < deadline) {
		await Bun.sleep(10);
		names = threadNames();
	}
	return names;
}

describe.skipIf(process.platform !== "linux")("dedicated wait threads", () => {
	it("runs a PTY session's control loop on its own thread", async () => {
		const session = new PtySession();
		const run = session.start({ command: "exec sleep 5", timeoutMs: 10_000, cols: 80, rows: 24 });
		try {
			expect(await waitForThread(PTY_CONTROL_THREAD)).toContain(PTY_CONTROL_THREAD);
		} finally {
			session.kill();
			await run.catch(() => undefined);
		}
	});

	it("waits for a reaped child on its own thread", async () => {
		const child = spawnRaw({
			application: "sleep",
			args: ["5"],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			cwd: process.cwd(),
		});
		for (const fd of [child.stdin, child.stdout, child.stderr]) fs.closeSync(fd);
		const reaped = reapChild(child.pid);
		try {
			expect(await waitForThread(REAP_THREAD)).toContain(REAP_THREAD);
		} finally {
			process.kill(child.pid, "SIGKILL");
		}
		expect(await reaped).toEqual({ exitCode: null, signal: 9 });
	});
});
