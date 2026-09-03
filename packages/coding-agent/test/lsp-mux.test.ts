import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
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

async function pollUntil(check: () => Promise<boolean>, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
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
		await server.shutdown();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	async function link(): Promise<{ client: MuxTestClient; connected: MuxConnectResult }> {
		const client = await MuxTestClient.connect(socketPath);
		clients.push(client);
		const connected = await client.request<MuxConnectResult>(MUX_CONNECT_METHOD, connectParams);
		return { client, connected };
	}

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
