import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { MessageFramer } from "../src/jsonrpc/message-framing";
import {
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_RESTART_METHOD,
	type MuxConnectParams,
	type MuxConnectResult,
} from "../src/lsp/mux/protocol";
import { groupOwnership, LspMuxServer, RETAINED_STOP_FAILURES, TERMINATION_BUDGET_MS } from "../src/lsp/mux/server";
import { ChildProcess } from "@oh-my-pi/pi-utils/ptree";

interface RpcMessage {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

interface FakeState {
	initializeCount: number;
	processId: number | null;
	didOpen: Record<string, number>;
	didChange: Record<string, number[]>;
	didClose: string[];
	notifications: string[];
}

interface PublishDiagnosticsParams {
	uri: string;
	version?: number;
	diagnostics: Array<{ message: string; severity: number }>;
}

class MuxTestClient {
	readonly #socket: net.Socket;
	readonly #framer = new MessageFramer(Buffer.alloc(0));
	readonly #pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	readonly #notifications = new Map<string, RpcMessage[]>();
	readonly #notificationWaiters = new Map<string, Array<(message: RpcMessage) => void>>();
	#nextId = 1;
	#closed = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;
		socket.on("data", (chunk: Buffer) => {
			this.#framer.push(chunk);
			for (const text of this.#framer.drain(() => {})) this.#receive(JSON.parse(text) as RpcMessage);
		});
		socket.on("error", error => this.#failPending(error));
		socket.on("close", () => {
			this.#closed = true;
			this.#failPending(new Error("Mux socket closed"));
		});
	}

	static async connect(endpoint: string): Promise<MuxTestClient> {
		const socket = net.createConnection(endpoint);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve();
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
		await promise;
		return new MuxTestClient(socket);
	}

	request<T>(method: string, params?: unknown, id: string | number = this.#nextId++): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#write({ jsonrpc: "2.0", id, method, params });
		return promise as Promise<T>;
	}

	notify(method: string, params?: unknown): void {
		this.#write({ jsonrpc: "2.0", method, params });
	}

	async nextNotification<T>(method: string): Promise<T> {
		const queued = this.#notifications.get(method);
		const message = queued?.shift();
		if (message) return message.params as T;
		const { promise, resolve } = Promise.withResolvers<RpcMessage>();
		const waiters = this.#notificationWaiters.get(method);
		if (waiters) waiters.push(resolve);
		else this.#notificationWaiters.set(method, [resolve]);
		return (await withTimeout(promise, `notification ${method}`)).params as T;
	}

	waitForClose(): Promise<void> {
		if (this.#closed || this.#socket.destroyed) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#socket.once("close", () => resolve());
		return withTimeout(promise, "socket close");
	}

	destroy(): void {
		this.#socket.destroy();
	}

	#write(message: RpcMessage): void {
		const json = JSON.stringify(message);
		this.#socket.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
	}

	#receive(message: RpcMessage): void {
		if (message.method !== undefined) {
			if (message.id !== undefined) {
				this.#write({ jsonrpc: "2.0", id: message.id, result: message.params });
				return;
			}
			const waiters = this.#notificationWaiters.get(message.method);
			const waiter = waiters?.shift();
			if (waiter) waiter(message);
			else {
				const queued = this.#notifications.get(message.method);
				if (queued) queued.push(message);
				else this.#notifications.set(message.method, [message]);
			}
			return;
		}
		if (message.id === undefined) return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
		else pending.resolve(message.result);
	}

	#failPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
	// Real socket/subprocess integration needs a wall-clock failure watchdog; always cancel it when the event wins.
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Running as the kernel reports it.
 *
 * `kill(pid, 0)` succeeds against an unreaped zombie, so it cannot answer a
 * question asked the instant a termination returns; the native status can.
 */
function processRunning(pid: number): boolean {
	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

/**
 * Every reason inside a shutdown failure, flattened.
 *
 * A stop's own `AggregateError` arrives nested inside the shutdown's, so a test
 * that asserts on the outer message asserts on a string no defect can change.
 */
function reasonsOf(error: unknown): unknown[] {
	if (error === undefined) return [];
	if (error instanceof AggregateError) return error.errors.flatMap(reason => reasonsOf(reason));
	return [error];
}

/**
 * Spin until `reference` reports the kernel's view of its subject's exit.
 *
 * Synchronous on purpose: it holds the loop turn Bun's reaper needs, so the
 * subject stays an unreaped zombie and the status flip comes from the kernel
 * rather than from the runtime noticing. The bound is only a hang-breaker —
 * the oracle is the caller's assertion — and it reads a monotonic clock, since
 * a backward wall-clock step would turn a hang-breaker into a hang and outlast
 * the test timeout with it.
 */
function spinUntilExited(reference: Process, what: string): void {
	const deadline = performance.now() + 5_000;
	while (reference.status() === ProcessStatus.Running)
		if (performance.now() > deadline) throw new Error(`${what} did not exit`);
}

/** Every helper the fixture spawns is this, which makes it identifiable. */
const FIXTURE_HELPER_ARGV = "sleep 60";

/**
 * SIGKILL a fixture helper, checking and signalling on one reference.
 *
 * A pid is not an identity, so resolving one, confirming it is still the
 * helper, and then signalling the bare number hands the decision back to the
 * number in between — the reuse race the confirmation was there to close,
 * reintroduced by the handoff. What signalling the reference buys is not
 * uniform, and is worth stating rather than assuming:
 *
 * - Linux: the reference is a pidfd, which pins the pid against reuse for as
 *   long as it is held, and the process itself is signalled through it with no
 *   lookup.
 * - macOS: no pidfd. The reference re-reads the `(pid, start time)` pair
 *   immediately before a numeric kill, which needs pid reuse *and* a matching
 *   start time to go wrong, but is not atomic.
 * - Windows: a retained handle, which reserves the pid and is terminated
 *   directly.
 *
 * On either POSIX platform a helper that leads its own group — the detached one
 * does — additionally draws a numeric `kill(-pgid)` from the tree walk, so that
 * part is only as safe as the pgid number.
 *
 * Limit worth knowing before extending this: pid plus argv cannot prove the
 * process at that number is the one that wrote the pid file. A reused pid
 * running another `sleep 60` matches. Realistically that is a concurrent run
 * of this same suite, and the cost is another run's helper dying early.
 */
function killFixtureHelper(pid: number): void {
	if (!(pid > 0)) return;
	const helper = Process.fromPid(pid);
	if (helper) {
		// Unrecognised is left alone: a stray helper beats signalling a stranger.
		if (helper.args().join(" ") !== FIXTURE_HELPER_ARGV) return;
		helper.killTree();
		return;
	}
	// No reference, which is two different situations. If references work here,
	// the helper is simply gone and the number now belongs to nobody we may
	// signal. If they do not — `pidfd_open` blocked by seccomp, or a kernel
	// without it — then absence says nothing about the helper, and the numeric
	// kill is the only mechanism this host has.
	if (Process.fromPid(process.pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}

/**
 * SIGKILL every helper whose pid the fixture published under `dir`.
 *
 * Teardown belongs with whatever owns the spawn, and that is the fixture: it
 * writes each helper's pid into the run's own directory before any test can
 * learn it. A test that fails between the spawn and the read has nothing to
 * clean up by hand, so registering cleanup inside the test is a pattern that
 * can only be got wrong — this reaches those helpers regardless.
 */
async function killStrayHelpers(dir: string): Promise<void> {
	const entries = await fs.readdir(dir).catch(() => [] as string[]);
	for (const entry of entries) {
		if (!entry.endsWith(".pid")) continue;
		const text = await Bun.file(path.join(dir, entry))
			.text()
			.catch(() => "");
		killFixtureHelper(Number.parseInt(text.trim(), 10));
	}
}

async function readPid(file: string): Promise<number> {
	let pid = 0;
	await pollUntil(
		async () => {
			pid =
				Number.parseInt(
					(
						await Bun.file(file)
							.text()
							.catch(() => "")
					).trim(),
					10,
				) || 0;
			return pid > 0;
		},
		`pid in ${path.basename(file)}`,
	);
	return pid;
}

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const initializeParams = (processId = 424242): Record<string, unknown> => ({
	processId,
	rootUri: null,
	capabilities: {},
});

async function initialize(client: MuxTestClient, processId = 424242): Promise<Record<string, unknown>> {
	const result = await client.request<Record<string, unknown>>("initialize", initializeParams(processId));
	client.notify("initialized", {});
	return result;
}

async function state(client: MuxTestClient): Promise<FakeState> {
	return client.request<FakeState>("test/state");
}

async function pollUntil(check: () => Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

describe("LspMuxServer", () => {
	let server: LspMuxServer;
	let tmpDir: string;
	let socketPath: string;
	let connectParams: MuxConnectParams;
	const clients: MuxTestClient[] = [];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-mux-test-"));
		socketPath = path.join(tmpDir, "mux.sock");
		connectParams = { command: process.execPath, args: ["run", fixturePath], cwd: tmpDir };
		server = new LspMuxServer();
		await server.listen(socketPath);
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		try {
			await server.shutdown();
		} finally {
			// Unconditional, and ahead of the directory it reads from. A shutdown
			// that rejects must not strand a helper, and a spy that survives into
			// the next test is a hazard for the whole file rather than for the one
			// that installed it.
			await killStrayHelpers(tmpDir);
			mock.restore();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	async function link(): Promise<{ client: MuxTestClient; connected: MuxConnectResult }> {
		const client = await MuxTestClient.connect(socketPath);
		clients.push(client);
		const connected = await client.request<MuxConnectResult>(MUX_CONNECT_METHOD, connectParams);
		return { client, connected };
	}

	it.skipIf(process.platform === "win32")("lets healthy language servers finish the shutdown handshake", async () => {
		const shutdownFile = path.join(tmpDir, "shutdown.json");
		connectParams.env = { TEST_LSP_SHUTDOWN_FILE: shutdownFile };
		const { client } = await link();
		await initialize(client);
		await server.shutdown();
		expect(await Bun.file(shutdownFile).json()).toEqual({ shutdownReceived: true, exitReceived: true });
	});

	it.skipIf(process.platform === "win32")(
		"terminates a helper the language server leaves behind",
		async () => {
			// The server honours `exit`, so the mux waits for its root to be gone
			// before terminating; the helper is only reachable through references
			// pinned while the root was still alive.
			const helperFile = path.join(tmpDir, "helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client } = await link();
			await initialize(client);
			let helperPid = 0;
			await pollUntil(async () => {
				helperPid =
					Number.parseInt(
						(
							await Bun.file(helperFile)
								.text()
								.catch(() => "")
						).trim(),
						10,
					) || 0;
				return helperPid > 0;
			}, "helper pid");
			const helperAlive = () => {
				try {
					process.kill(helperPid, 0);
					return true;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code !== "ESRCH";
				}
			};
			try {
				expect(helperAlive()).toBe(true);
				await server.shutdown();
				expect(server.serverKeys).toEqual([]);
				await pollUntil(() => Promise.resolve(!helperAlive()), "helper termination", 6_000);
			} finally {
				killFixtureHelper(helperPid);
			}
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"terminates a helper subtree whose direct child dies during the handshake",
		async () => {
			// The helper is killed while answering `shutdown`, so by termination time
			// only its reparented grandchild is left, reachable from neither the
			// helper nor the exited server.
			const grandchildFile = path.join(tmpDir, "grandchild.pid");
			connectParams.env = { TEST_LSP_GRANDCHILD_PID_FILE: grandchildFile };
			const { client } = await link();
			await initialize(client);
			const grandchildPid = await readPid(grandchildFile);
			try {
				expect(processAlive(grandchildPid)).toBe(true);
				await server.shutdown();
				await pollUntil(() => Promise.resolve(!processAlive(grandchildPid)), "grandchild termination", 6_000);
			} finally {
				killFixtureHelper(grandchildPid);
			}
		},
		10_000,
	);

	// Gated on the same precondition the mechanism is: where a reaped leader's
	// group cannot be attributed the mux takes no group ownership, and this
	// helper is unreachable there.
	it.skipIf(!groupOwnership.available())(
		"terminates a handshake-spawned helper before shutdown reports success",
		async () => {
			// Every snapshot this shutdown could take of the server's subtree predates
			// the helper: the server creates it while answering `shutdown` and then
			// exits on `exit`, reparenting it out of reach of a walk rooted at the
			// dead root. Only a relation the helper inherited at fork — its process
			// group — can still name it here.
			const handshakeFile = path.join(tmpDir, "handshake-helper.pid");
			const shutdownFile = path.join(tmpDir, "handshake-shutdown.json");
			connectParams.env = {
				TEST_LSP_HANDSHAKE_HELPER_PID_FILE: handshakeFile,
				TEST_LSP_SHUTDOWN_FILE: shutdownFile,
			};
			const { client } = await link();
			await initialize(client);
			// Read while the handshake is still running, because the contract is about
			// the state when shutdown returns. Nothing here has to survive a failure
			// to read it: the fixture published the pid, and teardown sweeps on that.
			const settled = server.shutdown().then(
				() => undefined,
				(error: unknown) => error,
			);
			const helperPid = await readPid(handshakeFile);
			const failure = await settled;
			if (failure !== undefined) throw failure;
			// Not polled: reporting success while this is still running is the defect,
			// so the deadline for it is the return itself.
			expect(processRunning(helperPid)).toBe(false);
			// And the root left on `exit` rather than being hard-killed at the budget,
			// so the helper really was orphaned by a graceful exit.
			expect(await Bun.file(shutdownFile).json()).toEqual({ shutdownReceived: true, exitReceived: true });
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"does not reach a handshake helper that leaves the process group",
		async () => {
			// A characterization of the residual rather than a wish. Group membership
			// is inherited, not enforced: a helper born after the pin that then calls
			// `setsid(2)` is in neither cleanup set, and no relation it carries still
			// leads back here. Containing it needs a cgroup or a subreaper, neither of
			// which the mux owns. Asserted so the gap cannot pass for coverage — it
			// fails the moment either half of it changes.
			const escapeFile = path.join(tmpDir, "escaping-helper.pid");
			connectParams.env = { TEST_LSP_ESCAPING_HELPER_PID_FILE: escapeFile };
			const { client } = await link();
			await initialize(client);
			const settled = server.shutdown().then(
				() => undefined,
				(error: unknown) => error,
			);
			const helperPid = await readPid(escapeFile);
			const failure = await settled;
			if (failure !== undefined) throw failure;
			expect(processRunning(helperPid)).toBe(true);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"cannot reach a handshake-spawned helper when the group is not owned",
		async () => {
			// What the gate governs, stated from the shut side. A helper pinned before
			// the handshake is still swept by identity, so it says nothing about the
			// gate — it dies either way. The one the gate decides is the late one: on
			// a host that cannot attribute a reaped leader's group the mux never takes
			// the group, and nothing then names a helper born after the pin.
			// Restored by teardown, not here: a spy that outlives a failing test is a
			// hazard for every test after it.
			const gateSpy = spyOn(groupOwnership, "available").mockReturnValue(false);
			const startupFile = path.join(tmpDir, "startup-helper.pid");
			const handshakeFile = path.join(tmpDir, "late-helper.pid");
			connectParams.env = {
				TEST_LSP_HELPER_PID_FILE: startupFile,
				TEST_LSP_HANDSHAKE_HELPER_PID_FILE: handshakeFile,
			};
			const { client } = await link();
			await initialize(client);
			expect(gateSpy).toHaveBeenCalled();
			const startupPid = await readPid(startupFile);
			const settled = server.shutdown().then(
				() => undefined,
				(error: unknown) => error,
			);
			const latePid = await readPid(handshakeFile);
			const failure = await settled;
			if (failure !== undefined) throw failure;
			expect(processRunning(startupPid)).toBe(false);
			expect(processRunning(latePid)).toBe(true);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"fails the stop when the server root exits before its subtree is walked",
		async () => {
			// The walk cannot report this and should not: rooted at a pid whose
			// process has gone it enumerates nothing and answers whole, because it
			// cannot separate a root that died a syscall ago from one that was never
			// running, and charging every exited node would make the hard wave's
			// rescan of a dying tree unattributable. The mux is the only side that
			// knows the root was pinned alive, so refusing is its job.
			//
			// Driven by killing the root from inside the walk, which is the only way
			// to reach a window that is otherwise two syscalls wide.
			const helperFile = path.join(tmpDir, "orphaned-helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const descendants = Process.prototype.descendants;
			const spy = spyOn(Process.prototype, "descendants").mockImplementation(function (this: Process) {
				if (this.pid !== pid) return descendants.call(this);
				process.kill(pid, "SIGKILL");
				spinUntilExited(this, "server root under the walk");
				return descendants.call(this);
			});
			try {
				const failure = await server.shutdown().then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(reasonsOf(failure).map(String).join("\n")).toContain(
					`server root ${pid} exited before its subtree could be walked`,
				);
			} finally {
				spy.mockRestore();
				killFixtureHelper(helperPid);
				await server.shutdown().catch(() => {});
				server = new LspMuxServer();
			}
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"fails the stop when the server root was already gone when its subtree was pinned",
		async () => {
			// The wider of the two windows, and the one a bracket that only compares
			// across the walk lets through: everything from the server's own exit up
			// to the pin, where the other covers a single walk. An already-dead root
			// is pinnable — `pidfd_open` succeeds on a zombie — so the reference says
			// nothing, and the walk it roots answers empty and whole.
			//
			// No spy needed. The mux pins synchronously, so `shutdown()` reaches the
			// pin before it yields, and the spin below holds the one loop turn Bun's
			// reaper and the mux's own exit callback both need: the server is still
			// in the mux's set and still an unreaped zombie when the pin reads it.
			const helperFile = path.join(tmpDir, "prepin-helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const root = Process.fromPid(pid);
			if (!root) throw new Error("No reference to the language-server root");
			try {
				process.kill(pid, "SIGKILL");
				spinUntilExited(root, "server root before the pin");
				const failure = await server.shutdown().then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(reasonsOf(failure).map(String).join("\n")).toContain(
					`server root ${pid} was already gone when its subtree was pinned`,
				);
			} finally {
				killFixtureHelper(helperPid);
				await server.shutdown().catch(() => {});
				server = new LspMuxServer();
			}
		},
		10_000,
	);

	for (const failure of ["timeout", "error"] as const) {
		it.skipIf(process.platform === "win32")(
			`reports incomplete shutdown when helper termination ${failure}s`,
			async () => {
				const helperFile = path.join(tmpDir, "helper.pid");
				connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
				const { client } = await link();
				await initialize(client);
				const helperPid = await readPid(helperFile);
				const killTreeAndWait = Process.prototype.killTreeAndWait;
				const spy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(
					async function (this: Process, options) {
						if (this.pid !== helperPid) return killTreeAndWait.call(this, options);
						if (failure === "error") throw new Error("Native helper termination failed");
						return false;
					},
				);
				try {
					await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
				} finally {
					spy.mockRestore();
					killFixtureHelper(helperPid);
					// Unconditional, because a body that failed before its own shutdown
					// would otherwise hand afterEach a fresh mux and leave this one
					// listening into the tests that follow. Already settled when the
					// body did get there, since shutdown memoizes.
					await server.shutdown().catch(() => {});
					server = new LspMuxServer();
				}
			},
			10_000,
		);
	}

	it.skipIf(process.platform === "win32")(
		"reports an in-flight idle stop's helper failure to a concurrent shutdown",
		async () => {
			// A server that went idle is already being stopped when shutdown arrives,
			// and the root's own termination promise settles first and covers only the
			// root. Handing shutdown that promise would close the listener while the
			// helper sweep is still running and report success over its failure, so
			// the second caller has to get the stop itself.
			//
			// The server has to ignore `exit` for the window to exist at all: a server
			// that exits politely is retired by its own exit callback before the sweep
			// starts, and shutdown then finds nothing left to join.
			const helperFile = path.join(tmpDir, "helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile, TEST_LSP_IGNORE_EXIT: "1" };
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const sweeping = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const rootRelease = Promise.withResolvers<void>();
			const killTreeAndWait = Process.prototype.killTreeAndWait;
			const helperSpy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(
				async function (this: Process, options) {
					if (this.pid !== helperPid) return killTreeAndWait.call(this, options);
					sweeping.resolve();
					await release.promise;
					return false;
				},
			);
			// Held so the root cannot retire the server before shutdown enumerates it,
			// which would leave nothing for the second stop to be handed at all.
			const killAndWait = ChildProcess.prototype.killAndWait;
			const rootSpy = spyOn(ChildProcess.prototype, "killAndWait").mockImplementation(
				async function (this: ChildProcess, reason, gracefulMs) {
					if (this.pid === pid) await rootRelease.promise;
					return killAndWait.call(this, reason, gracefulMs);
				},
			);
			const schedule = globalThis.setTimeout;
			const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
				handler: () => void,
				delay?: number,
				...args: unknown[]
			) => schedule(handler, delay === 5 * 60 * 1_000 ? 1 : delay, ...args)) as typeof setTimeout);
			try {
				client.destroy();
				await withTimeout(sweeping.promise, "idle stop reaching the helper sweep", 6_000);
				const shutdown = server.shutdown();
				rootRelease.resolve();
				release.resolve();
				await expect(shutdown).rejects.toThrow("LSP mux shutdown incomplete");
			} finally {
				rootRelease.resolve();
				release.resolve();
				helperSpy.mockRestore();
				rootSpy.mockRestore();
				timerSpy.mockRestore();
				killFixtureHelper(helperPid);
				// The memoized rejection would resurface in afterEach's own shutdown.
				server = new LspMuxServer();
			}
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"refuses connections that arrive after shutdown begins",
		async () => {
			// Shutdown snapshots the sessions and servers, waits on the stops, then
			// closes the listener. A connection accepted after that snapshot is in
			// neither set: it can spawn a server nothing will stop, and it keeps
			// `close()` pending for as long as it stays connected.
			const helperFile = path.join(tmpDir, "helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client } = await link();
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const sweeping = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const killTreeAndWait = Process.prototype.killTreeAndWait;
			const helperSpy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(
				async function (this: Process, options) {
					if (this.pid !== helperPid) return killTreeAndWait.call(this, options);
					sweeping.resolve();
					await release.promise;
					return killTreeAndWait.call(this, options);
				},
			);
			let late: net.Socket | undefined;
			try {
				const shutdown = server.shutdown();
				await withTimeout(sweeping.promise, "helper sweep", 6_000);
				const socket = net.connect(socketPath);
				late = socket;
				const closed = Promise.withResolvers<void>();
				socket.once("close", () => closed.resolve());
				const connected = Promise.withResolvers<void>();
				socket.once("connect", () => connected.resolve());
				socket.once("error", error => connected.reject(error));
				await connected.promise;
				const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: MUX_CONNECT_METHOD, params: connectParams });
				socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
				await withTimeout(closed.promise, "late connection refused", 4_000);
				release.resolve();
				await withTimeout(shutdown, "shutdown past a late connection", 6_000);
				expect(server.sessionCount).toBe(0);
			} finally {
				release.resolve();
				late?.destroy();
				helperSpy.mockRestore();
				killFixtureHelper(helperPid);
				server = new LspMuxServer();
			}
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"attempts every helper when one of them throws before returning a promise",
		async () => {
			// The native side captures its tree synchronously, so a preparation
			// failure surfaces as a throw rather than a rejection. Called bare inside
			// the map that feeds `allSettled`, one such throw abandons the rest of the
			// batch: later helpers are never attempted and earlier ones never awaited.
			const helperFile = path.join(tmpDir, "helper.pid");
			const grandchildFile = path.join(tmpDir, "grandchild.pid");
			connectParams.env = {
				TEST_LSP_HELPER_PID_FILE: helperFile,
				TEST_LSP_GRANDCHILD_PID_FILE: grandchildFile,
			};
			const { client } = await link();
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const grandchildPid = await readPid(grandchildFile);
			const attempted: number[] = [];
			const spy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(function (this: Process) {
				attempted.push(this.pid);
				throw new Error(`Native helper termination failed: ${this.pid}`);
			});
			try {
				await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
				expect(attempted).toContain(helperPid);
				expect(attempted).toContain(grandchildPid);
			} finally {
				spy.mockRestore();
				killFixtureHelper(helperPid);
				killFixtureHelper(grandchildPid);
				server = new LspMuxServer();
			}
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"reports a stop that already failed to a later shutdown",
		async () => {
			// An idle server's stop can fail long before anyone calls shutdown, and by
			// then the server is retired and the stop settled. Neither the tracked
			// servers nor the in-flight stops carry it, so the failure has to be kept
			// or the shutdown that follows reports success over what it left behind.
			const helperFile = path.join(tmpDir, "helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client } = await link();
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const killTreeAndWait = Process.prototype.killTreeAndWait;
			const helperSpy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(
				async function (this: Process, options) {
					if (this.pid !== helperPid) return killTreeAndWait.call(this, options);
					return false;
				},
			);
			const schedule = globalThis.setTimeout;
			const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
				handler: () => void,
				delay?: number,
				...args: unknown[]
			) => schedule(handler, delay === 5 * 60 * 1_000 ? 1 : delay, ...args)) as typeof setTimeout);
			try {
				client.destroy();
				await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "idle stop retirement", 6_000);
				// The stop rejects after the retirement it races; give it the turns it
				// needs so this really is the settled-and-forgotten case.
				await Bun.sleep(200);
				await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
			} finally {
				helperSpy.mockRestore();
				timerSpy.mockRestore();
				killFixtureHelper(helperPid);
				server = new LspMuxServer();
			}
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"reports a helper sweep still running after its server was retired",
		async () => {
			// A server is retired the moment its root termination finishes, which is
			// before its helper sweep does, so by the time shutdown enumerates the
			// tracked servers there is nothing left to enumerate. The stop itself has
			// to be what shutdown waits on, or a helper that is still being swept —
			// and about to fail — is neither waited for nor reported.
			const helperFile = path.join(tmpDir, "helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client } = await link();
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const sweeping = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const killTreeAndWait = Process.prototype.killTreeAndWait;
			const helperSpy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(
				async function (this: Process, options) {
					if (this.pid !== helperPid) return killTreeAndWait.call(this, options);
					sweeping.resolve();
					await release.promise;
					return false;
				},
			);
			const schedule = globalThis.setTimeout;
			const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
				handler: () => void,
				delay?: number,
				...args: unknown[]
			) => schedule(handler, delay === 5 * 60 * 1_000 ? 1 : delay, ...args)) as typeof setTimeout);
			try {
				client.destroy();
				await withTimeout(sweeping.promise, "idle stop reaching the helper sweep", 6_000);
				await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "server retirement", 4_000);
				const shutdown = server.shutdown();
				release.resolve();
				await expect(shutdown).rejects.toThrow("LSP mux shutdown incomplete");
			} finally {
				release.resolve();
				helperSpy.mockRestore();
				timerSpy.mockRestore();
				killFixtureHelper(helperPid);
				// The memoized rejection would resurface in afterEach's own shutdown.
				server = new LspMuxServer();
			}
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"bounds helper termination by the hard-termination budget",
		async () => {
			// Asserted on the budget handed to the native wait rather than on elapsed
			// wall clock, which goes flaky under load.
			const helperFile = path.join(tmpDir, "helper.pid");
			connectParams.env = { TEST_LSP_HELPER_PID_FILE: helperFile };
			const { client } = await link();
			await initialize(client);
			const helperPid = await readPid(helperFile);
			const budgets: (number | undefined)[] = [];
			const killTreeAndWait = Process.prototype.killTreeAndWait;
			const spy = spyOn(Process.prototype, "killTreeAndWait").mockImplementation(
				async function (this: Process, options) {
					if (this.pid === helperPid) budgets.push(options?.timeoutMs ?? undefined);
					return killTreeAndWait.call(this, options);
				},
			);
			try {
				await server.shutdown();
				expect(budgets).toEqual([TERMINATION_BUDGET_MS]);
			} finally {
				spy.mockRestore();
				killFixtureHelper(helperPid);
			}
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")("bounds shutdown when a language server ignores exit", async () => {
		connectParams.env = { TEST_LSP_IGNORE_EXIT: "1" };
		const { client } = await link();
		await initialize(client);
		await withTimeout(server.shutdown(), "server ignoring exit", 4_000);
		expect(server.serverKeys).toEqual([]);
		expect(server.sessionCount).toBe(0);
	});

	for (const expire of [false, true]) {
		it.skipIf(process.platform === "win32")(
			expire
				? "reports incomplete shutdown and retains tracking until native termination finishes"
				: "waits for native tree termination after the language-server root exits",
			async () => {
				connectParams.env = { TEST_LSP_IGNORE_EXIT: "1" };
				const { client, connected } = await link();
				await initialize(client);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const terminate = Process.prototype.terminate;
				const spy = spyOn(Process.prototype, "terminate").mockImplementation(
					async function (this: Process, options) {
						const result = await terminate.call(this, options);
						if (this.pid === connected.pid) {
							entered.resolve();
							await release.promise;
						}
						return result;
					},
				);
				const shutdown = server.shutdown();
				void shutdown.catch(() => {});
				try {
					expect(
						await withTimeout(
							Promise.race([entered.promise.then(() => "terminating"), shutdown.then(() => "completed")]),
							"native termination",
						),
					).toBe("terminating");
					if (expire) {
						await expect(shutdown).rejects.toThrow("LSP mux shutdown incomplete");
						expect(server.serverKeys).toEqual([connected.key]);
					} else {
						const outcome = await Promise.race([
							shutdown.then(() => "completed"),
							Bun.sleep(25).then(() => "pending"),
						]);
						expect(outcome).toBe("pending");
						expect(server.serverKeys).toEqual([connected.key]);
					}
				} finally {
					release.resolve();
					spy.mockRestore();
					await shutdown.catch(() => {});
					await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "termination cleanup");
					if (expire) {
						server = new LspMuxServer();
					}
				}
			},
			6_000,
		);
	}

	it.skipIf(process.platform === "win32")(
		"retires a server that exits after its termination failed",
		async () => {
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			const rejected = Promise.withResolvers<void>();
			// Fail termination without touching the process, so the failure lands
			// while the server is still alive and only its later exit can clean up.
			const spy = spyOn(ChildProcess.prototype, "killAndWait").mockImplementation(
				async function (this: ChildProcess) {
					if (this.pid !== pid) return;
					rejected.resolve();
					throw new Error(`Process tree termination timed out: ${pid}`);
				},
			);
			try {
				client.notify(MUX_RESTART_METHOD);
				await withTimeout(rejected.promise, "failed termination", 4_000);
				expect(server.serverKeys).toEqual([connected.key]);
				expect(server.sessionCount).toBe(1);
				process.kill(pid, "SIGKILL");
				await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "late-exit cleanup", 4_000);
				await pollUntil(() => Promise.resolve(server.sessionCount === 0), "session close", 4_000);
			} finally {
				spy.mockRestore();
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
				// The restart's termination failed, so this shutdown owes a report on
				// it. Asserted rather than swallowed, for the same reason.
				await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
				server = new LspMuxServer();
			}
		},
		10_000,
	);

	for (const trigger of ["restart", "initialize"] as const) {
		it.skipIf(process.platform === "win32")(
			trigger === "restart"
				? "reports a restart's failed termination to a later shutdown"
				: "reports a failed initialize's failed termination to a later shutdown",
			async () => {
				// Both of these kill a server outside any stop, and both reach it from
				// a handler that only logs the rejection — the session message pump for
				// one, the server reader loop for the other. The root's own exit then
				// retires the server, so by the time anyone calls shutdown there is no
				// tracked server and no in-flight stop, and unless the failure itself
				// was kept nothing is left to say a helper outlived it.
				const helperFile = path.join(tmpDir, "helper.pid");
				connectParams.env =
					trigger === "restart"
						? { TEST_LSP_HELPER_PID_FILE: helperFile }
						: { TEST_LSP_HELPER_PID_FILE: helperFile, TEST_LSP_INITIALIZE_ERROR: "1" };
				const { client, connected } = await link();
				const pid = connected.pid;
				if (pid === undefined) throw new Error("Mux did not report the language-server pid");
				const helperPid = await readPid(helperFile);
				const rejected = Promise.withResolvers<void>();
				// The root dies, so its exit is what retires the server, while the
				// termination still reports that it did not finish — which is exactly
				// the state that leaves the fixture's helper running past it.
				const spy = spyOn(ChildProcess.prototype, "killAndWait").mockImplementation(
					async function (this: ChildProcess) {
						if (this.pid !== pid) return;
						try {
							process.kill(pid, "SIGKILL");
						} catch {}
						rejected.resolve();
						throw new Error(`Process tree termination timed out: ${pid}`);
					},
				);
				try {
					if (trigger === "restart") {
						await initialize(client);
						client.notify(MUX_RESTART_METHOD);
					} else {
						await expect(client.request("initialize", initializeParams())).rejects.toThrow(
							"fake initialize failure",
						);
					}
					await withTimeout(rejected.promise, `failed ${trigger} termination`, 4_000);
					await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "late-exit cleanup", 4_000);
					expect(processRunning(helperPid)).toBe(true);
					await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
				} finally {
					spy.mockRestore();
					killFixtureHelper(helperPid);
					// Unconditional, because a body that failed before its own shutdown
					// would otherwise hand afterEach a fresh mux and leave this one
					// listening into the tests that follow. Already settled when the
					// body did get there, since shutdown memoizes.
					await server.shutdown().catch(() => {});
					server = new LspMuxServer();
				}
			},
			15_000,
		);
	}

	it.skipIf(process.platform === "win32")(
		"fails a stop that could not open a reference to the server root",
		async () => {
			// No reference is the same outcome as a walk that stopped short, and has
			// to be read that way rather than as a subtree with nothing in it: the
			// pin runs while the server is expected alive, so failing to open one
			// means a refused `pidfd_open` or a root that died into the gap, and in
			// both the helpers it may have left are past reach rather than absent.
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			const fromPid = Process.fromPid;
			const spy = spyOn(Process, "fromPid").mockImplementation((target: number) =>
				target === pid ? null : fromPid.call(Process, target),
			);
			try {
				await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
			} finally {
				spy.mockRestore();
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
				await server.shutdown().catch(() => {});
				server = new LspMuxServer();
			}
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"fails a stop whose helper subtree could not be pinned",
		async () => {
			// The walk refuses to hand back a subtree it knows is short, because the
			// caller pins what it is given and then reports that tree terminated. A
			// stop that never pinned the subtree has to fail for the same reason one
			// that failed to sweep it does — what it left behind is unaccounted for
			// either way — while still giving the server its clean exit.
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			const descendants = Process.prototype.descendants;
			const spy = spyOn(Process.prototype, "descendants").mockImplementation(function (this: Process) {
				if (this.pid !== pid) return descendants.call(this);
				throw new Error(`descendant walk of ${pid} could not be completed`);
			});
			try {
				await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
				// The handshake still ran: refusing to pin must not cost the server
				// the chance to exit on its own terms.
				expect(processRunning(pid)).toBe(false);
			} finally {
				spy.mockRestore();
				await server.shutdown().catch(() => {});
				server = new LspMuxServer();
			}
		},
		15_000,
	);

	it.skipIf(process.platform === "win32")(
		"caps retained termination failures without understating how many there were",
		async () => {
			// Anything that can make one termination fail can make the next one fail
			// too, and a mux that is never shut down would hold a settled promise per
			// failure forever. Capping what is kept must not cap what is reported:
			// the count past the cap still has to reach the shutdown.
			const failures = RETAINED_STOP_FAILURES + 2;
			const killAndWait = ChildProcess.prototype.killAndWait;
			const doomed = new Set<number>();
			const spy = spyOn(ChildProcess.prototype, "killAndWait").mockImplementation(
				async function (this: ChildProcess, reason, gracefulMs) {
					if (!doomed.has(this.pid)) return killAndWait.call(this, reason, gracefulMs);
					try {
						process.kill(this.pid, "SIGKILL");
					} catch {}
					throw new Error(`Process tree termination timed out: ${this.pid}`);
				},
			);
			try {
				for (let attempt = 0; attempt < failures; attempt++) {
					// A fresh key per iteration, so each restart kills a server of its
					// own: one memoized termination per server is one recorded failure.
					connectParams.env = { TEST_LSP_ATTEMPT: String(attempt) };
					const { client, connected } = await link();
					if (connected.pid === undefined) throw new Error("Mux did not report the language-server pid");
					doomed.add(connected.pid);
					client.notify(MUX_RESTART_METHOD);
					await pollUntil(
						() => Promise.resolve(!server.serverKeys.includes(connected.key)),
						`restart ${attempt} retirement`,
						6_000,
					);
				}
				const error = await server.shutdown().then(
					() => undefined,
					(thrown: unknown) => thrown,
				);
				expect(error).toBeInstanceOf(AggregateError);
				const aggregate = error as AggregateError;
				expect(aggregate.errors).toHaveLength(RETAINED_STOP_FAILURES + 1);
				expect(String(aggregate.errors.at(-1))).toContain(
					`withheld ${failures - RETAINED_STOP_FAILURES} further termination failures`,
				);
			} finally {
				spy.mockRestore();
				await server.shutdown().catch(() => {});
				server = new LspMuxServer();
			}
		},
		30_000,
	);

	for (const disconnectFirst of [false, true]) {
		it.skipIf(process.platform === "win32")(
			disconnectFirst
				? "terminates a nonreading server when disconnected-session cleanup stalls"
				: "bounds mux shutdown when a language server stops reading stdin",
			async () => {
				const { client, connected } = await link();
				const pid = connected.pid;
				if (pid === undefined) throw new Error("Mux did not report the language-server pid");
				try {
					await initialize(client);
					client.notify("textDocument/didOpen", {
						textDocument: { uri: "file:///blocked.ts", version: 1, text: "x" },
					});
					await client.request("test/stopReading");
					// Bun 1.3.14 keeps reading stdin while the JavaScript consumer is paused.
					process.kill(pid, "SIGSTOP");
					client.notify("test/fillPipe", { text: "x".repeat(8 * 1024 * 1024) });
					await client.request(MUX_PING_METHOD);
					if (disconnectFirst) {
						client.destroy();
						await pollUntil(
							() => Promise.resolve(server.serverKeys.length === 0),
							"disconnected-session cleanup",
							4_000,
						);
					} else {
						await withTimeout(server.shutdown(), "blocked mux shutdown", 4_000);
					}
					expect(server.sessionCount).toBe(0);
					expect(server.serverKeys).toEqual([]);
					await pollUntil(() => {
						try {
							process.kill(pid, 0);
							return Promise.resolve(false);
						} catch (error) {
							return Promise.resolve((error as NodeJS.ErrnoException).code === "ESRCH");
						}
					}, "blocked process exit");
				} finally {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			},
			10_000,
		);
	}

	it.skipIf(process.platform === "win32")(
		"becomes idle after disconnected-server termination times out",
		async () => {
			const { client, connected } = await link();
			const pid = connected.pid;
			if (pid === undefined) throw new Error("Mux did not report the language-server pid");
			await initialize(client);
			await client.request("test/stopReading");
			process.kill(pid, "SIGSTOP");
			client.notify("test/fillPipe", { text: "x".repeat(8 * 1024 * 1024) });
			await client.request(MUX_PING_METHOD);
			const release = Promise.withResolvers<void>();
			const idle = Promise.withResolvers<void>();
			server.onIdle = idle.resolve;
			const terminate = Process.prototype.terminate;
			const terminationSpy = spyOn(Process.prototype, "terminate").mockImplementation(
				async function (this: Process, options) {
					const result = await terminate.call(this, options);
					if (this.pid === pid) await release.promise;
					return result;
				},
			);
			const schedule = globalThis.setTimeout;
			const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
				handler: () => void,
				delay?: number,
				...args: unknown[]
			) => schedule(handler, delay === 15 * 60 * 1_000 ? 1 : delay, ...args)) as typeof setTimeout);
			try {
				client.destroy();
				await withTimeout(idle.promise, "mux idle after termination timeout", 4_000);
				expect(server.sessionCount).toBe(0);
				expect(server.serverKeys).toEqual([connected.key]);
			} finally {
				release.resolve();
				terminationSpy.mockRestore();
				timerSpy.mockRestore();
				await pollUntil(() => Promise.resolve(server.serverKeys.length === 0), "termination cleanup");
				// The third caller that kills a server outside a stop, and the only
				// coverage of it: session cleanup failed here, so the termination it
				// ran has to reach this shutdown rather than be logged and forgotten.
				// Asserted rather than swallowed — a teardown that accepts either
				// answer passes just as well with the tracking removed.
				await expect(server.shutdown()).rejects.toThrow("LSP mux shutdown incomplete");
				server = new LspMuxServer();
			}
		},
		6_000,
	);

	it.skipIf(process.platform === "win32")(
		"spawns one server per concurrent link",
		async () => {
			const first = await link();
			const second = await link();
			expect(first.connected.spawned).toBe(true);
			expect(second.connected.spawned).toBe(true);
			expect(second.connected.pid).not.toBe(first.connected.pid);

			const [firstInitialize, secondInitialize] = await Promise.all([
				initialize(first.client),
				initialize(second.client),
			]);
			const firstInfo = firstInitialize.serverInfo as { version: string };
			const secondInfo = secondInitialize.serverInfo as { version: string };
			expect(firstInfo.version).toBe(String(first.connected.pid));
			expect(secondInfo.version).toBe(String(second.connected.pid));
			expect((await state(first.client)).initializeCount).toBe(1);
			expect((await state(second.client)).initializeCount).toBe(1);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"rewrites initialize processId to the mux process",
		async () => {
			const { client } = await link();
			await initialize(client, 424242);
			expect((await state(client)).processId).toBe(process.pid);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"isolates equal request ids between sessions",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const [one, two] = await Promise.all([
				first.client.request<{ owner: string }>("test/echo", { owner: "first" }, 7),
				second.client.request<{ owner: string }>("test/echo", { owner: "second" }, 7),
			]);
			expect(one).toEqual({ owner: "first" });
			expect(two).toEqual({ owner: "second" });
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"isolates open-document overlays between concurrent sessions",
		async () => {
			const first = await link();
			const second = await link();
			expect(second.connected.pid).not.toBe(first.connected.pid);
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const uri = "file:///shared.ts";
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "first" },
			});
			second.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "second" },
			});

			await pollUntil(async () => {
				const [seenByFirst, seenBySecond] = await Promise.all([
					first.client.request<string | null>("test/documentText", { uri }),
					second.client.request<string | null>("test/documentText", { uri }),
				]);
				return seenByFirst === "first" && seenBySecond === "second";
			}, "session-specific document contents");
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"replays cached diagnostics when an idle server is reused",
		async () => {
			const first = await link();
			await initialize(first.client);
			const uri = "file:///diagnostics.ts";
			first.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "x" },
			});
			const publication = await first.client.nextNotification<PublishDiagnosticsParams>(
				"textDocument/publishDiagnostics",
			);
			expect(publication).toMatchObject({
				uri,
				version: 1,
				diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
			});

			first.client.destroy();
			await pollUntil(() => Promise.resolve(server.sessionCount === 0), "first session close");
			const second = await link();
			expect(second.connected.spawned).toBe(false);
			expect(second.connected.pid).toBe(first.connected.pid);
			await initialize(second.client);
			const replay = await second.client.nextNotification<PublishDiagnosticsParams>(
				"textDocument/publishDiagnostics",
			);
			expect(replay).toMatchObject({
				uri,
				diagnostics: [{ message: "fake", severity: 2, range: expect.any(Object) }],
			});
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"intercepts shutdown and exit for only the calling session",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			expect(await first.client.request<null>("shutdown")).toBeNull();
			const closed = first.client.waitForClose();
			first.client.notify("exit");
			await closed;
			expect(await second.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"answers muxPing before a link is bound",
		async () => {
			const client = await MuxTestClient.connect(socketPath);
			clients.push(client);
			expect(await client.request<string>(MUX_PING_METHOD)).toBe("pong");
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"restarts only the calling session's server",
		async () => {
			const first = await link();
			const second = await link();
			await Promise.all([initialize(first.client), initialize(second.client)]);
			const firstClosed = first.client.waitForClose();
			first.client.notify(MUX_RESTART_METHOD);
			await firstClosed;
			expect(await second.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });

			const replacement = await link();
			expect(replacement.connected.spawned).toBe(true);
			expect(replacement.connected.pid).not.toBe(first.connected.pid);
			expect(replacement.connected.pid).not.toBe(second.connected.pid);
		},
		10_000,
	);

	it.skipIf(process.platform === "win32")(
		"finishes orphan document closes before reusing a server",
		async () => {
			const first = await link();
			await initialize(first.client);
			const uris = Array.from({ length: 128 }, (_, index) => `file:///orphan-${index}.ts`);
			for (const uri of uris) {
				first.client.notify("textDocument/didOpen", {
					textDocument: { uri, languageId: "typescript", version: 1, text: "orphan" },
				});
			}
			await first.client.request("test/echo", { barrier: true });
			const firstClosed = first.client.waitForClose();
			first.client.destroy();
			await firstClosed;

			const second = await link();
			expect(second.connected.spawned).toBe(false);
			const uri = uris.at(-1);
			expect(uri).toBeDefined();
			await initialize(second.client);
			second.client.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "replacement" },
			});
			await second.client.request("test/echo", { barrier: true });
			expect(await second.client.request<string | null>("test/documentText", { uri })).toBe("replacement");
		},
		10_000,
	);
});
