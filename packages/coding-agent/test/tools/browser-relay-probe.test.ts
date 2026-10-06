import { afterEach, describe, expect, it } from "bun:test";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
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
