import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createBrowserPrelude,
	DEFAULT_RELAY_URL,
	resolveBrowserKind,
	resolveRelayKind,
} from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { BrowserKindTag } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

describe("resolveRelayKind", () => {
	it("is disabled by default", () => {
		expect(resolveRelayKind(null, {})).toBeNull();
		expect(resolveRelayKind({}, {})).toBeNull();
	});

	it("resolves the default endpoint when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, {})).toEqual({ kind: "relay", cdpUrl: DEFAULT_RELAY_URL });
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
			cdpUrl: DEFAULT_RELAY_URL,
		});
	});

	it("PI_BROWSER_RELAY=0 disables the relay even when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, { PI_BROWSER_RELAY: "0" })).toBeNull();
	});

	it("PI_BROWSER_RELAY=1 enables the relay when the setting is off", () => {
		expect(resolveRelayKind({ settingEnabled: false }, { PI_BROWSER_RELAY: "1" })).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
		});
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
			expect(guidance !== undefined).toBe(onRelay);
			if (onRelay) expect(guidance).toContain("`app: { relay: false }` for a throwaway managed browser");
		}
	});

	it("names the browser app.relay:false falls through to", () => {
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
			expect(resolveBrowserKind({ action: "open", app: { relay: false } }, session).kind).toBe(kind);
			const guidance = createBrowserPrelude(session).guidance;
			expect(guidance).toContain(says);
			expect(guidance).not.toContain("throwaway");
		}
	});
});
