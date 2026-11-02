import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { MessageFramer } from "../src/jsonrpc/message-framing";
import {
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_RESTART_METHOD,
	type MuxConnectParams,
	type MuxConnectResult,
} from "../src/lsp/mux/protocol";
import { LspMuxServer } from "../src/lsp/mux/server";

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
	initializationOptions: unknown;
	didOpen: Record<string, number>;
	didChange: Record<string, number[]>;
	didClose: string[];
	notifications: string[];
	workspaceFolders: string[];
}

class MuxTestClient {
	readonly #connection: IpcConnection;
	readonly #framer = new MessageFramer(Buffer.alloc(0));
	readonly #pending = new Map<
		string | number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	readonly #notifications = new Map<string, RpcMessage[]>();
	readonly #notificationWaiters = new Map<string, Array<(message: RpcMessage) => void>>();
	readonly #closed = Promise.withResolvers<void>();
	#nextId = 1;

	constructor(connection: IpcConnection) {
		this.#connection = connection;
		connection.startRaw(
			chunk => {
				this.#framer.push(chunk);
				for (const text of this.#framer.drain(() => {})) this.#receive(JSON.parse(text) as RpcMessage);
			},
			reason => {
				this.#failPending(new Error(reason ? `Mux connection closed: ${reason}` : "Mux connection closed"));
				this.#closed.resolve();
			},
		);
	}

	static async connect(endpoint: string): Promise<MuxTestClient> {
		return new MuxTestClient(await IpcConnection.connect(endpoint, { framing: "raw" }));
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

	sendRaw(bytes: Buffer): void {
		this.#connection.send(bytes);
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
		return withTimeout(this.#closed.promise, "connection close");
	}

	destroy(): void {
		this.#connection.destroy();
	}

	#write(message: RpcMessage): void {
		const json = JSON.stringify(message);
		this.#connection.send(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
	}

	#receive(message: RpcMessage): void {
		if (message.method !== undefined) {
			if (message.id !== undefined) {
				// Reply first, then queue the request so tests can await it via nextNotification.
				this.#write({ jsonrpc: "2.0", id: message.id, result: message.params });
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
	// Real IPC/subprocess integration needs a wall-clock failure watchdog; always cancel it when the event wins.
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const initializeParams = (processId = 424242, initializationOptions: unknown = {}): Record<string, unknown> => ({
	processId,
	rootUri: null,
	capabilities: {},
	initializationOptions,
});

async function initialize(
	client: MuxTestClient,
	processId = 424242,
	initializationOptions: unknown = {},
): Promise<Record<string, unknown>> {
	const result = await client.request<Record<string, unknown>>(
		"initialize",
		initializeParams(processId, initializationOptions),
	);
	client.notify("initialized", {});
	return result;
}

async function state(client: MuxTestClient): Promise<FakeState> {
	return client.request<FakeState>("test/state");
}

describe("LspMuxServer", () => {
	let server: LspMuxServer;
	let tmpDir: string;
	let endpoint: string;
	let connectParams: MuxConnectParams;
	const clients: MuxTestClient[] = [];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-mux-test-"));
		endpoint = ipcEndpoint(tmpDir, "mux");
		connectParams = { command: process.execPath, args: ["run", fixturePath], cwd: tmpDir };
		server = new LspMuxServer();
		await server.listen(endpoint);
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) client.destroy();
		await server.shutdown();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function link(params = connectParams): Promise<{ client: MuxTestClient; connected: MuxConnectResult }> {
		const client = await MuxTestClient.connect(endpoint);
		clients.push(client);
		const connected = await client.request<MuxConnectResult>(MUX_CONNECT_METHOD, params);
		return { client, connected };
	}

	it("disconnects a malformed link without terminating other sessions", async () => {
		const healthy = await link();
		await initialize(healthy.client);
		const malformed = await MuxTestClient.connect(endpoint);
		clients.push(malformed);
		const closed = malformed.waitForClose();
		malformed.sendRaw(Buffer.alloc(16 * 1024, 97));
		await closed;
		expect(await healthy.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({
			alive: true,
		});
	});

	it("spawns one server per concurrent link", async () => {
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
	}, 10_000);

	it("rewrites initialize processId to the mux process", async () => {
		const { client } = await link();
		await initialize(client, 424242);
		expect((await state(client)).processId).toBe(process.pid);
	}, 10_000);

	it("isolates equal request ids between sessions", async () => {
		const first = await link();
		const second = await link();
		await Promise.all([initialize(first.client), initialize(second.client)]);
		const [one, two] = await Promise.all([
			first.client.request<{ owner: string }>("test/echo", { owner: "first" }, 7),
			second.client.request<{ owner: string }>("test/echo", { owner: "second" }, 7),
		]);
		expect(one).toEqual({ owner: "first" });
		expect(two).toEqual({ owner: "second" });
	}, 10_000);

	it("intercepts shutdown and exit for only the calling session", async () => {
		const first = await link();
		const second = await link();
		await Promise.all([initialize(first.client), initialize(second.client)]);
		expect(await first.client.request<null>("shutdown")).toBeNull();
		const closed = first.client.waitForClose();
		first.client.notify("exit");
		await closed;
		expect(await second.client.request<{ alive: boolean }>("test/echo", { alive: true })).toEqual({ alive: true });
	}, 10_000);

	it("answers muxPing before a link is bound", async () => {
		const client = await MuxTestClient.connect(endpoint);
		clients.push(client);
		expect(await client.request<string>(MUX_PING_METHOD)).toBe("pong");
	}, 10_000);

	it("restarts only the calling session's server", async () => {
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
	}, 10_000);

	it("removes the workspace folders a session added before reusing its server", async () => {
		const first = await link();
		await initialize(first.client);
		const added = { uri: "file:///other-checkout", name: "other-checkout" };
		first.client.notify("workspace/didChangeWorkspaceFolders", { event: { added: [added], removed: [] } });
		expect((await state(first.client)).workspaceFolders).toEqual([added.uri]);
		const firstClosed = first.client.waitForClose();
		first.client.destroy();
		await firstClosed;

		const second = await link();
		expect(second.connected.spawned).toBe(false);
		await initialize(second.client);
		expect((await state(second.client)).workspaceFolders).toEqual([]);
	}, 10_000);
});
