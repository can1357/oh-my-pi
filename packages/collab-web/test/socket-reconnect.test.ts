import { afterEach, describe, expect, it, vi } from "bun:test";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `transient-network-room#${encodeBase64Url(new Uint8Array(32))}`;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
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

	message(data: string): void {
		this.onmessage?.(new MessageEvent("message", { data }));
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

describe("browser guest room recovery", () => {
	it("stays reconnecting while a dropped host recreates the room", () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		try {
			client.connect();
			instance(0).open();
			expect(client.getSnapshot().phase).toBe("waiting");

			instance(0).message('{"t":"room-closed"}');
			expect(client.getSnapshot().phase).not.toBe("ended");
			instance(0).relayClose(4001, "room closed");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(client.getSnapshot().phase).toBe("reconnecting");

			vi.advanceTimersByTime(2_000);
			instance(2).open();
			expect(client.getSnapshot().phase).toBe("reconnecting");
		} finally {
			client.close();
		}
	});

	it("ends an initial join when the room does not exist", () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const client = new GuestClient(LINK, "tester");

		client.connect();
		instance(0).open();
		instance(0).relayClose(4004, "no such room");

		expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "no such room" });
		vi.advanceTimersByTime(30_000);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});
});
