import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveBrowserKind, resolveTernKind, type TernKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { TERMINAL_OWNER_ENV } from "@oh-my-pi/pi-coding-agent/tools/browser/terminal-owner";

const TERN_ENV = { TERN_PANE_SOCKET: "/tmp/tern.sock", TERN_PANE: "42" };
const TERN: TernKind = { kind: "tern", socketPath: "/tmp/tern.sock", pane: 42 };

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.webkit": false, "browser.relay": false, ...settings }),
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
		expect(resolveBrowserKind({ action: "open", app: "http://127.0.0.1:9222" }, session(), TERN_ENV)).toEqual({
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

	it('skips Tern for app: "own" and the setting, falling through to cmux only for the setting', () => {
		expect(resolveBrowserKind({ action: "open", app: "own" }, session(), cmuxEnv).kind).toBe("headless");
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.tern": false }), cmuxEnv).kind).toBe("cmux");
	});

	it('target adopts in Tern even with the browser.tern setting off, unless app: "own"', () => {
		const settings = session({ "browser.tern": false });
		expect(resolveBrowserKind({ action: "open", target: "github" }, settings, cmuxEnv)).toEqual(TERN);
		expect(resolveBrowserKind({ action: "open", target: "github", app: "own" }, settings, cmuxEnv).kind).toBe(
			"headless",
		);
	});

	it('app: "tern" forces Tern over settings and errors outside Tern', () => {
		expect(
			resolveBrowserKind(
				{ action: "open", app: "tern" },
				session({ "browser.tern": false, "browser.cdpUrl": "http://127.0.0.1:9333" }),
				TERN_ENV,
			),
		).toEqual(TERN);
		expect(() => resolveBrowserKind({ action: "open", app: "tern" }, session(), {})).toThrow(
			/requires running inside a Tern pane/,
		);
	});
});

describe("resolveBrowserKind in a terminal another omp owns", () => {
	// An `omp -p` that an interactive omp's bash tool or eval cell started inherits its pane env and its claim.
	const paneEnv = { ...TERN_ENV, CMUX_SOCKET_PATH: "/tmp/cmux.sock" };
	const otherOwner = { [TERMINAL_OWNER_ENV]: String(process.pid + 1) };

	it("opens managed Chromium instead of a Tern PiP or a cmux surface", () => {
		expect(resolveBrowserKind({ action: "open" }, session(), { ...paneEnv, ...otherOwner }).kind).toBe("headless");
		expect(
			resolveBrowserKind({ action: "open" }, session(), { CMUX_SOCKET_PATH: "/tmp/cmux.sock", ...otherOwner }).kind,
		).toBe("headless");
	});

	it("still uses a configured relay or CDP URL, which come before Tern", () => {
		const env = { ...paneEnv, ...otherOwner };
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.relay": true }), env).kind).toBe("relay");
		expect(
			resolveBrowserKind({ action: "open" }, session({ "browser.cdpUrl": "http://127.0.0.1:9333" }), env).kind,
		).toBe("connected");
	});

	it("keeps Tern for the owner itself, its subagents and an unclaimed pane", () => {
		const own = { [TERMINAL_OWNER_ENV]: String(process.pid) };
		expect(resolveBrowserKind({ action: "open" }, session(), { ...paneEnv, ...own })).toEqual(TERN);
		expect(resolveBrowserKind({ action: "open" }, session(), paneEnv)).toEqual(TERN);
	});

	it("still uses Tern or cmux when the open or the env asks for it", () => {
		const env = { ...paneEnv, ...otherOwner };
		expect(resolveBrowserKind({ action: "open", app: "tern" }, session(), env)).toEqual(TERN);
		expect(resolveBrowserKind({ action: "open", target: "github" }, session(), env)).toEqual(TERN);
		expect(resolveBrowserKind({ action: "open" }, session(), { ...env, PI_BROWSER_TERN: "1" })).toEqual(TERN);
		expect(
			resolveBrowserKind({ action: "open" }, session(), {
				CMUX_SOCKET_PATH: "/tmp/cmux.sock",
				PI_BROWSER_CMUX: "1",
				...otherOwner,
			}).kind,
		).toBe("cmux");
	});
});
