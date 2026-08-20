// Integration test — real timers are required (ts-no-test-timers exception): this drives the actual
// daemon broker over a local socket and, for the persistent-child case, a real child process. Fake
// timers cannot control OS socket delivery or process exit. Shutdown is observed through the broker's
// run() promise, while the unauthenticated-client cases deliberately cross the configured idle grace.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerStartOptions, startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonWireRequest,
	type DaemonWireResponse,
	parseDaemonWireResponse,
} from "../../src/launch/protocol";

const UNAUTHENTICATED_IDLE_GRACE_MS = 50;
const DELAYED_AUTH_HOLD_MS = 200;
const SILENT_AUTH_TIMEOUT_MS = 200;

interface StartedBroker {
	finished: Promise<void>;
	ready: Promise<void>;
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(
	projectDir: string,
	runtimeDir: string,
	idleGraceMs: number,
	options: DaemonBrokerStartOptions = {},
): StartedBroker {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const finished = startDaemonBrokerFromEnvironment({
		...options,
		onListening: async () => {
			resolveReady();
			await options.onListening?.();
		},
	});
	void finished.catch(rejectReady);
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return { finished, ready };
}

function connect(endpoint: string): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: endpoint });
	const onConnect = (): void => {
		socket.off("error", onError);
		resolve(socket);
	};
	const onError = (error: Error): void => {
		socket.off("connect", onConnect);
		reject(error);
	};
	socket.once("connect", onConnect);
	socket.once("error", onError);
	return promise;
}

function readResponse(socket: net.Socket): Promise<DaemonWireResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonWireResponse>();
	let buffer = "";
	const cleanup = (): void => {
		socket.off("data", onData);
		socket.off("close", onClose);
		socket.off("error", onError);
	};
	const onData = (chunk: Buffer): void => {
		buffer += chunk.toString("utf8");
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		cleanup();
		try {
			resolve(parseDaemonWireResponse(JSON.parse(buffer.slice(0, newline))));
		} catch (error) {
			reject(error);
		}
	};
	const onClose = (): void => {
		cleanup();
		reject(new Error("Daemon broker closed the socket before responding"));
	};
	const onError = (error: Error): void => {
		cleanup();
		reject(error);
	};
	socket.on("data", onData);
	socket.once("close", onClose);
	socket.once("error", onError);
	return promise;
}

describe("daemon broker idle shutdown", () => {
	it("shuts down after its last persistent daemon exits with no clients", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const previousTitle = process.title;
		// Create the client (writes broker.token) before starting the broker, which reads that token.
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 100 });
		const broker = startBroker(projectDir, runtimeDir, 100);
		await broker.ready;
		try {
			// A persistent daemon that outlives the first idle-shutdown timer (100ms) and then
			// self-exits (~300ms). restart:"no" so its exit is terminal.
			const started = await client.request({
				op: "start",
				spec: {
					name: "persistent-temp",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 300)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: true,
					detached: false,
				},
			});
			expect(started.op).toBe("start");

			// Disconnect the final client. The broker keeps the persistent daemon alive, so the
			// idle timer this arms fires while the daemon is still live and returns without rearming.
			client.close();

			// When the daemon self-exits, terminal settlement must rearm idle shutdown; the broker
			// then releases its lease and run() resolves. Awaiting the broker promise IS the shutdown
			// signal. Before the fix nothing rearmed, so this await never resolved and the test timed
			// out — the regression this guards.
			await broker.finished;
		} finally {
			process.title = previousTitle;
		}
	}, 30_000);

	it("awaits an asynchronous listening callback and shuts down when it rejects", async () => {
		using tempDir = TempDir.createSync("@omp-launch-listening-callback-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		client.close();
		const callbackError = new Error("listening callback failed");
		const broker = startBroker(projectDir, runtimeDir, 1_000, {
			onListening: async () => {
				throw callbackError;
			},
		});

		await broker.ready;
		await expect(broker.finished).rejects.toBe(callbackError);
		await expect(connect(daemonBrokerEndpoint(projectDir, runtimeDir))).rejects.toBeDefined();
	});

	it("accepts authentication after an idle socket outlives the shutdown grace", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-auth-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		client.close();
		const token = (await Bun.file(path.join(runtimeDir, "broker.token")).text()).trim();
		const broker = startBroker(projectDir, runtimeDir, UNAUTHENTICATED_IDLE_GRACE_MS);
		await broker.ready;
		const socket = await connect(daemonBrokerEndpoint(projectDir, runtimeDir));

		try {
			await Bun.sleep(DELAYED_AUTH_HOLD_MS);
			const id = crypto.randomUUID();
			const request: DaemonWireRequest = { id, token, operation: { op: "ping" } };
			const response = readResponse(socket);
			socket.write(`${JSON.stringify(request)}\n`);
			expect(await response).toEqual({
				id,
				ok: true,
				result: { op: "ping", projectDir },
			});
		} finally {
			socket.destroy();
			await broker.finished;
		}
	}, 30_000);

	it("closes a silent unauthenticated socket and rearms idle shutdown", async () => {
		using tempDir = TempDir.createSync("@omp-launch-idle-silent-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		client.close();
		const broker = startBroker(projectDir, runtimeDir, UNAUTHENTICATED_IDLE_GRACE_MS, {
			clientAuthTimeoutMs: SILENT_AUTH_TIMEOUT_MS,
		});
		await broker.ready;
		const socket = await connect(daemonBrokerEndpoint(projectDir, runtimeDir));

		const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
		socket.once("close", resolveClosed);
		await closed;
		await broker.finished;
	}, 30_000);
});
