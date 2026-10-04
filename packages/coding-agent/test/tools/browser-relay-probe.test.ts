import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
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
});
