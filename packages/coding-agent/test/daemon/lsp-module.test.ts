/**
 * Contract of the daemon `lsp` module (shared language servers) and of the
 * `lsp/client.ts` connector in front of it. Each test runs a real daemon in a
 * private runtime dir and a fake stdio language server
 * (`test/fixtures/fake-language-server.ts`) that reports what it observed.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as daemonClientModule from "@oh-my-pi/pi-coding-agent/daemon/client";
import { daemonClient, isolateDaemonForSmokeTest } from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonTunnel } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { encodeMessageFrame, MessageFramer } from "@oh-my-pi/pi-coding-agent/jsonrpc/message-framing";
import { getOrCreateClient, holdSharedLsp, sendRequest, shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import {
	LSP_ACQUIRE_METHOD,
	LSP_MODULE_KIND,
	LSP_UNRESERVE_METHOD,
	type LspAcquireResult,
	type LspServerParams,
	type LspUnitParams,
	lspInstanceKey,
	MUX_SERVER_EXITED_METHOD,
	muxServerKey,
} from "@oh-my-pi/pi-coding-agent/lsp/mux/protocol";
import { Process } from "@oh-my-pi/pi-natives";
import { isEnoent, isRecord, TempDir } from "@oh-my-pi/pi-utils";

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "fake-language-server.ts");
const DAEMON_TEST_TIMEOUT_MS = 60_000;
const WAIT_MS = 15_000;

interface RpcMessage {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface FakeState {
	pid: number;
	ppid: number;
	initializeCount: number;
	open: string[];
	closed: string[];
	requestIds: Array<string | number>;
	env: { mark: string | null; daemonDir: string | null };
}

/** Result of the fake server's `fake/echo` and `fake/split` requests. */
interface EchoResult {
	value: string;
}

interface InitializeResult {
	serverInfo: { name: string; version: string };
}

/** Teardown never waits on how fast a process exits: whatever is still running is gone after this. */
function killQuietly(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already exited.
	}
}

async function until<T>(
	what: string,
	probe: () => T | undefined | Promise<T | undefined>,
	budgetMs = WAIT_MS,
): Promise<T> {
	const deadline = Date.now() + budgetMs;
	while (true) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		// Polls another process (the daemon); there is no in-process signal to await.
		await Bun.sleep(20);
	}
}

/** One client session on an attached `lsp` unit tunnel, speaking framed JSON-RPC. */
class LspSession {
	readonly messages: RpcMessage[] = [];
	readonly closed: Promise<void>;
	readonly #tunnel: DaemonTunnel;
	readonly #framer = new MessageFramer(Buffer.alloc(0));
	#nextId = 1;

	constructor(tunnel: DaemonTunnel) {
		this.#tunnel = tunnel;
		const closed = Promise.withResolvers<void>();
		this.closed = closed.promise;
		tunnel.start(
			chunk => {
				this.#framer.push(chunk);
				for (const text of this.#framer.drain(() => {})) this.messages.push(JSON.parse(text) as RpcMessage);
			},
			() => closed.resolve(),
		);
	}

	send(data: Uint8Array): void {
		this.#tunnel.send(data);
	}

	notify(method: string, params: unknown): void {
		this.send(encodeMessageFrame({ jsonrpc: "2.0", method, params }));
	}

	async request<T>(method: string, params: unknown, id: number = this.#nextId++): Promise<T> {
		this.send(encodeMessageFrame({ jsonrpc: "2.0", id, method, params }));
		const response = await this.response(id);
		if (response.error !== undefined) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
		return response.result as T;
	}

	response(id: string | number): Promise<RpcMessage> {
		return until(`response ${id}`, () => this.messages.find(m => m.id === id && m.method === undefined));
	}

	/** Full handshake; returns the `initialize` result this session saw. */
	async initialize(initializationOptions: unknown = {}): Promise<InitializeResult> {
		const result = await this.request<InitializeResult>("initialize", {
			processId: process.pid,
			rootUri: null,
			capabilities: {},
			initializationOptions,
		});
		this.notify("initialized", {});
		return result;
	}

	state(): Promise<FakeState> {
		return this.request<FakeState>("fake/state", {});
	}

	close(): void {
		this.#tunnel.close();
	}
}

let restoreDaemon: (() => Promise<void>) | undefined;
let workspace: TempDir | undefined;
let cwd = "";
const sessions: LspSession[] = [];
const watchedPids = new Set<number>();

beforeEach(async () => {
	restoreDaemon = await isolateDaemonForSmokeTest();
	workspace = TempDir.createSync("@omp-lsp-module-");
	cwd = await fs.realpath(workspace.path());
});

afterEach(async () => {
	await shutdownAll();
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) session.close();
	await restoreDaemon?.();
	restoreDaemon = undefined;
	for (const pid of watchedPids) killQuietly(pid);
	watchedPids.clear();
	await workspace?.remove();
	workspace = undefined;
});

async function daemon(): Promise<DaemonClient> {
	const client = await daemonClient();
	watchedPids.add(client.welcome.daemon.pid);
	return client;
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
	if (process.env.HOME) env.HOME = process.env.HOME;
	if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
	return { ...env, ...extra };
}

function serverParams(overrides: Partial<LspServerParams> = {}): LspServerParams {
	return { command: process.execPath, args: ["run", FIXTURE], cwd, ...overrides };
}

function acquire(client: DaemonClient, server: LspServerParams): Promise<LspAcquireResult> {
	return client.call<LspAcquireResult>(LSP_MODULE_KIND, LSP_ACQUIRE_METHOD, server);
}

/**
 * Acquire instance 0 of `server` once the daemon has noticed the previous
 * session detached; other instances acquired meanwhile are unreserved.
 */
async function acquireIdle(client: DaemonClient, server: LspServerParams): Promise<LspAcquireResult> {
	const first = lspInstanceKey(muxServerKey(server), 0);
	return until(`idle instance of ${first}`, async () => {
		const reservation = await acquire(client, server);
		if (reservation.key === first) return reservation;
		await client.call(LSP_MODULE_KIND, LSP_UNRESERVE_METHOD, reservation);
		return undefined;
	});
}

async function attach(client: DaemonClient, reservation: LspAcquireResult, params: LspUnitParams): Promise<LspSession> {
	const opened = await client.open({
		kind: LSP_MODULE_KIND,
		scope: reservation.scope,
		key: reservation.key,
		params,
	});
	const session = new LspSession(await client.attach(opened.unit.id, reservation.token));
	sessions.push(session);
	return session;
}

/** Acquire, open and attach a session to `server`; records the server pid for leak checks. */
async function connect(
	client: DaemonClient,
	server: LspServerParams,
	options: { reservation?: LspAcquireResult; spawnEnv?: Record<string, string> } = {},
): Promise<LspSession> {
	const reservation = options.reservation ?? (await acquire(client, server));
	return attach(client, reservation, { ...server, spawnEnv: options.spawnEnv ?? baseEnv(server.env) });
}

async function trackedState(session: LspSession): Promise<FakeState> {
	const state = await session.state();
	watchedPids.add(state.pid);
	return state;
}

describe("daemon lsp module", () => {
	test(
		"a second sequential session reuses the idle server and gets the cached initialize result without a second initialize reaching it",
		async () => {
			const client = await daemon();
			const server = serverParams();
			const first = await connect(client, server);
			const firstInit = await first.initialize();
			const firstState = await trackedState(first);
			first.close();

			const second = await connect(client, server, { reservation: await acquireIdle(client, server) });
			const secondInit = await second.initialize();
			const secondState = await second.state();

			expect(secondInit).toEqual(firstInit);
			expect(secondState.pid).toBe(firstState.pid);
			expect(secondState.initializeCount).toBe(1);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"two concurrent sessions with the same server identity get two server processes",
		async () => {
			const client = await daemon();
			const server = serverParams();
			const firstReservation = await acquire(client, server);
			const secondReservation = await acquire(client, server);
			expect(secondReservation.key).not.toBe(firstReservation.key);

			const first = await connect(client, server, { reservation: firstReservation });
			const second = await connect(client, server, { reservation: secondReservation });
			await Promise.all([first.initialize(), second.initialize()]);
			const [a, b] = await Promise.all([trackedState(first), trackedState(second)]);

			expect(a.pid).not.toBe(b.pid);
			expect([a.initializeCount, b.initializeCount]).toEqual([1, 1]);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	const identityRows: Array<{ name: string; a: Partial<LspServerParams>; b: Partial<LspServerParams> }> = [
		{ name: "env overlay", a: { env: { FAKE_LS_FLAVOR: "a" } }, b: { env: { FAKE_LS_FLAVOR: "b" } } },
		{
			name: "initializationOptions",
			a: { initializationOptions: { flavor: "a" } },
			b: { initializationOptions: { flavor: "b" } },
		},
	];
	for (const row of identityRows) {
		test(
			`a different ${row.name} never reuses an idle server started with another`,
			async () => {
				const client = await daemon();
				const serverA = serverParams(row.a);
				const serverB = serverParams(row.b);
				const first = await connect(client, serverA);
				await first.initialize(serverA.initializationOptions);
				const firstState = await trackedState(first);
				first.close();

				const second = await connect(client, serverB);
				await second.initialize(serverB.initializationOptions);
				const secondState = await trackedState(second);

				expect(secondState.pid).not.toBe(firstState.pid);
				expect(secondState.initializeCount).toBe(1);
			},
			DAEMON_TEST_TIMEOUT_MS,
		);
	}

	test(
		"documents a session opened are closed on the server when that session disconnects",
		async () => {
			const client = await daemon();
			const server = serverParams();
			const uri = `file://${path.join(cwd, "a.ts")}`;
			const first = await connect(client, server);
			await first.initialize();
			first.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: "typescript", version: 1, text: "let a = 1;\n" },
			});
			expect((await trackedState(first)).open).toEqual([uri]);
			first.close();

			const second = await connect(client, server, { reservation: await acquireIdle(client, server) });
			await second.initialize();
			const state = await second.state();

			expect(state.open).toEqual([]);
			expect(state.closed).toEqual([uri]);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a late answer to a departed session's request id never reaches the next session using the same id",
		async () => {
			const client = await daemon();
			const server = serverParams();
			const first = await connect(client, server);
			await first.initialize();
			first.send(
				encodeMessageFrame({ jsonrpc: "2.0", id: 50, method: "fake/echo", params: { value: "first", hold: true } }),
			);
			await trackedState(first);
			first.close();

			const second = await connect(client, server, { reservation: await acquireIdle(client, server) });
			await second.initialize();
			expect(await second.request<EchoResult>("fake/echo", { value: "second" }, 50)).toEqual({ value: "second" });
			// Release the departed session's held request, then wait until the server answered it.
			second.notify("fake/release", {});
			await second.request("fake/drain", {});
			const state = await second.state();

			const answers = second.messages.filter(m => m.id === 50 && m.method === undefined);
			expect(answers.map(m => m.result)).toEqual([{ value: "second" }]);
			expect(new Set(state.requestIds).size).toBe(state.requestIds.length);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a server exit delivers omp/muxServerExited with the exit code and the next acquire starts a fresh server",
		async () => {
			const client = await daemon();
			const server = serverParams();
			const first = await connect(client, server);
			await first.initialize();
			const firstState = await trackedState(first);
			first.notify("fake/exit", { code: 3 });

			const exited = await until("exit notification", () =>
				first.messages.find(m => m.method === MUX_SERVER_EXITED_METHOD),
			);
			expect(exited.params).toMatchObject({ code: 3 });
			await first.closed;

			const second = await connect(client, server, { reservation: await acquireIdle(client, server) });
			const secondInit = await second.initialize();
			const secondState = await trackedState(second);

			expect(secondState.pid).not.toBe(firstState.pid);
			expect(secondInit.serverInfo.version).toBe(String(secondState.pid));
			expect(secondState.initializeCount).toBe(1);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"the server is spawned with the client-supplied environment, never the daemon's",
		async () => {
			const client = await daemon();
			const session = await connect(client, serverParams(), {
				spawnEnv: baseEnv({ FAKE_LS_MARK: "from-client" }),
			});
			await session.initialize();
			const state = await trackedState(session);

			expect(state.ppid).toBe(client.welcome.daemon.pid);
			expect(state.env).toEqual({ mark: "from-client", daemonDir: null });
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"Content-Length frames split across chunk boundaries are reassembled in both directions",
		async () => {
			const client = await daemon();
			const session = await connect(client, serverParams());
			await session.initialize();
			watchedPids.add((await session.state()).pid);

			const request = encodeMessageFrame({
				jsonrpc: "2.0",
				id: 70,
				method: "fake/echo",
				params: { value: "joined" },
			});
			const cut = request.indexOf("\r\n\r\n") + 7;
			// Real pauses: the daemon must read each slice as its own socket chunk.
			session.send(request.subarray(0, 9));
			await Bun.sleep(30);
			session.send(request.subarray(9, cut));
			await Bun.sleep(30);
			session.send(request.subarray(cut));
			expect((await session.response(70)).result).toEqual({ value: "joined" });

			expect(await session.request<EchoResult>("fake/split", { value: "server-split" })).toEqual({
				value: "server-split",
			});
		},
		DAEMON_TEST_TIMEOUT_MS,
	);
});

describe("lsp client shared-server connector", () => {
	let hold: { set(enabled: boolean): void; release(): void } | undefined;
	const fixtureConfig = { command: process.execPath, args: ["run", FIXTURE], fileTypes: [".ts"], rootMarkers: [] };

	beforeEach(() => {
		hold = holdSharedLsp(true);
	});

	afterEach(() => {
		hold?.release();
		hold = undefined;
	});

	test(
		"with a daemon advertising the lsp module the language server runs under the daemon",
		async () => {
			const client = await daemon();
			const lsp = await getOrCreateClient(fixtureConfig, cwd, 20_000);
			const state = (await sendRequest(lsp, "fake/state", {}, undefined, 10_000)) as FakeState;
			watchedPids.add(state.pid);

			expect(state.ppid).toBe(client.welcome.daemon.pid);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	for (const shared of [true, false]) {
		test(
			`a timed-out ${shared ? "shared" : "private"} LSP startup reaps its launcher and descendant`,
			async () => {
				hold?.set(shared);
				const owner = shared ? (await daemon()).welcome.daemon.pid : process.pid;
				const marker = path.join(cwd, "launcher.json");
				const launcher = `
					const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], {
						stdin: "ignore", stdout: "inherit", stderr: "inherit"
					});
					await Bun.write(${JSON.stringify(marker)}, JSON.stringify({
						pid: process.pid, ppid: process.ppid, child: child.pid
					}));
					await child.exited;
				`;
				const config = {
					...fixtureConfig,
					command: "broken-launcher",
					resolvedCommand: process.execPath,
					args: ["-e", launcher],
				};
				// The real launcher and daemon run in other processes; fake clocks cannot drive their exits.
				const result = (
					shared
						? getOrCreateClient(config, cwd, 2_000)
						: getOrCreateClient(config, cwd, undefined, AbortSignal.timeout(2_000))
				).catch((error: unknown) => error);
				const record = await until("launcher PID record", async () => {
					const text = await Bun.file(marker)
						.text()
						.catch((error: unknown) => {
							if (isEnoent(error)) return "";
							throw error;
						});
					if (!text.endsWith("}")) return undefined;
					const record: unknown = JSON.parse(text);
					if (!isRecord(record)) throw new Error("Expected launcher and descendant PIDs");
					const { pid, ppid, child } = record;
					if (typeof pid !== "number" || typeof ppid !== "number" || typeof child !== "number") {
						throw new Error("Expected launcher and descendant PIDs");
					}
					return { pid, ppid, child };
				});
				watchedPids.add(record.pid);
				watchedPids.add(record.child);
				expect(record.ppid).toBe(owner);
				const error = await result;
				if (!(error instanceof Error)) throw new Error("Expected the startup to fail");
				expect(error.message).toContain(process.execPath);
				expect(error.message).toMatch(/timed out/i);

				await until(
					"launcher and descendant to exit",
					() => [record.pid, record.child].every(pid => Process.fromPid(pid)?.status() !== "running") || undefined,
					3_000,
				);
			},
			DAEMON_TEST_TIMEOUT_MS,
		);
	}

	test(
		"a daemon without the lsp capability makes the client spawn the server itself instead of acquiring",
		async () => {
			const calls: string[] = [];
			const stub = {
				welcome: { v: 1, daemon: { pid: 1, build: "stub", startedAt: 0 }, caps: {} },
				call: async (module: string, method: string) => {
					calls.push(`${module}.${method}`);
					throw new Error("stub daemon has no lsp module");
				},
			} as unknown as DaemonClient;
			vi.spyOn(daemonClientModule, "daemonClient").mockResolvedValue(stub);

			const lsp = await getOrCreateClient(fixtureConfig, cwd, 20_000);
			const state = (await sendRequest(lsp, "fake/state", {}, undefined, 10_000)) as FakeState;
			watchedPids.add(state.pid);

			expect(state.ppid).toBe(process.pid);
			expect(calls).toEqual([]);
		},
		DAEMON_TEST_TIMEOUT_MS,
	);

	test(
		"a failed shared open releases its reservation so the next acquire reuses instance 0",
		async () => {
			const client = await daemon();
			const missing = path.join(cwd, "no-such-language-server");
			const config = { command: missing, args: [], fileTypes: [".ts"], rootMarkers: [] };
			await expect(getOrCreateClient(config, cwd, 20_000)).rejects.toThrow();

			// The connector keys the server exactly like this: no lspmux env, `{}` initialization options.
			const server: LspServerParams = { command: missing, args: [], cwd, initializationOptions: {} };
			const reservation = await acquireIdle(client, server);
			expect(reservation.key).toBe(muxServerKey(server));
		},
		DAEMON_TEST_TIMEOUT_MS,
	);
});
