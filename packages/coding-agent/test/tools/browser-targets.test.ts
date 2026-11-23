import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude, resolveBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { cdpTargets, findFreeCdpPort, findRelayForTarget } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	type TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { type TabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getBrowserRelayInstallRegistryFile } from "@oh-my-pi/pi-utils/dirs";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const PANE = 3;

const BLOCKS = [
	{ block: 5, url: "https://docs.example/a", title: "Docs A", owner: null, shown: false, driven: false },
	{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE, shown: true, driven: true },
	{ block: 7, url: "https://docs.example/c", title: "Docs C", owner: null, shown: true, driven: false },
];

const ENV_KEYS = ["TERN_PANE_SOCKET", "TERN_PANE", "PI_BROWSER_TERN", "PI_BROWSER_RELAY"] as const;
let savedEnv: Map<string, string | undefined>;

let daemon: FakeDaemon | undefined;
let relay: RelayServer | undefined;
let extension: WebSocket | undefined;
const opened: string[] = [];

beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
});

afterEach(async () => {
	for (const name of opened.splice(0)) await tabSupervisor.releaseTab(name, { kill: false }).catch(() => undefined);
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

describe("browser targets with the relay", () => {
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

describe("browser targets with a relay per Chrome profile", () => {
	/**
	 * Two relay hosts under a home of their own, as the extensions of two Chrome profiles serve them: `older` started
	 * first and `newer` last, so a new tab goes to `newer`. Without the change a page of `older` is invisible.
	 */
	async function startRelayProfiles(
		olderTabs: TabSnapshot[],
		newerTabs: TabSnapshot[],
	): Promise<{ cleanup(): Promise<void>; newer: string; older: string }> {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-profiles-"));
		const homedir = spyOn(os, "homedir").mockReturnValue(home);
		const olderPort = await findFreeCdpPort();
		const older = startRelayServer({ port: olderPort });
		const olderExtension = await connectExtension(olderPort, olderTabs);
		const newerPort = await findFreeCdpPort();
		const newer = startRelayServer({ port: newerPort });
		const newerExtension = await connectExtension(newerPort, newerTabs);
		const endpoints = path.join(path.dirname(getBrowserRelayInstallRegistryFile()), "endpoints");
		await fs.mkdir(endpoints, { recursive: true });
		await Bun.write(path.join(endpoints, `${process.pid}-${newerPort}`), "");
		await Bun.write(path.join(endpoints, `${process.pid}-${olderPort}`), "");
		// Discovery prefers the host whose endpoint file changed last: date the older host's a minute back.
		const minuteAgo = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(endpoints, `${process.pid}-${olderPort}`), minuteAgo, minuteAgo);
		return {
			newer: `http://127.0.0.1:${newerPort}`,
			older: `http://127.0.0.1:${olderPort}`,
			async cleanup() {
				olderExtension.close();
				newerExtension.close();
				older.stop();
				newer.stop();
				homedir.mockRestore();
				await fs.rm(home, { recursive: true, force: true });
			},
		};
	}

	it("lists the pages of every relay, each tagged with it, when several Chrome profiles run the extension", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const relays = await startRelayProfiles(
			[snapshot(1, { url: "https://mail.example/", title: "Mail", active: true })],
			[snapshot(2, { url: "https://docs.example/", title: "Docs" })],
		);
		try {
			const { text, value } = await invoke(session(), { action: "targets", timeout: 10, app: "relay" });
			expect(value).toEqual([
				{
					target: "https://docs.example/",
					title: "Docs",
					url: "https://docs.example/",
					shown: false,
					relay: relays.newer,
				},
				{
					target: "https://mail.example/",
					title: "Mail",
					url: "https://mail.example/",
					shown: true,
					relay: relays.older,
				},
			]);
			expect(text).toStartWith("Chrome pages via the relay. 2 relays are running, one per Chrome profile");
			expect(text).toContain(`- relay ${relays.newer} (new tabs open here)`);
			expect(text.indexOf('- "Docs" https://docs.example/')).toBeLessThan(text.indexOf(`- relay ${relays.older}`));
			expect(text).toContain(`- relay ${relays.older}`);
			expect(text.endsWith('- "Mail" https://mail.example/ (active)')).toBe(true);
			// A relay named by `app` lists its own pages alone, in the one-relay shape.
			const bound = await invoke(session(), { action: "targets", timeout: 10, app: relays.older });
			expect(bound.value).toEqual([
				{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/", shown: true },
			]);
		} finally {
			await relays.cleanup();
		}
	}, 20_000);

	it("finds the relay that has the page a target names, past one that does not answer", async () => {
		const relays = await startRelayProfiles(
			[snapshot(1, { url: "https://mail.example/", title: "Mail" })],
			[snapshot(2, { url: "https://docs.example/", title: "Docs" })],
		);
		try {
			expect(await findRelayForTarget([relays.newer, relays.older], "Mail")).toBe(relays.older);
			expect(await findRelayForTarget([relays.newer, relays.older], "docs.example")).toBe(relays.newer);
			expect(await findRelayForTarget([relays.newer, "http://127.0.0.1:9", relays.older], "Mail")).toBe(
				relays.older,
			);
			expect(await findRelayForTarget([relays.newer, relays.older], "nowhere.example")).toBeNull();
		} finally {
			await relays.cleanup();
		}
	}, 20_000);

	it("adopts the live page when an earlier relay's match is discarded or internal", async () => {
		const relays = await startRelayProfiles(
			[
				snapshot(1, { url: "https://mail.example/", title: "Mail", discarded: true }),
				snapshot(3, { url: "devtools://devtools/bundled/inspector.html", title: "Docs" }),
			],
			[
				snapshot(2, { url: "https://mail.example/", title: "Mail" }),
				snapshot(4, { url: "https://docs.example/", title: "Docs" }),
			],
		);
		try {
			// The discarded and devtools pages are listed first, so a check that counts them picks the wrong relay.
			expect(await findRelayForTarget([relays.older, relays.newer], "Mail")).toBe(relays.newer);
			expect(await findRelayForTarget([relays.older, relays.newer], "Docs")).toBe(relays.newer);
		} finally {
			await relays.cleanup();
		}
	}, 20_000);

	it("drives the relay an app URL names and attaches to any other CDP URL", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const relays = await startRelayProfiles([], []);
		try {
			expect(resolveBrowserKind({ action: "open", app: `${relays.newer}/` }, session())).toEqual({
				kind: "relay",
				cdpUrl: relays.newer,
			});
			// `localhost` and `127.0.0.1` name the same live relay.
			const localhost = relays.newer.replace("127.0.0.1", "localhost");
			expect(resolveBrowserKind({ action: "open", app: localhost }, session())).toEqual({
				kind: "relay",
				cdpUrl: localhost,
			});
			expect(resolveBrowserKind({ action: "open", app: "http://127.0.0.1:9222" }, session())).toEqual({
				kind: "connected",
				cdpUrl: "http://127.0.0.1:9222",
			});
			// PI_BROWSER_RELAY=0 stays the kill switch for a relay named by URL.
			expect(
				resolveBrowserKind({ action: "open", app: relays.newer }, session(), { PI_BROWSER_RELAY: "0" }),
			).toEqual({ kind: "connected", cdpUrl: relays.newer });
		} finally {
			await relays.cleanup();
		}
		// A configured browser.relayUrl names its relay without any running host to discover.
		expect(
			resolveBrowserKind({ action: "open", app: relays.older }, session({ "browser.relayUrl": relays.older })),
		).toEqual({ kind: "relay", cdpUrl: relays.older });
	}, 20_000);

	it("reopens a tab adopted from an older relay on that relay unless app is a relay URL", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const relays = await startRelayProfiles([], []);
		const adopted = {
			browser: { kind: { kind: "relay" as const, cdpUrl: relays.older } },
			kindTag: "relay" as const,
		};
		const tabs = spyOn(tabSupervisor, "getTab").mockReturnValue(adopted as TabSession);
		const chosen: string[] = [];
		const acquire = spyOn(registry, "acquireBrowser").mockImplementation(async kind => {
			chosen.push(kind.kind === "relay" ? kind.cdpUrl : kind.kind);
			throw new Error("stop after the relay is chosen");
		});
		const reopen = { action: "open", name: "x", url: "https://mail.example/", timeout: 10 };
		try {
			await expect(invoke(session({ "browser.relay": true }), reopen)).rejects.toThrow(
				"stop after the relay is chosen",
			);
			expect(chosen).toEqual([relays.older]);
			chosen.length = 0;
			await expect(invoke(session(), { ...reopen, app: "relay" })).rejects.toThrow("stop after the relay is chosen");
			expect(chosen).toEqual([relays.older]);
			chosen.length = 0;
			await expect(invoke(session(), { ...reopen, app: relays.newer })).rejects.toThrow(
				"bound to a different browser",
			);
			expect(chosen).toEqual([]);
		} finally {
			tabs.mockRestore();
			acquire.mockRestore();
			await relays.cleanup();
		}
	}, 20_000);
});
