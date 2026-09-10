// Daemon death recovery: when the daemon process dies, attached clients must
// NOT freeze. Each client detects the dropped socket, requests recovery, a
// replacement daemon takes over the stale runtime dir (dead-pid owner lease +
// stale socket file), and every RemoteSessionHandle reattaches and completes
// commands again — all within a bounded deadline.
//
// This is the regression for the live incident where a daemon died and four
// attached instances hung indefinitely.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonClient } from "../src/daemon/client";
import { DaemonServer } from "../src/daemon/server";
import type { DaemonSessionRuntime, DaemonSessionSnapshot } from "../src/daemon/session-runtime";
import type { AgentSessionEventListener } from "../src/session/agent-session";
import { RemoteSessionHandle } from "../src/session/session-handle";

const FIXTURE = path.join(import.meta.dir, "fixtures", "daemon-death-server.ts");

function localFactory() {
	const commands = new Map<string, string[]>();
	const runtimeFactory = async ({
		cwd,
		sessionId,
	}: {
		cwd: string;
		sessionId?: string;
	}): Promise<DaemonSessionRuntime> => {
		const id = sessionId ?? crypto.randomUUID();
		const listeners = new Set<AgentSessionEventListener>();
		const recorded: string[] = [];
		commands.set(id, recorded);
		const session: DaemonSessionRuntime["session"] = {
			sessionId: id,
			isStreaming: false,
			prompt: async () => true,
			abort: async () => undefined,
			dispose: async () => undefined,
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
			protectedJobCount: () => 0,
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
					messageCount: recorded.length,
					queuedMessageCount: 0,
					todoPhases: [],
				},
				cwd,
				entries: [],
			}),
			command: async command => {
				recorded.push(JSON.stringify(command));
				return { accepted: true };
			},
			dispose: reason => session.dispose(reason === undefined ? undefined : { reason }),
			subscribe: session.subscribe,
		};
	};
	return { commands, runtimeFactory };
}

async function spawnCrashServer(runtimeDir: string, token: string) {
	const child = Bun.spawn(["bun", FIXTURE, runtimeDir, token], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let banner = "";
	const deadline = Date.now() + 15_000;
	while (!banner.includes("READY")) {
		if (Date.now() > deadline) {
			child.kill(9);
			throw new Error(`fixture daemon never became ready: ${JSON.stringify(banner)}`);
		}
		const { value, done } = await reader.read();
		if (done) throw new Error(`fixture daemon exited before READY: ${JSON.stringify(banner)}`);
		banner += decoder.decode(value);
	}
	return child;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

describe("daemon death recovery", () => {
	test("four attached clients all recover to a replacement daemon after the server process is SIGKILLed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-death-"));
		const runtimeDir = path.join(root, "runtime");
		const cwd = await fs.realpath(root);
		const child = await spawnCrashServer(runtimeDir, "secret");

		const fake = localFactory();
		let recoveryRequests = 0;
		let replacement: DaemonServer | undefined;
		let replacementStart: Promise<void> | undefined;
		// Idempotent recovery seam: in production every client's bootstrap calls
		// spawnDaemon() and the owner lease dedupes contenders. Here the seam is
		// shared and starts exactly one replacement server no matter how many of
		// the four clients request recovery.
		const recoverUnavailable = (): void => {
			recoveryRequests++;
			replacementStart ??= (async () => {
				replacement = new DaemonServer({
					profile: "test",
					runtimeDir,
					token: "secret",
					runtimeFactory: fake.runtimeFactory,
					ownerLeaseWaitMs: 500,
				});
				await replacement.run();
			})();
		};

		const clients: DaemonClient[] = [];
		const handles: RemoteSessionHandle[] = [];
		try {
			for (let i = 0; i < 4; i++) {
				const client = new DaemonClient({
					profile: "test",
					runtimeDir,
					token: "secret",
					recoverUnavailable,
				});
				clients.push(client);
				await client.connect();
				const sessionId = `death-${i}`;
				await client.request("session_create", { sessionId, cwd });
				const handle = new RemoteSessionHandle(client, sessionId, {
					recover: async () => {
						await client.request("session_create", { sessionId, cwd });
					},
					reconnectWaitMs: 30_000,
				});
				handles.push(handle);
				await handle.whenReady();
				await handle.prompt(`before-crash-${i}`);
				expect(handle.connectionState).toBe("connected");
			}

			// Hard crash: SIGKILL leaves the socket file and the owner lease
			// (dead pid) stale on disk — the replacement must reap both.
			child.kill(9);
			await child.exited;

			// Every client must observe the death instead of staying "connected".
			await waitFor(
				() => clients.every(client => client.snapshot.state !== "connected"),
				10_000,
				"all clients to observe the daemon death",
			);

			// The frozen-clients regression: every handle must complete a command
			// against the replacement daemon within a bounded deadline. This
			// exercises reconnect → recovery spawn → stale lease/socket takeover →
			// session_load not_found → recover() re-create → attach → command.
			const results = await Promise.allSettled(handles.map((handle, i) => handle.prompt(`after-crash-${i}`)));
			const failed = results.filter(result => result.status === "rejected");
			expect(failed).toEqual([]);

			expect(recoveryRequests).toBeGreaterThanOrEqual(1);
			expect(replacement).toBeDefined();
			for (let i = 0; i < 4; i++) {
				expect(handles[i]!.connectionState).toBe("connected");
				const recorded = fake.commands.get(`death-${i}`) ?? [];
				expect(recorded.some(entry => entry.includes(`after-crash-${i}`))).toBe(true);
			}
		} finally {
			for (const handle of handles) await handle.dispose().catch(() => undefined);
			for (const client of clients) client.close();
			if (!child.killed) child.kill(9);
			await replacementStart?.catch(() => undefined);
			await replacement?.shutdown(true);
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 40_000);

	test("independent client contenders elect one replacement daemon after a hard crash", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-contenders-"));
		const runtimeDir = path.join(root, "runtime");
		const cwd = await fs.realpath(root);
		const child = await spawnCrashServer(runtimeDir, "secret");
		const contenders: Bun.Subprocess[] = [];
		const clients: DaemonClient[] = [];
		const handles: RemoteSessionHandle[] = [];
		let recoveryRequests = 0;
		const recoverUnavailable = (): void => {
			recoveryRequests++;
			contenders.push(
				Bun.spawn(["bun", FIXTURE, runtimeDir, "secret"], {
					stdout: "ignore",
					stderr: "ignore",
				}),
			);
		};
		try {
			for (let i = 0; i < 4; i++) {
				const client = new DaemonClient({
					profile: "test",
					runtimeDir,
					token: "secret",
					recoverUnavailable,
				});
				clients.push(client);
				await client.connect();
				const sessionId = `contender-${i}`;
				await client.request("session_create", { sessionId, cwd });
				const handle = new RemoteSessionHandle(client, sessionId, {
					recover: async () => {
						await client.request("session_create", { sessionId, cwd });
					},
					reconnectWaitMs: 30_000,
				});
				handles.push(handle);
				await handle.whenReady();
			}

			child.kill(9);
			await child.exited;
			await waitFor(
				() => clients.every(client => client.snapshot.state !== "connected"),
				10_000,
				"all contender clients to observe the daemon death",
			);

			const results = await Promise.allSettled(handles.map((handle, i) => handle.prompt(`after-crash-${i}`)));
			expect(results.filter(result => result.status === "rejected")).toEqual([]);
			expect(recoveryRequests).toBeGreaterThanOrEqual(1);
			const daemonIds = new Set(
				clients.map(client => (client.snapshot.state === "connected" ? client.snapshot.daemonId : undefined)),
			);
			expect(daemonIds).toHaveLength(1);
			expect(daemonIds.has(undefined)).toBe(false);

			const owner = (await Bun.file(path.join(runtimeDir, "daemon.owner")).json()) as { pid?: unknown };
			expect(contenders.some(contender => contender.pid === owner.pid)).toBe(true);
		} finally {
			for (const handle of handles) await handle.dispose().catch(() => undefined);
			for (const client of clients) client.close();
			if (!child.killed) child.kill(9);
			for (const contender of contenders) {
				if (contender.exitCode === null) contender.kill(9);
				await contender.exited;
			}
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 40_000);

	test("independent clients replace one live but unresponsive daemon and all reattach", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-hang-"));
		const runtimeDir = path.join(root, "runtime");
		const cwd = await fs.realpath(root);
		const child = await spawnCrashServer(runtimeDir, "secret");
		const contenders: Bun.Subprocess[] = [];
		const clients: DaemonClient[] = [];
		const handles: RemoteSessionHandle[] = [];
		let recoveryRequests = 0;
		const recoverUnavailable = (): void => {
			recoveryRequests++;
			contenders.push(
				Bun.spawn(["bun", FIXTURE, runtimeDir, "secret"], {
					stdout: "ignore",
					stderr: "ignore",
				}),
			);
		};
		try {
			for (let i = 0; i < 4; i++) {
				const client = new DaemonClient({
					profile: "test",
					runtimeDir,
					token: "secret",
					requestTimeoutMs: 250,
					recoverUnavailable,
				});
				clients.push(client);
				await client.connect();
				const sessionId = `hung-${i}`;
				await client.request("session_create", { sessionId, cwd });
				const handle = new RemoteSessionHandle(client, sessionId, {
					recover: async () => {
						await client.request("session_create", { sessionId, cwd });
					},
					reconnectWaitMs: 30_000,
				});
				handles.push(handle);
				await handle.whenReady();
			}
			const oldDaemonId = clients[0]!.snapshot.state === "connected" ? clients[0]!.snapshot.daemonId : undefined;
			expect(oldDaemonId).toBeDefined();

			process.kill(child.pid, "SIGSTOP");
			const probes = await Promise.allSettled(clients.map(client => client.request("ping")));
			expect(probes.every(result => result.status === "rejected")).toBe(true);
			await waitFor(
				() =>
					clients.every(
						client =>
							client.snapshot.state === "connected" &&
							client.snapshot.daemonId !== undefined &&
							client.snapshot.daemonId !== oldDaemonId,
					),
				25_000,
				"all clients to attach to a replacement for the hung daemon",
			);

			const results = await Promise.allSettled(handles.map((handle, i) => handle.prompt(`after-hang-${i}`)));
			expect(results.filter(result => result.status === "rejected")).toEqual([]);
			expect(recoveryRequests).toBeGreaterThanOrEqual(1);
			const daemonIds = new Set(
				clients.map(client => (client.snapshot.state === "connected" ? client.snapshot.daemonId : undefined)),
			);
			expect(daemonIds).toHaveLength(1);
			expect(daemonIds.has(undefined)).toBe(false);
			const owner = (await Bun.file(path.join(runtimeDir, "daemon.owner")).json()) as { pid?: unknown };
			expect(contenders.some(contender => contender.pid === owner.pid)).toBe(true);
		} finally {
			for (const handle of handles) await handle.dispose().catch(() => undefined);
			for (const client of clients) client.close();
			if (!child.killed) child.kill(9);
			await child.exited;
			for (const contender of contenders) {
				if (contender.exitCode === null) contender.kill(9);
				await contender.exited;
			}
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 40_000);

	test("without recovery, a parked command fails within the reconnect bound instead of hanging forever", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-death-"));
		const runtimeDir = path.join(root, "runtime");
		const cwd = await fs.realpath(root);
		const child = await spawnCrashServer(runtimeDir, "secret");
		const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
		try {
			await client.connect();
			await client.request("session_create", { sessionId: "solo", cwd });
			const handle = new RemoteSessionHandle(client, "solo", { reconnectWaitMs: 500 });
			await handle.whenReady();
			await handle.prompt("before");

			child.kill(9);
			await child.exited;
			await waitFor(() => client.snapshot.state !== "connected", 10_000, "client to observe the daemon death");

			const started = Date.now();
			await expect(handle.prompt("after")).rejects.toThrow(/did not reconnect|disconnected/);
			// Bounded, not frozen: the reconnect gate must give up near its
			// configured 500ms budget (generous ceiling for slow CI).
			expect(Date.now() - started).toBeLessThan(10_000);
			await handle.dispose().catch(() => undefined);
		} finally {
			client.close();
			if (!child.killed) child.kill(9);
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 40_000);
});
