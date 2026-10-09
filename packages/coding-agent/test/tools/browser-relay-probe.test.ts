import { afterEach, describe, expect, it } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	relayExtensionNotice,
	UPDATE_RELAY_EXTENSION,
	waitForRelayExtension,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { DISCARDED_TABS_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
	discardedTabsProtocol: 1,
} as const;

const LEGACY_EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
} as const;

describe("waitForRelayExtension", () => {
	let relay: RelayServer | undefined;
	let fake: Bun.Server<undefined> | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		fake?.stop(true);
		extension = undefined;
		relay = undefined;
		fake = undefined;
	});

	it("gives up at once when nothing is listening instead of polling the dial window", async () => {
		const port = await findFreeCdpPort();
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("unreachable");
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("fails fast when the relay outlived the dial window without ever seeing an extension", async () => {
		const info: RelayUnavailableInfo = {
			ompRelayVersion: VERSION,
			error: "relay extension is not connected",
			extensionSeen: false,
			uptimeMs: 60_000,
		};
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(info, { status: 503 }),
		});
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("no-extension");
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("fails fast when the extension has been gone longer than the redial window, as after Chrome quits", async () => {
		const info: RelayUnavailableInfo = {
			error: "relay extension is not connected",
			extensionSeen: true,
			uptimeMs: 600_000,
			ompRelayVersion: VERSION,
			disconnectedMs: 120_000,
		};
		let probes = 0;
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				probes++;
				return Response.json(info, { status: 503 });
			},
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("extension-gone");
		expect(probes).toBe(1);
	});

	it("reports a stale relay before blaming an extension that has been gone past the redial window", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json(
					{
						error: "relay extension is not connected",
						extensionSeen: true,
						uptimeMs: 600_000,
						ompRelayVersion: "0.0.0-other",
						disconnectedMs: 120_000,
					},
					{ status: 503 },
				),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("outdated-relay");
	});

	it("keeps polling after a recent disconnect and fails once the redial window has passed", async () => {
		const disconnects = [1_000, 120_000];
		let probes = 0;
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				const info: RelayUnavailableInfo = {
					error: "relay extension is not connected",
					extensionSeen: true,
					uptimeMs: 600_000,
					ompRelayVersion: VERSION,
					disconnectedMs: disconnects[Math.min(probes++, disconnects.length - 1)],
				};
				return Response.json(info, { status: 503 });
			},
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("extension-gone");
		expect(probes).toBe(2);
	});

	it("rejects an already-running relay without discarded-tab metadata", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					Browser: "Chrome/151",
					"Protocol-Version": "1.3",
					"User-Agent": "test",
					"V8-Version": "",
					"WebKit-Version": "",
					webSocketDebuggerUrl: `ws://127.0.0.1:${fake!.port}/cdp`,
				}),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("outdated-relay");
	});

	it("reports a stale relay before blaming its extension, even if the capability marker matches", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					ompRelayVersion: "18.5.1",
					ompRelayDiscardedTabsProtocol: "1",
					ompExtensionDiscardedTabsProtocol: "0",
				}),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("outdated-relay");
	});

	it("accepts a compatible relay from another OMP version", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					ompRelayVersion: "18.5.1",
					ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
					ompExtensionDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
				}),
		});
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("ready");
	});

	it("identifies a stale relay before its extension connects, without waiting for the dial window", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json(
					{ error: "relay extension is not connected", extensionSeen: false, uptimeMs: 60_000 },
					{ status: 503 },
				),
		});
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("outdated-relay");
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("rejects an extension without discarded-tab snapshots, even when it has no tabs", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extension.addEventListener("open", () => extension?.send(JSON.stringify(LEGACY_EXTENSION_HELLO)), { once: true });
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("outdated-extension");
	});

	it("keeps polling a young relay and reports ready once the extension handshakes", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const wait = waitForRelayExtension(`http://127.0.0.1:${port}`);
		// The relay is serving 503 (young, no extension yet) before the extension dials in.
		expect((await fetch(`http://127.0.0.1:${port}/json/version`)).status).toBe(503);
		extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extension.addEventListener("open", () => extension?.send(JSON.stringify(EXTENSION_HELLO)), { once: true });
		expect(await wait).toBe("ready");
	});

	it("still waits for an extension that disconnected and comes back inside the redial window", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const first = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		first.addEventListener("open", () => first.send(JSON.stringify(EXTENSION_HELLO)), { once: true });
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("ready");
		const closed = Promise.withResolvers<void>();
		first.addEventListener("close", () => closed.resolve(), { once: true });
		first.close();
		await closed.promise;
		// A reaped service worker redials: the wait must hold on and succeed, not fail fast.
		const wait = waitForRelayExtension(`http://127.0.0.1:${port}`);
		const gone = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as RelayUnavailableInfo;
		expect(gone.extensionSeen).toBeTrue();
		extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extension.addEventListener("open", () => extension?.send(JSON.stringify(EXTENSION_HELLO)), { once: true });
		expect(await wait).toBe("ready");
	});
});

describe("relayExtensionNotice", () => {
	let relay: RelayServer | undefined;
	let fake: Bun.Server<undefined> | undefined;
	const extensions: WebSocket[] = [];

	afterEach(() => {
		for (const socket of extensions.splice(0)) socket.close();
		relay?.stop();
		fake?.stop(true);
		relay = undefined;
		fake = undefined;
	});

	async function startRelay(): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		return port;
	}

	/** Connects an extension and resolves once the relay has handled its hello (the pong follows it). */
	async function connectExtension(port: number, hello: object): Promise<WebSocket> {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extensions.push(socket);
		const ponged = Promise.withResolvers<void>();
		socket.addEventListener("message", event => {
			if (JSON.parse(String(event.data)).t === "pong") ponged.resolve();
		});
		socket.addEventListener(
			"open",
			() => {
				socket.send(JSON.stringify(hello));
				socket.send(JSON.stringify({ t: "ping" }));
			},
			{ once: true },
		);
		await ponged.promise;
		return socket;
	}

	it("says nothing for an extension installed by this omp", async () => {
		const port = await startRelay();
		await connectExtension(port, { ...EXTENSION_HELLO, ompVersion: VERSION });
		expect(await relayExtensionNotice(`http://127.0.0.1:${port}`)).toBeNull();
	});

	it("names the older omp that installed a protocol-compatible extension and how to update it", async () => {
		const port = await startRelay();
		await connectExtension(port, { ...EXTENSION_HELLO, ompVersion: "18.6.1" });
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("ready");
		const notice = await relayExtensionNotice(`http://127.0.0.1:${port}`);
		expect(notice).toContain("installed by omp 18.6.1");
		expect(notice).toContain(UPDATE_RELAY_EXTENSION);
	});

	it("flags an extension installed before omp stamped its version", async () => {
		const port = await startRelay();
		await connectExtension(port, EXTENSION_HELLO);
		const notice = await relayExtensionNotice(`http://127.0.0.1:${port}`);
		expect(notice).toContain("installed by an older omp");
		expect(notice).toContain(UPDATE_RELAY_EXTENSION);
	});

	it("still fails a stamped extension that lacks the relay protocol instead of only noting it", async () => {
		const port = await startRelay();
		await connectExtension(port, { ...LEGACY_EXTENSION_HELLO, ompVersion: "18.6.1" });
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("outdated-extension");
	});

	it.each([
		{ order: "the stale browser said hello first", stale: "first" },
		{ order: "the stale browser said hello last", stale: "last" },
	])("names a stale extension when another browser on the relay is current ($order)", async ({ stale }) => {
		const port = await startRelay();
		const old = { ...EXTENSION_HELLO, instanceId: "old-browser", ompVersion: "18.6.1" };
		const current = { ...EXTENSION_HELLO, instanceId: "current-browser", ompVersion: VERSION };
		for (const hello of stale === "first" ? [old, current] : [current, old]) await connectExtension(port, hello);
		expect(await relayExtensionNotice(`http://127.0.0.1:${port}`)).toContain("installed by omp 18.6.1");
	});

	it("stops naming a stale browser once it disconnects", async () => {
		const port = await startRelay();
		const old = await connectExtension(port, { ...EXTENSION_HELLO, instanceId: "old-browser", ompVersion: "18.6.1" });
		await connectExtension(port, { ...EXTENSION_HELLO, instanceId: "current-browser", ompVersion: VERSION });
		const closed = Promise.withResolvers<void>();
		old.addEventListener("close", () => closed.resolve(), { once: true });
		old.close();
		await closed.promise;
		expect(await relayExtensionNotice(`http://127.0.0.1:${port}`)).toBeNull();
	});

	it("keeps naming a connected stale browser after the current one's service worker reconnects", async () => {
		const port = await startRelay();
		const current = { ...EXTENSION_HELLO, instanceId: "current-browser", ompVersion: VERSION };
		await connectExtension(port, { ...EXTENSION_HELLO, instanceId: "old-browser", ompVersion: "18.6.1" });
		await connectExtension(port, current);
		await connectExtension(port, current);
		expect(await relayExtensionNotice(`http://127.0.0.1:${port}`)).toContain("installed by omp 18.6.1");
	});

	it("says nothing when the relay is too old to report its extension's version", async () => {
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					ompRelayVersion: "18.5.1",
					ompRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
					ompExtensionDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
				}),
		});
		expect(await relayExtensionNotice(`http://127.0.0.1:${fake.port}`)).toBeNull();
	});

	it("gives up on the read when the open's deadline passes instead of waiting out its own timeout", async () => {
		fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
		const started = performance.now();
		expect(await relayExtensionNotice(`http://127.0.0.1:${fake.port}`, AbortSignal.timeout(50))).toBeNull();
		expect(performance.now() - started).toBeLessThan(1_000);
	});
});
