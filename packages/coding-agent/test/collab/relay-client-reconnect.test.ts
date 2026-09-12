import { afterEach, describe, expect, it, vi } from "bun:test";
import { CollabSocket } from "../../src/collab/relay-client";

const NativeWebSocket = globalThis.WebSocket;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	bufferedAmount = 0;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}

	send(_data: unknown): void {}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.relayClose(code, reason);
	}
}

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

function restoreNativeWebSocket(): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
}

function guestSocket(key: CryptoKey): CollabSocket {
	return new CollabSocket({
		wsUrl: "ws://localhost:8788/r/transient-network-room",
		role: "guest",
		key,
	});
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

afterEach(() => {
	restoreNativeWebSocket();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("CollabSocket guest room recovery", () => {
	it("retries a host-closed room and missing-room races until the host returns", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const closes: Array<{ reason: string; willReconnect: boolean }> = [];
		const socket = guestSocket(key);
		socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });

		try {
			socket.connect();
			instance(0).open();
			instance(0).relayClose(4001, "room closed");
			expect(closes).toEqual([{ reason: "room closed", willReconnect: true }]);

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(closes.at(-1)).toEqual({ reason: "no such room", willReconnect: true });

			vi.advanceTimersByTime(2_000);
			instance(2).open();
			expect(socket.isOpen).toBe(true);
		} finally {
			socket.close();
		}
	});

	it("keeps a missing room terminal on the initial join", async () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const closes: Array<{ reason: string; willReconnect: boolean }> = [];
		const socket = guestSocket(key);
		socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });

		socket.connect();
		instance(0).open();
		instance(0).relayClose(4004, "no such room");

		expect(closes).toEqual([{ reason: "no such room", willReconnect: false }]);
		vi.advanceTimersByTime(30_000);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});
});
