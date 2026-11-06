import { afterEach, describe, expect, it } from "bun:test";
import { generateRoomKey, importRoomKey } from "../../src/collab/crypto";
import { CollabSocket } from "../../src/collab/relay-client";

const NativeWebSocket = globalThis.WebSocket;

function installWebSocket(value: unknown): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value });
}

/** Records each constructed socket; never connects. */
class RecordingWebSocket {
	static readonly OPEN = 1;
	static instances: { url: string; options: Bun.WebSocketOptions | undefined }[] = [];
	binaryType = "arraybuffer";
	readyState = 0;
	onclose: ((event: CloseEvent) => void) | null = null;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(url: string, options?: Bun.WebSocketOptions) {
		RecordingWebSocket.instances.push({ url, options });
	}

	addEventListener(): void {}
	close(): void {}
}

describe("CollabSocket connect headers", () => {
	let server: Bun.Server<undefined> | undefined;
	const sockets: CollabSocket[] = [];

	afterEach(() => {
		for (const socket of sockets.splice(0)) socket.close();
		server?.stop(true);
		server = undefined;
		installWebSocket(NativeWebSocket);
		RecordingWebSocket.instances = [];
	});

	it("sends fresh headers on the first connect and on every reconnect", async () => {
		const upgrades: (string | null)[] = [];
		const secondUpgrade = Promise.withResolvers<void>();
		server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				upgrades.push(req.headers.get("authorization"));
				if (upgrades.length === 2) secondUpgrade.resolve();
				return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
			},
			websocket: {
				message() {},
				// The first connection drops like a relay restart (transient close).
				open(ws) {
					if (upgrades.length === 1) ws.close(1011, "restart");
				},
			},
		});
		const urls: string[] = [];
		let issued = 0;
		const socket = new CollabSocket({
			wsUrl: `ws://localhost:${server.port}/r/headersRoom01`,
			role: "guest",
			key: await importRoomKey(generateRoomKey()),
			connectHeaders: async url => {
				urls.push(url);
				return { Authorization: `Bearer token-${++issued}` };
			},
		});
		sockets.push(socket);
		socket.connect();
		await secondUpgrade.promise;

		expect(upgrades).toEqual(["Bearer token-1", "Bearer token-2"]);
		expect(urls).toEqual([
			`ws://localhost:${server.port}/r/headersRoom01?role=guest`,
			`ws://localhost:${server.port}/r/headersRoom01?role=guest`,
		]);
	});

	it("opens no socket when close() runs while the headers are pending", async () => {
		installWebSocket(RecordingWebSocket);
		const pending = Promise.withResolvers<Record<string, string> | undefined>();
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/pendingRoom01",
			role: "host",
			key: await importRoomKey(generateRoomKey()),
			connectHeaders: () => pending.promise,
		});
		const closes: string[] = [];
		socket.onClose = reason => closes.push(reason);
		socket.connect();
		socket.close();
		pending.resolve({ Authorization: "Bearer late" });
		// One macrotask: the header continuation has run by now.
		await Bun.sleep(0);

		expect(RecordingWebSocket.instances).toEqual([]);
		expect(closes).toEqual(["closed"]);
	});

	it("fires onConnecting only once the headers resolve and the socket exists", async () => {
		installWebSocket(RecordingWebSocket);
		const pending = Promise.withResolvers<Record<string, string> | undefined>();
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/slowHeaders01",
			role: "host",
			key: await importRoomKey(generateRoomKey()),
			connectHeaders: () => pending.promise,
		});
		sockets.push(socket);
		const socketsAtConnecting: number[] = [];
		socket.onConnecting = () => socketsAtConnecting.push(RecordingWebSocket.instances.length);
		socket.connect();
		await Bun.sleep(0);
		expect(socketsAtConnecting).toEqual([]);

		pending.resolve({ Authorization: "Bearer slow" });
		await Bun.sleep(0);
		expect(socketsAtConnecting).toEqual([1]);
	});

	it("connects without the headers when the provider rejects", async () => {
		installWebSocket(RecordingWebSocket);
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/rejectRoom01",
			role: "guest",
			key: await importRoomKey(generateRoomKey()),
			connectHeaders: async () => {
				throw new Error("token refresh failed");
			},
		});
		sockets.push(socket);
		socket.connect();
		await Bun.sleep(0);

		expect(RecordingWebSocket.instances.map(instance => instance.options?.headers)).toEqual([undefined]);
	});

	it("ends the socket through onClose when the transport constructor throws after the headers", async () => {
		installWebSocket(
			class {
				constructor() {
					throw new Error("transport setup failed");
				}
			},
		);
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/throwRoom01",
			role: "guest",
			key: await importRoomKey(generateRoomKey()),
			connectHeaders: async () => ({ Authorization: "Bearer x" }),
		});
		const closed = Promise.withResolvers<{ reason: string; willReconnect: boolean }>();
		socket.onClose = (reason, willReconnect) => closed.resolve({ reason, willReconnect });
		socket.connect();

		expect(await closed.promise).toEqual({
			reason: "could not open relay connection: transport setup failed",
			willReconnect: false,
		});
	});
});
