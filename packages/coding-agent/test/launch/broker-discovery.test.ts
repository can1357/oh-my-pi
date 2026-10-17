// Real private broker, native IPC requests, child exits, and production wait consumers.
// Only project resolution and connection/response/callback delivery gates are substituted.
import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import * as clients from "../../src/launch/client";
import type { DaemonBrokerClient } from "../../src/launch/client";
import type { ToolSession } from "../../src/tools";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import * as services from "../../src/launch/services";
import { WaitTool } from "../../src/tools/wait";
import { IrcBus } from "../../src/irc/bus";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { daemonBrokerEndpoint } from "../../src/launch/paths";
import { type DaemonOperation, type DaemonWireResponse, parseDaemonWireMessage } from "../../src/launch/protocol";

interface Fixture {
	client: DaemonBrokerClient;
	session: ToolSession;
	projectDir: string;
	runtimeDir: string;
	owner: string;
	change: Array<() => void>;
}
async function withBroker(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-broker-regression-"));
	const projectDir = path.join(root, "project");
	const runtimeDir = path.join(root, "runtime");
	await fs.mkdir(projectDir);
	const client = await clients.createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5000 });
	const previousTitle = process.title;
	const env = {
		OMP_DAEMON_PROJECT_DIR: projectDir,
		OMP_DAEMON_RUNTIME_DIR: runtimeDir,
		OMP_DAEMON_IDLE_GRACE_MS: "5000",
	};
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	const listening = Promise.withResolvers<void>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve() });
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const dispose: Array<() => void> = [];
	const change: Array<() => void> = [];
	const owner = crypto.randomUUID();
	const session: ToolSession = {
		cwd: projectDir,
		hasUI: false,
		settings: Settings.isolated({ "launch.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => owner,
		getSessionId: () => owner,
		registerDisposeCallback: callback => {
			dispose.push(callback);
		},
		registerSessionChangeCallback: callback => {
			change.push(callback);
		},
	};
	try {
		await Promise.race([
			listening.promise,
			finished.then(() => {
				throw new Error("Private broker exited before listening");
			}),
		]);
		vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(client);
		await run({ client, session, projectDir, runtimeDir, owner, change });
	} finally {
		vi.restoreAllMocks();
		for (const callback of dispose) callback();
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await finished;
		process.title = previousTitle;
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function startOwned(f: Fixture, name: string): Promise<void> {
	await f.client.request({
		op: "start",
		owner: f.owner,
		spec: {
			name,
			application: process.execPath,
			args: ["-e", "console.log('service-ready'); process.stdin.once('data', () => process.exit(0));"],
			env: {},
			cwd: f.projectDir,
			pty: false,
			ready: { log: "service-ready", timeoutMs: 5000 },
			restart: "no",
			persist: false,
			detached: false,
		},
	});
}

function holdResponse(client: DaemonBrokerClient, op: "list" | "start") {
	const received = Promise.withResolvers<void>();
	void received.promise.catch(() => undefined);
	const release = Promise.withResolvers<void>();
	const request = client.request.bind(client);
	let held = false;
	let signal: AbortSignal | undefined;
	const spy = vi.spyOn(client, "request").mockImplementation(async (operation, requestSignal) => {
		if (operation.op !== op || held) return request(operation, requestSignal);
		held = true;
		signal = requestSignal;
		try {
			const result = await request(operation, requestSignal);
			received.resolve();
			await release.promise;
			return result;
		} catch (error) {
			received.reject(error);
			throw error;
		}
	});
	return {
		received: received.promise,
		release: release.resolve,
		restore: () => spy.mockRestore(),
		get signal() {
			return signal;
		},
	};
}
/** Hold the real native connection before the production client can bind it. */
function holdConnection() {
	const connected = Promise.withResolvers<IpcConnection>();
	const release = Promise.withResolvers<void>();
	const connect = IpcConnection.connect.bind(IpcConnection);
	vi.spyOn(IpcConnection, "connect").mockImplementationOnce(async (endpoint, options) => {
		try {
			const connection = await connect(endpoint, options);
			connected.resolve(connection);
			await release.promise;
			return connection;
		} catch (error) {
			connected.reject(error);
			throw error;
		}
	});
	return { connected: connected.promise, release: release.resolve };
}

// Event-driven success; a bounded watchdog releases gates even on pristine failure.
async function beforeRelease<T>(release: () => void, result: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		deadline.reject(new Error("Result did not precede discovery gate release"));
		release();
	}, 2000);
	try {
		return await Promise.race([result, deadline.promise]);
	} finally {
		clearTimeout(timer);
		release();
	}
}

async function terminalListBeforeCompletion(f: Fixture, keepOtherService: boolean): Promise<void> {
	const completionReceived = Promise.withResolvers<void>();
	const completionRelease = Promise.withResolvers<void>();
	const onCompletion = f.client.onCompletion.bind(f.client);
	vi.spyOn(f.client, "onCompletion").mockImplementation((owner, sink) =>
		onCompletion(owner, async notification => {
			completionReceived.resolve();
			await completionRelease.promise;
			await sink(notification);
		}),
	);
	await startOwned(f, "exiting");
	if (keepOtherService) await startOwned(f, "still-live");
	await services.listServices(f.session);
	const listEntered = Promise.withResolvers<void>();
	const listRelease = Promise.withResolvers<void>();
	const request = f.client.request.bind(f.client);
	let held = false;
	vi.spyOn(f.client, "request").mockImplementation(async (operation, signal) => {
		if (operation.op === "list" && !held) {
			held = true;
			listEntered.resolve();
			await listRelease.promise;
		}
		return request(operation, signal);
	});
	const controller = new AbortController();
	const waiting = new WaitTool(f.session).execute("terminal-list", {}, controller.signal);
	try {
		await listEntered.promise;
		await f.client.request({ op: "send", name: "exiting", data: "finish\n" });
		// The broker has truly settled and sent completion; only its consumer
		// delivery is held, so discovery now reads a real terminal snapshot.
		await completionReceived.promise;
		listRelease.resolve();
		const result = await beforeRelease(completionRelease.resolve, waiting);
		expect(result.content.some(block => block.type === "text" && /service finished/i.test(block.text))).toBe(true);
		expect(services.hasLiveOwnedService(f.session)).toBe(keepOtherService);
	} finally {
		controller.abort();
		listRelease.resolve();
		completionRelease.resolve();
		await waiting.catch(() => undefined);
	}
}

describe("broker discovery and session generations", () => {
	test("same-scope session invalidation does not suppress the next real discovery", () =>
		withBroker(async f => {
			await startOwned(f, "resumable");
			const gate = holdResponse(f.client, "list");
			const tool = new WaitTool(f.session);
			const stale = tool.execute("invalidated-discovery", {});
			const outcome = stale.then(
				() => undefined,
				(error: unknown) => error,
			);
			await gate.received;
			for (const callback of f.change) callback();
			gate.release();
			expect(await outcome).toBeInstanceOf(Error);
			gate.restore();

			const freshGate = holdResponse(f.client, "list");
			const installed = Promise.withResolvers<void>();
			const waitForCompletion = services.waitForOwnedServiceCompletion;
			vi.spyOn(services, "waitForOwnedServiceCompletion").mockImplementation((session, signal) => {
				const result = waitForCompletion(session, signal);
				installed.resolve();
				return result;
			});
			const controller = new AbortController();
			const fresh = tool.execute("same-scope-rediscovery", {}, controller.signal);
			void fresh.catch(() => undefined);
			try {
				await beforeRelease(freshGate.release, freshGate.received);
				await beforeRelease(freshGate.release, installed.promise);
				await f.client.request({ op: "send", name: "resumable", data: "finish\n" });
				const result = await fresh;
				expect(result.content.some(block => block.type === "text" && /service finished/i.test(block.text))).toBe(
					true,
				);
				expect(services.hasLiveOwnedService(f.session)).toBe(false);
			} finally {
				controller.abort();
				freshGate.release();
				await fresh.catch(() => undefined);
			}
		}));
	test("terminal discovery wakes the service waiter before its delayed completion", () =>
		withBroker(f => terminalListBeforeCompletion(f, false)));
	test("terminal discovery reports an exit even when another owned service stays live", () =>
		withBroker(f => terminalListBeforeCompletion(f, true)));
	test("connection-cancel-sends-nothing-and-shared-connect-survives", () =>
		withBroker(async f => {
			const gate = holdConnection();
			const controller = new AbortController();
			const added = vi.spyOn(controller.signal, "addEventListener");
			const removed = vi.spyOn(controller.signal, "removeEventListener");
			const cancelled = f.client.request(
				{
					op: "start",
					spec: {
						name: "must-not-start",
						application: process.execPath,
						args: ["-e", "process.stdin.resume()"],
						env: {},
						cwd: f.projectDir,
						pty: false,
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				controller.signal,
			);
			const outcome = cancelled.catch((error: unknown) => error);
			const sibling = f.client.request({ op: "list" });
			void sibling.catch(() => undefined);
			try {
				const connection = await gate.connected;
				controller.abort();
				const error = await beforeRelease(gate.release, outcome);
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new Error("Expected cancellation");
				expect(error.message).toContain("request aborted");
				expect(connection.closed).toBe(false);
				const listed = await sibling;
				if (listed.op !== "list") throw new Error("Expected real list");
				expect(listed.daemons.some(d => d.name === "must-not-start")).toBe(false);
				for (const [event, listener] of added.mock.calls)
					expect(removed.mock.calls.some(([name, callback]) => name === event && callback === listener)).toBe(
						true,
					);
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
			} finally {
				gate.release();
				await Promise.allSettled([cancelled, sibling]);
			}
		}));
	test("client close destroys a late native connection without sending its request", () =>
		withBroker(async f => {
			// A separate client keeps fixture shutdown independent of the closed consumer.
			const closing = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
			const gate = holdConnection();
			const request = closing.request({ op: "list" });
			const outcome = request.catch((error: unknown) => error);
			try {
				const connection = await gate.connected;
				closing.close();
				gate.release();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new Error("Expected closed client");
				expect(error.message).toContain("client is closed");
				expect(connection.closed).toBe(true);
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
			} finally {
				closing.close();
				gate.release();
				await request.catch(() => undefined);
			}
		}));
	test("cancelled pending native request leaves its service and sibling requests usable", () =>
		withBroker(async f => {
			await startOwned(f, "pending-cancel");
			const controller = new AbortController();
			const connect = IpcConnection.connect.bind(IpcConnection);
			const connected = Promise.withResolvers<IpcConnection>();
			vi.spyOn(IpcConnection, "connect").mockImplementationOnce(async (endpoint, options) => {
				const connection = await connect(endpoint, options);
				connected.resolve(connection);
				return connection;
			});
			const consumer = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
			try {
				await consumer.request({ op: "ping" });
				const connection = await connected.promise;
				const sent = Promise.withResolvers<void>();
				const send = connection.send.bind(connection);
				vi.spyOn(connection, "send").mockImplementation(frame => {
					const result = send(frame);
					if (typeof frame === "string" && JSON.parse(frame).operation.op === "wait") sent.resolve();
					return result;
				});
				const waiting = consumer.request(
					{ op: "wait", name: "pending-cancel", for: "exit", timeoutMs: 5000 },
					controller.signal,
				);
				const outcome = waiting.catch((error: unknown) => error);
				await sent.promise;
				controller.abort();
				await expect(outcome).resolves.toBeInstanceOf(Error);
				expect(connection.closed).toBe(false);
				expect((await consumer.request({ op: "ping" })).op).toBe("ping");
				await consumer.request({ op: "send", name: "pending-cancel", data: "finish\n" });
				const exited = await consumer.request({ op: "wait", name: "pending-cancel", for: "exit", timeoutMs: 5000 });
				if (exited.op !== "wait") throw new Error("Expected real wait");
				expect(exited.timedOut).toBe(false);
				expect(exited.daemon.state).toBe("exited");
			} finally {
				controller.abort();
				consumer.close();
			}
		}));
	test("late native close cannot reject requests on the replacement connection", () =>
		withBroker(async f => {
			const gate = holdConnection();
			const first = f.client.request({ op: "ping" });
			void first.catch(() => undefined);
			const old = await gate.connected;
			const closeReceived = Promise.withResolvers<void>();
			const closeRelease = Promise.withResolvers<void>();
			const closeDelivered = Promise.withResolvers<void>();
			const start = old.start.bind(old);
			vi.spyOn(old, "start").mockImplementation((onLine, onClose) =>
				start(onLine, reason => {
					closeReceived.resolve();
					void closeRelease.promise.then(() => {
						onClose(reason);
						closeDelivered.resolve();
					});
				}),
			);
			try {
				gate.release();
				await first;
				await startOwned(f, "replacement-survivor");
				const sent = Promise.withResolvers<void>();
				const send = old.send.bind(old);
				vi.spyOn(old, "send").mockImplementation(frame => {
					const result = send(frame);
					if (typeof frame === "string" && JSON.parse(frame).operation.op === "wait") sent.resolve();
					return result;
				});
				const stale = f.client.request({ op: "wait", name: "replacement-survivor", for: "exit", timeoutMs: 5000 });
				const staleOutcome = stale.catch((error: unknown) => error);
				await sent.promise;
				old.destroy();
				await closeReceived.promise;
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
				expect(await staleOutcome).toBeInstanceOf(Error);
				const current = f.client.request({
					op: "wait",
					name: "replacement-survivor",
					for: "exit",
					timeoutMs: 5000,
				});
				void current.catch(() => undefined);
				closeRelease.resolve();
				await closeDelivered.promise;
				await f.client.request({ op: "send", name: "replacement-survivor", data: "finish\n" });
				const result = await current;
				if (result.op !== "wait") throw new Error("Expected replacement wait");
				expect(result.timedOut).toBe(false);
				expect(result.daemon.state).toBe("exited");
			} finally {
				gate.release();
				closeRelease.resolve();
				await first.catch(() => undefined);
			}
		}));
	test.each(["abort", "close"] as const)("%s after native binding sends no operation", boundary =>
		withBroker(async f => {
			const consumer = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
			const gate = holdConnection();
			const controller = new AbortController();
			const cancelled = consumer.request({ op: "list" }, controller.signal);
			const outcome = cancelled.catch((error: unknown) => error);
			const connection = await gate.connected;
			const start = connection.start.bind(connection);
			vi.spyOn(connection, "start").mockImplementation((onLine, onClose) => {
				start(onLine, onClose);
				if (boundary === "abort") controller.abort();
				else consumer.close();
			});
			const frames: string[] = [];
			const send = connection.send.bind(connection);
			vi.spyOn(connection, "send").mockImplementation(frame => {
				if (typeof frame === "string") frames.push(frame);
				return send(frame);
			});
			try {
				gate.release();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new Error("Expected cancellation or close after binding");
				expect(frames).toEqual([]);
				expect(connection.closed).toBe(boundary === "close");
				if (boundary === "abort") expect((await consumer.request({ op: "ping" })).op).toBe("ping");
				else await expect(consumer.request({ op: "ping" })).rejects.toBeInstanceOf(Error);
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
			} finally {
				controller.abort();
				consumer.close();
				gate.release();
				await cancelled.catch(() => undefined);
			}
		}),
	);
	test("a native send dropped at close rejects before the delayed close callback", () =>
		withBroker(async f => {
			const gate = holdConnection();
			const first = f.client.request({ op: "ping" });
			void first.catch(() => undefined);
			const connection = await gate.connected;
			const closeRelease = Promise.withResolvers<void>();
			const start = connection.start.bind(connection);
			vi.spyOn(connection, "start").mockImplementation((onLine, onClose) =>
				start(onLine, reason => {
					void closeRelease.promise.then(() => onClose(reason));
				}),
			);
			try {
				gate.release();
				await first;
				const send = connection.send.bind(connection);
				let dropped: boolean | undefined;
				vi.spyOn(connection, "send").mockImplementationOnce(frame => {
					connection.destroy();
					dropped = send(frame);
					return dropped;
				});
				const request = f.client.request({ op: "list" });
				const outcome = request.catch((error: unknown) => error);
				const error = await beforeRelease(closeRelease.resolve, outcome);
				expect(dropped).toBe(false);
				expect(error).toBeInstanceOf(Error);
				if (!(error instanceof Error)) throw new Error("Expected dropped request failure");
				expect(error.message).toContain("connection closed");
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
			} finally {
				gate.release();
				closeRelease.resolve();
				await first.catch(() => undefined);
			}
		}));
	test("native backpressure still delivers a large service input exactly once", () =>
		withBroker(async f => {
			const gate = holdConnection();
			const first = f.client.request({ op: "ping" });
			void first.catch(() => undefined);
			const connection = await gate.connected;
			try {
				gate.release();
				await first;
				await f.client.request({
					op: "start",
					owner: f.owner,
					spec: {
						name: "large-input",
						application: process.execPath,
						args: [
							"-e",
							"let input = ''; console.log('ready'); process.stdin.on('data', chunk => { input += chunk; if (input.endsWith('finish\\n')) { console.log('received:' + (input.length - 7)); process.exit(0); } });",
						],
						env: {},
						cwd: f.projectDir,
						pty: false,
						ready: { log: "ready", timeoutMs: 5000 },
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				const payload = "x".repeat(600 * 1024);
				const secondPayload = "y".repeat(600 * 1024);
				const backpressure: boolean[] = [];
				const send = connection.send.bind(connection);
				vi.spyOn(connection, "send").mockImplementation(frame => {
					const accepted = send(frame);
					if (typeof frame === "string") {
						const data = JSON.parse(frame).operation.data;
						if (data === payload || data === secondPayload) backpressure.push(accepted);
					}
					return accepted;
				});
				// A small ping corks this batch so large frames cannot take native's
				// direct-write path. Each stays below the broker's 1 MiB request cap,
				// while both resume before uncork and queue over 1 MiB.
				const [ping, firstSent, secondSent] = await Promise.all([
					f.client.request({ op: "ping" }),
					f.client.request({ op: "send", name: "large-input", data: payload }),
					f.client.request({ op: "send", name: "large-input", data: secondPayload }),
				]);
				expect(ping.op).toBe("ping");
				expect(firstSent.op).toBe("send");
				expect(secondSent.op).toBe("send");
				expect(backpressure).toEqual([true, false]);
				await f.client.request({ op: "send", name: "large-input", data: "finish\n" });
				const exited = await f.client.request({ op: "wait", name: "large-input", for: "exit", timeoutMs: 5000 });
				if (exited.op !== "wait") throw new Error("Expected real exit");
				expect(exited.timedOut).toBe(false);
				const logs = await f.client.request({
					op: "logs",
					name: "large-input",
					lines: 10,
					head: false,
					follow: false,
					timeoutMs: 0,
				});
				if (logs.op !== "logs") throw new Error("Expected real child output");
				expect(logs.text).toContain(`received:${payload.length + secondPayload.length}`);
			} finally {
				gate.release();
				await first.catch(() => undefined);
			}
		}));
	test("late completion sink failure cannot close the replacement native connection", () =>
		withBroker(async f => {
			const gate = holdConnection();
			const first = f.client.request({ op: "ping" });
			void first.catch(() => undefined);
			const old = await gate.connected;
			const received = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const unregister = f.client.onCompletion(f.owner, async () => {
				received.resolve();
				await release.promise;
				throw new Error("Delayed completion delivery failed");
			});
			try {
				gate.release();
				await first;
				await startOwned(f, "old-sink");
				await f.client.request({ op: "send", name: "old-sink", data: "finish\n" });
				await received.promise;
				old.destroy();
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
				unregister();
				await startOwned(f, "new-sink");
				const current = f.client.request({ op: "wait", name: "new-sink", for: "exit", timeoutMs: 5000 });
				void current.catch(() => undefined);
				await f.client.request({ op: "ping" });
				release.resolve();
				expect((await f.client.request({ op: "ping" })).op).toBe("ping");
				await f.client.request({ op: "send", name: "new-sink", data: "finish\n" });
				const exited = await current;
				if (exited.op !== "wait") throw new Error("Expected real replacement wait");
				expect(exited.timedOut).toBe(false);
				expect(exited.daemon.state).toBe("exited");
			} finally {
				unregister();
				gate.release();
				release.resolve();
				await first.catch(() => undefined);
			}
		}));
	test("hung-discovery-does-not-block-local-job", () =>
		withBroker(async f => {
			const gate = holdResponse(f.client, "list");
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const job = Promise.withResolvers<string>();
			f.session.asyncJobManager = manager;
			const id = manager.register("bash", "owned-build", () => job.promise, { ownerId: f.owner });
			const waiting = new WaitTool(f.session).execute("job", {});
			try {
				await gate.received;
				job.resolve("owned build completed");
				const result = await beforeRelease(gate.release, waiting);
				expect(result.details?.jobs?.[0]).toMatchObject({
					id,
					status: "completed",
					resultText: "owned build completed",
				});
				expect(gate.signal?.aborted).toBe(true);
				expect(manager.isJobResultConsumed(id)).toBe(true);
			} finally {
				gate.release();
				job.resolve("cleanup");
				await waiting.catch(() => undefined);
				await manager.dispose();
			}
		}));
	test("hung-discovery-does-not-block-accepted-completion", () =>
		withBroker(async f => {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			f.session.asyncJobManager = manager;
			const id = manager.register("bash", "settled", async () => "accepted completion", { ownerId: f.owner });
			await manager.waitForAll();
			const gate = holdResponse(f.client, "list");
			try {
				const result = await beforeRelease(gate.release, new WaitTool(f.session).execute("accepted", {}));
				expect(result.details?.jobs?.[0]?.id).toBe(id);
			} finally {
				gate.release();
				await manager.dispose();
			}
		}));
	test("hung-discovery-does-not-block-real-message", () =>
		withBroker(async f => {
			const registry = new AgentRegistry();
			registry.register({ id: f.owner, displayName: "isolated waiter", kind: "sub", session: null });
			f.session.agentRegistry = registry;
			const gate = holdResponse(f.client, "list");
			const controller = new AbortController();
			const installed = Promise.withResolvers<void>();
			// A global bus retains its construction-time registry; other test
			// fixtures can replace that registry without replacing the bus.
			const bus = new IrcBus(registry);
			vi.spyOn(IrcBus, "global").mockReturnValue(bus);
			const original = bus.wait.bind(bus);
			vi.spyOn(bus, "wait").mockImplementation((agentId, filter, timeoutMs, signal) => {
				const result = original(agentId, filter, timeoutMs, signal);
				installed.resolve();
				return result;
			});
			const waiting = new WaitTool(f.session).execute("message", {}, controller.signal);
			try {
				await gate.received;
				const driven = (async () => {
					await installed.promise;
					const receipt = await bus.send(
						{ from: "isolated-peer", to: f.owner, body: "directly consumed" },
						{ suppressRelay: true },
					);
					expect(receipt).toMatchObject({ to: f.owner, outcome: "injected" });
					return waiting;
				})();
				const result = await beforeRelease(gate.release, driven);
				expect(result.details?.waited?.body).toBe("directly consumed");
			} finally {
				controller.abort();
				gate.release();
				await waiting.catch(() => undefined);
				registry.unregister(f.owner);
			}
		}));
	test("hung-discovery-does-not-block-real-service-exit", () =>
		withBroker(async f => {
			await startOwned(f, "service");
			await services.listServices(f.session);
			const gate = holdResponse(f.client, "list");
			const controller = new AbortController();
			const waiting = new WaitTool(f.session).execute("exit", {}, controller.signal);
			try {
				await gate.received;
				await f.client.request({ op: "send", name: "service", data: "finish\n" });
				const result = await beforeRelease(gate.release, waiting);
				expect(result.content.some(b => b.type === "text" && /service finished/i.test(b.text))).toBe(true);
				expect(services.hasLiveOwnedService(f.session)).toBe(false);
			} finally {
				controller.abort();
				gate.release();
				await waiting.catch(() => undefined);
			}
		}));
	test("wait-caller-abort-races-discovery-without-stopping-service", () =>
		withBroker(async f => {
			await startOwned(f, "survivor");
			await services.listServices(f.session);
			const gate = holdResponse(f.client, "list");
			const controller = new AbortController();
			const waiting = new WaitTool(f.session).execute("cancel", {}, controller.signal);
			const outcome = waiting.then(
				() => {
					throw new Error("Cancelled wait unexpectedly returned a result");
				},
				(error: unknown) => error,
			);
			try {
				await gate.received;
				controller.abort();
				const error = await beforeRelease(gate.release, outcome);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).name).toBe("ToolAbortError");
				expect(gate.signal?.aborted).toBe(true);
				gate.restore();
				const current = await f.client.request({ op: "list" });
				if (current.op !== "list") throw new Error("Expected real list");
				expect(current.daemons.find(d => d.name === "survivor")?.state).toBe("ready");
			} finally {
				controller.abort();
				gate.release();
				await waiting.catch(() => undefined);
			}
		}));
	test("failed discovery without a local source reports failure rather than nothing to wait for", () =>
		withBroker(async f => {
			const closed = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
			closed.close();
			vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(closed);
			await expect(new WaitTool(f.session).execute("failure", {})).rejects.toThrow(
				"Service state unavailable: Daemon broker client is closed. Last-known service state is not current.",
			);
		}));
	test("service-only wait survives a failed refresh and returns the real owned service exit", () =>
		withBroker(async f => {
			await startOwned(f, "last-known");
			await services.listServices(f.session);
			const closed = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
			closed.close();
			vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(closed);
			const listeningAfterFailure = Promise.withResolvers<void>();
			const waitForCompletion = services.waitForOwnedServiceCompletion;
			let installed = 0;
			vi.spyOn(services, "waitForOwnedServiceCompletion").mockImplementation((session, signal) => {
				const completion = waitForCompletion(session, signal);
				if (++installed === 2) listeningAfterFailure.resolve();
				return completion;
			});
			const controller = new AbortController();
			const waiting = new WaitTool(f.session).execute("failed-refresh-service", {}, controller.signal);
			void waiting.catch(() => undefined);
			try {
				await beforeRelease(listeningAfterFailure.resolve, listeningAfterFailure.promise);
				expect(services.hasLiveOwnedService(f.session)).toBe(true);
				// Discovery really rejected on a closed socket client. The original
				// subscription is still live and its child really exits afterwards.
				await f.client.request({ op: "send", name: "last-known", data: "finish\n" });
				const result = await beforeRelease(() => controller.abort(), waiting);
				expect(result.content).toEqual([
					{ type: "text", text: "A service finished. Read proc:// for its status and output." },
				]);
				expect(result.details).toEqual({ op: "wait", jobs: [] });
				expect(services.hasLiveOwnedService(f.session)).toBe(false);
			} finally {
				controller.abort();
				await waiting.catch(() => undefined);
			}
		}));
	test("service-only wait reports stale discovery failure at the cap without consuming the live service", () =>
		withBroker(async f => {
			await startOwned(f, "cap-survivor");
			await services.listServices(f.session);
			const closed = await clients.createDaemonBrokerClient(f.projectDir, { runtimeDir: f.runtimeDir });
			closed.close();
			vi.spyOn(clients, "daemonClientForProject").mockResolvedValue(closed);
			const started = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(started);
			const waitForCompletion = services.waitForOwnedServiceCompletion;
			let installed = 0;
			vi.spyOn(services, "waitForOwnedServiceCompletion").mockImplementation((session, signal) => {
				const completion = waitForCompletion(session, signal);
				// The second listener is installed after the real list failure.
				// Advance only the deadline calculation; broker/socket timers stay real.
				if (++installed === 2) clock.mockReturnValue(started + 30 * 60_000);
				return completion;
			});
			const controller = new AbortController();
			const waiting = new WaitTool(f.session).execute("failed-refresh-cap", {}, controller.signal);
			const outcome = waiting.then(
				() => {
					throw new Error("Wait reported a successful snapshot after failed service discovery");
				},
				(error: unknown) => error,
			);
			try {
				const error = await beforeRelease(() => controller.abort(), outcome);
				expect(error).toBeInstanceOf(ToolError);
				if (!(error instanceof ToolError)) throw new Error("Expected service discovery failure");
				expect(error.message).toMatch(/service state unavailable/i);
				expect(error.message).toMatch(/not current/i);
				expect(error.message).not.toMatch(/nothing to wait for/i);
				expect(services.hasLiveOwnedService(f.session)).toBe(true);
				clock.mockRestore();
				// A failed wait must leave the actual owned completion source usable.
				const completionAbort = new AbortController();
				const exited = services.waitForOwnedServiceCompletion(f.session, completionAbort.signal);
				try {
					await f.client.request({ op: "send", name: "cap-survivor", data: "finish\n" });
					await beforeRelease(() => completionAbort.abort(), exited);
					expect(services.hasLiveOwnedService(f.session)).toBe(false);
				} finally {
					completionAbort.abort();
				}
			} finally {
				clock.mockRestore();
				controller.abort();
				await waiting.catch(() => undefined);
			}
		}));
	test("late-list-cannot-resurrect-completed-generation", () =>
		withBroker(async f => {
			await startOwned(f, "first");
			await startOwned(f, "second");
			await services.listServices(f.session);
			const gate = holdResponse(f.client, "list");
			const listed = services.listServices(f.session);
			try {
				await gate.received;
				const exited = services.waitForOwnedServiceCompletion(f.session);
				await f.client.request({ op: "send", name: "first", data: "finish\n" });
				await exited;
				gate.release();
				await listed;
				expect(services.hasLiveOwnedService(f.session)).toBe(true);
				const other = services.waitForOwnedServiceCompletion(f.session);
				await f.client.request({ op: "send", name: "second", data: "finish\n" });
				await other;
				expect(services.hasLiveOwnedService(f.session)).toBe(false);
			} finally {
				gate.release();
				await listed.catch(() => undefined);
			}
		}));
	test("late-list-rejected-after-session-generation-change", () =>
		withBroker(async f => {
			await startOwned(f, "previous");
			await services.listServices(f.session);
			const gate = holdResponse(f.client, "list");
			const listed = services.listServices(f.session);
			const outcome = listed.then(
				() => undefined,
				(error: unknown) => error,
			);
			await gate.received;
			// Same owner id but a different session revision must still reject stale state.
			for (const callback of f.change) callback();
			gate.release();
			expect(await outcome).toBeInstanceOf(Error);
			expect(services.hasLiveOwnedService(f.session)).toBe(false);
		}));
	test("late-start-cannot-overwrite-newer-replacement", () =>
		withBroker(async f => {
			vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: ["-e"],
				env: {},
				prefix: undefined,
			});
			const start = {
				name: "replace",
				command: "console.log('ready'); process.stdin.once('data', () => process.exit(0));",
				pty: false,
				ready: { log: "ready", timeout: 5 },
			};
			const gate = holdResponse(f.client, "start");
			const older = services.startService(f.session, start);
			try {
				await gate.received;
				const newer = await services.startService(f.session, start);
				gate.release();
				const late = await older;
				expect(late.daemon.id).not.toBe(newer.daemon.id);
				gate.restore();
				const controller = new AbortController();
				const exited = services.waitForOwnedServiceCompletion(f.session, controller.signal);
				await f.client.request({ op: "send", name: "replace", data: "finish\n" });
				await beforeRelease(() => controller.abort(), exited);
				expect(services.hasLiveOwnedService(f.session)).toBe(false);
			} finally {
				gate.release();
				await older.catch(() => undefined);
			}
		}));
	test("late-start-rejected-after-session-generation-change", () =>
		withBroker(async f => {
			vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: ["-e"],
				env: {},
				prefix: undefined,
			});
			const gate = holdResponse(f.client, "start");
			const older = services.startService(f.session, {
				name: "old-start",
				command: "console.log('ready'); process.stdin.resume();",
				pty: false,
				ready: { log: "ready", timeout: 5 },
			});
			const outcome = older.then(
				() => undefined,
				(error: unknown) => error,
			);
			await gate.received;
			f.session.getSessionId = () => "new-owner";
			for (const callback of f.change) callback();
			gate.release();
			expect(await outcome).toBeInstanceOf(Error);
			expect(services.hasLiveOwnedService(f.session)).toBe(false);
		}));
	test("interruptible readiness cancels only its wait and leaves the acknowledged service live", () =>
		withBroker(async f => {
			vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: ["-e"],
				env: {},
				prefix: undefined,
			});
			const gate = holdConnection();
			const interrupt = new AbortController();
			const waitSent = Promise.withResolvers<string>();
			const starting = services.startService(
				f.session,
				{
					name: "ready-survivor",
					command: "process.stdin.once('data', () => process.exit(0));",
					pty: false,
					ready: { log: "NEVER", timeout: 60 },
				},
				undefined,
				interrupt.signal,
			);
			void starting.catch(() => undefined);
			const connection = await gate.connected;
			const send = connection.send.bind(connection);
			vi.spyOn(connection, "send").mockImplementation(frame => {
				const sent = send(frame);
				if (typeof frame === "string") {
					const request = JSON.parse(frame) as { id: string; operation: { op: string } };
					if (request.operation.op === "wait") waitSent.resolve(request.id);
				}
				return sent;
			});
			try {
				gate.release();
				const requestId = await waitSent.promise;
				await f.client.request({ op: "ping" });
				interrupt.abort();
				const result = await beforeRelease(() => interrupt.abort(), starting);
				expect(result.readyInterrupted).toBe(true);
				expect(result.readyTimedOut).toBe(false);
				expect(services.hasLiveOwnedService(f.session)).toBe(true);
				expect(await f.client.request({ op: "cancel", requestId })).toEqual({ op: "cancel", cancelled: false });
				const live = await f.client.request({ op: "describe", name: "ready-survivor" });
				if (live.op !== "describe") throw new Error("Expected service snapshot");
				expect(live.daemon.id).toBe(result.daemon.id);
				expect(live.daemon.state).toBe("starting");
				// Use a fresh listener: the readiness-only interrupt has already fired.
				const completionAbort = new AbortController();
				const completion = services.waitForOwnedServiceCompletion(f.session, completionAbort.signal);
				try {
					await f.client.request({ op: "send", name: "ready-survivor", data: "finish\n" });
					await beforeRelease(() => completionAbort.abort(), completion);
					expect(services.hasLiveOwnedService(f.session)).toBe(false);
				} finally {
					completionAbort.abort();
				}
			} finally {
				gate.release();
				interrupt.abort();
				await starting.catch(() => undefined);
			}
		}));
	test("a delayed launch acknowledgement cannot wait on a same-name replacement", () =>
		withBroker(async f => {
			vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: ["-e"],
				env: {},
				prefix: undefined,
			});
			const params = {
				name: "ready-replaced",
				command: "process.stdin.once('data', () => process.exit(0));",
				pty: false,
				ready: { log: "NEVER", timeout: 60 },
			};
			const gate = holdResponse(f.client, "start");
			const interrupt = new AbortController();
			const older = services.startService(f.session, params, undefined, interrupt.signal);
			const outcome = older.catch((error: unknown) => error);
			try {
				await gate.received;
				const replacement = await services.startService(f.session, { ...params, ready: undefined });
				gate.release();
				const error = await beforeRelease(() => interrupt.abort(), outcome);
				expect(error).toBeInstanceOf(clients.DaemonBrokerRejectedError);
				expect((error as Error).message).toContain("launch generation changed");
				expect(services.hasLiveOwnedService(f.session)).toBe(true);
				const current = await f.client.request({ op: "describe", name: params.name });
				if (current.op !== "describe") throw new Error("Expected replacement snapshot");
				expect(current.daemon.id).toBe(replacement.daemon.id);
				expect(current.daemon.state).toBe("running");
			} finally {
				gate.release();
				interrupt.abort();
				await older.catch(() => undefined);
			}
		}));
	test("a session change during readiness is not hidden by a concurrent ready interrupt", () =>
		withBroker(async f => {
			vi.spyOn(f.session.settings, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: ["-e"],
				env: {},
				prefix: undefined,
			});
			const entered = Promise.withResolvers<void>();
			const request = f.client.request.bind(f.client);
			vi.spyOn(f.client, "request").mockImplementation((operation, signal) => {
				const result = request(operation, signal);
				if (operation.op === "wait") entered.resolve();
				return result;
			});
			const interrupt = new AbortController();
			const starting = services.startService(
				f.session,
				{
					name: "old-readiness",
					command: "process.stdin.resume();",
					pty: false,
					ready: { log: "NEVER", timeout: 60 },
				},
				undefined,
				interrupt.signal,
			);
			const outcome = starting.catch((error: unknown) => error);
			try {
				await entered.promise;
				for (const callback of f.change) callback();
				interrupt.abort();
				const error = await beforeRelease(() => interrupt.abort(), outcome);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("Service session changed");
				expect(services.hasLiveOwnedService(f.session)).toBe(false);
			} finally {
				interrupt.abort();
				await starting.catch(() => undefined);
			}
		}));
	test("a wait bound to an acknowledged start rejects a restarted launch with the same daemon id", () =>
		withBroker(async f => {
			await startOwned(f, "restarted-ready");
			const previous = await f.client.request({ op: "describe", name: "restarted-ready" });
			if (previous.op !== "describe") throw new Error("Expected acknowledged launch");
			const restarted = await f.client.request({ op: "restart", name: "restarted-ready" });
			if (restarted.op !== "restart") throw new Error("Expected restarted launch");
			expect(restarted.daemon.id).toBe(previous.daemon.id);
			expect(restarted.daemon.startedAt).not.toBe(previous.daemon.startedAt);
			await expect(
				f.client.request({
					op: "wait",
					name: "restarted-ready",
					for: "ready",
					timeoutMs: 5000,
					id: previous.daemon.id,
					startedAt: previous.daemon.startedAt,
				}),
			).rejects.toThrow("launch generation changed before the wait");
			const current = await f.client.request({
				op: "wait",
				name: "restarted-ready",
				for: "ready",
				timeoutMs: 5000,
				id: restarted.daemon.id,
				startedAt: restarted.daemon.startedAt,
			});
			if (current.op !== "wait") throw new Error("Expected current readiness");
			expect(current.timedOut).toBe(false);
			expect(current.daemon.state).toBe("ready");
		}));
	test.each(["wait", "logs"] as const)("cancels %s during real completion-owner persistence before polling", op =>
		withBroker(async f => {
			await startOwned(f, "metadata-survivor");
			const connection = await IpcConnection.connect(daemonBrokerEndpoint(f.runtimeDir), {
				framing: "lines",
				timeoutMs: 1000,
			});
			const token = (await fs.readFile(path.join(f.runtimeDir, "broker.token"), "utf8")).trim();
			const replies = new Map<string, { resolve: (response: DaemonWireResponse) => void }>();
			connection.start(
				line => {
					const message = parseDaemonWireMessage(JSON.parse(line));
					if (!("event" in message)) replies.get(message.id)?.resolve(message);
				},
				() => undefined,
			);
			const send = (id: string, operation: DaemonOperation, owners?: string[]) => {
				const response = Promise.withResolvers<DaemonWireResponse>();
				replies.set(id, response);
				connection.send(
					JSON.stringify({
						id,
						token,
						operation,
						owners,
						completionEvents: owners !== undefined,
						completionSubscriptionId: "persistence-regression",
					}),
				);
				return response.promise;
			};
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const rename = fs.rename;
			let held = false;
			const metadataPath = path.join(f.runtimeDir, "daemons", "metadata-survivor", "meta.json");
			vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (!held && to === metadataPath) {
					held = true;
					entered.resolve();
					await release.promise;
				}
				return rename(from, to);
			});
			const operation: DaemonOperation =
				op === "wait"
					? { op, name: "metadata-survivor", for: "exit", timeoutMs: 60_000 }
					: { op, name: "metadata-survivor", lines: 20, head: false, follow: true, timeoutMs: 60_000 };
			const pending = send("held-request", operation, [f.owner]);
			// A watchdog bounds real native IPC/filesystem failure; fake timers
			// cannot drive the broker's child process or atomic-rename completion.
			const watchdog = setTimeout(() => {
				entered.reject(new Error("Completion-owner persistence gate was not reached"));
				release.resolve();
			}, 2000);
			try {
				await entered.promise;
				clearTimeout(watchdog);
				// Another socket cannot cancel this request, even with its exact id.
				expect(await f.client.request({ op: "cancel", requestId: "held-request" })).toEqual({
					op: "cancel",
					cancelled: false,
				});
				// This response must arrive while the real metadata rename is still
				// gated. The helper releases persistence only after receiving it.
				const cancelled = await beforeRelease(
					release.resolve,
					send("cancel-request", { op: "cancel", requestId: "held-request" }),
				);
				expect(cancelled).toEqual({ id: "cancel-request", ok: true, result: { op: "cancel", cancelled: true } });
				const result = await beforeRelease(release.resolve, pending);
				expect(result.ok).toBe(false);
				if (result.ok) throw new Error("Cancelled request unexpectedly succeeded");
				expect(result.error).toContain("cancelled");
				expect(await send("late-cancel", { op: "cancel", requestId: "held-request" })).toMatchObject({
					ok: true,
					result: { cancelled: false },
				});
				const live = await f.client.request({ op: "describe", name: "metadata-survivor" });
				if (live.op !== "describe") throw new Error("Expected live service");
				expect(live.daemon.state).toBe("ready");
				await f.client.request({ op: "send", name: "metadata-survivor", data: "finish\n" });
				const exited = await f.client.request({ op: "wait", name: "metadata-survivor", for: "exit", timeoutMs: 5000 });
				if (exited.op !== "wait") throw new Error("Expected exited service");
				expect(exited.daemon.state).toBe("exited");
			} finally {
				clearTimeout(watchdog);
				release.resolve();
				connection.destroy();
			}
		}),
	);
});
