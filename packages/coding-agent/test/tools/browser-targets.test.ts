import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { cdpTargets, findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as discovery from "@oh-my-pi/pi-coding-agent/tools/browser/relay/discovery";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	type TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import * as windowsDiscovery from "@oh-my-pi/pi-coding-agent/tools/browser/relay/windows-discovery";
import * as networking from "@oh-my-pi/pi-coding-agent/tools/browser/relay/wsl-networking";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { getTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const PANE = 3;

const BLOCKS = [
	{ block: 5, url: "https://docs.example/a", title: "Docs A", owner: null, shown: false, driven: false },
	{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE, shown: true, driven: true },
	{ block: 7, url: "https://docs.example/c", title: "Docs C", owner: null, shown: true, driven: false },
];

const ENV_KEYS = [
	"TERN_PANE_SOCKET",
	"TERN_PANE",
	"PI_BROWSER_TERN",
	"PI_BROWSER_RELAY",
	"PI_PANEL_RELAY_URL",
] as const;
let savedEnv: Map<string, string | undefined>;

let daemon: FakeDaemon | undefined;
let relay: RelayServer | undefined;
let extension: WebSocket | undefined;
const opened: string[] = [];

beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
});

afterEach(async () => {
	for (const name of opened.splice(0)) await releaseTab(name, { kill: false }).catch(() => undefined);
	await daemon?.close();
	daemon = undefined;
	extension?.close();
	extension = undefined;
	relay?.stop();
	relay = undefined;
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** A Tern window listing `blocks`, able to host an adoption of any of them. */
async function startWindow(blocks: readonly Record<string, unknown>[]): Promise<FakeDaemon> {
	daemon = await startFakeDaemon((op): FakeAnswer => {
		switch (op.op) {
			case "blocks":
				return { ok: { blocks } };
			case "events":
				return { ok: { events: [], next: 40, dropped: 0 } };
			case "state": {
				const block = blocks.find(entry => entry.block === op.block);
				return {
					ok: {
						url: block?.url ?? "about:blank",
						title: block?.title ?? "",
						loading: false,
						shown: true,
						width: 800,
						height: 600,
					},
				};
			}
			case "eval":
				return { ok: { value: { value: [] } } };
			default:
				return { ok: {} };
		}
	});
	process.env.TERN_PANE_SOCKET = daemon.socketPath;
	process.env.TERN_PANE = String(PANE);
	delete process.env.PI_BROWSER_TERN;
	return daemon;
}

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relay": false,
			"browser.cmux": false,
			"tools.maxTimeout": 0,
			...settings,
		}),
	};
}

async function invoke(tool: ToolSession, parameters: Record<string, unknown>) {
	const result = await createBrowserPrelude(tool).invoke(parameters, { session: tool, toolCallId: "browser-targets" });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	const value = isRecord(result.details) ? result.details.value : undefined;
	return { text, value };
}

describe("browser targets in Tern", () => {
	it("lists the window's browser blocks and names the omp tab holding an adopted one", async () => {
		await startWindow(BLOCKS);
		const tool = session();
		opened.push("docs");
		await invoke(tool, { action: "open", name: "docs", timeout: 5, target: "Docs C" });
		const { text, value } = await invoke(tool, { action: "targets", timeout: 5 });
		expect(value).toEqual([
			{ target: "5", title: "Docs A", url: "https://docs.example/a", shown: false, docked: true, driven: false },
			{ target: "6", title: "Docs B", url: "https://docs.example/b", shown: true, docked: false, driven: true },
			{
				target: "7",
				title: "Docs C",
				url: "https://docs.example/c",
				shown: true,
				docked: true,
				driven: false,
				tab: "docs",
			},
		]);
		expect(text).toStartWith("Tern browser blocks (adopt one with target set to its id):\n");
		expect(text).toContain('- 5 "Docs A" https://docs.example/a (docked, not on screen)');
		expect(text).toContain('- 7 "Docs C" https://docs.example/c (docked, on screen, driven by omp tab "docs")');
	});

	it("omits shown and driven an older Tern does not report", async () => {
		await startWindow([{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE }]);
		const { text, value } = await invoke(session(), { action: "targets", timeout: 5 });
		expect(value).toStrictEqual([{ target: "6", title: "Docs B", url: "https://docs.example/b", docked: false }]);
		expect(text).toContain("update Tern to adopt the user's own");
	});
});

describe("browser targets elsewhere", () => {
	it("explains that targets exist only inside Tern, with the relay, or at a CDP endpoint", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const failure = await invoke(session(), { action: "targets", timeout: 5 }).catch((error: unknown) => error);
		expect(String(failure)).toContain("targets exist only inside a Tern pane");
		expect(String(failure)).toContain("at a CDP endpoint");
	});

	it("lists a CDP endpoint's pages from its /json list", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		using server = Bun.serve({
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/json"
					? Response.json([
							{ id: "A", type: "page", url: "https://mail.example/", title: "Mail" },
							{ id: "B", type: "service_worker", url: "https://mail.example/sw.js", title: "sw" },
						])
					: new Response("not found", { status: 404 }),
		});
		const app = `http://127.0.0.1:${server.port}`;
		const { text, value } = await invoke(session(), { action: "targets", timeout: 5, app });
		expect(value).toStrictEqual([{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/" }]);
		expect(text).toBe(
			`Pages at ${app} (adopt one with target set to its URL or a title substring):\n- "Mail" https://mail.example/`,
		);
		// The object `app` of older releases names the same endpoint.
		const legacy = await invoke(session(), { action: "targets", timeout: 5, app: { cdp_url: app } });
		expect(legacy.value).toStrictEqual(value);
	});
});

describe("cdpTargets", () => {
	it("keeps live, non-internal pages with their URL as the target", () => {
		const entries = [
			{ id: "a", type: "page", url: "https://mail.example/", title: "Mail", active: "true", discarded: "false" },
			{ id: "b", type: "page", url: "https://docs.example/", title: "Docs", active: "false", discarded: "false" },
			{ id: "c", type: "page", url: "https://old.example/", title: "Old", active: "false", discarded: "true" },
			{ id: "d", type: "page", url: "devtools://devtools/bundled/inspector.html", title: "DevTools" },
			{ id: "e", type: "service_worker", url: "https://mail.example/sw.js", title: "sw" },
			{ id: "f", type: "page", title: "no url" },
			"garbage",
		];
		expect(cdpTargets(entries)).toEqual([
			{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/", shown: true },
			{ target: "https://docs.example/", title: "Docs", url: "https://docs.example/", shown: false },
		]);
	});
});

function snapshot(tabId: number, fields: Partial<TabSnapshot>): TabSnapshot {
	return {
		tabId,
		url: "https://example.com/",
		title: "Example",
		active: false,
		discarded: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...fields,
	};
}

/** Stands in for the relay extension: says hello with `tabs` and acknowledges every RPC. */
async function connectExtension(port: number, tabs: TabSnapshot[]): Promise<WebSocket> {
	const opened = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`);
	ws.addEventListener("open", () => {
		ws.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
				tabs,
				attachedTabIds: [],
			}),
		);
		opened.resolve(ws);
	});
	ws.addEventListener("error", () => opened.reject(new Error("extension socket failed")));
	ws.addEventListener("message", event => {
		const message: unknown = JSON.parse(String(event.data));
		if (isRecord(message) && message.t === "rpc" && typeof message.id === "number") {
			ws.send(JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} }));
		}
	});
	return await opened.promise;
}

async function windowsKind(port: number) {
	const cdpUrl = `http://127.0.0.1:${port}`;
	const info = await (await fetch(`${cdpUrl}/json/version`, { proxy: "" })).json();
	if (!isRecord(info) || typeof info.ompRelayInstance !== "string") throw new Error("No relay instance");
	return { kind: "relay" as const, cdpUrl, windowsInstance: info.ompRelayInstance };
}

describe("browser open with a mirrored WSL relay", () => {
	it("reuses the verified name but refuses a different relay, even on the same port", async () => {
		process.env.PI_BROWSER_RELAY = "1";
		const realWorker = globalThis.Worker;
		let workers = 0;
		const old = startRelayServer({ port: 0 });
		const replacement = startRelayServer({ port: 0 });
		const name = "windows-bound";
		const freshName = "windows-fresh";
		const panelName = "windows-panel";
		try {
			spyOn(networking, "getWslNetworkingMode").mockReturnValue("mirrored");
			spyOn(discovery, "discoverRelayEndpoints").mockReturnValue([]);
			const windows = spyOn(windowsDiscovery, "discoverWindowsRelay");
			// Use the real prelude, browser registry, relay and tab supervisor; only emulate the page worker.
			globalThis.Worker = class extends EventTarget {
				postMessage(message: WorkerInbound) {
					const send = (data: WorkerOutbound) => this.dispatchEvent(new MessageEvent("message", { data }));
					if (message.type === "init") {
						send({ type: "setup" });
						send({
							type: "ready",
							info: { targetId: String(++workers), url: "about:blank", viewport: { width: 800, height: 600 } },
						});
					} else if (message.type === "close") {
						queueMicrotask(() => send({ type: "closed" }));
					}
				}
				terminate() {}
			} as unknown as typeof Worker;
			await connectExtension(old.port, []);
			await connectExtension(replacement.port, []);
			const oldKind = await windowsKind(old.port);
			const replacementKind = await windowsKind(replacement.port);
			windows.mockResolvedValue(oldKind);
			const tool = session();
			const open = { action: "open", name, timeout: 3 };
			expect((await invoke(tool, open)).text).toStartWith(`Opened tab "${name}"`);
			const bound = getTab(name);
			expect(bound?.browser.kind).toEqual(oldKind);
			expect((await invoke(tool, open)).text).toStartWith(`Reused tab "${name}"`);
			expect(getTab(name)).toBe(bound);
			expect(windows).toHaveBeenCalledTimes(1);
			expect(workers).toBe(1);

			const connecting = Promise.withResolvers<never>();
			const connect = spyOn(Bun, "connect").mockImplementationOnce(() => connecting.promise);
			try {
				// A pending TCP connect must not keep the raw GET alive past its cheap-probe budget.
				await expect(invoke(tool, { ...open, timeout: 1 })).rejects.toThrow(/did not answer from WSL/);
			} finally {
				connect.mockRestore();
				void connecting.promise.catch(() => undefined);
				connecting.reject(new Error("fixture connect ended"));
			}
			expect(windows).toHaveBeenCalledTimes(2);

			old.stop();
			const requests: string[] = [];
			using _impostor = Bun.serve({
				hostname: "127.0.0.1",
				port: old.port,
				fetch(request) {
					requests.push(`${request.method} ${new URL(request.url).pathname}`);
					return Response.json({ ompRelayVersion: "1.0.0", ompRelayInstance: replacementKind.windowsInstance });
				},
			});
			await expect(invoke(tool, open)).rejects.toThrow(/bound Windows omp browser relay.*did not answer from WSL/);
			expect(windows).toHaveBeenCalledTimes(3);
			windows.mockResolvedValue(replacementKind);
			await expect(invoke(tool, open)).rejects.toThrow(/bound to a different browser/);
			expect(windows).toHaveBeenCalledTimes(4);
			expect(requests).toEqual(["GET /json/version", "GET /json/version"]);
			expect(getTab(name)).toBe(bound);
			expect(workers).toBe(1);

			expect((await invoke(tool, { ...open, name: freshName })).text).toStartWith(`Opened tab "${freshName}"`);
			expect(getTab(freshName)?.browser.kind).toEqual(replacementKind);
			// The relay discovery last verified answers its identity again: no new helper launch.
			expect(windows).toHaveBeenCalledTimes(4);

			process.env.PI_BROWSER_RELAY = "only";
			process.env.PI_PANEL_RELAY_URL = replacementKind.cdpUrl;
			const panel = session({ "browser.relayUrl": "///" });
			await expect(invoke(panel, open)).rejects.toThrow(/bound to a different browser/);
			expect((await invoke(panel, { ...open, name: panelName })).text).toStartWith(`Opened tab "${panelName}"`);
			expect(getTab(panelName)?.browser.kind).toEqual({ kind: "relay", cdpUrl: replacementKind.cdpUrl });
			expect(windows).toHaveBeenCalledTimes(4);
		} finally {
			for (const tab of [name, freshName, panelName])
				await releaseTab(tab, { keepPage: true }).catch(() => undefined);
			old.stop();
			replacement.stop();
			globalThis.Worker = realWorker;
			mock.restore();
		}
	});
});

describe("browser targets with the relay", () => {
	it("rediscovers a rotated Windows relay instead of listing the old browser", async () => {
		process.env.PI_BROWSER_RELAY = "1";
		const mode = spyOn(networking, "getWslNetworkingMode").mockReturnValue("mirrored");
		const local = spyOn(discovery, "discoverRelayEndpoints").mockReturnValue([]);
		const windows = spyOn(windowsDiscovery, "discoverWindowsRelay");
		const methods: string[] = [];
		using reused = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				methods.push(request.method);
				return Response.json({ Browser: "Chrome/151" });
			},
		});
		const hosts: RelayServer[] = [];
		try {
			local.mockReturnValueOnce([reused.url.origin]);
			const tool = session();
			for (const title of ["First", "Second"]) {
				const host = startRelayServer({ port: 0 });
				hosts.push(host); // Keep the first port allocated so the replacement cannot reuse it.
				const url = `https://example.com/${title}`;
				const peer = await connectExtension(host.port, [snapshot(1, { url, title })]);
				try {
					windows.mockResolvedValue(await windowsKind(host.port));
					const { value } = await invoke(tool, { action: "targets", app: "relay" });
					expect(value).toEqual([{ target: url, title, url, shown: false }]);
				} finally {
					peer.close();
				}
			}
			expect(methods).toEqual(["GET"]);
			await expect(invoke(session({ "browser.relayUrl": "///" }), { action: "open", app: "relay" })).rejects.toThrow(
				/configure browser\.relayUrl/,
			);
			mode.mockReturnValue("nat");
			await expect(invoke(tool, { action: "targets", app: "relay" })).rejects.toThrow(/No local omp browser relay/);
			expect(windows).toHaveBeenCalledTimes(2);
		} finally {
			for (const host of hosts) host.stop();
			windows.mockRestore();
			local.mockRestore();
			mode.mockRestore();
		}
	});

	it("lists the user's Chrome pages, skipping discarded ones", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		extension = await connectExtension(port, [
			snapshot(1, { url: "https://mail.example/", title: "Mail", active: true }),
			snapshot(2, { url: "https://docs.example/", title: "Docs" }),
			snapshot(3, { url: "https://old.example/", title: "Old", discarded: true }),
		]);
		const tool = session({ "browser.relayUrl": `http://127.0.0.1:${port}` });
		const { text, value } = await invoke(tool, { action: "targets", timeout: 10, app: "relay" });
		expect(value).toEqual([
			{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/", shown: true },
			{ target: "https://docs.example/", title: "Docs", url: "https://docs.example/", shown: false },
		]);
		expect(text).toBe(
			'Chrome pages via the relay (adopt one with target set to its URL or a title substring):\n- "Mail" https://mail.example/ (active)\n- "Docs" https://docs.example/',
		);
	}, 20_000);
});
