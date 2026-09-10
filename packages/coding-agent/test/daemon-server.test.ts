import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@oh-my-pi/pi-utils";
import * as buildStamp from "../src/daemon/build-stamp";
import { DaemonClient } from "../src/daemon/client";
import {
	DAEMON_MAX_FRAME_BYTES,
	DAEMON_PROTOCOL_MAJOR,
	type DaemonFrame,
	decodeDaemonFrame,
	encodeDaemonFrame,
} from "../src/daemon/protocol";
import { DaemonServer, startDaemonServerFromEnvironment } from "../src/daemon/server";
import { DaemonSessionRegistry } from "../src/daemon/session-registry";
import type {
	DaemonSessionCreateOverrides,
	DaemonSessionRuntime,
	DaemonSessionSnapshot,
} from "../src/daemon/session-runtime";
import * as sdk from "../src/sdk";
import type { AgentSessionEventListener } from "../src/session/agent-session";
import { RemoteSessionHandle } from "../src/session/session-handle";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function fakeFactory(protectedJobCount = 0) {
	const runtimes = new Map<
		string,
		{ emit(event: unknown): void; commands: string[]; disposed: boolean; disposedReason?: postmortem.Reason }
	>();
	const runtimeFactory = async ({
		cwd,
		sessionId,
	}: {
		cwd: string;
		sessionId?: string;
	}): Promise<DaemonSessionRuntime> => {
		const id = sessionId ?? `generated-${runtimes.size}`;
		const listeners = new Set<(event: never) => void>();
		const state: {
			emit: (event: unknown) => void;
			commands: string[];
			disposed: boolean;
			disposedReason?: postmortem.Reason;
		} = {
			emit: (event: unknown) => {
				const payload = event as never;
				listeners.forEach(listener => {
					listener(payload);
				});
			},
			commands: [],
			disposed: false,
		};
		runtimes.set(id, state);
		const session: DaemonSessionRuntime["session"] = {
			sessionId: id,
			isStreaming: false,
			prompt: async (text: string) => {
				state.commands.push(text);
				return true;
			},
			abort: async () => undefined,
			dispose: async () => {
				state.disposed = true;
			},
			subscribe: (listener: AgentSessionEventListener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		return {
			sessionId: id,
			cwd,
			session,
			protectedJobCount: () => protectedJobCount,
			snapshot: (): DaemonSessionSnapshot => ({
				state: {
					sessionId: id,
					thinkingLevel: undefined,
					isStreaming: false,
					fastModeEnabled: false,
					fastModeActive: false,
					tokensPerSecond: null,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					interruptMode: "immediate",
					autoCompactionEnabled: true,
					messageCount: state.commands.length,
					queuedMessageCount: 0,
					todoPhases: [],
				},
				cwd,
				entries: [],
			}),
			command: async command => {
				if (
					typeof command !== "object" ||
					command === null ||
					!("text" in command) ||
					typeof command.text !== "string"
				)
					throw new Error("text required");
				state.commands.push(command.text);
				return { accepted: true };
			},
			dispose: async reason => {
				state.disposedReason = reason;
				await session.dispose();
			},
			subscribe: session.subscribe,
		};
	};
	return { runtimes, runtimeFactory };
}

class FrameReader {
	#buffer = "";
	#frames: DaemonFrame[] = [];
	#waiters: Array<{ resolve: (frame: DaemonFrame) => void; reject: (error: Error) => void }> = [];

	constructor(readable: net.Socket) {
		readable.setEncoding("utf8");
		readable.on("data", chunk => {
			this.#buffer += String(chunk);
			for (;;) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) return;
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				if (!line) continue;
				const frame = decodeDaemonFrame(line);
				const waiter = this.#waiters.shift();
				if (waiter) waiter.resolve(frame);
				else this.#frames.push(frame);
			}
		});
		readable.on("error", error => {
			for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
		});
	}

	next(): Promise<DaemonFrame> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		const deferred = Promise.withResolvers<DaemonFrame>();
		this.#waiters.push(deferred);
		return deferred.promise;
	}
}

async function connect(endpoint: string): Promise<{ socket: net.Socket; reader: FrameReader }> {
	const deferred = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: endpoint });
	socket.once("connect", () => deferred.resolve(socket));
	socket.once("error", deferred.reject);
	const connected = await deferred.promise;
	return { socket: connected, reader: new FrameReader(connected) };
}

function hello(token: string, requestId = "hello"): DaemonFrame {
	return { v: DAEMON_PROTOCOL_MAJOR, tag: "hello", requestId, profile: "test", token };
}

async function destroyAndWait(socket: net.Socket): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	socket.once("close", () => deferred.resolve());
	socket.destroy();
	await deferred.promise;
}

describe("daemon server and registry", () => {
	test("keeps independent sessions, one interactive lease, and detached work", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-registry-"));
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({
			runtimeFactory: fake.runtimeFactory,
			id: (() => {
				let n = 0;
				return () => `s${++n}`;
			})(),
		});
		const first = await registry.create(undefined, root);
		const second = await registry.create(undefined, root);
		expect(registry.status().sessionCount).toBe(2);
		const sink: unknown[] = [];
		await registry.attach(first.sessionId, "a1", "interactive", frame => {
			sink.push(frame);
		});
		await expect(
			registry.attach(first.sessionId, "a2", "interactive", frame => {
				sink.push(frame);
			}),
		).rejects.toMatchObject({ code: "session_busy" });
		await registry.attach(first.sessionId, "o1", "observe", frame => {
			sink.push(frame);
		});
		await expect(registry.command(first.sessionId, "o1", { text: "no" })).rejects.toMatchObject({
			code: "session_busy",
		});
		registry.disconnect(first.sessionId, "a1");
		await registry.attach(first.sessionId, "a2", "interactive", frame => {
			sink.push(frame);
		});
		expect(registry.status().attachmentCount).toBe(2);
		expect(second.sessionId).not.toBe(first.sessionId);
		await registry.dispose();
		expect(fake.runtimes.get(first.sessionId)?.disposed).toBe(true);
		expect(fake.runtimes.get(second.sessionId)?.disposed).toBe(true);
	});

	test("terminal attachments preserve sequence while omitting semantic event payloads", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-terminal-events-"));
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({ runtimeFactory: fake.runtimeFactory });
		const session = await registry.create("terminal", root);
		const frames: unknown[] = [];
		await registry.attach(
			session.sessionId,
			"terminal-client",
			"interactive",
			frame => {
				frames.push(frame);
			},
			undefined,
			"terminal",
		);

		const largePayload = "semantic-payload".repeat(32 * 1024);
		fake.runtimes.get(session.sessionId)?.emit({ type: "message_update", message: largePayload });
		fake.runtimes.get(session.sessionId)?.emit({ type: "terminal_output", data: "visible" });

		const events = frames as Array<{ type?: unknown; seq?: unknown; event?: { type?: unknown; data?: unknown } }>;
		expect(events.map(frame => frame.seq)).toEqual([1, 2]);
		expect(events.map(frame => frame.event?.type)).toEqual(["daemon_event_skipped", "terminal_output"]);
		expect(JSON.stringify(events[0])).not.toContain("semantic-payload");
		expect(events[1]?.event?.data).toBe("visible");
		await registry.dispose();
	});
	test("yields large terminal output fanout between bounded batches", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-terminal-yield-"));
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({ runtimeFactory: fake.runtimeFactory });
		const session = await registry.create("terminal-yield", root);
		const frames: unknown[] = [];
		const complete = Promise.withResolvers<void>();
		const output = "x".repeat(128 * 1024 * 40);
		const expectedChunks = Math.ceil(output.length / (128 * 1024));
		await registry.attach(session.sessionId, "terminal-client", "interactive", frame => {
			frames.push(frame);
			if (frames.length === expectedChunks) complete.resolve();
		});

		const observer = Promise.withResolvers<void>();
		queueMicrotask(observer.resolve);
		fake.runtimes.get(session.sessionId)?.emit({ type: "terminal_output", data: output });

		expect(frames.length).toBeGreaterThan(0);
		expect(frames.length).toBeLessThan(expectedChunks);
		await observer.promise;
		await complete.promise;
		expect(frames.length).toBe(expectedChunks);
		await registry.dispose();
	});
	test("recovers terminal fanout after an attachment sink throws", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-terminal-fanout-recovery-"));
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({ runtimeFactory: fake.runtimeFactory });
		const session = await registry.create("terminal-fanout-recovery", root);
		const delivered: unknown[] = [];
		let calls = 0;
		await registry.attach(
			session.sessionId,
			"terminal-client",
			"interactive",
			frame => {
				calls++;
				if (calls === 1) throw new Error("sink failed");
				delivered.push(frame);
			},
			0,
		);

		fake.runtimes.get(session.sessionId)?.emit({ type: "terminal_output", data: "first" });
		fake.runtimes.get(session.sessionId)?.emit({ type: "terminal_output", data: "second" });

		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatchObject({
			type: "event",
			event: { type: "terminal_output", data: "second" },
		});
		await registry.dispose();
	});
	test("hosts independent sessions from different working-directory roots", async () => {
		const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-cwd-a-"));
		const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-cwd-b-"));
		const secondAlias = path.join(os.tmpdir(), `omp-daemon-cwd-alias-${crypto.randomUUID()}`);
		await fs.symlink(secondRoot, secondAlias);
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({ runtimeFactory: fake.runtimeFactory });

		const first = await registry.create("first", firstRoot);
		const second = await registry.create("second", secondAlias);

		expect(first.cwd).toBe(await fs.realpath(firstRoot));
		expect(second.cwd).toBe(await fs.realpath(secondRoot));
		expect(registry.status().sessionCount).toBe(2);
		await registry.dispose();
		await fs.rm(secondAlias);
	});

	test("parks an idle detached runtime after the configured grace period", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-park-"));
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({
			runtimeFactory: fake.runtimeFactory,
			detachedSessionTtlMs: 15,
			listSessions: async () => [{ id: "parked", path: path.join(root, "parked.jsonl"), cwd: root }],
		});
		await registry.create("parked", root);
		await registry.attach("parked", "interactive", "interactive", () => undefined);

		await Bun.sleep(30);
		expect(registry.status().sessionCount).toBe(1);
		registry.detach("parked", "interactive");
		await Bun.sleep(40);

		expect(registry.status().sessionCount).toBe(0);
		expect(fake.runtimes.get("parked")?.disposed).toBe(true);
		expect((await registry.load("parked")).cwd).toBe(await fs.realpath(root));
		expect(registry.status().sessionCount).toBe(1);
		await registry.close("parked");
	});

	test("waits for detached protected work to finish before parking", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-park-protected-"));
		const fake = fakeFactory();
		let protectedJobCount = 1;
		const registry = new DaemonSessionRegistry({
			runtimeFactory: async options => ({
				...(await fake.runtimeFactory(options)),
				protectedJobCount: () => protectedJobCount,
			}),
			detachedSessionTtlMs: 15,
		});
		await registry.create("protected", root);

		await Bun.sleep(30);
		expect(registry.status().sessionCount).toBe(1);
		protectedJobCount = 0;
		fake.runtimes.get("protected")?.emit({ type: "protected_job_finished" });
		await Bun.sleep(40);

		expect(registry.status().sessionCount).toBe(0);
		expect(fake.runtimes.get("protected")?.disposed).toBe(true);
	});

	test("serves separate projects through the unnamed profile endpoint", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-profile-"));
		const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-profile-a-"));
		const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-profile-b-"));
		const runtimeDir = path.join(root, "runtime");
		const server = new DaemonServer({
			profile: null,
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await server.run();
		const client = new DaemonClient({ profile: null, runtimeDir, token: "secret" });
		try {
			await client.connect();
			await client.request("session_create", { sessionId: "first", cwd: firstRoot });
			await client.request("session_create", { sessionId: "second", cwd: secondRoot });
			const sessions = (await client.request("session_list")) as Array<{
				sessionId: string;
				cwd: string;
			}>;
			expect(sessions).toEqual([
				expect.objectContaining({ sessionId: "first", cwd: await fs.realpath(firstRoot) }),
				expect.objectContaining({ sessionId: "second", cwd: await fs.realpath(secondRoot) }),
			]);
			expect(server.status().sessionCount).toBe(2);
			expect(server.status().shard.profile).toBeNull();
		} finally {
			await server.registry.close("first").catch(() => undefined);
			await server.registry.close("second").catch(() => undefined);
			client.close();
			await server.shutdown(true);
		}
	});

	test("removes an exited hosted session while its runtime cleanup continues", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-terminal-exit-"));
		const fake = fakeFactory();
		const releaseDispose = Promise.withResolvers<void>();
		const registry = new DaemonSessionRegistry({
			runtimeFactory: async options => {
				const runtime = await fake.runtimeFactory(options);
				return {
					...runtime,
					dispose: async reason => {
						await releaseDispose.promise;
						await runtime.dispose(reason);
					},
				};
			},
		});
		const session = await registry.create("exiting", root);
		await registry.attach(session.sessionId, "interactive", "interactive", () => {});

		fake.runtimes.get(session.sessionId)?.emit({ type: "terminal_closed", reason: "exit" });
		await flushMicrotasks();

		expect(registry.list()).toEqual([]);
		expect(registry.status().attachmentCount).toBe(0);
		expect(fake.runtimes.get(session.sessionId)?.disposed).toBe(false);

		releaseDispose.resolve();
		await flushMicrotasks();
		expect(fake.runtimes.get(session.sessionId)?.disposed).toBe(true);
		expect(fake.runtimes.get(session.sessionId)?.disposedReason).toBe(postmortem.Reason.EXIT);
	});

	test("loads and resumes persisted session IDs through the injected runtime factory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-load-"));
		const fake = fakeFactory();
		const requestedFiles: string[] = [];
		const forwarded: Array<{ cwd: string; overrides?: DaemonSessionCreateOverrides }> = [];
		const registry = new DaemonSessionRegistry({
			runtimeFactory: async options => {
				if (options.sessionFile) requestedFiles.push(options.sessionFile);
				forwarded.push({ cwd: options.cwd, overrides: options.overrides });
				return fake.runtimeFactory(options);
			},
			listSessions: async () => [{ id: "persisted", path: path.join(root, "persisted.jsonl"), cwd: root }],
		});
		expect((await registry.load("persisted")).sessionId).toBe("persisted");
		expect((await registry.resume("persisted")).sessionId).toBe("persisted");
		expect(requestedFiles).toEqual([path.join(root, "persisted.jsonl")]);
		const child = path.join(root, "child");
		await fs.mkdir(child);
		const overrides: DaemonSessionCreateOverrides = {
			provider: "openai",
			model: "gpt-test",
			thinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
		};
		await registry.create("override", child, overrides);
		expect(forwarded.at(-1)).toEqual({ cwd: child, overrides });
		await registry.close("override");
		await registry.close("persisted");
		expect(fake.runtimes.get("persisted")?.disposed).toBe(true);
	});
	test("a losing startup contender cannot remove the active daemon lease", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-race-"));
		const runtimeDir = path.join(root, "runtime");
		const winner = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await winner.run();
		const loser = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		try {
			await expect(loser.run()).rejects.toThrow(/already owned/);
			expect(await Bun.file(path.join(runtimeDir, "daemon.owner")).exists()).toBe(true);
			const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
			try {
				await expect(client.serverStatus()).resolves.toMatchObject({ daemonId: winner.status().daemonId });
			} finally {
				client.close();
			}
		} finally {
			await winner.shutdown(true);
		}
	});
	test("the hidden daemon worker exits cleanly when another contender won startup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-worker-race-"));
		const runtimeDir = path.join(root, "runtime");
		const winner = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await winner.run();
		try {
			await expect(
				startDaemonServerFromEnvironment({
					profile: "test",
					runtimeDir,
					token: "secret",
					runtimeFactory: fakeFactory().runtimeFactory,
				}),
			).resolves.toBeUndefined();
			expect(await Bun.file(path.join(runtimeDir, "daemon.owner")).exists()).toBe(true);
		} finally {
			await winner.shutdown(true);
		}
	});
	test("forced shutdown releases the socket and owner lease for immediate restart", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-shutdown-cleanup-"));
		const runtimeDir = path.join(root, "runtime");
		const ownerPath = path.join(runtimeDir, "daemon.owner");
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		let restarted: DaemonServer | undefined;
		try {
			await server.run();
			const endpoint = server.endpoint!;
			expect(await Bun.file(ownerPath).exists()).toBe(true);
			await expect(fs.stat(endpoint)).resolves.toBeDefined();

			await server.shutdown(true);
			expect(await Bun.file(ownerPath).exists()).toBe(false);
			await expect(fs.stat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });

			restarted = new DaemonServer({
				profile: "test",
				runtimeDir,
				token: "secret",
				runtimeFactory: fakeFactory().runtimeFactory,
			});
			await restarted.run();
			expect(restarted.status().shard.profile).toBe("test");
		} finally {
			await restarted?.shutdown(true);
			await server.shutdown(true);
		}
	});

	test("half-closed peer sockets never park shutdown or leak descriptors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-halfclose-"));
		const runtimeDir = path.join(root, "runtime");
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		let halfClosed: net.Socket | undefined;
		try {
			await server.run();
			// A rude peer half-closes (FIN) without ever completing the socket:
			// pre-fix the released connection stayed out of tracking while
			// net.Server.close() waited on it forever.
			const socket = net.createConnection({ path: server.endpoint! });
			halfClosed = socket;
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", () => resolve());
				socket.once("error", reject);
			});
			// Client 'connect' can fire before the server's accept callback runs;
			// prove the connection actually entered tracking before half-closing,
			// otherwise the FIN-release observation below is vacuous.
			const acceptDeadline = Date.now() + 3_000;
			while (server.idleShutdownEligible() && Date.now() < acceptDeadline) {
				await Bun.sleep(10);
			}
			expect(server.idleShutdownEligible()).toBe(false);
			halfClosed.end();
			// Wait until the server actually processed the FIN and released the
			// connection — otherwise shutdown's own destroy loop still covers
			// the socket and the pre-fix code would pass too.
			const releaseDeadline = Date.now() + 3_000;
			while (!server.idleShutdownEligible() && Date.now() < releaseDeadline) {
				await Bun.sleep(10);
			}
			expect(server.idleShutdownEligible()).toBe(true);

			const started = performance.now();
			const result = await server.shutdown(true);
			expect(result.shutdown).toBe(true);
			// Contract: the release path destroyed the half-closed socket, so
			// shutdown never needed the 2s lingering-socket fallback. The bound
			// only has to separate the two paths, not measure performance.
			expect(performance.now() - started).toBeLessThan(1_900);
			await expect(fs.stat(server.endpoint!)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			halfClosed?.destroy();
			await server.shutdown(true);
		}
	}, 10_000);

	test("reclaims a malformed owner lease when no daemon is listening", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-corrupt-"));
		const runtimeDir = path.join(root, "runtime");
		await fs.mkdir(runtimeDir, { recursive: true });
		await Bun.write(path.join(runtimeDir, "daemon.owner"), "{not valid json");
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		try {
			await server.run();
			const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
			try {
				await expect(client.serverStatus()).resolves.toMatchObject({ daemonId: server.status().daemonId });
			} finally {
				client.close();
			}
			expect(await Bun.file(path.join(runtimeDir, "daemon.owner")).exists()).toBe(true);
		} finally {
			await server.shutdown(true);
		}
	});

	test("reclaims a stale owner lease when its live pid belongs to another process", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-reused-pid-"));
		const runtimeDir = path.join(root, "runtime");
		const ownerPath = path.join(runtimeDir, "daemon.owner");
		await fs.mkdir(runtimeDir, { recursive: true });
		await Bun.write(
			ownerPath,
			JSON.stringify({ pid: process.pid, daemonId: "stale-owner", startedAt: Date.now() - 60_000 }),
		);
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			// The production lease loop performs one 100ms platform-clock poll;
			// this integration contract must cross that real ownership deadline.
			ownerLeaseWaitMs: 1,
			ownerProcessVerifier: () => false,
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		try {
			await server.run();
			const owner = await Bun.file(ownerPath).json();
			expect(owner.daemonId).toBe(server.status().daemonId);
		} finally {
			await server.shutdown(true).catch(() => undefined);
		}
	});

	test("publishes an authenticated endpoint before shared resources finish initializing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-starting-"));
		const runtimeDir = path.join(root, "runtime");
		const ownerPath = path.join(runtimeDir, "daemon.owner");
		const authStorage = await sdk.discoverAuthStorage(path.join(root, "agent"));
		const discovery = Promise.withResolvers<typeof authStorage>();
		const discoveryStarted = Promise.withResolvers<void>();
		const discover = spyOn(sdk, "discoverAuthStorage").mockImplementation(() => {
			discoveryStarted.resolve();
			return discovery.promise;
		});
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			buildStamp: "test",
		});
		const started = server.run();
		const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
		try {
			await discoveryStarted.promise;
			expect(await Bun.file(ownerPath).exists()).toBe(true);
			expect((await fs.stat(path.join(runtimeDir, "daemon.sock"))).isSocket()).toBe(true);
			const status = await client.serverStatus();
			expect(status).toMatchObject({ daemonId: server.status().daemonId });
		} finally {
			discovery.resolve(authStorage);
			await started.catch(() => undefined);
			client.close();
			await server.shutdown(true).catch(() => undefined);
			discover.mockRestore();
		}
	});

	test("resolves the build stamp before the socket accepts a handshake", async () => {
		// A daemon that listens before its stamp resolves answers `hello` without
		// a `buildStamp`; the client that just spawned it then reads that as a
		// mismatched build and shuts it down, looping until it gives up with
		// `connect ENOENT …/daemon.sock`.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-stamp-order-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const stamp = Promise.withResolvers<string>();
		const stampRequested = Promise.withResolvers<void>();
		const stampSpy = spyOn(buildStamp, "daemonBuildStamp").mockImplementation(() => {
			stampRequested.resolve();
			return stamp.promise;
		});
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		const started = server.run();
		try {
			await stampRequested.promise;
			await expect(fs.stat(endpoint)).rejects.toMatchObject({ code: "ENOENT" });
			stamp.resolve("stamp-1");
			await started;
			const { socket, reader } = await connect(endpoint);
			try {
				socket.write(encodeDaemonFrame(hello("secret")));
				expect(await reader.next()).toMatchObject({ tag: "hello_ok", buildStamp: "stamp-1" });
			} finally {
				await destroyAndWait(socket);
			}
		} finally {
			stamp.resolve("stamp-1");
			await started.catch(() => undefined);
			await server.shutdown(true).catch(() => undefined);
			stampSpy.mockRestore();
		}
	});
	test("waits out a live-but-unbound owner and reclaims once it drains", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-drain-"));
		const runtimeDir = path.join(root, "runtime");
		const ownerPath = path.join(runtimeDir, "daemon.owner");
		await fs.mkdir(runtimeDir, { recursive: true });
		// A live pid (this test process) with no listener: the shape a draining
		// or starting predecessor leaves behind.
		await Bun.write(ownerPath, JSON.stringify({ pid: process.pid, daemonId: "drainer", startedAt: Date.now() }));
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			ownerLeaseWaitMs: 2_000,
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		// Real delay on purpose: server.run() polls the owner file with real
		// wall-clock sleeps internally, so fake timers cannot drive this loop.
		// Simulate the predecessor finishing its drain shortly after the
		// contender starts polling.
		const release = Bun.sleep(250).then(() => fs.rm(ownerPath, { force: true }));
		try {
			await server.run();
			await release;
			const owner = await Bun.file(ownerPath).json();
			expect(owner.daemonId).toBe(server.status().daemonId);
		} finally {
			await server.shutdown(true);
			await release;
		}
	});
	test("gives up on a live-but-unbound owner only after the lease deadline", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-stuck-"));
		const runtimeDir = path.join(root, "runtime");
		const ownerPath = path.join(runtimeDir, "daemon.owner");
		await fs.mkdir(runtimeDir, { recursive: true });
		await Bun.write(ownerPath, JSON.stringify({ pid: process.pid, daemonId: "stuck", startedAt: Date.now() }));
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			ownerLeaseWaitMs: 400,
			ownerProcessVerifier: () => undefined,
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		const startedAt = Date.now();
		try {
			await expect(server.run()).rejects.toThrow(/still starting|still draining/);
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
			// The stuck owner's lease must be left untouched.
			const owner = await Bun.file(ownerPath).json();
			expect(owner.daemonId).toBe("stuck");
		} finally {
			await server.shutdown(true).catch(() => undefined);
		}
	});
	test("releases interactive lease on EOF, replays ordered events, and gates idle shutdown", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-replay-"));
		const runtimeDir = path.join(root, "runtime");
		const fake = fakeFactory(1);
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fake.runtimeFactory,
		});
		await server.run();
		const endpoint = server.endpoint!;
		const canonicalRoot = await fs.realpath(root);
		const first = await connect(endpoint);
		first.socket.write(encodeDaemonFrame(hello("secret", "h1")));
		expect((await first.reader.next()).tag).toBe("hello_ok");
		first.socket.write(
			encodeDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "create",
				operation: { op: "session_create", sessionId: "s1", cwd: canonicalRoot },
			}),
		);
		expect((await first.reader.next()).tag).toBe("response");
		first.socket.write(
			encodeDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "attach",
				operation: { op: "attach", sessionId: "s1", attachmentId: "a1", mode: "interactive" },
			}),
		);
		const initialFrames = [
			await first.reader.next(),
			await first.reader.next(),
			await first.reader.next(),
			await first.reader.next(),
		];
		expect(initialFrames.map(frame => frame.tag)).toEqual([
			"snapshot_begin",
			"snapshot_chunk",
			"snapshot_end",
			"response",
		]);
		fake.runtimes.get("s1")?.emit({ type: "message_update", text: "one" });
		expect((await first.reader.next()).tag).toBe("event");
		await destroyAndWait(first.socket);
		// The server-side close callback is a separate Unix-socket event; fake timers cannot drive libuv I/O.
		for (let attempt = 0; attempt < 100 && server.status().attachmentCount > 0; attempt++) {
			await Bun.sleep(10);
		}
		expect(server.status().sessionCount).toBe(1);
		expect(server.status().attachmentCount).toBe(0);
		fake.runtimes.get("s1")?.emit({ type: "message_update", text: "two" });

		const second = await connect(endpoint);
		second.socket.write(encodeDaemonFrame(hello("secret", "h2")));
		expect((await second.reader.next()).tag).toBe("hello_ok");
		second.socket.write(
			encodeDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "reattach",
				operation: { op: "attach", sessionId: "s1", attachmentId: "a2", mode: "interactive", lastSeq: 1 },
			}),
		);
		const replay = [await second.reader.next(), await second.reader.next()];
		expect(replay[0]?.tag).toBe("event");
		expect(replay[1]?.tag).toBe("response");
		expect(server.status().attachmentCount).toBe(1);
		const blocked = await server.shutdown();
		expect(blocked.shutdown).toBe(false);
		expect(blocked.blockers).toContain("clients");
		expect(blocked.blockers).toContain("sessions");
		expect(blocked.blockers).toContain("protected_jobs");
		await destroyAndWait(second.socket);
		await server.shutdown(true);

		const idleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-idle-"));
		const idleServer = new DaemonServer({
			profile: "test",
			runtimeDir: path.join(idleRoot, "runtime"),
			token: "secret",
			runtimeFactory: fakeFactory(1).runtimeFactory,
		});
		await idleServer.run();
		await idleServer.registry.create("idle", idleRoot);
		const idleBlocked = await idleServer.shutdown();
		expect(idleBlocked.blockers).toContain("sessions");
		expect(idleBlocked.blockers).toContain("protected_jobs");
		await idleServer.registry.close("idle");
		expect(idleServer.idleShutdownEligible()).toBe(true);
		expect((await idleServer.shutdown()).shutdown).toBe(true);
	});

	test("an oversized session event becomes a truncation marker instead of wedging the stream", async () => {
		// A >1MiB event cannot encode into a wire frame: pre-fix it threw
		// synchronously through the session's subscribe listener, poisoned the
		// replay log, and froze the attached client mid-render (observed with a
		// 120MB transcript). The registry must bound it to a marker with normal
		// seq so live delivery AND replay keep flowing.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-oversize-"));
		const runtimeDir = path.join(root, "runtime");
		const fake = fakeFactory();
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fake.runtimeFactory,
		});
		await server.run();
		try {
			const endpoint = server.endpoint!;
			const canonicalRoot = await fs.realpath(root);
			const client = await connect(endpoint);
			client.socket.write(encodeDaemonFrame(hello("secret", "h1")));
			expect((await client.reader.next()).tag).toBe("hello_ok");
			client.socket.write(
				encodeDaemonFrame({
					v: DAEMON_PROTOCOL_MAJOR,
					tag: "request",
					requestId: "create",
					operation: { op: "session_create", sessionId: "big", cwd: canonicalRoot },
				}),
			);
			expect((await client.reader.next()).tag).toBe("response");
			client.socket.write(
				encodeDaemonFrame({
					v: DAEMON_PROTOCOL_MAJOR,
					tag: "request",
					requestId: "attach",
					operation: { op: "attach", sessionId: "big", attachmentId: "a1", mode: "interactive" },
				}),
			);
			const preamble = [
				await client.reader.next(),
				await client.reader.next(),
				await client.reader.next(),
				await client.reader.next(),
			];
			expect(preamble.map(frame => frame.tag)).toEqual([
				"snapshot_begin",
				"snapshot_chunk",
				"snapshot_end",
				"response",
			]);

			// Live leg: the oversized event arrives as a marker and the stream
			// stays alive with the next seq.
			fake.runtimes.get("big")?.emit({ type: "message_update", text: "x".repeat(2 * 1024 * 1024) });
			const truncated = (await client.reader.next()) as {
				tag: string;
				seq?: number;
				event?: { type?: string; reason?: string };
			};
			expect(truncated.tag).toBe("event");
			expect(truncated.event?.type).toBe("daemon_event_truncated");
			expect(truncated.event?.reason).toBe("oversized");
			fake.runtimes.get("big")?.emit({ type: "message_update", text: "after" });
			const following = (await client.reader.next()) as { tag: string; seq?: number; event?: { text?: string } };
			expect(following.tag).toBe("event");
			expect(following.event?.text).toBe("after");
			expect(following.seq).toBe((truncated.seq ?? 0) + 1);
			await destroyAndWait(client.socket);
			server.registry.disconnect("big", "a1");

			// Replay leg — the one that used to wedge forever: emit the poison
			// while NO attachment is connected so it lands in the retained log,
			// then reattach from before it. The log must hold a marker that
			// replays cleanly instead of an event that fails to encode.
			fake.runtimes.get("big")?.emit({ type: "message_update", text: "y".repeat(2 * 1024 * 1024) });
			fake.runtimes.get("big")?.emit({ type: "message_update", text: "tail" });
			const second = await connect(endpoint);
			second.socket.write(encodeDaemonFrame(hello("secret", "h2")));
			expect((await second.reader.next()).tag).toBe("hello_ok");
			second.socket.write(
				encodeDaemonFrame({
					v: DAEMON_PROTOCOL_MAJOR,
					tag: "request",
					requestId: "reattach",
					operation: {
						op: "attach",
						sessionId: "big",
						attachmentId: "a2",
						mode: "interactive",
						lastSeq: following.seq ?? 2,
					},
				}),
			);
			const replayMarker = (await second.reader.next()) as { tag: string; event?: { type?: string } };
			const replayTail = (await second.reader.next()) as { tag: string; event?: { text?: string } };
			const replayResponse = await second.reader.next();
			expect(replayMarker.tag).toBe("event");
			expect(replayMarker.event?.type).toBe("daemon_event_truncated");
			expect(replayTail.tag).toBe("event");
			expect(replayTail.event?.text).toBe("tail");
			expect(replayResponse.tag).toBe("response");
			await destroyAndWait(second.socket);
		} finally {
			await server.shutdown(true);
		}
	}, 20_000);

	test("authenticates before mutation and reports authoritative status over Unix socket", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-server-"));
		const runtimeDir = path.join(root, "runtime");
		const fake = fakeFactory();
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fake.runtimeFactory,
		});
		await server.run();
		const endpoint = server.endpoint!;
		const bad = await connect(endpoint);
		bad.socket.write(encodeDaemonFrame(hello("wrong", "bad")));
		const badResponse = await bad.reader.next();
		expect(badResponse.tag).toBe("response");
		expect(fake.runtimes.size).toBe(0);
		bad.socket.destroy();
		const incompatible = await connect(endpoint);
		incompatible.socket.write(
			`${JSON.stringify({ v: 99, tag: "hello", requestId: "version", profile: "test", token: "secret" })}\n`,
		);
		expect((await incompatible.reader.next()).tag).toBe("response");
		expect(fake.runtimes.size).toBe(0);
		incompatible.socket.destroy();

		const client = await connect(endpoint);
		const canonicalRoot = await fs.realpath(root);
		client.socket.write(encodeDaemonFrame(hello("secret")));
		expect((await client.reader.next()).tag).toBe("hello_ok");
		client.socket.write(
			encodeDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "create",
				operation: {
					op: "session_create",
					sessionId: "s1",
					cwd: canonicalRoot,
					overrides: {
						provider: "openai",
						model: "gpt-test",
						thinkingLevel: "high",
						steeringMode: "all",
						followUpMode: "all",
					},
				},
			}),
		);
		expect((await client.reader.next()).tag).toBe("response");
		client.socket.write(
			encodeDaemonFrame({
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "request",
				requestId: "status",
				operation: { op: "server_status" },
			}),
		);
		const status = await client.reader.next();
		expect(status.tag).toBe("response");
		expect(server.status().sessionCount).toBe(1);
		expect(server.status().attachmentCount).toBe(0);
		client.socket.destroy();
		const shutdown = await server.shutdown(true);
		expect(shutdown.shutdown).toBe(true);
	});
	test("buffers events emitted during attachment snapshot without a sequence gap", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-attach-race-"));
		let emit: ((event: unknown) => void) | undefined;
		let emitted = false;
		const registry = new DaemonSessionRegistry({
			runtimeFactory: async ({ cwd, sessionId }): Promise<DaemonSessionRuntime> => {
				const listeners = new Set<AgentSessionEventListener>();
				emit = event => {
					for (const listener of listeners) listener(event as never);
				};
				const session = {
					sessionId: sessionId ?? "race",
					prompt: async () => true,
					abort: async () => undefined,
					dispose: async () => undefined,
					subscribe: (listener: AgentSessionEventListener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				} as DaemonSessionRuntime["session"];
				return {
					sessionId: session.sessionId,
					cwd,
					session,
					snapshot: (): DaemonSessionSnapshot => {
						if (!emitted) {
							emitted = true;
							emit?.({ type: "message_end" });
						}
						return {
							state: {
								sessionId: session.sessionId,
								thinkingLevel: undefined,
								isStreaming: false,
								fastModeEnabled: false,
								fastModeActive: false,
								tokensPerSecond: null,
								isCompacting: false,
								steeringMode: "all",
								followUpMode: "all",
								interruptMode: "immediate",
								autoCompactionEnabled: true,
								messageCount: 0,
								queuedMessageCount: 0,
								todoPhases: [],
							},
							cwd,
							entries: [],
						};
					},
					command: async () => ({}),
					dispose: reason => session.dispose(reason === undefined ? undefined : { reason }),
					subscribe: session.subscribe,
				};
			},
		});
		await registry.create("race", root);
		const frames: unknown[] = [];
		const attached = await registry.attach("race", "a1", "observe", frame => {
			frames.push(frame);
		});
		expect(attached.barrierSeq).toBe(1);
		expect(attached.frames.map(frame => (frame as { type?: unknown }).type)).toEqual([
			"snapshot_begin",
			"snapshot_chunk",
			"snapshot_end",
		]);
		expect(frames.map(frame => (frame as { type?: unknown }).type)).toEqual(["event"]);
		expect((frames.at(-1) as { seq?: unknown }).seq).toBe(1);
		expect(registry.status().attachmentCount).toBe(1);
		await registry.dispose();
	});
	test("shutdown request stops when requester is the only blocker and reports live blockers", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-stop-"));
		const runtimeDir = path.join(root, "runtime");
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await server.run();
		const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
		await client.connect();
		const stopped = (await client.request("shutdown")) as { shutdown: boolean; blockers: string[] };
		expect(stopped).toEqual({ shutdown: true, blockers: [] });
		for (let attempt = 0; attempt < 20 && !server.closed; attempt++) await Bun.sleep(5);
		expect(server.closed).toBe(true);
		await expect(fs.stat(server.endpoint!)).rejects.toMatchObject({ code: "ENOENT" });
		client.close();

		const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-stop-blocked-"));
		const blockedRuntimeDir = path.join(blockedRoot, "runtime");
		const blockedServer = new DaemonServer({
			profile: "test",
			runtimeDir: blockedRuntimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await blockedServer.run();
		const blockedClient = new DaemonClient({ profile: "test", runtimeDir: blockedRuntimeDir, token: "secret" });
		await blockedClient.connect();
		await blockedClient.request("session_create", { sessionId: "live", cwd: blockedRoot });
		const blocked = (await blockedClient.request("shutdown")) as { shutdown: boolean; blockers: string[] };
		expect(blocked.shutdown).toBe(false);
		expect(blocked.blockers).toContain("sessions");
		await blockedClient.request("session_close", { sessionId: "live" });
		expect(await blockedClient.request("shutdown")).toEqual({ shutdown: true, blockers: [] });
		blockedClient.close();
	});
	test("hydrates RemoteSessionHandle state and dispatches typed commands across reconnect", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-remote-"));
		const runtimeDir = path.join(root, "runtime");
		const model = { provider: "openai", id: "gpt-resumed", name: "gpt-resumed", api: "openai-responses" } as never;
		const todoPhases = [{ name: "ship", tasks: [{ content: "test", status: "in_progress" }] }] as never;
		const persistedTranscript = `${"x".repeat(DAEMON_MAX_FRAME_BYTES)}tail`;
		const terminalOutput = "\x1b".repeat(DAEMON_MAX_FRAME_BYTES);
		const current = {
			thinkingLevel: "high",
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
			messageCount: 7,
			queuedMessageCount: 2,
			todoPhases,
			commands: [] as string[],
		};
		const listeners = new Set<AgentSessionEventListener>();
		const emit = (event: unknown): void => {
			for (const listener of listeners) listener(event as never);
		};
		const runtimeFactory = async ({
			cwd,
			sessionId,
		}: {
			cwd: string;
			sessionId?: string;
		}): Promise<DaemonSessionRuntime> => {
			const id = sessionId ?? "remote";
			const session = {
				sessionId: id,
				prompt: async (_text: string) => {
					current.messageCount++;
					emit({ type: "message_end" });
					return true;
				},
				abort: async () => undefined,
				dispose: async () => undefined,
				subscribe: (listener: AgentSessionEventListener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as DaemonSessionRuntime["session"];
			const state = (): DaemonSessionSnapshot["state"] => ({
				model,
				thinkingLevel: current.thinkingLevel as never,
				isStreaming: false,
				isCompacting: false,
				steeringMode: current.steeringMode as never,
				followUpMode: current.followUpMode as never,
				interruptMode: current.interruptMode as never,
				sessionId: id,
				autoCompactionEnabled: true,
				messageCount: current.messageCount,
				queuedMessageCount: current.queuedMessageCount,
				todoPhases: current.todoPhases,
				fastModeEnabled: false,
				fastModeActive: false,
				tokensPerSecond: null,
			});
			return {
				sessionId: id,
				cwd,
				session,
				snapshot: () => ({
					state: state(),
					cwd,
					entries: [{ type: "message", text: persistedTranscript }],
				}),
				command: async command => {
					const type =
						typeof command === "object" && command !== null && "type" in command ? String(command.type) : "";
					current.commands.push(type);
					if (type === "prompt") return { agentInvoked: await session.prompt("prompt") };
					if (type === "set_todos" && typeof command === "object" && command !== null && "phases" in command) {
						current.todoPhases = command.phases as never;
						return { todoPhases: current.todoPhases };
					}
					if (
						type === "set_thinking_level" &&
						typeof command === "object" &&
						command !== null &&
						"level" in command
					)
						current.thinkingLevel = String(command.level);
					if (type === "set_steering_mode" && typeof command === "object" && command !== null && "mode" in command)
						current.steeringMode = String(command.mode) as never;
					if (
						type === "set_follow_up_mode" &&
						typeof command === "object" &&
						command !== null &&
						"mode" in command
					)
						current.followUpMode = String(command.mode) as never;
					if (
						type === "set_interrupt_mode" &&
						typeof command === "object" &&
						command !== null &&
						"mode" in command
					)
						current.interruptMode = String(command.mode) as never;
					if (
						type === "set_host_tools" ||
						type === "set_host_uri_schemes" ||
						type === "extension_ui_response" ||
						type === "host_tool_result" ||
						type === "host_tool_update" ||
						type === "host_uri_result"
					)
						return {};
					return {};
				},
				dispose: reason => session.dispose(reason === undefined ? undefined : { reason }),
				subscribe: session.subscribe,
			};
		};
		const server = new DaemonServer({ profile: "test", runtimeDir, token: "secret", runtimeFactory });
		await server.run();
		const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
		await client.connect();
		await client.request("session_create", { sessionId: "remote", cwd: root });
		const handle = new RemoteSessionHandle(client, "remote");
		await handle.whenReady();
		expect(handle.state.model?.id).toBe("gpt-resumed");
		expect(handle.state.messageCount).toBe(7);
		expect(handle.state.steeringMode).toBe("one-at-a-time");
		expect(handle.state.todoPhases).toEqual(todoPhases);
		const persistedEntry = handle.snapshot.entries[0] as { text?: string } | undefined;
		expect(persistedEntry?.text?.length).toBe(persistedTranscript.length);
		expect(persistedEntry?.text?.endsWith("tail")).toBe(true);
		const seen: string[] = [];
		const terminalChunks: string[] = [];
		handle.subscribe(event => {
			seen.push(event.type);
			if (event.type === "terminal_output") terminalChunks.push(event.data);
		});
		emit({ type: "terminal_output", data: terminalOutput });
		for (let attempt = 0; attempt < 20 && terminalChunks.join("").length < terminalOutput.length; attempt++)
			await Bun.sleep(5);
		const receivedTerminalOutput = terminalChunks.join("");
		expect(receivedTerminalOutput.length).toBe(terminalOutput.length);
		expect(Bun.hash(receivedTerminalOutput)).toBe(Bun.hash(terminalOutput));
		await handle.prompt("hello");
		await handle.setThinkingLevel("high" as never);
		await handle.setSteeringMode("all");
		await handle.setFollowUpMode("all");
		await handle.setInterruptMode("immediate");
		await handle.setTodos(todoPhases);
		await handle.setHostTools([]);
		await handle.setHostUriSchemes([]);
		await handle.respondExtensionUI({ type: "extension_ui_response", id: "ui-1", cancelled: true });
		expect(current.commands).toEqual([
			"prompt",
			"set_thinking_level",
			"set_steering_mode",
			"set_follow_up_mode",
			"set_interrupt_mode",
			"set_todos",
			"set_host_tools",
			"set_host_uri_schemes",
			"extension_ui_response",
		]);
		expect(seen).toContain("message_end");
		await handle.dispose();
		const resumed = new RemoteSessionHandle(client, "remote");
		await resumed.whenReady();
		expect(resumed.state.model?.id).toBe("gpt-resumed");
		expect(resumed.state.messageCount).toBe(8);
		expect(resumed.state.todoPhases).toEqual(todoPhases);
		await resumed.dispose();
		client.close();
		await server.shutdown(true);
	});

	test("registry keys hosted sessions by the underlying session id, never a minted handle", async () => {
		// ONE id everywhere: `--resume <id shown anywhere>` must behave exactly
		// like `/resume <id>`, which is only possible when the registry, the
		// session state, and the transcript filename agree on the id.
		const registry = new DaemonSessionRegistry({
			id: () => "minted-handle-must-not-leak",
			runtimeFactory: async ({ cwd }) =>
				({
					sessionId: "ignored",
					cwd,
					session: {
						sessionId: "0197-real-session-id",
						isStreaming: false,
						prompt: async () => true,
						abort: async () => undefined,
						dispose: async () => undefined,
						subscribe: () => () => undefined,
					},
					protectedJobCount: () => 0,
					snapshot: () => ({ state: { sessionId: "0197-real-session-id" }, cwd, entries: [] }),
					command: async () => ({}),
					dispose: async () => undefined,
					subscribe: () => () => undefined,
				}) as unknown as DaemonSessionRuntime,
		});
		const summary = await registry.create(undefined, os.tmpdir());
		expect(summary.sessionId).toBe("0197-real-session-id");
		expect(registry.list().map(entry => entry.sessionId)).toEqual(["0197-real-session-id"]);
		await registry.close("0197-real-session-id");
	});

	test("a named recovery keeps the requested id when the fresh runtime has a different internal id", async () => {
		const registry = new DaemonSessionRegistry({
			runtimeFactory: async ({ cwd, sessionId }) =>
				({
					sessionId: sessionId ?? "runtime-id",
					cwd,
					session: {
						sessionId: "fresh-internal-id",
						isStreaming: false,
						prompt: async () => true,
						abort: async () => undefined,
						dispose: async () => undefined,
						subscribe: () => () => undefined,
					},
					protectedJobCount: () => 0,
					snapshot: () => ({ state: { sessionId }, cwd, entries: [] }),
					command: async () => ({}),
					dispose: async () => undefined,
					subscribe: () => () => undefined,
				}) as unknown as DaemonSessionRuntime,
		});
		const summary = await registry.create("requested-recovery-id", os.tmpdir());
		expect(summary.sessionId).toBe("requested-recovery-id");
		expect(registry.list().map(entry => entry.sessionId)).toEqual(["requested-recovery-id"]);
		await registry.close("requested-recovery-id");
	});

	test("a named session_create rehydrates the persisted transcript instead of starting blank", async () => {
		const factoryCalls: Array<{ sessionId?: string; sessionFile?: string }> = [];
		const registry = new DaemonSessionRegistry({
			listSessions: async () => [
				{ id: "0197-persisted", cwd: os.tmpdir(), path: "/tmp/0197-persisted.jsonl" } as never,
			],
			runtimeFactory: async ({ cwd, sessionId, sessionFile }) => {
				factoryCalls.push({ sessionId, sessionFile });
				return {
					sessionId: sessionId ?? "fresh",
					cwd,
					session: {
						sessionId: sessionId ?? "fresh",
						isStreaming: false,
						prompt: async () => true,
						abort: async () => undefined,
						dispose: async () => undefined,
						subscribe: () => () => undefined,
					},
					protectedJobCount: () => 0,
					snapshot: () => ({ state: { sessionId: sessionId ?? "fresh" }, cwd, entries: [] }),
					command: async () => ({}),
					dispose: async () => undefined,
					subscribe: () => () => undefined,
				} as unknown as DaemonSessionRuntime;
			},
		});
		const summary = await registry.create("0197-persisted", os.tmpdir());
		expect(summary.sessionId).toBe("0197-persisted");
		expect(factoryCalls).toEqual([{ sessionId: "0197-persisted", sessionFile: "/tmp/0197-persisted.jsonl" }]);
		await registry.close("0197-persisted");
	});
});
