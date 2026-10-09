import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonWireRequest,
	parseDaemonWireMessage,
	parseDaemonWireRequest,
} from "../../src/launch/protocol";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";

interface BrokerFixture {
	projectDir: string;
	runtimeDir: string;
	ownerClient: DaemonBrokerClient;
	monitorClient: DaemonBrokerClient;
	createClient(): Promise<DaemonBrokerClient>;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function withBroker(
	body: (fixture: BrokerFixture) => Promise<void>,
	options: DaemonBrokerStartOptions = {},
): Promise<void> {
	using tempDir = TempDir.createSync("@omp-stall-service-events-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const clients: DaemonBrokerClient[] = [];
	const createClient = async (): Promise<DaemonBrokerClient> => {
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		clients.push(client);
		return client;
	};
	// Create the token before the embedded broker reads it, and wait for its lease before connecting.
	const ownerClient = await createClient();
	const monitorClient = await createClient();
	const previousTitle = process.title;
	const previousProcessName =
		process.platform === "linux" ? (await fs.readFile("/proc/self/comm", "utf8")).replace(/\n$/, "") : previousTitle;
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ ...options, onListening: () => listening.resolve(true) });
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	try {
		if (!(await Promise.race([listening.promise, finished.then(() => false)]))) {
			throw new Error("Embedded diagnostic test broker did not claim its scope");
		}
		await body({ projectDir, runtimeDir, ownerClient, monitorClient, createClient });
	} finally {
		await monitorClient.request({ op: "shutdown" }).catch(() => undefined);
		for (const client of clients) client.close();
		await finished;
		setProcessName(previousProcessName);
		process.title = previousTitle;
	}
}

interface ProtocolServerFixture {
	client: DaemonBrokerClient;
	requests: DaemonWireRequest[];
	currentSocket(): net.Socket;
	rejectNextRequest(reason: string): void;
}

/** Socket-level client tests use a scripted protocol peer, not a daemon or child process. */
async function withProtocolServer(body: (fixture: ProtocolServerFixture) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@omp-service-observation-gap-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
	const sockets = new Set<net.Socket>();
	const requests: DaemonWireRequest[] = [];
	let currentSocket: net.Socket | undefined;
	let nextError: string | undefined;
	const server = net.createServer(socket => {
		currentSocket = socket;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const request = parseDaemonWireRequest(JSON.parse(buffer.slice(0, newline)));
				buffer = buffer.slice(newline + 1);
				requests.push(request);
				const error = nextError;
				nextError = undefined;
				socket.write(
					`${JSON.stringify(
						error === undefined
							? { id: request.id, ok: true, result: { op: "ping", projectDir: client.projectDir } }
							: { id: request.id, ok: false, error },
					)}\n`,
				);
			}
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(daemonBrokerEndpoint(client.projectDir, runtimeDir), resolve);
		});
		await body({
			client,
			requests,
			currentSocket: () => {
				if (!currentSocket) throw new Error("Diagnostic protocol client has not connected");
				return currentSocket;
			},
			rejectNextRequest: reason => {
				nextError = reason;
			},
		});
	} finally {
		client.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

function serviceSpec(projectDir: string, name: string, exitCode = 0): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args: [
			"-e",
			`console.log('service-ready'); await Bun.stdin.stream().getReader().read(); process.exit(${exitCode})`,
		],
		env: {},
		cwd: projectDir,
		pty: false,
		ready: { log: "service-ready", timeoutMs: 5_000 },
		restart: "no",
		persist: false,
		detached: false,
	};
}

const completion: DaemonCompletionNotification = {
	event: "daemon-completed",
	completionId: "completion-1",
	owner: "child-owner",
	daemon: {
		name: "child-service",
		id: "daemon-1",
		owner: "child-owner",
		state: "exited",
		createdAt: 1,
		startedAt: 2,
		exitedAt: 3,
		exitCode: 0,
		restartCount: 0,
		outputBytes: 0,
		persist: false,
		detached: false,
	},
};

describe("diagnostic service event protocol", () => {
	it("decodes diagnostic registrations independently of owned subscriptions and acknowledgements", () => {
		const request = parseDaemonWireRequest({
			id: "request-1",
			token: "token-1",
			owners: ["regular-owner"],
			observedOwners: ["child-owner", "parked-owner"],
			completionAcks: ["regular-completion"],
			operation: { op: "ping" },
		});
		expect(request.observedOwners).toEqual(["child-owner", "parked-owner"]);
		expect(request.owners).toEqual(["regular-owner"]);
		expect(request.completionAcks).toEqual(["regular-completion"]);
		expect(() => parseDaemonWireRequest({ ...request, observedOwners: [1] })).toThrow(
			"request.observedOwners item must be a string",
		);
	});

	it("decodes observations as a distinct event and validates the nested snapshot", () => {
		const notification: DaemonCompletionNotification = {
			...completion,
			daemon: { ...completion.daemon, state: "restarting", restartCount: 1 },
		};
		expect(parseDaemonWireMessage({ event: "daemon-observed", notification })).toEqual({
			event: "daemon-observed",
			notification,
		});
		expect(parseDaemonWireMessage(completion)).toEqual(completion);
		expect(() =>
			parseDaemonWireMessage({ event: "daemon-observed", notification: { ...completion, event: "other" } }),
		).toThrow("completion.event must be daemon-completed");
		expect(() =>
			parseDaemonWireMessage({
				event: "daemon-observed",
				notification: { ...completion, daemon: { ...completion.daemon, state: "other" } },
			}),
		).toThrow("Unknown daemon state");
	});
});

describe("diagnostic observation coverage gaps", () => {
	it("publishes acknowledged diagnostic scopes separately from owned subscriptions and clears the cached scope", async () => {
		await withProtocolServer(async ({ client, requests }) => {
			client.onCompletion("regular-owner", () => undefined);
			const unsubscribe = client.observeOwners(["child-owner"], () => undefined);
			await client.request({ op: "ping" });
			await client.request({ op: "ping" });
			const registrations = () => requests.filter(request => request.observedOwners !== undefined);
			expect(registrations().map(request => request.observedOwners)).toEqual([["child-owner"]]);
			for (const request of registrations()) {
				expect(request.owners).toBeUndefined();
				expect(request.detachedOwners).toBeUndefined();
				expect(request.completionEvents).toBeUndefined();
				expect(request.completionAcks).toBeUndefined();
				expect(request.completionUnsubscribes).toBeUndefined();
				expect(request.completionSubscriptionId).toBeUndefined();
			}
			unsubscribe();
			await client.request({ op: "ping" });
			await client.request({ op: "ping" });
			expect(registrations().map(request => request.observedOwners)).toEqual([["child-owner"], []]);
			const unsubscribeAgain = client.observeOwners(["child-owner"], () => undefined);
			await client.request({ op: "ping" });
			expect(registrations().map(request => request.observedOwners)).toEqual([["child-owner"], [], ["child-owner"]]);
			unsubscribeAgain();
			await client.request({ op: "ping" });
		});
	}, 10_000);

	it("retries a rejected empty scope instead of caching an unacknowledged unsubscribe", async () => {
		await withProtocolServer(async ({ client, requests, rejectNextRequest }) => {
			const unsubscribe = client.observeOwners(["child-owner"], () => undefined);
			await client.request({ op: "ping" });
			rejectNextRequest("scope clear rejected");
			unsubscribe();
			await expect(client.request({ op: "ping" })).rejects.toThrow("scope clear rejected");
			await client.request({ op: "ping" });
			expect(
				requests.filter(request => request.observedOwners !== undefined).map(request => request.observedOwners),
			).toEqual([["child-owner"], [], []]);
		});
	}, 10_000);

	it("reports lost coverage once per registration and exposes reconnect registration failures without acking observations", async () => {
		await withProtocolServer(async ({ client, requests, currentSocket, rejectNextRequest }) => {
			const gaps: string[] = [];
			const disconnected = Promise.withResolvers<string>();
			const registrationFailed = Promise.withResolvers<string>();
			const observed = Promise.withResolvers<DaemonCompletionNotification>();
			client.observeOwners(
				["child-owner", "parked-owner"],
				notification => observed.resolve(notification),
				reason => {
					gaps.push(reason);
					if (reason.includes("connection closed")) disconnected.resolve(reason);
					if (reason.includes("registration failed")) registrationFailed.resolve(reason);
				},
			);
			await client.request({ op: "ping" });
			rejectNextRequest("observer registration rejected");
			currentSocket().destroy();
			expect(await disconnected.promise).toContain("completions during the coverage gap are unavailable");
			expect(gaps).toHaveLength(1);
			expect(await registrationFailed.promise).toContain("observer registration rejected");
			expect(gaps).toHaveLength(2);
			await client.request({ op: "ping" });
			currentSocket().write(`${JSON.stringify({ event: "daemon-observed", notification: completion })}\n`);
			expect(await observed.promise).toEqual(completion);
			await client.request({ op: "ping" });
			expect(requests.every(request => (request.completionAcks?.length ?? 0) === 0)).toBe(true);
		});
	}, 10_000);

	it("does not report coverage gaps after unsubscribe or intentional client closure", async () => {
		for (const unsubscribeFirst of [false, true]) {
			await withProtocolServer(async ({ client, currentSocket }) => {
				const gaps: string[] = [];
				const unsubscribe = client.observeOwners(
					["child-owner"],
					() => undefined,
					reason => gaps.push(reason),
				);
				await client.request({ op: "ping" });
				if (unsubscribeFirst) {
					unsubscribe();
					await client.request({ op: "ping" });
				}
				const closed = Promise.withResolvers<void>();
				currentSocket().once("close", () => closed.resolve());
				client.close();
				await closed.promise;
				expect(gaps).toEqual([]);
			});
		}
	}, 10_000);
});

describe("authoritative observational service events", () => {
	it("neither steals the owned sink nor acknowledges its pending completion", async () => {
		await withBroker(async ({ projectDir, runtimeDir, ownerClient, monitorClient }) => {
			const owned = Promise.withResolvers<DaemonCompletionNotification>();
			const localObservation = Promise.withResolvers<DaemonCompletionNotification>();
			const remoteObservation = Promise.withResolvers<DaemonCompletionNotification>();
			const releaseOwnedSink = Promise.withResolvers<void>();
			ownerClient.onCompletion("child-owner", async notification => {
				owned.resolve(notification);
				await releaseOwnedSink.promise;
			});
			ownerClient.observeOwners(["child-owner"], notification => localObservation.resolve(notification));
			monitorClient.observeOwners(["child-owner"], notification => remoteObservation.resolve(notification));
			try {
				await monitorClient.request({ op: "ping" });
				await ownerClient.request({
					op: "start",
					owner: "child-owner",
					spec: serviceSpec(projectDir, "owned-failure", 3),
				});
				await ownerClient.request({ op: "send", name: "owned-failure", data: "exit\n" });
				const [delivered, local, remote] = await Promise.all([
					owned.promise,
					localObservation.promise,
					remoteObservation.promise,
				]);
				expect(local).toEqual(delivered);
				expect(remote).toEqual(delivered);
				expect(delivered.daemon.state).toBe("failed");
				expect(delivered.daemon.exitCode).toBe(3);
				// The regular sink is still pending: diagnostic callbacks must not write an ack.
				const metadata = await Bun.file(path.join(runtimeDir, "daemons", "owned-failure", "meta.json")).json();
				expect(metadata.pendingCompletions.map((item: DaemonCompletionNotification) => item.completionId)).toEqual([
					delivered.completionId,
				]);
			} finally {
				releaseOwnedSink.resolve();
			}
		});
	}, 15_000);

	it("observes explicit stops and launch failures without changing regular stop delivery", async () => {
		await withBroker(async ({ projectDir, ownerClient, monitorClient }) => {
			const observed: DaemonCompletionNotification[] = [];
			const stopped = Promise.withResolvers<DaemonCompletionNotification>();
			const failed = Promise.withResolvers<DaemonCompletionNotification>();
			const delivered: DaemonCompletionNotification[] = [];
			ownerClient.onCompletion("child-owner", notification => {
				delivered.push(notification);
			});
			monitorClient.observeOwners(["child-owner"], notification => {
				observed.push(notification);
				if (notification.daemon.name === "stopped-service") stopped.resolve(notification);
				else failed.resolve(notification);
			});
			await monitorClient.request({ op: "ping" });
			await ownerClient.request({
				op: "start",
				owner: "child-owner",
				spec: serviceSpec(projectDir, "stopped-service"),
			});
			await ownerClient.request({ op: "stop", name: "stopped-service", timeoutMs: 2_000 });
			expect((await stopped.promise).daemon).toMatchObject({ state: "exited", owner: "child-owner" });
			expect((await stopped.promise).daemon.exitedAt).toBeNumber();
			await ownerClient.request({
				op: "start",
				owner: "child-owner",
				spec: {
					...serviceSpec(projectDir, "launch-failure"),
					application: path.join(projectDir, "missing-executable"),
					ready: undefined,
				},
			});
			const failure = await failed.promise;
			expect(failure.daemon.state).toBe("failed");
			expect(failure.daemon.exitReason).toBeString();
			await ownerClient.request({ op: "ping" });
			expect(delivered.map(({ daemon }) => daemon.name)).toEqual(["launch-failure"]);
			expect(observed.map(({ daemon }) => daemon.name)).toEqual(["stopped-service", "launch-failure"]);
		});
	}, 15_000);

	it("captures a restarting generation's prior exit and the explicit stop of its backoff", async () => {
		await withBroker(
			async ({ projectDir, ownerClient, monitorClient }) => {
				const observed: DaemonCompletionNotification[] = [];
				const restarting = Promise.withResolvers<DaemonCompletionNotification>();
				const delivered: DaemonCompletionNotification[] = [];
				ownerClient.onCompletion("child-owner", notification => {
					delivered.push(notification);
				});
				monitorClient.observeOwners(["child-owner"], notification => {
					observed.push(notification);
					if (notification.daemon.state === "restarting") restarting.resolve(notification);
				});
				await monitorClient.request({ op: "ping" });
				const started = await ownerClient.request({
					op: "start",
					owner: "child-owner",
					spec: { ...serviceSpec(projectDir, "restarting-service", 4), restart: "always" },
				});
				if (started.op !== "start") throw new Error("Expected service start");
				await ownerClient.request({ op: "send", name: "restarting-service", data: "exit\n" });
				const priorExit = await restarting.promise;
				expect(priorExit.daemon).toMatchObject({
					state: "restarting",
					exitCode: 4,
					restartCount: 1,
					startedAt: started.daemon.startedAt,
				});
				expect(priorExit.daemon.pid).toBeUndefined();
				expect(priorExit.daemon.readyAt).toBeUndefined();
				expect(priorExit.daemon.exitedAt).toBeNumber();
				await ownerClient.request({ op: "restart", name: "restarting-service" });
				await ownerClient.request({ op: "wait", name: "restarting-service", for: "ready", timeoutMs: 5_000 });
				await monitorClient.request({ op: "ping" });
				expect(observed.map(({ daemon }) => daemon.state)).toEqual(["restarting", "exited"]);
				expect(priorExit.daemon.state).toBe("restarting");
				expect(priorExit.daemon.exitCode).toBe(4);
				expect(delivered).toEqual([]);
			},
			{ restartBackoffBaseMs: 10_000 },
		);
	}, 15_000);

	it("observes a concurrent explicit backoff stop once without manufacturing owned delivery", async () => {
		await withBroker(
			async ({ projectDir, ownerClient, monitorClient }) => {
				const observed: DaemonCompletionNotification[] = [];
				const restarting = Promise.withResolvers<void>();
				const stopped = Promise.withResolvers<DaemonCompletionNotification>();
				const delivered: DaemonCompletionNotification[] = [];
				ownerClient.onCompletion("child-owner", notification => {
					delivered.push(notification);
				});
				monitorClient.observeOwners(["child-owner"], notification => {
					observed.push(notification);
					if (notification.daemon.state === "restarting") restarting.resolve();
					else if (notification.daemon.state === "exited") stopped.resolve(notification);
				});
				await monitorClient.request({ op: "ping" });
				const started = await ownerClient.request({
					op: "start",
					owner: "child-owner",
					spec: { ...serviceSpec(projectDir, "backoff-stop-service", 4), restart: "always" },
				});
				if (started.op !== "start") throw new Error("Expected service start");
				await ownerClient.request({ op: "send", name: "backoff-stop-service", data: "exit\n" });
				await restarting.promise;
				await Promise.all([
					ownerClient.request({ op: "stop", name: "backoff-stop-service", timeoutMs: 2_000 }),
					ownerClient.request({ op: "stop", name: "backoff-stop-service", timeoutMs: 2_000 }),
				]);
				expect((await stopped.promise).daemon).toMatchObject({
					id: started.daemon.id,
					state: "exited",
					restartCount: 1,
					pid: undefined,
				});
				await monitorClient.request({ op: "ping" });
				expect(observed.map(({ daemon }) => daemon.state)).toEqual(["restarting", "exited"]);
				expect(delivered).toEqual([]);
			},
			{ restartBackoffBaseMs: 10_000 },
		);
	}, 15_000);

	it("continues observing a parked child after its connection closes and preserves owned replay", async () => {
		await withBroker(async ({ projectDir, ownerClient, monitorClient, createClient }) => {
			const observed = Promise.withResolvers<DaemonCompletionNotification>();
			const parkedDeliveries: DaemonCompletionNotification[] = [];
			const park = ownerClient.onCompletion("parked-child", notification => {
				parkedDeliveries.push(notification);
			});
			monitorClient.observeOwners(["parked-child"], notification => observed.resolve(notification));
			await monitorClient.request({ op: "ping" });
			await ownerClient.request({
				op: "start",
				owner: "parked-child",
				spec: serviceSpec(projectDir, "parked-service", 5),
			});
			park({ preservePending: true });
			await ownerClient.request({ op: "ping" });
			ownerClient.close();
			await monitorClient.request({ op: "send", name: "parked-service", data: "exit\n" });
			const notification = await observed.promise;
			expect(notification.owner).toBe("parked-child");
			expect(notification.daemon.exitCode).toBe(5);
			expect(parkedDeliveries).toEqual([]);
			const resumedClient = await createClient();
			const replayed = Promise.withResolvers<DaemonCompletionNotification>();
			resumedClient.onCompletion("parked-child", replay => replayed.resolve(replay));
			await resumedClient.request({ op: "ping" });
			expect(await replayed.promise).toEqual(notification);
		});
	}, 15_000);

	it("scopes owners per monitor and lets overlapping subscriptions unsubscribe independently", async () => {
		await withBroker(async ({ projectDir, ownerClient, monitorClient, createClient }) => {
			const anotherMonitor = await createClient();
			const first: DaemonCompletionNotification[] = [];
			const second: DaemonCompletionNotification[] = [];
			const unrelated: DaemonCompletionNotification[] = [];
			const removeFirst = monitorClient.observeOwners(["child-owner"], notification => first.push(notification));
			const removeSecond = monitorClient.observeOwners(["child-owner", "child-owner"], notification =>
				second.push(notification),
			);
			anotherMonitor.observeOwners(["unrelated-owner"], notification => unrelated.push(notification));
			await Promise.all([monitorClient.request({ op: "ping" }), anotherMonitor.request({ op: "ping" })]);
			for (const [name, owner] of [
				["unrelated-service", "unrelated-owner"],
				["first-child", "child-owner"],
			] as const) {
				await ownerClient.request({ op: "start", owner, spec: serviceSpec(projectDir, name) });
				await ownerClient.request({ op: "stop", name, timeoutMs: 2_000 });
			}
			await Promise.all([monitorClient.request({ op: "ping" }), anotherMonitor.request({ op: "ping" })]);
			expect(first.map(({ daemon }) => daemon.name)).toEqual(["first-child"]);
			expect(second.map(({ daemon }) => daemon.name)).toEqual(["first-child"]);
			expect(unrelated.map(({ daemon }) => daemon.name)).toEqual(["unrelated-service"]);
			removeFirst();
			await monitorClient.request({ op: "ping" });
			await ownerClient.request({
				op: "start",
				owner: "child-owner",
				spec: serviceSpec(projectDir, "second-child"),
			});
			await ownerClient.request({ op: "stop", name: "second-child", timeoutMs: 2_000 });
			await monitorClient.request({ op: "ping" });
			expect(first).toHaveLength(1);
			expect(second.map(({ daemon }) => daemon.name)).toEqual(["first-child", "second-child"]);
			removeSecond();
			removeSecond();
			await monitorClient.request({ op: "ping" });
			await ownerClient.request({
				op: "start",
				owner: "child-owner",
				spec: serviceSpec(projectDir, "unobserved-child"),
			});
			await ownerClient.request({ op: "stop", name: "unobserved-child", timeoutMs: 2_000 });
			await monitorClient.request({ op: "ping" });
			expect(second).toHaveLength(2);
			expect(unrelated).toHaveLength(1);
		});
	}, 20_000);

	it("captures every opted-in terminal event beyond the broker's ten-entry list cap", async () => {
		await withBroker(async ({ projectDir, ownerClient, monitorClient }) => {
			const observed: DaemonCompletionNotification[] = [];
			let next = Promise.withResolvers<DaemonCompletionNotification>();
			monitorClient.observeOwners(["child-owner"], notification => {
				observed.push(notification);
				next.resolve(notification);
			});
			await monitorClient.request({ op: "ping" });
			for (let index = 0; index < 12; index++) {
				next = Promise.withResolvers<DaemonCompletionNotification>();
				const name = `finished-child-${index}`;
				await ownerClient.request({
					op: "start",
					owner: "child-owner",
					spec: { ...serviceSpec(projectDir, name), args: ["-e", "process.exit(0)"], ready: undefined },
				});
				expect((await next.promise).daemon.name).toBe(name);
			}
			const listed = await monitorClient.request({ op: "list" });
			if (listed.op !== "list") throw new Error("Expected daemon list");
			expect(listed.daemons).toHaveLength(10);
			expect(observed.map(({ daemon }) => daemon.name)).toEqual(
				Array.from({ length: 12 }, (_, index) => `finished-child-${index}`),
			);
		});
	}, 20_000);
});
