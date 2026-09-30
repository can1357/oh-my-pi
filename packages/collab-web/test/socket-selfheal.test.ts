import { afterEach, describe, expect, it, vi } from "bun:test";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";

const NativeWebSocket = globalThis.WebSocket;
const LINK = `selfheal-room#${encodeBase64Url(new Uint8Array(32))}`;

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

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}
}

/** Minimal DOM surface: just enough add/remove/dispatch for socket self-healing. */
class FakeEventTarget {
	private handlers = new Map<string, Set<EventListener>>();
	addEventListener(type: string, handler: EventListener): void {
		let set = this.handlers.get(type);
		if (!set) this.handlers.set(type, (set = new Set()));
		set.add(handler);
	}
	removeEventListener(type: string, handler: EventListener): void {
		this.handlers.get(type)?.delete(handler);
	}
	dispatch(type: string): void {
		for (const handler of [...(this.handlers.get(type) ?? [])]) handler({ type } as Event);
	}
	handlerCount(): number {
		let total = 0;
		for (const set of this.handlers.values()) total += set.size;
		return total;
	}
}

const fakeDocument = Object.assign(new FakeEventTarget(), { visibilityState: "visible" });
const fakeWindow = new FakeEventTarget();

function installBrowserStubs(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
	Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
	Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
}

function restoreBrowserStubs(): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
	Reflect.deleteProperty(globalThis, "document");
	Reflect.deleteProperty(globalThis, "window");
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

/** bun:test's vi has no setSystemTime; advance Date.now() via a spy instead. */
function advanceClock(ms: number): void {
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + ms);
}

function goForeground(): void {
	Object.assign(fakeDocument, { visibilityState: "visible" });
	fakeDocument.dispatch("visibilitychange");
}

afterEach(() => {
	restoreBrowserStubs();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("zombie connection self-healing", () => {
	it("replaces a stale OPEN socket when the page returns to the foreground", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const client = new GuestClient(LINK, "tester");
		client.connect();
		instance(0).open();

		advanceClock(120_000); // two minutes of silence
		goForeground();

		expect(ScriptedWebSocket.instances).toHaveLength(2);
		expect(instance(0).readyState).toBe(ScriptedWebSocket.CLOSED);
		expect(instance(1).readyState).toBe(ScriptedWebSocket.CONNECTING);
		client.close();
	});

	it("keeps a fresh connection across foreground events", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const client = new GuestClient(LINK, "tester");
		client.connect();
		instance(0).open();

		advanceClock(5_000); // well under the stale threshold
		goForeground();
		fakeWindow.dispatch("online");

		expect(ScriptedWebSocket.instances).toHaveLength(1);
		expect(instance(0).readyState).toBe(ScriptedWebSocket.OPEN);
		client.close();
	});

	it("ignores healing events while a connection attempt is still pending", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const client = new GuestClient(LINK, "tester");
		client.connect(); // CONNECTING, never opened

		advanceClock(120_000);
		goForeground();
		fakeWindow.dispatch("online");
		fakeWindow.dispatch("pageshow");

		expect(ScriptedWebSocket.instances).toHaveLength(1);
		client.close();
	});

	it("is idempotent under event bursts", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const client = new GuestClient(LINK, "tester");
		client.connect();
		instance(0).open();

		advanceClock(120_000);
		goForeground();
		goForeground();
		fakeWindow.dispatch("online");
		fakeWindow.dispatch("pageshow");

		expect(ScriptedWebSocket.instances).toHaveLength(2);
		client.close();
	});

	it("forces a reconnect through the observable reconnect lifecycle", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const client = new GuestClient(LINK, "tester");
		client.connect();
		instance(0).open();

		advanceClock(120_000);
		goForeground();

		// The forced replacement must enter the ordinary reconnect lifecycle:
		// onClose(willReconnect=true) flips the client to "reconnecting" (and
		// drops the partial snapshot) until the next welcome arrives.
		expect(client.getSnapshot().phase).toBe("reconnecting");
		instance(1).open();
		client.close();
	});

	it("arms listeners on connect and re-arms them after close+connect", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const before = fakeDocument.handlerCount() + fakeWindow.handlerCount();
		const client = new GuestClient(LINK, "tester");
		// Construction alone must not subscribe; connect() owns the lifecycle.
		expect(fakeDocument.handlerCount() + fakeWindow.handlerCount()).toBe(before);

		client.connect();
		expect(fakeDocument.handlerCount() + fakeWindow.handlerCount()).toBe(before + 3); // visibilitychange + online + pageshow

		client.close();
		expect(fakeDocument.handlerCount() + fakeWindow.handlerCount()).toBe(before);

		client.connect(); // reopened client keeps healing
		expect(fakeDocument.handlerCount() + fakeWindow.handlerCount()).toBe(before + 3);
		client.close();
	});

	it("aborts the replacement when close() runs from the onClose listener", () => {
		vi.useFakeTimers();
		installBrowserStubs();
		const client = new GuestClient(LINK, "tester");
		client.connect();
		instance(0).open();
		// A snapshot subscriber closing the client from the reconnecting
		// transition must stop the socket from opening a replacement.
		const unsubscribe = client.subscribe(() => client.close());

		advanceClock(120_000);
		goForeground();

		expect(ScriptedWebSocket.instances).toHaveLength(1);
		unsubscribe();
	});
});
