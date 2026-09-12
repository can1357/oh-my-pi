import { afterEach, describe, expect, it } from "bun:test";
import { CollabSocket } from "../../src/collab/relay-client";

const NativeWebSocket = globalThis.WebSocket;

/** Records outbound frames and never drops a queued write on close(), so the
 * assertions isolate `CollabSocket`'s own send/close ordering rather than any
 * transport quirk. */
class RecordingWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: RecordingWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	bufferedAmount = 0;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = RecordingWebSocket.CONNECTING;
	sent: Uint8Array[] = [];

	constructor(url: string | URL) {
		this.url = String(url);
		RecordingWebSocket.instances.push(this);
	}

	send(data: Uint8Array): void {
		this.sent.push(data);
	}

	open(): void {
		this.readyState = RecordingWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	close(): void {
		if (this.readyState === RecordingWebSocket.CLOSED) return;
		this.readyState = RecordingWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code: 1000, reason: "closed" }));
	}
}

function install(): void {
	RecordingWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RecordingWebSocket });
}

function instance(index: number): RecordingWebSocket {
	const ws = RecordingWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

async function hostSocket(): Promise<CollabSocket> {
	const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
	return new CollabSocket({ wsUrl: "ws://localhost:8788/r/graceful-shutdown-room", role: "host", key });
}

afterEach(() => {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
});

describe("CollabSocket.flush", () => {
	it("closing without flushing drops a frame still queued behind the async seal", async () => {
		install();
		const socket = await hostSocket();
		socket.connect();
		instance(0).open();

		socket.send({ t: "bye", reason: "stopped sharing" });
		socket.close();
		// Await the real send chain (the socket is already closed, so flush()
		// adds no timer): the seal callback must observe the closed socket and
		// drop the frame instead of writing it.
		await socket.flush();

		expect(instance(0).sent).toHaveLength(0);
	});

	it("flush writes the queued goodbye before the socket is closed", async () => {
		install();
		const socket = await hostSocket();
		socket.connect();
		instance(0).open();

		socket.send({ t: "bye", reason: "stopped sharing" });
		await socket.flush();
		expect(instance(0).sent).toHaveLength(1);

		socket.close();
		expect(instance(0).sent).toHaveLength(1);
	});
});
