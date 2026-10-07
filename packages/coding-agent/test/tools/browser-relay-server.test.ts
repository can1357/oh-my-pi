import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { TabSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

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

async function connectExtension(port: number, tabs: TabSnapshot[] = []): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.addEventListener(
		"open",
		() => {
			ws.send(JSON.stringify({ ...EXTENSION_HELLO, tabs }));
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
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
	});

	async function startReadyRelay(tabs: TabSnapshot[] = []): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		extension = await connectExtension(port, tabs);
		await waitForDiscovery(port);
		return port;
	}

	it("binds actual Puppeteer bootstrap and navigation to the selected relay websocket target", async () => {
		const snapshots: TabSnapshot[] = [1, 2].map(tabId => ({
			tabId,
			url: `https://example.test/${tabId}`,
			title: "Same profile title",
			active: tabId === 1,
			discarded: false,
			windowId: 1,
			pinned: false,
			groupId: -1,
		}));
		const port = await startReadyRelay(snapshots);
		const requests: Array<{ op: string; tabId?: number; method?: string }> = [];
		extension!.addEventListener("message", event => {
			const request = JSON.parse(String(event.data));
			if (request.t !== "rpc") return;
			requests.push(request);
			extension!.send(JSON.stringify({ t: "rpcResult", id: request.id, ok: true, result: {} }));
		});
		const entries = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{
			id: string;
			url: string;
		}>;
		const selectedTargetId = entries.find(entry => entry.url.endsWith("/2"))!.id;
		const selected = await acquireBrowser(
			{ kind: "relay", cdpUrl: `http://127.0.0.1:${port}`, selectedTargetId },
			{ cwd: process.cwd() },
		);
		try {
			if (!("browser" in selected)) throw new Error("Expected a Puppeteer relay connection");
			expect(new URL(selected.browser.wsEndpoint()).searchParams.get("targetId")).toBe(selectedTargetId);
			const pageTargets = selected.browser.targets().filter(target => target.type() === "page");
			expect(pageTargets).toHaveLength(1);
			expect(pageTargets[0]!.url()).toBe("https://example.test/2");
			const session = await pageTargets[0]!.createCDPSession();
			await session.send("Page.navigate", { url: "https://task.test/" });
			await session.detach();
			expect(requests.filter(request => request.op === "attach").map(request => request.tabId)).toEqual([2]);
			expect(requests.filter(request => request.method === "Page.navigate").map(request => request.tabId)).toEqual([
				2,
			]);
			expect(requests.some(request => request.tabId === 1)).toBe(false);
			const unavailable = await fetch(`http://127.0.0.1:${port}/cdp?targetId=PAGEremoved.999`);
			expect(unavailable.status).toBe(409);
		} finally {
			await releaseBrowser(selected, { kill: false });
		}
	});

	it("advertises the requested Host authority so a remote Puppeteer client dials the relay", async () => {
		const port = await startReadyRelay();
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
});
