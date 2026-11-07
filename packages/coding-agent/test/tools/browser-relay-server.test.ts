import { afterEach, describe, expect, it, vi } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { relayCdpClientsOf } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import * as natives from "@oh-my-pi/pi-natives";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	discardedTabsProtocol: 1,
	tabs: [],
	attachedTabIds: [],
} as const;

async function rawGet(port: number, requestBytes: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.write(requestBytes);
			},
			data(_socket, chunk) {
				response += chunk.toString("latin1");
			},
			error(_socket, error) {
				reject(error);
			},
			close() {
				resolve(response);
			},
		},
	});
	return promise;
}

function decodeChunkedBody(body: string): string {
	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const lengthText = body.slice(offset, lineEnd).split(";", 1)[0]!;
		const length = Number.parseInt(lengthText, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return decoded;
		if (body.length < offset + length + 2) throw new Error("Invalid chunked response: truncated chunk");
		decoded += body.slice(offset, offset + length);
		offset += length;
		if (body.slice(offset, offset + 2) !== "\r\n")
			throw new Error("Invalid chunked response: missing chunk terminator");
		offset += 2;
	}
}

function parseVersion(response: string): Record<string, string> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	return JSON.parse(/\r\ntransfer-encoding:\s*chunked\b/i.test(headers) ? decodeChunkedBody(body) : body) as Record<
		string,
		string
	>;
}

async function connectExtension(port: number): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.addEventListener(
		"open",
		() => {
			ws.send(JSON.stringify(EXTENSION_HELLO));
			resolve(ws);
		},
		{ once: true },
	);
	ws.addEventListener("error", () => reject(new Error("Extension socket failed to connect")), { once: true });
	return promise;
}

async function waitForDiscovery(port: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		if (response.status === 200) return;
	}
	throw new Error("Relay discovery endpoint did not become ready");
}

describe("browser relay discovery endpoint", () => {
	const savedKeepFront = process.env.PI_BROWSER_RELAY_KEEP_FRONT;
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
		vi.restoreAllMocks();
		if (savedKeepFront === undefined) delete process.env.PI_BROWSER_RELAY_KEEP_FRONT;
		else process.env.PI_BROWSER_RELAY_KEEP_FRONT = savedKeepFront;
	});

	async function startReadyRelay(): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		return port;
	}

	it("advertises the requested Host authority so a remote Puppeteer client dials the relay", async () => {
		process.env.PI_BROWSER_RELAY_KEEP_FRONT = "1";
		const lookups = vi.spyOn(natives, "macOSLoopbackPeerApp").mockResolvedValue(null);
		const serve = vi.spyOn(Bun, "serve");
		relay = startRelayServer({ port: 0 });
		const server = serve.mock.results[0]!.value as Bun.Server<unknown>;
		const requestIP = server.requestIP.bind(server);
		const acceptedPeers: Bun.SocketAddress[] = [];
		vi.spyOn(server, "requestIP").mockImplementation(req => {
			const peer = requestIP(req);
			if (peer) acceptedPeers.push(peer);
			return peer;
		});
		const port = server.port!;
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		expect(acceptedPeers).toHaveLength(1);
		const peer = acceptedPeers[0]!;
		expect(peer.address).toBe("127.0.0.1");
		if (process.platform === "darwin") {
			expect(lookups).toHaveBeenCalledTimes(1);
			expect(lookups).toHaveBeenCalledWith("127.0.0.1", port, peer.address, peer.port);
		} else {
			expect(lookups).not.toHaveBeenCalled();
		}
		const response = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe("ws://100.100.92.97:12803/cdp");
	});

	it("uses the loopback discovery URL when an HTTP/1.0 request has no Host header", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.0\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("uses the loopback discovery URL when Host is empty", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("uses the loopback discovery URL when Host would produce an unusable WebSocket authority", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	it("reports 503 with extensionSeen=false while no extension has ever handshaken", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		expect(response.status).toBe(503);
		const info = (await response.json()) as RelayUnavailableInfo;
		expect(info.extensionSeen).toBeFalse();
		expect(info.uptimeMs).toBeGreaterThanOrEqual(0);
	});

	it("keeps extensionSeen=true across an extension disconnect so clients wait for the service-worker revival", async () => {
		const port = await startReadyRelay();
		extension!.close();
		const deadline = Date.now() + 1_000;
		let response = await fetch(`http://127.0.0.1:${port}/json/version`);
		while (response.status !== 503 && Date.now() < deadline) {
			response = await fetch(`http://127.0.0.1:${port}/json/version`);
		}
		expect(response.status).toBe(503);
		const info = (await response.json()) as RelayUnavailableInfo;
		expect(info.extensionSeen).toBeTrue();
		// Clients measure the redial window from the disconnect.
		expect(info.disconnectedMs).toBeGreaterThanOrEqual(0);
	});

	it("reports how many CDP clients are connected, both while waiting for the extension and once ready", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const discovery = async () => {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			const body: unknown = await response.json();
			return {
				status: response.status,
				clients: typeof body === "object" && body !== null ? relayCdpClientsOf(body) : null,
			};
		};
		expect(await discovery()).toEqual({ status: 503, clients: 0 });
		const client = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
		const opened = Promise.withResolvers<void>();
		client.addEventListener("open", () => opened.resolve(), { once: true });
		await opened.promise;
		expect(await discovery()).toEqual({ status: 503, clients: 1 });
		extension = await connectExtension(port);
		await waitForDiscovery(port);
		expect(await discovery()).toEqual({ status: 200, clients: 1 });
		client.close();
		const deadline = Date.now() + 1_000;
		let after = await discovery();
		while (after.clients !== 0 && Date.now() < deadline) after = await discovery();
		expect(after).toEqual({ status: 200, clients: 0 });
	});
});

describe("browser relay with PI_BROWSER_RELAY_KEEP_FRONT=0", () => {
	const saved = process.env.PI_BROWSER_RELAY_KEEP_FRONT;
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
		vi.restoreAllMocks();
		if (saved === undefined) delete process.env.PI_BROWSER_RELAY_KEEP_FRONT;
		else process.env.PI_BROWSER_RELAY_KEEP_FRONT = saved;
	});

	// Only macOS looks up the browser behind an extension socket, to send the user's keys back from it.
	it.skipIf(process.platform !== "darwin")(
		"never looks up the browser behind a connecting extension, so no key reroute is set up",
		async () => {
			const lookups = vi.spyOn(natives, "macOSLoopbackPeerApp").mockResolvedValue(null);
			process.env.PI_BROWSER_RELAY_KEEP_FRONT = "0";
			const port = await findFreeCdpPort();
			relay = startRelayServer({ port });
			extension = await connectExtension(port);
			await waitForDiscovery(port);
			expect(lookups).not.toHaveBeenCalled();
		},
	);
});
