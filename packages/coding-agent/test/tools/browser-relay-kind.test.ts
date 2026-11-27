import { discoverRelayEndpoints } from "../../src/tools/browser/relay/discovery";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude, resolveBrowserKind, resolveRelayKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser, type BrowserKindTag, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { RelayKind } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/kind";
import { DISCARDED_TABS_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

describe("resolveRelayKind", () => {
	it("is disabled by default", () => {
		expect(resolveRelayKind(null, {})).toBeNull();
		expect(resolveRelayKind({}, {})).toBeNull();
	});

	it("resolves the default endpoint when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, {})).toEqual({
			kind: "relay",
			cdpUrl: discoverRelayEndpoints()[0] ?? "",
		});
	});

	it("uses the configured URL and trims trailing slashes", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "http://127.0.0.1:9333///" }, {})).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:9333",
		});
	});

	it("falls back to the default endpoint for a blank URL", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "   " }, {})).toEqual({
			kind: "relay",
			cdpUrl: discoverRelayEndpoints()[0] ?? "",
		});
	});

	it("PI_BROWSER_RELAY=0 disables the relay even when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, { PI_BROWSER_RELAY: "0" })).toBeNull();
	});

	it("PI_BROWSER_RELAY=only enables the relay when the setting is off", () => {
		expect(resolveRelayKind({ settingEnabled: false }, { PI_BROWSER_RELAY: "only" })).toEqual({
			kind: "relay",
			cdpUrl: discoverRelayEndpoints()[0] ?? "",
		});
	});

	it("PI_BROWSER_RELAY=1 enables the relay when the setting is off", () => {
		expect(resolveRelayKind({ settingEnabled: false }, { PI_BROWSER_RELAY: "1" })).toEqual({
			kind: "relay",
			cdpUrl: discoverRelayEndpoints()[0] ?? "",
		});
	});
});

describe("Windows relay acquisition", () => {
	it("verifies identity before CDP and uses the fixed socket without attempting a restart", async () => {
		const windowsInstance = crypto.randomUUID();
		const protocol = String(DISCARDED_TABS_PROTOCOL_VERSION);
		const ready = {
			ompRelayVersion: "1.0.0",
			ompRelayInstance: windowsInstance,
			ompRelayDiscardedTabsProtocol: protocol,
			ompExtensionDiscardedTabsProtocol: protocol,
			ompRelayCdpClients: 0,
		};
		let version: Record<string, unknown> = {};
		const requests: string[] = [];
		using server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				const path = new URL(request.url).pathname;
				requests.push(`${request.method} ${path}`);
				if (path === "/json/version") {
					return Response.json({ ...version, webSocketDebuggerUrl: `ws://${server.url.host}/advertised` });
				}
				if (path === "/cdp" && server.upgrade(request)) return;
				return new Response(null, { status: 404 });
			},
			websocket: {
				message(ws, message) {
					const { id, method } = JSON.parse(String(message)) as { id: number; method: string };
					ws.send(
						JSON.stringify({
							id,
							result: method === "Target.getBrowserContexts" ? { browserContextIds: [] } : {},
						}),
					);
				},
			},
		});
		const kind: RelayKind = { kind: "relay", cdpUrl: server.url.origin, windowsInstance };
		const opts = { cwd: process.cwd(), signal: AbortSignal.timeout(3_000) };
		for (const unverified of [
			{ Browser: "Chrome/151" },
			{ ...ready, ompRelayVersion: "" },
			{ ...ready, ompRelayInstance: crypto.randomUUID() },
		]) {
			version = unverified;
			await expect(acquireBrowser(kind, opts)).rejects.toThrow(/verified Windows relay did not answer/);
		}
		version = { ...ready, ompRelayDiscardedTabsProtocol: "" };
		await expect(acquireBrowser(kind, opts)).rejects.toThrow(/Windows relay or Chrome extension is incompatible/);
		expect(requests.splice(0)).toEqual(Array(4).fill("GET /json/version"));

		version = ready;
		const handle = await acquireBrowser(kind, opts);
		try {
			expect("wsEndpoint" in handle && handle.wsEndpoint).toBe(`ws://${server.url.host}/cdp`);
			await expect(acquireBrowser({ ...kind, windowsInstance: crypto.randomUUID() }, opts)).rejects.toThrow(
				/verified Windows relay did not answer/,
			);
			expect(requests).toEqual(["GET /json/version", "GET /cdp", "GET /json/version"]);
		} finally {
			await releaseBrowser(handle, { kill: false });
		}
	});
});

describe("browser prelude relay guidance", () => {
	const ENV_KEYS = [
		"PI_BROWSER_RELAY",
		"PI_BROWSER_TERN",
		"PI_BROWSER_CMUX",
		"TERN_PANE_SOCKET",
		"TERN_PANE",
		"CMUX_SOCKET_PATH",
		// Inherited from an interactive omp when the tests run from its bash tool.
		"PI_TERMINAL_OWNER_PID",
	] as const;
	const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	beforeEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	const sessionWith = (settings: Record<string, unknown>): ToolSession =>
		({
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(settings),
		}) as ToolSession;

	it("tells the model an open without app drives the user's Chrome only while that is what it does", () => {
		for (const [settings, env] of [
			[{ "browser.relay": true }, undefined],
			[{ "browser.relay": false }, undefined],
			[{ "browser.relay": true }, "0"],
			[{ "browser.relay": false }, "1"],
		] as const) {
			if (env === undefined) delete process.env.PI_BROWSER_RELAY;
			else process.env.PI_BROWSER_RELAY = env;
			const session = sessionWith(settings);
			const onRelay = resolveBrowserKind({ action: "open" }, session).kind === "relay";
			const guidance = createBrowserPrelude(session).guidance;
			expect(guidance?.includes('`app: "auto"` for a throwaway managed browser') ?? false).toBe(onRelay);
		}
	});

	it('names the browser app: "auto" falls through to', () => {
		const cases: {
			settings: Record<string, unknown>;
			env: Record<string, string>;
			kind: BrowserKindTag;
			says: string;
		}[] = [
			{
				// The block goes to the model provider: a token in the URL must not.
				settings: { "browser.cdpUrl": "http://user:pw@127.0.0.1:9333/?token=s3cret" },
				env: {},
				kind: "connected",
				says: "open in the browser at `browser.cdpUrl` (http://127.0.0.1:9333/?token=%5Bredacted%5D) instead",
			},
			{
				settings: {},
				env: { TERN_PANE_SOCKET: "/tmp/tern.sock", TERN_PANE: "1" },
				kind: "tern",
				says: "omp's own Tern picture-in-picture instead",
			},
			{
				settings: {},
				env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
				kind: "cmux",
				says: "omp's own cmux browser surface instead",
			},
		];
		for (const { settings, env, kind, says } of cases) {
			for (const key of ENV_KEYS) delete process.env[key];
			Object.assign(process.env, env);
			const session = sessionWith({ "browser.relay": true, ...settings });
			expect(resolveBrowserKind({ action: "open", app: "auto" }, session).kind).toBe(kind);
			const guidance = createBrowserPrelude(session).guidance;
			expect(guidance).toContain(says);
			expect(guidance).not.toContain("throwaway");
		}
	});
});

describe("resolveBrowserKind in a subagent", () => {
	const subagent = (settings: Record<string, unknown>, taskDepth = 1): ToolSession =>
		({
			cwd: process.cwd(),
			hasUI: false,
			taskDepth,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(settings),
		}) as ToolSession;
	const pane = {
		TERN_PANE_SOCKET: "/tmp/tern.sock",
		TERN_PANE: "1",
		CMUX_SOCKET_PATH: "/tmp/cmux.sock",
		PI_BROWSER_WEBKIT: "0",
	};

	it("skips the relay, Tern and cmux the parent would use for an open without app", () => {
		expect(resolveBrowserKind({ action: "open" }, subagent({ "browser.relay": true }), pane).kind).toBe("headless");
		expect(resolveBrowserKind({ action: "open" }, subagent({}), { ...pane, PI_BROWSER_RELAY: "1" }).kind).toBe(
			"headless",
		);
		expect(
			resolveBrowserKind(
				{ action: "open" },
				subagent({ "browser.relay": true, "browser.cdpUrl": "http://127.0.0.1:9222" }),
				pane,
			).kind,
		).toBe("connected");
	});

	it("skips Tern and cmux even when PI_BROWSER_TERN=1 or PI_BROWSER_CMUX=1 forces them for the parent", () => {
		const forced = { ...pane, PI_BROWSER_TERN: "1", PI_BROWSER_CMUX: "1" };
		expect(resolveBrowserKind({ action: "open" }, subagent({}), forced).kind).toBe("headless");
		expect(
			resolveBrowserKind({ action: "open" }, subagent({}), {
				CMUX_SOCKET_PATH: "/tmp/cmux.sock",
				PI_BROWSER_CMUX: "1",
				PI_BROWSER_WEBKIT: "0",
			}).kind,
		).toBe("headless");
	});

	it("leaves a /tan clone (task depth 0) on its parent's defaults, which its copied prompt describes", () => {
		expect(resolveBrowserKind({ action: "open" }, subagent({ "browser.relay": true }, 0), pane).kind).toBe("relay");
	});

	it("still opens the user's Chrome or Tern when the open asks", () => {
		const session = subagent({ "browser.relay": true });
		expect(resolveBrowserKind({ action: "open", app: "relay" }, session, pane).kind).toBe("relay");
		expect(resolveBrowserKind({ action: "open", app: "tern" }, session, pane).kind).toBe("tern");
		expect(resolveBrowserKind({ action: "open", target: "docs" }, session, pane).kind).toBe("tern");
		expect(
			resolveBrowserKind({ action: "open", app: "relay" }, session, { ...pane, PI_BROWSER_RELAY: "0" }).kind,
		).toBe("headless");
	});

	it("gets no relay guidance, since its open without app stays out of the user's Chrome", () => {
		const saved = process.env.PI_BROWSER_RELAY;
		delete process.env.PI_BROWSER_RELAY;
		try {
			const guidance = createBrowserPrelude(subagent({ "browser.relay": true })).guidance;
			expect(guidance).toBe(createBrowserPrelude(subagent({ "browser.relay": false })).guidance);
		} finally {
			if (saved !== undefined) process.env.PI_BROWSER_RELAY = saved;
		}
	});
});

describe("relay-only sessions (PI_BROWSER_RELAY=only)", () => {
	const only = { PI_BROWSER_RELAY: "only" };
	const sessionAt = (taskDepth: number): ToolSession =>
		({
			cwd: process.cwd(),
			hasUI: false,
			taskDepth,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({}),
		}) as ToolSession;

	it("sends every open to the relay, a subagent's included", () => {
		expect(resolveBrowserKind({ action: "open" }, sessionAt(0), only).kind).toBe("relay");
		expect(resolveBrowserKind({ action: "open" }, sessionAt(1), only).kind).toBe("relay");
		expect(resolveBrowserKind({ action: "open", app: "relay" }, sessionAt(1), only).kind).toBe("relay");
	});

	it("refuses any other app", () => {
		for (const app of ["auto", "own", "http://127.0.0.1:9222"]) {
			expect(() => resolveBrowserKind({ action: "open", app }, sessionAt(0), only)).toThrow(
				"This session drives the user's Chrome through the omp extension and has no other browser",
			);
		}
	});

	it("tells the model the user's Chrome is the only browser", () => {
		const saved = process.env.PI_BROWSER_RELAY;
		process.env.PI_BROWSER_RELAY = "only";
		try {
			for (const depth of [0, 1]) {
				const guidance = createBrowserPrelude(sessionAt(depth)).guidance;
				expect(guidance).toContain("There is no other browser");
				expect(guidance).toContain("the user's Chrome");
				expect(guidance).not.toContain('app: "auto"');
			}
		} finally {
			if (saved === undefined) delete process.env.PI_BROWSER_RELAY;
			else process.env.PI_BROWSER_RELAY = saved;
		}
	});
});
