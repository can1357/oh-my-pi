// Integration test — real timers are required (ts-no-test-timers exception): the bug is a broker
// that fails part-way through starting or shutting down and leaves its native Unix-socket server
// accepting connections, its run() pending, or the scope lease held. Fake timers cannot drive the
// native listener or a real daemon child, and the runtime-dir case depends on the broker's real
// scope-loss interval. Each case awaits the broker's own promise and then makes a real
// connection; no test code waits on a clock.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { FileLock, IpcServer, Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, options: DaemonBrokerStartOptions): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "60000";
	const broker = startDaemonBrokerFromEnvironment(options);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

/** Whether a real client can still connect to `endpoint`; a refused or missing socket fails at once. */
function acceptsConnection(endpoint: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection(endpoint);
	const finish = (connected: boolean): void => {
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	return promise;
}

/**
 * Wrap the real native bind so each test can close any server a regression leaks, and so a case can
 * act at the instant the bind completes. The bind itself is never faked.
 */
function captureBinds(afterBind?: () => Promise<void>): IpcServer[] {
	const servers: IpcServer[] = [];
	const listen = IpcServer.listen.bind(IpcServer);
	spyOn(IpcServer, "listen").mockImplementation(async (...args: Parameters<typeof IpcServer.listen>) => {
		const server = await listen(...args);
		servers.push(server);
		await afterBind?.();
		return server;
	});
	return servers;
}

describe.skipIf(process.platform === "win32")("daemon broker cleanup after a failure", () => {
	const previousTitle = process.title;
	let leaked: IpcServer[] = [];

	afterEach(async () => {
		mock.restore();
		// Close is idempotent, so a server the broker already closed is unaffected.
		for (const server of leaked) await server.close();
		leaked = [];
		process.title = previousTitle;
	});

	it("closes its server when startup fails after the bind", async () => {
		using tempDir = TempDir.createSync("@omp-launch-startup-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
		leaked = captureBinds();
		try {
			const failure = new Error("embedding host failed to connect its clients");
			const broker = startBroker(projectDir, runtimeDir, {
				onListening: () => {
					throw failure;
				},
			});
			await expect(broker).rejects.toBe(failure);
			expect(leaked).toHaveLength(1);
			// The caller sees a failed startup; nothing it no longer owns may still answer clients.
			expect(await acceptsConnection(daemonBrokerEndpoint(runtimeDir))).toBe(false);
		} finally {
			client.close();
		}
	}, 10_000);

	it("treats a runtime dir lost during the bind as scope loss and leaves nothing listening", async () => {
		using tempDir = TempDir.createSync("@omp-launch-startup-loss-");
		const projectDir = path.join(tempDir.path(), "project");
		// Too long for `sun_path`, so the socket is bound outside the runtime dir and survives its
		// deletion: a leaked server would stay reachable instead of losing its path with the dir.
		const runtimeDir = path.join(tempDir.path(), "long-runtime-".repeat(12));
		const endpoint = daemonBrokerEndpoint(runtimeDir);
		expect(endpoint.startsWith(runtimeDir)).toBe(false);
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
		leaked = captureBinds(() => fs.rm(runtimeDir, { recursive: true, force: true }));
		try {
			// The dir's identity is taken before the bind, so this loss is the steady-state kind: the
			// watcher releases the scope and startup ends normally rather than failing half-open.
			await startBroker(projectDir, runtimeDir, { endpointCheckMs: 10 });
			expect(leaked).toHaveLength(1);
			expect(await acceptsConnection(endpoint)).toBe(false);
		} finally {
			client.close();
		}
	}, 10_000);

	it("releases the scope lease when startup fails before the broker runs", async () => {
		using tempDir = TempDir.createSync("@omp-launch-startup-token-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir, { mode: 0o700 });
		await fs.writeFile(path.join(runtimeDir, "broker.token"), "", { mode: 0o600 });

		await expect(startBroker(projectDir, runtimeDir, {})).rejects.toThrow("Daemon broker token is empty");
		// A held lease would make every later broker for this scope exit at once.
		const lease = FileLock.tryAcquire(path.join(runtimeDir, "broker.pid"));
		try {
			expect(lease.acquired).toBe(true);
		} finally {
			lease.release();
		}
	}, 10_000);

	it("closes its server, ends run() and releases the lease when stopping a daemon fails", async () => {
		using tempDir = TempDir.createSync("@omp-launch-shutdown-failure-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
		leaked = captureBinds();
		const listening = Promise.withResolvers<void>();
		const broker = startBroker(projectDir, runtimeDir, { onListening: listening.resolve });
		// Settle into a value so the rejection is asserted rather than reported as unhandled.
		const settled = broker.then(
			() => "resolved",
			(error: unknown) => error,
		);
		let daemonPid: number | undefined;
		try {
			await listening.promise;
			// The child's interval only keeps the daemon alive until the test kills it.
			const started = await client.request({
				op: "start",
				spec: {
					name: "stop-refused",
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1_000)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error(`unexpected daemon result ${started.op}`);
			daemonPid = started.daemon.pid;
			expect(daemonPid).toBeNumber();

			// The native terminate is the only fault injected; the stop around it, the server close
			// and the lease release are all real.
			const failure = new Error("terminate refused");
			const fromPid = Process.fromPid.bind(Process);
			spyOn(Process, "fromPid").mockImplementation((pid: number) => {
				const processRef = fromPid(pid);
				if (processRef && pid === daemonPid) spyOn(processRef, "terminate").mockRejectedValue(failure);
				return processRef;
			});
			await client.request({ op: "shutdown" });

			// The failure surfaces through run() instead of stranding it, and the cleanup still ran.
			expect(await settled).toBe(failure);
			expect(await acceptsConnection(daemonBrokerEndpoint(runtimeDir))).toBe(false);
			const lease = FileLock.tryAcquire(path.join(runtimeDir, "broker.pid"));
			try {
				expect(lease.acquired).toBe(true);
			} finally {
				lease.release();
			}
		} finally {
			client.close();
			// The refused terminate left the daemon running.
			mock.restore();
			if (daemonPid !== undefined) await Process.fromPid(daemonPid)?.terminate({ group: true, timeoutMs: 2_000 });
		}
	}, 15_000);
});
