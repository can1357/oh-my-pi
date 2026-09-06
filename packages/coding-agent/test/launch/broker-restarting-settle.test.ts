// Integration test — real timers are required (ts-no-test-timers exception): this spawns the
// actual cross-process daemon broker driving real child processes, and the bug is a leaked real
// `setTimeout` in #settle that resurrects a stopped daemon. Fake timers cannot control the OS
// process-exit promise or the unix-socket RPC the broker relies on. The embedded broker uses a
// shorter real backoff here; proving the absence of resurrection still requires crossing it.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonMonitorNotification,
	type DaemonSnapshot,
} from "../../src/launch/protocol";

const RESTART_BACKOFF_BASE_MS = 250;
const INITIAL_RESTART_DELAY_MS = RESTART_BACKOFF_BASE_MS * 2;
const RESTART_SETTLE_MARGIN_MS = 150;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions = {}): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment(options);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function snapshotOf(client: DaemonBrokerClient, name: string): Promise<DaemonSnapshot> {
	const listed = await client.request({ op: "list" });
	if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
	const daemon = listed.daemons.find(entry => entry.name === name);
	if (!daemon) throw new Error(`daemon ${name} not listed`);
	return daemon;
}

async function waitForState(
	client: DaemonBrokerClient,
	name: string,
	state: DaemonSnapshot["state"],
	deadlineMs: number,
): Promise<DaemonSnapshot> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const daemon = await snapshotOf(client, name);
		if (daemon.state === state) return daemon;
		await Bun.sleep(25);
	}
	throw new Error(`daemon ${name} never reached state ${state}`);
}

describe("daemon broker restart settling", () => {
	it("does not re-settle a restarting detached daemon on ops, keeping stop authoritative", async () => {
		using tempDir = TempDir.createSync("@omp-launch-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir, {
			restartBackoffBaseMs: RESTART_BACKOFF_BASE_MS,
		});
		const name = "crash-loop";
		const monitorNotifications: DaemonMonitorNotification[] = [];
		const monitorCompleted = Promise.withResolvers<void>();
		const unregisterMonitor = client.onOutput?.(
			{
				id: "crash-monitor",
				name,
				owner: "owner",
				artifactPath: path.join(tempDir.path(), "restart-progress.log"),
			},
			notification => {
				monitorNotifications.push(notification);
				if (notification.event === "daemon-monitor-completed") monitorCompleted.resolve();
			},
		);
		if (!unregisterMonitor) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				spec: {
					name,
					// Fast-exit child: exits 0 immediately, so restart:"always" parks it in `restarting`.
					application: process.execPath,
					args: ["-e", "process.exit(0)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: false,
					detached: true,
				},
			});
			expect(started.op).toBe("start");

			// Enter the restarting backoff window and record the restart count.
			const restarting = await waitForState(client, name, "restarting", 5_000);
			const baseline = restarting.restartCount;

			// Poll while restarting. Each op runs #refreshDetached; a re-entrant #settle would
			// phantom-increment restartCount and leak an armed timer (issue #6852).
			for (let i = 0; i < 3; i++) {
				const seen = await snapshotOf(client, name);
				expect(seen.state).toBe("restarting");
				expect(seen.restartCount).toBe(baseline);
			}

			// Stop must be authoritative: clears the single armed timer, no orphaned timer resurrects.
			const stopped = await client.request({ op: "stop", name, timeoutMs: 2_000 });
			if (stopped.op !== "stop") throw new Error(`unexpected result: ${stopped.op}`);
			expect(stopped.daemon.state).toBe("exited");
			await monitorCompleted.promise;
			expect(monitorNotifications.at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
				daemon: { name, state: "exited" },
			});

			// Cross the configured initial backoff where a leaked timer would fire #launch.
			await Bun.sleep(INITIAL_RESTART_DELAY_MS + RESTART_SETTLE_MARGIN_MS);
			const afterStop = await snapshotOf(client, name);
			expect(afterStop.state).toBe("exited");
			expect(afterStop.pid).toBeUndefined();
			expect(afterStop.restartCount).toBe(baseline);
		} finally {
			unregisterMonitor?.();
			await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 20_000);

	it("settles a recovered detached daemon once across concurrent refreshes", async () => {
		using tempDir = TempDir.createSync("@omp-launch-recovered-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		const name = "recovered-crash";
		let pid: number | undefined;

		const firstClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const firstBroker = startBroker(projectDir, runtimeDir);
		try {
			const started = await firstClient.request({
				op: "start",
				spec: {
					name,
					application: process.execPath,
					args: ["-e", 'Bun.serve({ port: 0, fetch() { return new Response("ok"); } })'],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "always",
					persist: true,
					detached: true,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected result: ${started.op}`);
			pid = started.daemon.pid;
			if (pid === undefined) throw new Error("detached daemon has no pid");
		} finally {
			await firstClient.request({ op: "shutdown" }).catch(() => undefined);
			firstClient.close();
			await firstBroker;
		}

		const secondClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const secondBroker = startBroker(projectDir, runtimeDir);
		try {
			const recovered = await snapshotOf(secondClient, name);
			expect(recovered.state).toBe("running");
			expect(recovered.pid).toBe(pid);

			const processRef = Process.fromPid(pid);
			if (!processRef) throw new Error(`recovered daemon process ${pid} is unavailable`);
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });

			// Both requests enter #settle before its detached-output read completes. The
			// post-read guard must let only one continuation settle this generation.
			const concurrentLists = await Promise.all([
				secondClient.request({ op: "list" }),
				secondClient.request({ op: "list" }),
			]);
			for (const listed of concurrentLists) {
				if (listed.op !== "list") throw new Error(`unexpected result: ${listed.op}`);
				const daemon = listed.daemons.find(entry => entry.name === name);
				expect(daemon?.state).toBe("restarting");
				expect(daemon?.restartCount).toBe(1);
			}
		} finally {
			await secondClient.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			await secondClient.request({ op: "shutdown" }).catch(() => undefined);
			secondClient.close();
			await secondBroker;
			const processRef = pid === undefined ? null : Process.fromPid(pid);
			if (processRef?.status() === "running") {
				await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			}
			process.title = previousTitle;
		}
	}, 20_000);
});
