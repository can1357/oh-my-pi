// Integration test: the bug is a broker that a shutdown reaches while it is still starting, and that
// goes on to open its native Unix-socket listener, or to take over recovered daemon records, after
// the shutdown has finished, so the scope lease is released with something still listening or
// running. The native listener, the lease and the reaped child processes are all real; each case
// holds startup at one real await, requests the shutdown through the callback a signal runs, and then
// observes the broker's own promises and real connections. No test code waits on a clock.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { FileLock, IpcServer, Process } from "@oh-my-pi/pi-natives";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const TOKEN = "shutdown-during-startup-token";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function writeToken(runtimeDir: string): Promise<void> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(runtimeDir, "broker.token"), TOKEN, { mode: 0o600 });
}

/** Start the broker on a scope whose token is {@link TOKEN}, settling into a value so a rejection is asserted. */
function startBroker(projectDir: string, runtimeDir: string): Promise<unknown> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "60000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker.then(
		() => "resolved",
		(error: unknown) => error,
	);
}

/** The callback the broker registers for process cleanup: what a SIGTERM runs to shut it down. */
function captureBrokerShutdown(): () => Promise<void> {
	let shutdown: ((reason: postmortem.Reason) => void | Promise<void>) | undefined;
	const register = postmortem.register.bind(postmortem);
	spyOn(postmortem, "register").mockImplementation((...args: Parameters<typeof postmortem.register>) => {
		if (args[0] === "daemon-broker") shutdown = args[1];
		return register(...args);
	});
	return async () => {
		if (!shutdown) throw new Error("the broker registered no shutdown callback");
		await shutdown(postmortem.Reason.SIGTERM);
	};
}

/** Run `observe` at the instant the broker drops its scope lease, to check what is still open then. */
function observeLeaseRelease(runtimeDir: string, observe: () => void): void {
	const pidPath = path.join(runtimeDir, "broker.pid");
	const tryAcquire = FileLock.tryAcquire.bind(FileLock);
	let observed = false;
	spyOn(FileLock, "tryAcquire").mockImplementation((lockPath: string) => {
		const lock = tryAcquire(lockPath);
		if (observed || lockPath !== pidPath || !lock.acquired) return lock;
		observed = true;
		const release = lock.release.bind(lock);
		spyOn(lock, "release").mockImplementation(() => {
			observe();
			release();
		});
		return lock;
	});
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

/** Whether the broker answers an authenticated ping on a new connection; one it will not serve closes unanswered. */
function answersPing(endpoint: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection(endpoint);
	const finish = (answered: boolean): void => {
		socket.destroy();
		resolve(answered);
	};
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ id: "probe", token: TOKEN, operation: { op: "ping" } })}\n`);
	});
	socket.once("data", () => finish(true));
	socket.once("close", () => finish(false));
	socket.once("error", () => finish(false));
	return promise;
}

/** Write the record a previous broker leaves for a non-detached daemon it was still running. */
async function seedRunningRecord(runtimeDir: string, cwd: string, name: string, pid: number): Promise<void> {
	const dir = path.join(runtimeDir, "daemons", name);
	const spec: DaemonSpec = {
		name,
		application: "sleep",
		args: ["3600"],
		env: {},
		cwd,
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
	};
	const daemon: DaemonSnapshot = {
		name,
		id: name,
		state: "running",
		pid,
		createdAt: 1,
		startedAt: 1,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	};
	await Bun.write(path.join(dir, "spec.json"), JSON.stringify(spec));
	await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon }));
}

function recordState(runtimeDir: string, name: string): DaemonSnapshot["state"] {
	const meta = JSON.parse(readFileSync(path.join(runtimeDir, "daemons", name, "meta.json"), "utf8")) as {
		daemon: DaemonSnapshot;
	};
	return meta.daemon.state;
}

describe.skipIf(process.platform === "win32")("daemon broker shutdown during startup", () => {
	const previousTitle = process.title;
	let leaked: IpcServer[] = [];

	afterEach(async () => {
		mock.restore();
		// Close is idempotent, so a server the broker already closed is unaffected.
		for (const server of leaked) await server.close();
		leaked = [];
		process.title = previousTitle;
	});

	it("serves no client and closes the server before the lease release when shutdown lands during the bind", async () => {
		using tempDir = TempDir.createSync("@omp-launch-shutdown-bind-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const endpoint = daemonBrokerEndpoint(runtimeDir);
		await fs.mkdir(projectDir);
		await writeToken(runtimeDir);
		const shutdown = captureBrokerShutdown();

		// The real bind runs, then its return to the broker is held, so the native listener is live
		// while the broker has not seen the server yet.
		const bound = Promise.withResolvers<void>();
		const returnBind = Promise.withResolvers<void>();
		let serverClosed = false;
		const listen = IpcServer.listen.bind(IpcServer);
		spyOn(IpcServer, "listen").mockImplementation(async (...args: Parameters<typeof IpcServer.listen>) => {
			const server = await listen(...args);
			leaked.push(server);
			const close = server.close.bind(server);
			spyOn(server, "close").mockImplementation(async () => {
				await close();
				serverClosed = true;
			});
			bound.resolve();
			await returnBind.promise;
			return server;
		});
		let closedAtLeaseRelease: boolean | undefined;
		observeLeaseRelease(runtimeDir, () => {
			closedAtLeaseRelease = serverClosed;
		});

		const broker = startBroker(projectDir, runtimeDir);
		try {
			await bound.promise;
			// The shutdown a signal requests finishes while the bind is still pending.
			await shutdown();
			const answeredAfterShutdown = await answersPing(endpoint);
			returnBind.resolve();

			expect(await broker).toBe("resolved");
			expect(answeredAfterShutdown).toBe(false);
			expect(closedAtLeaseRelease).toBe(true);
			expect(await acceptsConnection(endpoint)).toBe(false);
		} finally {
			returnBind.resolve();
		}
	}, 10_000);

	it("retires the record it is recovering when shutdown lands, adopts no more, and binds nothing", async () => {
		using tempDir = TempDir.createSync("@omp-launch-shutdown-recovery-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const endpoint = daemonBrokerEndpoint(runtimeDir);
		await fs.mkdir(projectDir);
		await writeToken(runtimeDir);
		// Live orphans of a previous broker. Recovery terminates a record's whole process group, so
		// each child leads its own; otherwise that would signal this test's group.
		const children = ["orphan-a", "orphan-b"].map(name => ({
			name,
			child: Bun.spawn(["sleep", "3600"], { detached: true, stdio: ["ignore", "ignore", "ignore"] }),
		}));
		try {
			for (const { name, child } of children) {
				expect(Process.fromPid(child.pid)?.groupId()).toBe(child.pid);
				await seedRunningRecord(runtimeDir, projectDir, name, child.pid);
			}
			const shutdown = captureBrokerShutdown();
			const binds: IpcServer[] = [];
			const listen = IpcServer.listen.bind(IpcServer);
			spyOn(IpcServer, "listen").mockImplementation(async (...args: Parameters<typeof IpcServer.listen>) => {
				const server = await listen(...args);
				leaked.push(server);
				binds.push(server);
				return server;
			});

			// Recovery's terminate of whichever record it reaches first is held, so the shutdown
			// lands while that record is half-recovered and the other is not yet read.
			const reaping = Promise.withResolvers<number>();
			const finishReaping = Promise.withResolvers<void>();
			const terminated: number[] = [];
			const fromPid = Process.fromPid.bind(Process);
			spyOn(Process, "fromPid").mockImplementation((pid: number) => {
				const processRef = fromPid(pid);
				if (!processRef || !children.some(({ child }) => child.pid === pid)) return processRef;
				const terminate = processRef.terminate.bind(processRef);
				spyOn(processRef, "terminate").mockImplementation(async (...args: Parameters<Process["terminate"]>) => {
					terminated.push(pid);
					if (terminated.length === 1) {
						reaping.resolve(pid);
						await finishReaping.promise;
					}
					return terminate(...args);
				});
				return processRef;
			});
			const statesAtLeaseRelease = new Map<string, DaemonSnapshot["state"]>();
			observeLeaseRelease(runtimeDir, () => {
				for (const { name } of children) statesAtLeaseRelease.set(name, recordState(runtimeDir, name));
			});

			const broker = startBroker(projectDir, runtimeDir);
			try {
				const reapedPid = await reaping.promise;
				const reaped = children.find(({ child }) => child.pid === reapedPid);
				const untouched = children.find(({ child }) => child.pid !== reapedPid);
				if (!reaped || !untouched) throw new Error("recovery reaped no seeded record");
				// A signal handler exits the process once this shutdown settles, so the record in
				// flight must be retired and written by then, not merely before the lease release.
				const stateWhenShutdownSettled = shutdown().then(() => recordState(runtimeDir, reaped.name));
				finishReaping.resolve();

				expect(await broker).toBe("resolved");
				expect(await stateWhenShutdownSettled).toBe("exited");
				expect(binds).toHaveLength(0);
				expect(await acceptsConnection(endpoint)).toBe(false);
				// The record in flight was reaped and its reaped state written before the lease
				// went; the one not yet read is left as the previous broker wrote it.
				expect(terminated).toEqual([reapedPid]);
				expect(statesAtLeaseRelease.get(reaped.name)).toBe("exited");
				expect(statesAtLeaseRelease.get(untouched.name)).toBe("running");
			} finally {
				finishReaping.resolve();
			}
		} finally {
			for (const { child } of children) {
				child.kill();
				await child.exited;
			}
		}
	}, 15_000);
});
