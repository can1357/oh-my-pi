// Integration test — real timers are required (ts-no-test-timers exception): the
// assertion is about real child-process I/O over a real PTY, where the injected
// bytes arrive asynchronously from the platform's console host. Fake timers
// cannot drive the pty reader or the daemon's socket RPC.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Start an in-process broker for `projectDir`, scoping its environment to the call. */
function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

/**
 * Supervising a PTY must not put bytes on the program's stdin. The PTY host
 * (`PSEUDOCONSOLE_INHERIT_CURSOR` on Windows) asks its client for the cursor
 * position when the session starts, and answering that query writes a cursor
 * report into the supervised program, which reads it as input the user never
 * typed. Only the PTY layer answers the host handshake; the supervisor stays
 * silent until the client sends something.
 *
 * On Windows this fails before the fix, where `#launchPty` answered the host's
 * own handshake a second time. On POSIX no host handshake emits `CSI 6 n`, so
 * there it pins the weaker — and still wanted — property that the supervisor
 * injects nothing at all; TS CI runs Linux only, so the Windows failure mode is
 * not what this test catches in CI. The POSIX half of the responder's behaviour
 * is pinned by the exact cursor report in `broker-output-snapshot.test.ts`.
 */
describe("supervised PTY startup input", () => {
	it("reports only the client's byte as the program's first input", async () => {
		using tempDir = TempDir.createSync("@omp-launch-pty-stdin-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "first-read.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	process.stdout.write("STDIN:" + JSON.stringify(chunk) + "\\n");
	process.exit(0);
});
process.stdout.write("READY\\n");
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "first-read",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: true,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();

			await client.request({ op: "send", name: "first-read", data: "q" });

			const completed = await client.request({ op: "wait", name: "first-read", for: "exit", timeoutMs: 6_000 });
			if (completed.op !== "wait") throw new Error("unexpected wait result");
			expect(completed.timedOut).toBeFalse();
			expect(completed.daemon.exitCode).toBe(0);

			const logs = await client.request({
				op: "logs",
				name: "first-read",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			if (logs.op !== "logs") throw new Error("unexpected logs result");
			expect(logs.text).toContain('STDIN:"q"');
			expect(logs.text).not.toContain('STDIN:"\\u001b');
		} finally {
			await client.request({ op: "stop", name: "first-read", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
		}
	}, 20_000);
});
