import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveBrowserKind, resolveTernKind, type TernKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const TERN_ENV = { TERN_PANE_SOCKET: "/tmp/tern.sock", TERN_PANE: "42" };
const TERN: TernKind = { kind: "tern", socketPath: "/tmp/tern.sock", pane: 42 };

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.relay": false, ...settings }),
	};
}

describe("resolveTernKind", () => {
	it("needs both the daemon socket and a numeric pane", () => {
		expect(resolveTernKind(null, TERN_ENV)).toEqual(TERN);
		expect(resolveTernKind(null, { TERN_PANE_SOCKET: "/tmp/tern.sock" })).toBeNull();
		expect(resolveTernKind(null, { ...TERN_ENV, TERN_PANE: "pane-1" })).toBeNull();
	});

	it("lets PI_BROWSER_TERN override the setting in both directions", () => {
		expect(resolveTernKind({ settingEnabled: true }, { ...TERN_ENV, PI_BROWSER_TERN: "0" })).toBeNull();
		expect(resolveTernKind({ settingEnabled: false }, TERN_ENV)).toBeNull();
		expect(resolveTernKind({ settingEnabled: false }, { ...TERN_ENV, PI_BROWSER_TERN: "1" })).toEqual(TERN);
	});
});

describe("resolveBrowserKind with Tern", () => {
	const cmuxEnv = { ...TERN_ENV, CMUX_SOCKET_PATH: "/tmp/cmux.sock" };

	it("prefers a Tern PiP over cmux and Chromium inside a Tern pane", () => {
		expect(resolveBrowserKind({ action: "open" }, session(), cmuxEnv)).toEqual(TERN);
	});

	it("keeps explicit app options, the relay and browser.cdpUrl ahead of Tern", () => {
		expect(
			resolveBrowserKind({ action: "open", app: { cdp_url: "http://127.0.0.1:9222" } }, session(), TERN_ENV),
		).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9222",
		});
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.relay": true }), TERN_ENV).kind).toBe("relay");
		expect(
			resolveBrowserKind({ action: "open" }, session({ "browser.cdpUrl": "http://127.0.0.1:9333" }), TERN_ENV).kind,
		).toBe("connected");
	});

	it("keeps the Tern PiP for headed:false", () => {
		expect(resolveBrowserKind({ action: "open", headed: false }, session(), cmuxEnv)).toEqual(TERN);
	});

	it("skips Tern for app.tern:false and the setting, falling through to cmux", () => {
		expect(resolveBrowserKind({ action: "open", app: { tern: false } }, session(), cmuxEnv).kind).toBe("cmux");
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.tern": false }), cmuxEnv).kind).toBe("cmux");
	});

	it("app.tern:true forces Tern over settings and errors outside Tern", () => {
		expect(
			resolveBrowserKind(
				{ action: "open", app: { tern: true } },
				session({ "browser.tern": false, "browser.cdpUrl": "http://127.0.0.1:9333" }),
				TERN_ENV,
			),
		).toEqual(TERN);
		expect(() => resolveBrowserKind({ action: "open", app: { tern: true } }, session(), {})).toThrow(
			/requires running inside a Tern pane/,
		);
	});
});
