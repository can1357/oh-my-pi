import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveBrowserKind, resolveWebKitKind, type WebKitKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

let root: string;
/** An engine directory holding an executable host. */
let engineDir: string;
let executable: string;
/** An engine directory without one. */
let emptyDir: string;

beforeAll(async () => {
	// Real path: the kind names the host by its real path (macOS's tmpdir is a link).
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "webkit-kind-")));
	engineDir = path.join(root, "engine");
	emptyDir = path.join(root, "empty");
	executable = path.join(engineDir, "ABHost");
	await fs.mkdir(emptyDir);
	await Bun.write(executable, "#!/bin/sh\n");
	await fs.chmod(executable, 0o755);
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.relay": false, ...settings }),
	};
}

describe("resolveBrowserKind with omp's WebKit host", () => {
	it("defaults to the WebKit host found through the env override or the path setting", () => {
		const webkit: WebKitKind = { kind: "webkit", path: executable };
		expect(resolveBrowserKind({ action: "open" }, session(), { PI_BROWSER_WEBKIT_PATH: engineDir })).toEqual(webkit);
		// The setting may name the executable itself.
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.webkitPath": executable }), {})).toEqual(webkit);
		// The env override is not a fallback chain: one that holds no host hides the setting.
		expect(
			resolveBrowserKind({ action: "open" }, session({ "browser.webkitPath": engineDir }), {
				PI_BROWSER_WEBKIT_PATH: emptyDir,
			}).kind,
		).toBe("headless");
	});

	it("opens Chromium when no host executable resolves", async () => {
		expect(resolveBrowserKind({ action: "open" }, session(), { PI_BROWSER_WEBKIT_PATH: emptyDir }).kind).toBe(
			"headless",
		);
		const plainFile = path.join(root, "not-executable");
		await Bun.write(plainFile, "");
		await fs.chmod(plainFile, 0o644);
		expect(resolveBrowserKind({ action: "open" }, session(), { PI_BROWSER_WEBKIT_PATH: plainFile }).kind).toBe(
			"headless",
		);
	});

	it("follows the browser.webkit setting, with PI_BROWSER_WEBKIT overriding it either way", () => {
		const env = { PI_BROWSER_WEBKIT_PATH: engineDir };
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.webkit": false }), env).kind).toBe("headless");
		expect(resolveBrowserKind({ action: "open" }, session(), { ...env, PI_BROWSER_WEBKIT: "0" }).kind).toBe(
			"headless",
		);
		expect(
			resolveBrowserKind({ action: "open" }, session({ "browser.webkit": false }), {
				...env,
				PI_BROWSER_WEBKIT: "1",
			}).kind,
		).toBe("webkit");
	});

	it("runs the host a link leads to by its real path, with the viewer that ships beside it", async () => {
		const shown = path.join(root, "engine-with-viewer");
		const host = path.join(shown, "ABHost");
		const viewer = path.join(shown, "ABView");
		for (const file of [host, viewer]) {
			await Bun.write(file, "#!/bin/sh\n");
			await fs.chmod(file, 0o755);
		}
		// The executable may be named through a link (Tern links ~/.o2/lib/abkit to a version): the host
		// runs from the link's target, so it keeps its own version's helpers when the link moves on.
		const link = path.join(root, "abhost");
		await fs.symlink(host, link);
		const env = { PI_BROWSER_WEBKIT_PATH: link };
		const webkit: WebKitKind = { kind: "webkit", path: host, viewer };
		expect(resolveBrowserKind({ action: "open", headed: true }, session(), env)).toEqual(webkit);
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.headless": false }), env)).toEqual(webkit);
		expect(resolveBrowserKind({ action: "open", headed: true, app: "webkit" }, session(), env)).toEqual(webkit);
	});

	it("leaves a visible window to Chromium on an engine without a viewer", () => {
		const env = { PI_BROWSER_WEBKIT_PATH: engineDir };
		expect(resolveBrowserKind({ action: "open", headed: true }, session(), env)).toMatchObject({
			kind: "headless",
			headless: false,
		});
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.headless": false }), env)).toMatchObject({
			kind: "headless",
			headless: false,
		});
		// `headed: false` asks for a hidden browser whatever the setting says: WebKit can be that.
		expect(
			resolveBrowserKind({ action: "open", headed: false }, session({ "browser.headless": false }), env).kind,
		).toBe("webkit");
	});

	it('lets one open opt out with app: "chromium" and require the host with app: "webkit"', () => {
		const env = { PI_BROWSER_WEBKIT_PATH: engineDir };
		const pane = { TERN_PANE_SOCKET: "/tmp/tern.sock", TERN_PANE: "42" };
		expect(resolveBrowserKind({ action: "open", app: "chromium" }, session(), env).kind).toBe("headless");
		// Naming Chromium picks it outright, whatever Tern would have taken.
		expect(resolveBrowserKind({ action: "open", app: "chromium" }, session(), { ...env, ...pane }).kind).toBe(
			"headless",
		);

		// Required: it wins over the setting that turns the backend off, over Tern, cmux and a configured CDP URL.
		const required = { action: "open", app: "webkit" } as const;
		expect(resolveBrowserKind(required, session({ "browser.webkit": false }), env).kind).toBe("webkit");
		expect(resolveBrowserKind(required, session({ "browser.headless": false }), env).kind).toBe("webkit");
		expect(
			resolveBrowserKind(required, session({ "browser.cdpUrl": "http://127.0.0.1:9333" }), {
				...env,
				...pane,
				CMUX_SOCKET_PATH: "/tmp/cmux.sock",
			}).kind,
		).toBe("webkit");

		// Required and unavailable is an error, never a quiet Chromium.
		expect(() => resolveBrowserKind(required, session(), { PI_BROWSER_WEBKIT_PATH: emptyDir })).toThrow(
			/app: "webkit" requires omp's WebKit engine/,
		);
		expect(() => resolveBrowserKind(required, session(), { ...env, PI_BROWSER_WEBKIT: "0" })).toThrow(
			/app: "webkit" requires omp's WebKit engine/,
		);
		// Nothing an open asks for sends a required open elsewhere: a window it cannot show fails when it is shown.
		expect(resolveBrowserKind({ ...required, headed: true }, session(), env).kind).toBe("webkit");
	});

	it("looks for the platform's executable name in an engine directory and takes a file path as given", async () => {
		const windowsEngine = path.join(root, "windows-engine");
		const windowsHost = path.join(windowsEngine, "ABHost.exe");
		await Bun.write(windowsHost, "");
		await fs.chmod(windowsHost, 0o755);
		const inDirectory = { PI_BROWSER_WEBKIT_PATH: windowsEngine };
		expect(resolveWebKitKind(null, inDirectory, "win32")).toEqual({ kind: "webkit", path: windowsHost });
		// The same directory holds no host for another platform, and a POSIX engine directory none for Windows.
		expect(resolveWebKitKind(null, inDirectory, "linux")).toBeNull();
		expect(resolveWebKitKind(null, { PI_BROWSER_WEBKIT_PATH: engineDir }, "win32")).toBeNull();
		// A file is the executable whatever it is called and whatever the platform.
		expect(resolveWebKitKind(null, { PI_BROWSER_WEBKIT_PATH: windowsHost }, "linux")).toEqual({
			kind: "webkit",
			path: windowsHost,
		});
		expect(resolveWebKitKind(null, { PI_BROWSER_WEBKIT_PATH: executable }, "win32")).toEqual({
			kind: "webkit",
			path: executable,
		});
	});

	it("stays behind explicit app options, the relay, a CDP URL, Tern and cmux", () => {
		const env = { PI_BROWSER_WEBKIT_PATH: engineDir };
		const pane = { TERN_PANE_SOCKET: "/tmp/tern.sock", TERN_PANE: "42" };
		expect(resolveBrowserKind({ action: "open", app: "http://127.0.0.1:9222" }, session(), env).kind).toBe(
			"connected",
		);
		expect(resolveBrowserKind({ action: "open", app: "/usr/bin/chromium" }, session(), env).kind).toBe("spawned");
		expect(resolveBrowserKind({ action: "open" }, session({ "browser.relay": true }), env).kind).toBe("relay");
		expect(
			resolveBrowserKind({ action: "open" }, session({ "browser.cdpUrl": "http://127.0.0.1:9333" }), env).kind,
		).toBe("connected");
		expect(resolveBrowserKind({ action: "open" }, session(), { ...env, ...pane }).kind).toBe("tern");
		expect(
			resolveBrowserKind({ action: "open" }, session(), { ...env, CMUX_SOCKET_PATH: "/tmp/cmux.sock" }).kind,
		).toBe("cmux");
		// Opting out of Tern lands on omp's own browser, which is now WebKit.
		expect(resolveBrowserKind({ action: "open", app: "own" }, session(), { ...env, ...pane }).kind).toBe("webkit");
	});
});
