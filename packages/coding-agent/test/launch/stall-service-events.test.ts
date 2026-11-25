import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { daemonBuildId } from "../../src/daemon/build";
import { canonicalProjectDir, closeDaemonClient, daemonClient, probeDaemon } from "../../src/daemon/client";
import { daemonEndpoint, daemonTokenPath } from "../../src/daemon/paths";
import {
	DAEMON_DIR_ENV,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_TCP_ENV,
	type DaemonClient,
	type DaemonCompletionEvent,
	type DaemonRequest,
	type DaemonUnitEvent,
	type ProcSpec,
	projectScope,
	type UnitScope,
	type UnitSnapshot,
} from "../../src/daemon/protocol";
import { observeProjectServices } from "../../src/launch/services";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

interface ProtocolServerFixture {
	client: DaemonClient;
	requests: DaemonRequest[];
	currentSocket(): IpcConnection;
	rejectNextWatch(reason: string): void;
}

/** Socket-level client tests use a scripted protocol peer, not a daemon or child process. */
async function withProtocolServer(body: (fixture: ProtocolServerFixture) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-obs-gap-"));
	const previousDir = process.env[DAEMON_DIR_ENV];
	const previousTcp = process.env[DAEMON_TCP_ENV];
	await closeDaemonClient();
	process.env[DAEMON_DIR_ENV] = dir;
	delete process.env[DAEMON_TCP_ENV];
	await fs.writeFile(daemonTokenPath(), "test-token", { mode: 0o600 });
	const sockets = new Set<IpcConnection>();
	const requests: DaemonRequest[] = [];
	let currentSocket: IpcConnection | undefined;
	let nextWatchError: string | undefined;
	const server = await IpcServer.listen(daemonEndpoint(), { framing: "lines" }, socket => {
		currentSocket = socket;
		sockets.add(socket);
		let welcomed = false;
		socket.start(
			line => {
				if (!welcomed) {
					welcomed = true;
					socket.send(
						JSON.stringify({
							v: DAEMON_PROTOCOL_VERSION,
							daemon: { pid: process.pid, build: daemonBuildId(), startedAt: Date.now() },
							caps: {},
						}),
					);
					return;
				}
				const request = JSON.parse(line) as DaemonRequest;
				requests.push(request);
				if (request.op === "watch" && nextWatchError !== undefined) {
					const error = nextWatchError;
					nextWatchError = undefined;
					socket.send(JSON.stringify({ id: request.id, ok: false, error }));
					return;
				}
				const result =
					request.op === "ping"
						? { pid: process.pid, build: daemonBuildId() }
						: request.op === "list"
							? { units: [] }
							: {};
				socket.send(JSON.stringify({ id: request.id, ok: true, result }));
			},
			() => {
				sockets.delete(socket);
			},
		);
	});
	try {
		const client = await daemonClient();
		await body({
			client,
			requests,
			currentSocket: () => {
				if (!currentSocket) throw new Error("Diagnostic protocol client has not connected");
				return currentSocket;
			},
			rejectNextWatch: reason => {
				nextWatchError = reason;
			},
		});
	} finally {
		await closeDaemonClient();
		for (const socket of sockets) socket.destroy();
		await server.close();
		if (previousDir === undefined) delete process.env[DAEMON_DIR_ENV];
		else process.env[DAEMON_DIR_ENV] = previousDir;
		if (previousTcp !== undefined) process.env[DAEMON_TCP_ENV] = previousTcp;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

interface DaemonFixture {
	projectDir: string;
	scope: UnitScope;
	ownerClient: DaemonClient;
	monitorClient: DaemonClient;
	createClient(): Promise<DaemonClient>;
}

async function withDaemon(body: (fixture: DaemonFixture) => Promise<void>): Promise<void> {
	const harness = await IsolatedDaemon.create();
	const projectDir = path.join(harness.dir, "project");
	await fs.mkdir(projectDir, { recursive: true });
	const canonicalDir = await canonicalProjectDir(projectDir);
	const scope = projectScope(canonicalDir);
	const extraClients: DaemonClient[] = [];
	const createClient = async (): Promise<DaemonClient> => {
		const client = await probeDaemon();
		if (!client) throw new Error("Expected isolated daemon to be running");
		extraClients.push(client);
		return client;
	};
	try {
		const monitorClient = await daemonClient();
		harness.track(monitorClient.welcome.daemon.pid);
		const ownerClient = await createClient();
		await body({ projectDir, scope, ownerClient, monitorClient, createClient });
	} finally {
		for (const client of extraClients) client.close();
		await harness.dispose();
	}
}

function serviceProc(projectDir: string, exitCode = 0): ProcSpec {
	return {
		application: process.execPath,
		args: [
			"-e",
			`console.log('service-ready'); await Bun.stdin.stream().getReader().read(); process.exit(${exitCode})`,
		],
		env: {},
		cwd: projectDir,
		pty: false,
		ready: { log: "service-ready", timeoutMs: 5_000 },
	};
}

const sampleUnitEvent: DaemonUnitEvent = {
	ev: "unit",
	unit: {
		id: "unit-1",
		kind: "proc",
		scope: projectScope("/tmp/project"),
		key: "child-service",
		label: "child-service",
		generation: "gen-1",
		owner: "child-owner",
		state: "exited",
		pids: [],
		createdAt: 1,
		startedAt: 2,
		exitedAt: 3,
		exitCode: 0,
		restartCount: 0,
		outputBytes: 0,
		leases: 0,
		policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
		supervised: true,
	},
};

describe("diagnostic observation coverage gaps", () => {
	it("reports lost coverage once per disconnect and exposes reconnect watch failures without acking completions", async () => {
		await withProtocolServer(async ({ client, requests, currentSocket, rejectNextWatch }) => {
			const gaps: string[] = [];
			const disconnected = Promise.withResolvers<string>();
			const registrationFailed = Promise.withResolvers<string>();
			const observed = Promise.withResolvers<DaemonUnitEvent>();
			const unsubscribe = client.onUnit(event => observed.resolve(event), {
				keepAlive: false,
				onGap: reason => {
					gaps.push(reason);
					if (reason.includes("connection closed")) disconnected.resolve(reason);
					if (reason.includes("registration failed")) registrationFailed.resolve(reason);
				},
			});
			try {
				await client.request({ op: "ping" });
				rejectNextWatch("observer registration rejected");
				currentSocket().destroy();
				expect(await disconnected.promise).toContain("completions during the coverage gap are unavailable");
				expect(gaps).toHaveLength(1);
				expect(await registrationFailed.promise).toContain("observer registration rejected");
				expect(gaps).toHaveLength(2);
				await client.request({ op: "watch" });
				currentSocket().send(JSON.stringify(sampleUnitEvent));
				expect(await observed.promise).toEqual(sampleUnitEvent);
				await client.request({ op: "ping" });
				expect(requests.some(request => request.op === "subscribe")).toBe(false);
			} finally {
				unsubscribe();
			}
		});
	}, 10_000);

	it("does not report coverage gaps after unsubscribe or intentional client closure", async () => {
		for (const unsubscribeFirst of [false, true]) {
			const clientClosed = Promise.withResolvers<void>();
			const realConnect = IpcConnection.connect;
			const restoreStarts: Array<() => void> = [];
			const connect = spyOn(IpcConnection, "connect").mockImplementation(async (endpoint, options) => {
				const socket = await realConnect(endpoint, options);
				const realStart = socket.start;
				const start = spyOn(socket, "start").mockImplementation((onLine, onClose) => {
					realStart.call(socket, onLine, reason => {
						// Native client/server close callbacks are unordered. Signal only
						// after the actual client's close handler has finished.
						onClose(reason);
						clientClosed.resolve();
					});
				});
				restoreStarts.push(() => start.mockRestore());
				return socket;
			});
			try {
				await withProtocolServer(async ({ client }) => {
					const gaps: string[] = [];
					const unsubscribe = client.onUnit(() => undefined, {
						keepAlive: false,
						onGap: reason => gaps.push(reason),
					});
					await client.request({ op: "ping" });
					if (unsubscribeFirst) {
						unsubscribe();
						await client.request({ op: "ping" });
					}
					client.close();
					await clientClosed.promise;
					expect(gaps).toEqual([]);
				});
			} finally {
				connect.mockRestore();
				for (const restore of restoreStarts) restore();
			}
		}
	}, 10_000);
});

describe("authoritative observational service events", () => {
	it("neither steals the owned sink nor acknowledges its pending completion", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient }) => {
			const owned = Promise.withResolvers<DaemonCompletionEvent>();
			const observed = Promise.withResolvers<UnitSnapshot>();
			const releaseOwnedSink = Promise.withResolvers<void>();
			ownerClient.onCompletion("child-owner", async event => {
				owned.resolve(event);
				await releaseOwnedSink.promise;
			});
			const handle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit =>
				observed.resolve(unit),
			);
			try {
				await ownerClient.request({ op: "ping" });
				await ownerClient.open({
					kind: "proc",
					scope,
					key: "owned-failure",
					owner: "child-owner",
					proc: serviceProc(projectDir, 3),
					policy: { hold: "persist", restart: "no", survive: "exec" },
					lease: false,
				});
				await ownerClient.request({
					op: "send",
					unit: { kind: "proc", scope, key: "owned-failure" },
					data: "exit\n",
				});
				const [delivered, unit] = await Promise.all([owned.promise, observed.promise]);
				expect(unit.id).toBe(delivered.unit.id);
				expect(unit.state).toBe("failed");
				expect(unit.exitCode).toBe(3);
				expect(delivered.unit.state).toBe("failed");
				expect(delivered.unit.exitCode).toBe(3);
				// Diagnostic observation must never ack the pending completion while the owned sink is still in flight.
				expect(unit.owner).toBe("child-owner");
			} finally {
				releaseOwnedSink.resolve();
				handle.dispose();
			}
		});
	}, 20_000);

	it("observes explicit stops and launch failures without changing regular stop delivery", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient }) => {
			const observed: UnitSnapshot[] = [];
			const stopped = Promise.withResolvers<UnitSnapshot>();
			const failed = Promise.withResolvers<UnitSnapshot>();
			const delivered: DaemonCompletionEvent[] = [];
			ownerClient.onCompletion("child-owner", event => {
				delivered.push(event);
			});
			const handle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit => {
				observed.push(unit);
				if (unit.key === "stopped-service") stopped.resolve(unit);
				else if (unit.key === "launch-failure") failed.resolve(unit);
			});
			try {
				await ownerClient.request({ op: "ping" });
				await ownerClient.open({
					kind: "proc",
					scope,
					key: "stopped-service",
					owner: "child-owner",
					proc: serviceProc(projectDir),
					policy: { hold: "persist", restart: "no", survive: "exec" },
					lease: false,
				});
				await ownerClient.request({
					op: "stop",
					unit: { kind: "proc", scope, key: "stopped-service" },
					timeoutMs: 2_000,
				});
				const stoppedUnit = await stopped.promise;
				expect(stoppedUnit).toMatchObject({ state: "exited", owner: "child-owner" });
				expect(stoppedUnit.exitedAt).toBeNumber();
				await ownerClient.open({
					kind: "proc",
					scope,
					key: "launch-failure",
					owner: "child-owner",
					proc: {
						...serviceProc(projectDir),
						application: path.join(projectDir, "missing-executable"),
						ready: undefined,
					},
					policy: { hold: "persist", restart: "no", survive: "exec" },
					lease: false,
				});
				const failure = await failed.promise;
				expect(failure.state).toBe("failed");
				expect(failure.exitReason).toBeString();
				await waitFor(() => delivered.length >= 1, "owned launch-failure completion", 5_000);
				expect(delivered.map(({ unit }) => unit.key)).toEqual(["launch-failure"]);
				expect(observed.map(unit => unit.key)).toEqual(["stopped-service", "launch-failure"]);
			} finally {
				handle.dispose();
			}
		});
	}, 20_000);

	it("captures a restarting generation's prior exit and the explicit stop of its backoff", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient, monitorClient }) => {
			const observed: UnitSnapshot[] = [];
			const restarting = Promise.withResolvers<UnitSnapshot>();
			const delivered: DaemonCompletionEvent[] = [];
			ownerClient.onCompletion("child-owner", event => {
				delivered.push(event);
			});
			const handle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit => {
				observed.push(unit);
				if (unit.state === "restarting") restarting.resolve(unit);
			});
			try {
				await ownerClient.request({ op: "ping" });
				const started = await ownerClient.open({
					kind: "proc",
					scope,
					key: "restarting-service",
					owner: "child-owner",
					proc: serviceProc(projectDir, 4),
					policy: { hold: "persist", restart: "always", survive: "exec" },
					lease: false,
				});
				await ownerClient.request({
					op: "send",
					unit: { kind: "proc", scope, key: "restarting-service" },
					data: "exit\n",
				});
				const priorExit = await restarting.promise;
				expect(priorExit).toMatchObject({
					state: "restarting",
					exitCode: 4,
					restartCount: 1,
					startedAt: started.unit.startedAt,
					pids: [],
				});
				expect(priorExit.readyAt).toBeUndefined();
				expect(priorExit.exitedAt).toBeNumber();
				await ownerClient.request({
					op: "restart",
					unit: { kind: "proc", scope, key: "restarting-service" },
				});
				await ownerClient.request({
					op: "wait",
					unit: { kind: "proc", scope, key: "restarting-service" },
					for: "ready",
					timeoutMs: 5_000,
				});
				await monitorClient.request({ op: "ping" });
				expect(observed.map(unit => unit.state)).toEqual(["restarting", "exited"]);
				expect(delivered).toEqual([]);
			} finally {
				handle.dispose();
			}
		});
	}, 20_000);

	it("observes a concurrent explicit backoff stop once without manufacturing owned delivery", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient, monitorClient }) => {
			const observed: UnitSnapshot[] = [];
			const restarting = Promise.withResolvers<void>();
			const stopped = Promise.withResolvers<UnitSnapshot>();
			const delivered: DaemonCompletionEvent[] = [];
			ownerClient.onCompletion("child-owner", event => {
				delivered.push(event);
			});
			const handle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit => {
				observed.push(unit);
				if (unit.state === "restarting") restarting.resolve();
				else if (unit.state === "exited") stopped.resolve(unit);
			});
			try {
				await ownerClient.request({ op: "ping" });
				const started = await ownerClient.open({
					kind: "proc",
					scope,
					key: "backoff-stop-service",
					owner: "child-owner",
					proc: serviceProc(projectDir, 4),
					policy: { hold: "persist", restart: "always", survive: "exec" },
					lease: false,
				});
				await ownerClient.request({
					op: "send",
					unit: { kind: "proc", scope, key: "backoff-stop-service" },
					data: "exit\n",
				});
				await restarting.promise;
				const ref = { kind: "proc", scope, key: "backoff-stop-service" };
				await Promise.all([
					ownerClient.request({ op: "stop", unit: ref, timeoutMs: 2_000 }),
					ownerClient.request({ op: "stop", unit: ref, timeoutMs: 2_000 }),
				]);
				expect(await stopped.promise).toMatchObject({
					id: started.unit.id,
					state: "exited",
					restartCount: 1,
					pids: [],
				});
				await monitorClient.request({ op: "ping" });
				expect(observed.map(unit => unit.state)).toEqual(["restarting", "exited"]);
				expect(delivered).toEqual([]);
			} finally {
				handle.dispose();
			}
		});
	}, 20_000);

	it("continues observing a parked child after its connection closes and preserves owned replay", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient, monitorClient, createClient }) => {
			const observed = Promise.withResolvers<UnitSnapshot>();
			const parkedDeliveries: DaemonCompletionEvent[] = [];
			const park = ownerClient.onCompletion("parked-child", event => {
				parkedDeliveries.push(event);
			});
			const handle = await observeProjectServices(projectDir, new Set(["parked-child"]), unit =>
				observed.resolve(unit),
			);
			try {
				await ownerClient.request({ op: "ping" });
				await ownerClient.open({
					kind: "proc",
					scope,
					key: "parked-service",
					owner: "parked-child",
					proc: serviceProc(projectDir, 5),
					policy: { hold: "persist", restart: "no", survive: "exec" },
					lease: false,
				});
				park({ preservePending: true });
				await ownerClient.request({ op: "ping" });
				ownerClient.close();
				await monitorClient.request({
					op: "send",
					unit: { kind: "proc", scope, key: "parked-service" },
					data: "exit\n",
				});
				const unit = await observed.promise;
				expect(unit.owner).toBe("parked-child");
				expect(unit.exitCode).toBe(5);
				expect(parkedDeliveries).toEqual([]);
				const resumedClient = await createClient();
				const replayed = Promise.withResolvers<DaemonCompletionEvent>();
				resumedClient.onCompletion("parked-child", replay => replayed.resolve(replay));
				await resumedClient.request({ op: "ping" });
				const replayedEvent = await replayed.promise;
				expect(replayedEvent.owner).toBe("parked-child");
				expect(replayedEvent.unit.id).toBe(unit.id);
				expect(replayedEvent.unit.exitCode).toBe(5);
			} finally {
				handle.dispose();
			}
		});
	}, 20_000);

	it("scopes owners per observer handle and lets overlapping subscriptions dispose independently", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient, monitorClient }) => {
			const first: UnitSnapshot[] = [];
			const second: UnitSnapshot[] = [];
			const unrelated: UnitSnapshot[] = [];
			const firstHandle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit =>
				first.push(unit),
			);
			const secondHandle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit =>
				second.push(unit),
			);
			const unrelatedHandle = await observeProjectServices(projectDir, new Set(["unrelated-owner"]), unit =>
				unrelated.push(unit),
			);
			try {
				for (const [key, owner] of [
					["unrelated-service", "unrelated-owner"],
					["first-child", "child-owner"],
				] as const) {
					await ownerClient.open({
						kind: "proc",
						scope,
						key,
						owner,
						proc: serviceProc(projectDir),
						policy: { hold: "persist", restart: "no", survive: "exec" },
						lease: false,
					});
					await ownerClient.request({ op: "stop", unit: { kind: "proc", scope, key }, timeoutMs: 2_000 });
				}
				await monitorClient.request({ op: "ping" });
				expect(first.map(unit => unit.key)).toEqual(["first-child"]);
				expect(second.map(unit => unit.key)).toEqual(["first-child"]);
				expect(unrelated.map(unit => unit.key)).toEqual(["unrelated-service"]);
				firstHandle.dispose();
				await ownerClient.open({
					kind: "proc",
					scope,
					key: "second-child",
					owner: "child-owner",
					proc: serviceProc(projectDir),
					policy: { hold: "persist", restart: "no", survive: "exec" },
					lease: false,
				});
				await ownerClient.request({
					op: "stop",
					unit: { kind: "proc", scope, key: "second-child" },
					timeoutMs: 2_000,
				});
				await monitorClient.request({ op: "ping" });
				expect(first).toHaveLength(1);
				expect(second.map(unit => unit.key)).toEqual(["first-child", "second-child"]);
				secondHandle.dispose();
				secondHandle.dispose();
				await ownerClient.open({
					kind: "proc",
					scope,
					key: "unobserved-child",
					owner: "child-owner",
					proc: serviceProc(projectDir),
					policy: { hold: "persist", restart: "no", survive: "exec" },
					lease: false,
				});
				await ownerClient.request({
					op: "stop",
					unit: { kind: "proc", scope, key: "unobserved-child" },
					timeoutMs: 2_000,
				});
				await monitorClient.request({ op: "ping" });
				expect(second).toHaveLength(2);
				expect(unrelated).toHaveLength(1);
			} finally {
				firstHandle.dispose();
				secondHandle.dispose();
				unrelatedHandle.dispose();
			}
		});
	}, 25_000);

	it("captures every opted-in terminal event beyond the daemon's ten-entry terminal history cap", async () => {
		await withDaemon(async ({ projectDir, scope, ownerClient }) => {
			const observed: UnitSnapshot[] = [];
			let next = Promise.withResolvers<UnitSnapshot>();
			const handle = await observeProjectServices(projectDir, new Set(["child-owner"]), unit => {
				observed.push(unit);
				next.resolve(unit);
			});
			try {
				for (let index = 0; index < 12; index++) {
					next = Promise.withResolvers<UnitSnapshot>();
					const key = `finished-child-${index}`;
					await ownerClient.open({
						kind: "proc",
						scope,
						key,
						owner: "child-owner",
						proc: { ...serviceProc(projectDir), args: ["-e", "process.exit(0)"], ready: undefined },
						policy: { hold: "persist", restart: "no", survive: "exec" },
						lease: false,
					});
					expect((await next.promise).key).toBe(key);
				}
				const listed = await handle.list();
				expect(listed).toHaveLength(10);
				expect(observed.map(unit => unit.key)).toEqual(
					Array.from({ length: 12 }, (_, index) => `finished-child-${index}`),
				);
			} finally {
				handle.dispose();
			}
		});
	}, 30_000);
});
