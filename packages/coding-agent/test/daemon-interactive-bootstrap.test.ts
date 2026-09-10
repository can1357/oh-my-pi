import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { daemonBuildStamp } from "../src/daemon/build-stamp";
import { createDaemonClient } from "../src/daemon/client";
import {
	bootstrapDaemonInteractive,
	type DaemonInteractiveBootstrapOptions,
	ensureDaemonBuildPairing,
	isDaemonModeOptedIn,
	isDefaultInteractiveArgv,
	resolveDaemonInteractiveResume,
} from "../src/daemon/interactive-bootstrap";
import { DaemonServer } from "../src/daemon/server";
import type { RpcSessionState } from "../src/modes/rpc/rpc-types";
import * as sessionListing from "../src/session/session-listing";
import { SessionManager } from "../src/session/session-manager";

describe("daemon interactive bootstrap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("identifies the default interactive launch argv", () => {
		expect(isDefaultInteractiveArgv([])).toBe(true);
		expect(isDefaultInteractiveArgv(["hello"])).toBe(true);
		expect(isDefaultInteractiveArgv(["launch", "hello"])).toBe(true);
		expect(isDefaultInteractiveArgv(["grep", "needle"])).toBe(false);
		expect(isDefaultInteractiveArgv(["--print", "hello"])).toBe(false);
		expect(isDefaultInteractiveArgv(["--mode", "text"])).toBe(true);
		expect(isDefaultInteractiveArgv(["--mode", "text", "-p", "hi"])).toBe(false);
		expect(isDefaultInteractiveArgv(["--mode=text", "--no-daemon"])).toBe(false);
		expect(isDefaultInteractiveArgv(["explain", "constructor"])).toBe(true);
		expect(isDefaultInteractiveArgv(["toString"])).toBe(true);
	});
	test("daemon hosting is opt-in and --no-daemon always wins", () => {
		expect(isDaemonModeOptedIn([], false)).toBe(false);
		expect(isDaemonModeOptedIn([], true)).toBe(true);
		expect(isDaemonModeOptedIn(["--daemon"], false)).toBe(true);
		expect(isDaemonModeOptedIn(["--no-daemon"], true)).toBe(false);
		expect(isDaemonModeOptedIn(["--daemon", "--no-daemon"], false)).toBe(false);
	});
	test("forks an explicit cross-project resume into the requested working directory", async () => {
		const sourceCwd = "/other/project";
		const targetCwd = "/current/project";
		const sourcePath = `${sourceCwd}/source.jsonl`;
		const forkedPath = `${targetCwd}/forked.jsonl`;
		vi.spyOn(sessionListing, "resolveResumableSession").mockResolvedValue({
			scope: "global",
			session: {
				path: sourcePath,
				id: "source",
				cwd: sourceCwd,
				title: "source",
				created: new Date(0),
				modified: new Date(0),
				messageCount: 1,
				size: 1,
				firstMessage: "source",
				allMessagesText: "source",
			},
		});
		const forkedManager = { getSessionFile: () => forkedPath } as unknown as SessionManager;
		const forkFrom = vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(forkedManager);

		const resolved = await resolveDaemonInteractiveResume({
			argv: ["--resume", "source"],
			cwd: targetCwd,
		});

		expect(forkFrom).toHaveBeenCalledWith(sourcePath, targetCwd, undefined);
		expect(resolved).toMatchObject({
			argv: ["--resume", forkedPath],
			cwd: targetCwd,
		});
	});

	test("authenticates, forwards the complete launch argv, and detaches without disposing the server runtime", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		let disposed = false;
		let receivedArgv: string[] | undefined;
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			runtimeFactory: async ({ sessionId, cwd, overrides }) => {
				receivedArgv = overrides?.argv;
				return {
					sessionId: sessionId ?? "session",
					cwd,
					snapshot: () => ({
						state: { sessionId: sessionId ?? "session", cwd } as unknown as RpcSessionState,
						cwd,
						entries: [],
					}),
					session: {
						sessionId: sessionId ?? "session",
						isStreaming: false,
						prompt: async () => true,
						abort: async () => {},
						dispose: async () => {},
						subscribe: () => () => {},
					},
					command: async () => ({}),
					dispose: async () => {
						disposed = true;
					},
					subscribe: () => () => {},
				};
			},
		});
		await server.run();
		try {
			await expect(
				bootstrapDaemonInteractive({
					argv: [],
					profile: "test",
					cwd: root,
					runtimeDir,
					endpoint,
					token: "wrong-token",
					startTimeoutMs: 100,
				}),
			).rejects.toThrow("terminal");
			const bootstrapped = await bootstrapDaemonInteractive({
				argv: ["--model", "openai/gpt-5"],
				profile: "test",
				cwd: root,
				runtimeDir,
				endpoint,
				token: server.token,
			});
			expect(bootstrapped.client.snapshot.state).toBe("connected");
			expect(bootstrapped.handle.connectionState).toBe("connected");
			expect(receivedArgv).toEqual(["--model", "openai/gpt-5"]);
			await bootstrapped.handle.dispose();
			expect(disposed).toBe(false);
			bootstrapped.client.close();
		} finally {
			await server.shutdown();
		}
	});

	test("--resume of a session the daemon already hosts attaches to it instead of failing session_busy", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-resume-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const transcript = path.join(root, "2026-07-16T22-14-33-633Z_hosted-1.jsonl");
		let factoryCalls = 0;
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			runtimeFactory: async ({ sessionId, cwd, overrides }) => {
				factoryCalls++;
				// A resume runtime adopts the transcript's session id — exactly
				// how a real createAgentSessionRuntime resumes a session file.
				const id = sessionId ?? (overrides?.argv?.includes("--resume") ? "hosted-1" : "fresh");
				return {
					sessionId: id,
					cwd,
					snapshot: () => ({
						state: { sessionId: id, cwd } as unknown as RpcSessionState,
						cwd,
						entries: [],
					}),
					session: {
						sessionId: id,
						isStreaming: false,
						prompt: async () => true,
						abort: async () => {},
						dispose: async () => {},
						subscribe: () => () => {},
					},
					command: async () => ({}),
					dispose: async () => {},
					subscribe: () => () => {},
				};
			},
		});
		await server.run();
		// No resolver mock: `--resume <path>` must resolve through the transcript
		// FILE. Mocking `resolveResumableSession` here hid a real regression —
		// its matcher is prefix-based over ids and never matches a path, so the
		// hosted-session probe was skipped and the launch died with
		// `session_busy` even though the daemon was hosting that very session.
		await writeFile(
			transcript,
			`${JSON.stringify({ type: "session", version: 3, id: "hosted-1", cwd: root, timestamp: new Date(0).toISOString() })}\n`,
		);
		try {
			// The session is already live in the daemon (a previous client died
			// and left it parked).
			const seed = await createDaemonClient({ profile: "test", runtimeDir, endpoint, token: server.token });
			await seed.connect();
			await seed.request("session_create", { sessionId: "hosted-1", cwd: root });
			seed.close();

			const bootstrapped = await bootstrapDaemonInteractive({
				argv: ["--resume", transcript],
				profile: "test",
				cwd: root,
				runtimeDir,
				endpoint,
				token: server.token,
			});
			expect(bootstrapped.handle.connectionState).toBe("connected");
			expect(bootstrapped.handle.state.sessionId).toBe("hosted-1");
			// The resume attached to the EXISTING hosted runtime: the named
			// create was rejected BEFORE building a duplicate runtime, so only
			// the seed session ever hit the factory.
			expect(factoryCalls).toBe(1);
			await bootstrapped.handle.dispose();
			bootstrapped.client.close();
		} finally {
			await server.shutdown(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("--resume of an unhosted session keeps the plain create path with the full launch argv", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-resume-disk-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const transcript = path.join(root, "2026-07-16T22-14-33-633Z_hosted-1.jsonl");
		let factoryCalls = 0;
		let receivedSessionId: string | undefined = "sentinel";
		let receivedArgv: string[] | undefined;
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			runtimeFactory: async ({ sessionId, cwd, overrides }) => {
				factoryCalls++;
				receivedSessionId = sessionId;
				receivedArgv = overrides?.argv;
				const id = "hosted-1";
				return {
					sessionId: id,
					cwd,
					snapshot: () => ({
						state: { sessionId: id, cwd } as unknown as RpcSessionState,
						cwd,
						entries: [],
					}),
					session: {
						sessionId: id,
						isStreaming: false,
						prompt: async () => true,
						abort: async () => {},
						dispose: async () => {},
						subscribe: () => () => {},
					},
					command: async () => ({}),
					dispose: async () => {},
					subscribe: () => () => {},
				};
			},
		});
		await server.run();
		await writeFile(
			transcript,
			`${JSON.stringify({ type: "session", version: 3, id: "hosted-1", cwd: root, timestamp: new Date(0).toISOString() })}\n`,
		);
		try {
			const bootstrapped = await bootstrapDaemonInteractive({
				argv: ["--resume", transcript],
				profile: "test",
				cwd: root,
				runtimeDir,
				endpoint,
				token: server.token,
			});
			expect(bootstrapped.handle.connectionState).toBe("connected");
			expect(bootstrapped.handle.state.sessionId).toBe("hosted-1");
			// Disk resume goes through the PLAIN create: no named sessionId (the
			// registry's named path would skip prepareCliLaunch) and the full
			// launch argv reaches the runtime factory untouched.
			expect(factoryCalls).toBe(1);
			expect(receivedSessionId).toBeUndefined();
			expect(receivedArgv).toEqual(["--resume", transcript]);
			await bootstrapped.handle.dispose();
			bootstrapped.client.close();
		} finally {
			await server.shutdown(true);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("a connection closed by a dying daemon retries into a fresh spawn instead of aborting startup", async () => {
		// The multi-resume race: client A replaces a stale daemon (shutdown
		// destroys accepted sockets) exactly while client B's handshake is in
		// flight. B used to abort with "Daemon connection failed before
		// startup: Daemon connection closed"; the close must classify as
		// transport-unavailable so the spawn/retry loop takes over.
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-dying-"));
		const runtimeDir = path.join(root, "runtime");
		await mkdir(runtimeDir, { recursive: true });
		const endpoint = path.join(runtimeDir, "daemon.sock");
		// Dying daemon: accepts and immediately destroys every socket.
		const dying = net.createServer(socket => socket.destroy());
		await new Promise<void>(resolve => dying.listen(endpoint, resolve));
		let server: DaemonServer | undefined;
		let spawns = 0;
		const spawnDaemon = (() => {
			spawns++;
			// The "fresh daemon": replace the dying listener with a real server.
			void (async () => {
				if (server) return;
				await new Promise<void>(resolve => dying.close(() => resolve()));
				await rm(endpoint, { force: true });
				server = new DaemonServer({
					profile: "test",
					runtimeDir,
					endpoint,
					token: "secret",
					runtimeFactory: async ({ sessionId, cwd }) => ({
						sessionId: sessionId ?? "fresh",
						cwd,
						snapshot: () => ({
							state: { sessionId: sessionId ?? "fresh", cwd } as unknown as RpcSessionState,
							cwd,
							entries: [],
						}),
						session: {
							sessionId: sessionId ?? "fresh",
							isStreaming: false,
							prompt: async () => true,
							abort: async () => {},
							dispose: async () => {},
							subscribe: () => () => {},
						},
						command: async () => ({}),
						dispose: async () => {},
						subscribe: () => () => {},
					}),
				});
				await server.run();
			})();
			return { exited: Promise.resolve(0), exitCode: null, unref: () => {} };
		}) as unknown as NonNullable<DaemonInteractiveBootstrapOptions["spawnDaemon"]>;
		try {
			const bootstrapped = await bootstrapDaemonInteractive({
				argv: [],
				profile: "test",
				cwd: root,
				runtimeDir,
				endpoint,
				token: "secret",
				startTimeoutMs: 10_000,
				spawnDaemon,
			});
			expect(bootstrapped.client.snapshot.state).toBe("connected");
			expect(spawns).toBeGreaterThanOrEqual(1);
			await bootstrapped.handle.dispose();
			bootstrapped.client.close();
		} finally {
			await server?.shutdown(true);
			await new Promise<void>(resolve => {
				dying.close(() => resolve());
			});
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("retries session creation when the paired daemon dies before replying", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-post-pairing-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		let dyingCreates = 0;
		let replacementCreates = 0;
		let replacement: DaemonServer | undefined;
		let replacementStart: Promise<void> | undefined;
		const runtime = (sessionId: string | undefined, cwd: string) => ({
			sessionId: sessionId ?? "recovered",
			cwd,
			snapshot: () => ({
				state: { sessionId: sessionId ?? "recovered", cwd } as unknown as RpcSessionState,
				cwd,
				entries: [],
			}),
			session: {
				sessionId: sessionId ?? "recovered",
				isStreaming: false,
				prompt: async () => true,
				abort: async () => {},
				dispose: async () => {},
				subscribe: () => () => {},
			},
			command: async () => ({}),
			dispose: async () => {},
			subscribe: () => () => {},
		});
		const dying = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			token: "secret",
			runtimeFactory: async ({ sessionId, cwd }) => {
				dyingCreates++;
				// Pairing has already succeeded. Destroy the accepted socket
				// while session_create is in flight, as a stale owner does when
				// another OMP instance replaces it.
				void dying?.shutdown(true);
				await Bun.sleep(10);
				return runtime(sessionId, cwd);
			},
		});
		await dying.run();
		const spawnDaemon = (() => {
			replacementStart ??= (async () => {
				await dying?.shutdown(true);
				replacement = new DaemonServer({
					profile: "test",
					runtimeDir,
					endpoint,
					token: "secret",
					runtimeFactory: async ({ sessionId, cwd }) => {
						replacementCreates++;
						return runtime(sessionId, cwd);
					},
				});
				await replacement.run();
			})();
			return { exited: Promise.resolve(0), exitCode: null, unref: () => {} };
		}) as unknown as NonNullable<DaemonInteractiveBootstrapOptions["spawnDaemon"]>;
		try {
			const bootstrapped = await bootstrapDaemonInteractive({
				argv: [],
				profile: "test",
				cwd: root,
				runtimeDir,
				endpoint,
				token: "secret",
				startTimeoutMs: 10_000,
				spawnDaemon,
			});
			expect(dyingCreates).toBe(1);
			expect(replacementCreates).toBe(1);
			expect(bootstrapped.handle.connectionState).toBe("connected");
			await bootstrapped.handle.dispose();
			bootstrapped.client.close();
		} finally {
			await replacementStart?.catch(() => {});
			await replacement?.shutdown(true);
			await dying?.shutdown(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("two concurrent launches racing the same dying daemon both connect to one replacement", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-race-"));
		const runtimeDir = path.join(root, "runtime");
		await mkdir(runtimeDir, { recursive: true });
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const dying = net.createServer(socket => socket.destroy());
		await new Promise<void>(resolve => dying.listen(endpoint, resolve));
		let server: DaemonServer | undefined;
		let replacementStart: Promise<void> | undefined;
		let spawns = 0;
		let sessionCounter = 0;
		const spawnDaemon = (() => {
			spawns++;
			// Idempotent, like the real owner lease: many contenders, ONE server.
			replacementStart ??= (async () => {
				await new Promise<void>(resolve => dying.close(() => resolve()));
				await rm(endpoint, { force: true });
				server = new DaemonServer({
					profile: "test",
					runtimeDir,
					endpoint,
					token: "secret",
					runtimeFactory: async ({ sessionId, cwd }) => {
						const id = sessionId ?? `race-${sessionCounter++}`;
						return {
							sessionId: id,
							cwd,
							snapshot: () => ({
								state: { sessionId: id, cwd } as unknown as RpcSessionState,
								cwd,
								entries: [],
							}),
							session: {
								sessionId: id,
								isStreaming: false,
								prompt: async () => true,
								abort: async () => {},
								dispose: async () => {},
								subscribe: () => () => {},
							},
							command: async () => ({}),
							dispose: async () => {},
							subscribe: () => () => {},
						};
					},
				});
				await server.run();
			})();
			return { exited: Promise.resolve(0), exitCode: null, unref: () => {} };
		}) as unknown as NonNullable<DaemonInteractiveBootstrapOptions["spawnDaemon"]>;
		try {
			// Both launches hit the dying listener simultaneously — the exact
			// multi-`--resume` race: each handshake is destroyed mid-flight.
			const [first, second] = await Promise.all([
				bootstrapDaemonInteractive({
					argv: [],
					profile: "test",
					cwd: root,
					runtimeDir,
					endpoint,
					token: "secret",
					startTimeoutMs: 10_000,
					spawnDaemon,
				}),
				bootstrapDaemonInteractive({
					argv: [],
					profile: "test",
					cwd: root,
					runtimeDir,
					endpoint,
					token: "secret",
					startTimeoutMs: 10_000,
					spawnDaemon,
				}),
			]);
			expect(first.client.snapshot.state).toBe("connected");
			expect(second.client.snapshot.state).toBe("connected");
			expect(first.handle.state.sessionId).not.toBe(second.handle.state.sessionId);
			expect(spawns).toBeGreaterThanOrEqual(1);
			await first.handle.dispose();
			await second.handle.dispose();
			first.client.close();
			second.client.close();
		} finally {
			// Settle the replacement-start latch before teardown so a still-
			// booting server cannot race the shutdown below.
			await replacementStart?.catch(() => {});
			await server?.shutdown(true);
			await new Promise<void>(resolve => {
				dying.close(() => resolve());
			});
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	test("pairing whose shutdown request dies with the stale daemon respawns instead of keeping it", async () => {
		// Two clients race one stale daemon: the loser's `shutdown` request
		// fails with a transport error because the winner's replacement already
		// killed it. That must flow into spawn+reconnect, not "kept-stale"
		// (which left the client issuing requests against a dead socket).
		let stamp: string | undefined = "old-build";
		let reconnects = 0;
		let spawns = 0;
		const fakeClient = {
			get serverBuildStamp(): string | undefined {
				return stamp;
			},
			request: async () => {
				throw new Error("Daemon connection closed");
			},
			reconnect: async () => {
				reconnects++;
				stamp = "new-build";
			},
			snapshot: { state: "connected" },
		} as unknown as Parameters<typeof ensureDaemonBuildPairing>[0];
		const outcome = await ensureDaemonBuildPairing(fakeClient, {
			localStamp: "new-build",
			spawn: () => {
				spawns++;
			},
			readOwnerPid: async () => undefined,
			waitMs: 1_000,
		});
		expect(outcome).toBe("replaced");
		expect(spawns).toBe(1);
		expect(reconnects).toBeGreaterThanOrEqual(1);
	});

	test("replaces a stale-build daemon gracefully and reconnects to the fresh one", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-pairing-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const runtimeFactory = async ({ sessionId, cwd }: { sessionId?: string; cwd: string }) => ({
			sessionId: sessionId ?? "session",
			cwd,
			snapshot: () => ({
				state: { sessionId: sessionId ?? "session", cwd } as unknown as RpcSessionState,
				cwd,
				entries: [],
			}),
			session: {
				sessionId: sessionId ?? "session",
				isStreaming: false,
				prompt: async () => true,
				abort: async () => {},
				dispose: async () => {},
				subscribe: () => () => {},
			},
			command: async () => ({}),
			dispose: async () => {},
			subscribe: () => () => {},
		});
		const stale = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			buildStamp: "17.0.0+stale",
			runtimeFactory,
		});
		await stale.run();
		let fresh: DaemonServer | undefined;
		try {
			const client = await createDaemonClient({
				profile: "test",
				runtimeDir,
				endpoint,
				token: stale.token,
				connectTimeoutMs: 500,
			});
			await client.connect();
			expect(client.serverBuildStamp).toBe("17.0.0+stale");

			let spawnError: Error | undefined;
			let spawnTask: Promise<void> = Promise.resolve();
			const outcome = await ensureDaemonBuildPairing(client, {
				localStamp: "17.0.0+fresh",
				spawn: () => {
					// Bounded and awaitable: dangling background retries outlive the
					// test promise and stall the runner's completion detection.
					spawnTask = (async () => {
						const spawnDeadline = Date.now() + 6_000;
						while (Date.now() < spawnDeadline) {
							const candidate = new DaemonServer({
								profile: "test",
								runtimeDir,
								endpoint,
								token: stale.token,
								buildStamp: "17.0.0+fresh",
								runtimeFactory,
							});
							try {
								await candidate.run();
								spawnError = undefined;
								fresh = candidate;
								return;
							} catch (error) {
								spawnError = error instanceof Error ? error : new Error(String(error));
								await Bun.sleep(50);
							}
						}
					})();
				},
				// Real owner-file read: the wait loop must hold until the stale
				// server's lease release removes the file (ENOENT -> undefined).
				// The recorded pid is the test runner itself, so the pid-liveness
				// break never fires here — exactly the file-removal path.
				readOwnerPid: async () => {
					try {
						const owner = (await Bun.file(path.join(runtimeDir, "daemon.owner")).json()) as {
							pid?: unknown;
						};
						return typeof owner.pid === "number" ? owner.pid : undefined;
					} catch {
						return undefined;
					}
				},
				killOwner: () => {
					throw new Error("graceful path must not signal the owner");
				},
				waitMs: 8_000,
			});
			await spawnTask;
			if (!fresh && spawnError) throw spawnError;

			expect(outcome).toBe("replaced");
			expect(client.snapshot.state).toBe("connected");
			expect(client.serverBuildStamp).toBe("17.0.0+fresh");
			expect(stale.closed).toBe(true);
			client.close();
		} finally {
			await fresh?.shutdown(true);
			await stale.shutdown(true);
		}
	}, 20_000);

	test("force-replaces a stale daemon even when clients and sessions are active", async () => {
		let stamp: string | undefined = "old-build";
		let ownerReads = 0;
		let spawns = 0;
		let reconnects = 0;
		const killed: number[] = [];
		const fakeClient = {
			get serverBuildStamp(): string | undefined {
				return stamp;
			},
			request: async () => ({ shutdown: false, blockers: ["clients", "sessions"] }),
			reconnect: async () => {
				reconnects++;
				stamp = "new-build";
			},
			snapshot: { state: "connected" },
		} as unknown as Parameters<typeof ensureDaemonBuildPairing>[0];

		const outcome = await ensureDaemonBuildPairing(fakeClient, {
			localStamp: "new-build",
			spawn: () => {
				spawns++;
			},
			readOwnerPid: async () => (ownerReads++ === 0 ? 4321 : undefined),
			killOwner: pid => {
				killed.push(pid);
			},
			waitMs: 1_000,
		});

		expect(outcome).toBe("replaced");
		expect(killed).toEqual([4321]);
		expect(spawns).toBe(1);
		expect(reconnects).toBeGreaterThanOrEqual(1);
	});

	test("replaces a pre-pairing daemon whose owner PID file is missing", async () => {
		// The wrong-build daemon predates both the buildStamp handshake and the
		// daemon.owner lease file (user-reported: "Refusing stale daemon build
		// (pre-pairing daemon): its owner PID is unavailable"). Startup must
		// still spawn a contender and land on the fresh build instead of
		// aborting outright.
		let stamp: string | undefined;
		let spawns = 0;
		let reconnects = 0;
		const fakeClient = {
			get serverBuildStamp(): string | undefined {
				return stamp;
			},
			request: async () => {
				throw new Error("unknown operation: shutdown");
			},
			reconnect: async () => {
				reconnects++;
				stamp = "new-build";
			},
			snapshot: { state: "connected" },
		} as unknown as Parameters<typeof ensureDaemonBuildPairing>[0];

		const outcome = await ensureDaemonBuildPairing(fakeClient, {
			localStamp: "new-build",
			spawn: () => {
				spawns++;
			},
			readOwnerPid: async () => undefined,
			killOwner: () => {
				throw new Error("no owner pid is known; nothing may be signalled");
			},
			waitMs: 1_000,
		});

		expect(outcome).toBe("replaced");
		expect(spawns).toBe(1);
		expect(reconnects).toBeGreaterThanOrEqual(1);
	});

	test("keeps reconnecting while the draining old daemon still answers with its stale stamp", async () => {
		// User-reported: "Refusing mismatched replacement daemon build (missing
		// stamp)". The first reconnect can land back on the old daemon whose
		// listener is still draining; pairing must keep retrying within the
		// budget until the replacement's stamp appears, not fail on the first
		// mismatched reconnect.
		let stamp: string | undefined = "old-build";
		let reconnects = 0;
		const fakeClient = {
			get serverBuildStamp(): string | undefined {
				return stamp;
			},
			request: async () => ({ shutdown: true }),
			reconnect: async () => {
				reconnects++;
				// First two reconnects land on the draining pre-pairing daemon.
				stamp = reconnects >= 3 ? "new-build" : undefined;
			},
			snapshot: { state: "connected" },
		} as unknown as Parameters<typeof ensureDaemonBuildPairing>[0];

		const outcome = await ensureDaemonBuildPairing(fakeClient, {
			localStamp: "new-build",
			spawn: () => {},
			readOwnerPid: async () => undefined,
			waitMs: 2_000,
		});

		expect(outcome).toBe("replaced");
		expect(reconnects).toBeGreaterThanOrEqual(3);
	});

	test("fails closed when no replacement ever reports the expected build stamp", async () => {
		let reconnects = 0;
		const fakeClient = {
			get serverBuildStamp(): string | undefined {
				return "wrong-build";
			},
			request: async () => ({ shutdown: true }),
			reconnect: async () => {
				reconnects++;
			},
			snapshot: { state: "connected" },
		} as unknown as Parameters<typeof ensureDaemonBuildPairing>[0];

		await expect(
			ensureDaemonBuildPairing(fakeClient, {
				localStamp: "new-build",
				spawn: () => {},
				readOwnerPid: async () => undefined,
				waitMs: 300,
			}),
		).rejects.toThrow(/wrong-build.*expected new-build/);
		expect(reconnects).toBeGreaterThanOrEqual(1);
	});

	test("spawns a patient contender when the old owner outlives the drain budget", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-pairing-drain-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const stale = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			buildStamp: "17.0.0+stale",
		});
		await stale.run();
		let fresh: DaemonServer | undefined;
		try {
			const client = await createDaemonClient({
				profile: "test",
				runtimeDir,
				endpoint,
				token: stale.token,
				connectTimeoutMs: 500,
			});
			await client.connect();

			let spawnCount = 0;
			let spawnError: Error | undefined;
			let spawnTask: Promise<void> = Promise.resolve();
			const outcome = await ensureDaemonBuildPairing(client, {
				localStamp: "17.0.0+fresh",
				spawn: () => {
					spawnCount++;
					spawnTask = (async () => {
						// Real retry loop on purpose: the candidate races the stale
						// server's socket release, which happens on the platform
						// clock — fake timers cannot drive the kernel bind.
						const spawnDeadline = Date.now() + 6_000;
						while (Date.now() < spawnDeadline) {
							const candidate = new DaemonServer({
								profile: "test",
								runtimeDir,
								endpoint,
								token: stale.token,
								buildStamp: "17.0.0+fresh",
							});
							try {
								await candidate.run();
								spawnError = undefined;
								fresh = candidate;
								return;
							} catch (error) {
								spawnError = error instanceof Error ? error : new Error(String(error));
								await Bun.sleep(50);
							}
						}
					})();
				},
				// The owner pid never vanishes: models a predecessor draining past
				// the budget (the user-reported takeover crash shape).
				readOwnerPid: async () => process.pid,
				killOwner: () => {
					throw new Error("graceful path must not signal the owner");
				},
				waitMs: 2_000,
			});
			await spawnTask;
			if (!fresh && spawnError) throw spawnError;

			expect(spawnCount).toBe(1);
			expect(outcome).toBe("replaced");
			expect(client.snapshot.state).toBe("connected");
			expect(client.serverBuildStamp).toBe("17.0.0+fresh");
			client.close();
		} finally {
			await fresh?.shutdown(true);
			await stale.shutdown(true);
		}
	}, 20_000);

	test("takes over an older-protocol daemon it cannot talk to and boots on the fresh one", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-proto-takeover-"));
		const runtimeDir = path.join(root, "runtime");
		await mkdir(runtimeDir, { recursive: true });
		const endpoint = path.join(runtimeDir, "daemon.sock");
		// Stand-in for the old daemon's owner process: exits on SIGTERM.
		const oldOwner = Bun.spawn(["sleep", "30"]);
		await Bun.write(
			path.join(runtimeDir, "daemon.owner"),
			JSON.stringify({ pid: oldOwner.pid, daemonId: "old-protocol", startedAt: Date.now() }),
		);
		// From this client's perspective a pre-v2 daemon answers every frame
		// with a v1 envelope, which the decoder rejects with the server major.
		const oldSockets = new Set<net.Socket>();
		const oldServer = net.createServer(socket => {
			oldSockets.add(socket);
			socket.on("close", () => oldSockets.delete(socket));
			socket.on("error", () => undefined);
			socket.on("data", () => socket.write(`${JSON.stringify({ v: 1, tag: "hello_ok" })}\n`));
		});
		const listening = Promise.withResolvers<void>();
		oldServer.once("error", listening.reject);
		oldServer.listen(endpoint, () => listening.resolve());
		await listening.promise;

		const localStamp = await daemonBuildStamp();
		let fresh: DaemonServer | undefined;
		let spawnCount = 0;
		let spawnTask: Promise<void> = Promise.resolve();
		const spawnDaemon: DaemonInteractiveBootstrapOptions["spawnDaemon"] = () => {
			spawnCount++;
			spawnTask = (async () => {
				// The replacement can only bind after the signaled owner exits
				// and the dead listener releases the socket path.
				await oldOwner.exited;
				const closed = Promise.withResolvers<void>();
				oldServer.close(() => closed.resolve());
				for (const socket of oldSockets) socket.destroy();
				await closed.promise;
				await rm(endpoint, { force: true });
				const candidate = new DaemonServer({
					profile: "test",
					runtimeDir,
					endpoint,
					token: "secret",
					buildStamp: localStamp,
					runtimeFactory: async ({ sessionId, cwd }: { sessionId?: string; cwd: string }) => ({
						sessionId: sessionId ?? "session",
						cwd,
						snapshot: () => ({
							state: { sessionId: sessionId ?? "session", cwd } as unknown as RpcSessionState,
							cwd,
							entries: [],
						}),
						session: {
							sessionId: sessionId ?? "session",
							isStreaming: false,
							prompt: async () => true,
							abort: async () => {},
							dispose: async () => {},
							subscribe: () => () => {},
						},
						command: async () => ({}),
						dispose: async () => {},
						subscribe: () => () => {},
					}),
				});
				await candidate.run();
				fresh = candidate;
			})();
			return { exited: Promise.resolve(0), exitCode: null, unref: () => {} };
		};

		try {
			const bootstrapped = await bootstrapDaemonInteractive({
				argv: [],
				profile: "test",
				cwd: root,
				runtimeDir,
				endpoint,
				token: "secret",
				connectTimeoutMs: 1_000,
				startTimeoutMs: 8_000,
				spawnDaemon,
			});
			await spawnTask;
			expect(spawnCount).toBe(1);
			expect(oldOwner.signalCode).toBe("SIGTERM");
			expect(bootstrapped.client.snapshot.state).toBe("connected");
			await bootstrapped.handle.dispose();
			bootstrapped.client.close();
		} finally {
			oldOwner.kill();
			const closed = Promise.withResolvers<void>();
			oldServer.close(() => closed.resolve());
			closed.promise.catch(() => undefined);
			await fresh?.shutdown(true);
		}
	}, 20_000);

	test("proceeds without any takeover when build stamps match", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-pairing-match-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		const server = new DaemonServer({
			profile: "test",
			runtimeDir,
			endpoint,
			buildStamp: "17.0.0+same",
		});
		await server.run();
		try {
			const client = await createDaemonClient({
				profile: "test",
				runtimeDir,
				endpoint,
				token: server.token,
				connectTimeoutMs: 500,
			});
			await client.connect();
			const outcome = await ensureDaemonBuildPairing(client, {
				localStamp: "17.0.0+same",
				spawn: () => {
					throw new Error("matched builds must not respawn");
				},
				waitMs: 1_000,
			});
			expect(outcome).toBe("matched");
			expect(server.closed).toBe(false);
			client.close();
		} finally {
			await server.shutdown(true);
		}
	});
});
