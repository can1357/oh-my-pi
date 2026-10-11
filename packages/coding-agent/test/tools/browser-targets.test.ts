import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, relayTargets } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	type TabSnapshot,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import { releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const PANE = 3;

const BLOCKS = [
	{ block: 5, url: "https://docs.example/a", title: "Docs A", owner: null, shown: false, driven: false },
	{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE, shown: true, driven: true },
	{ block: 7, url: "https://docs.example/c", title: "Docs C", owner: null, shown: true, driven: false },
];

const ENV_KEYS = ["TERN_PANE_SOCKET", "TERN_PANE", "PI_BROWSER_TERN", "PI_BROWSER_RELAY"] as const;
const savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

let daemon: FakeDaemon | undefined;
let relay: RelayServer | undefined;
let extension: WebSocket | undefined;
const opened: string[] = [];

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
		await invoke(tool, { action: "open", name: "docs", timeout: 5, app: { target: "Docs C" } });
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
		expect(text).toStartWith("Tern browser blocks (adopt one with app.target set to its id):\n");
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
	it("explains that targets exist only inside Tern or with the relay", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const failure = await invoke(session(), { action: "targets", timeout: 5 }).catch((error: unknown) => error);
		expect(String(failure)).toContain("targets exist only inside a Tern pane");
		expect(String(failure)).toContain("app.relay: true or the browser.relay setting");
	});
});

describe("relayTargets", () => {
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
		expect(relayTargets(entries)).toEqual([
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
		const { text, value } = await invoke(tool, { action: "targets", timeout: 10, app: { relay: true } });
		expect(value).toEqual([
			{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/", shown: true },
			{ target: "https://docs.example/", title: "Docs", url: "https://docs.example/", shown: false },
		]);
		expect(text).toBe(
			'Chrome pages via the relay (adopt one with app.target set to its URL or a title substring):\n- "Mail" https://mail.example/ (active)\n- "Docs" https://docs.example/',
		);
	}, 20_000);
});
