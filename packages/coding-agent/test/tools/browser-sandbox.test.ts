/**
 * The browser under the OS sandbox: what a call declares to the sandbox gate, and how omp's own
 * Chromium launches contained (egress proxy flags, no `file:` cross-file access, keyed by its
 * containment, every `file:` load checked, page downloads kept out of the user's folders).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { invokeEvalPrelude } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { grantExecIn } from "@oh-my-pi/pi-coding-agent/sandbox/grants";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { buildHeadlessLaunchArgs } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { resolveInitScriptSources } from "@oh-my-pi/pi-coding-agent/tools/browser/open-options";
import { type BrowserHandle, browserKey } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	browserCallSubjects,
	chromiumSandbox,
	isHeadedChromium,
	tabExecTarget,
} from "@oh-my-pi/pi-coding-agent/tools/browser/sandbox";
import { cfgBrowserWebKit, cfgBrowserWebKitPath } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const VIEWPORT = { width: 800, height: 600 };

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
let workspace: string;
let runtimes: SandboxRuntime[];

function session(cwd = workspace): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		isToolActive: (name: string) => name === "sandbox_request",
	} as unknown as ToolSession;
}

/** What the browser prelude declares to the sandbox gate for `parameters`. */
function subjects(parameters: unknown, cwd?: string) {
	return createBrowserPrelude(session(cwd)).sandboxSubjects?.(parameters);
}

beforeEach(async () => {
	state = beginSettingsTest();
	for (const key of ["PI_BROWSER_WEBKIT", "PI_BROWSER_WEBKIT_PATH", "PI_BROWSER_RELAY", "PUPPETEER_PROXY"]) {
		delete process.env[key];
	}
	scratch = TempDir.createSync("@omp-browser-sandbox-");
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	for (const dir of [workspace, agentDir]) fs.mkdirSync(dir);
	runtimes = [];
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
	settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
	cfgSandboxEnabled.set(settings, true);
});

afterEach(async () => {
	try {
		for (const runtime of runtimes) await runtime.dispose();
		SandboxRuntime.resetForTest();
	} finally {
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
		state = undefined;
		scratch.removeSync();
	}
});

describe("browser sandbox declarations", () => {
	it("resolves upload paths against the session cwd, skipping the tab form's selector", () => {
		const nested = path.join(workspace, "nested");
		expect(
			subjects(
				{ action: "call", chain: [{ method: "uploadFile", args: ["a.txt", "b.txt", ["../c.txt"]] }] },
				nested,
			),
		).toEqual([
			{ kind: "read", target: path.join(nested, "b.txt") },
			{ kind: "read", target: path.join(workspace, "c.txt") },
		]);
		// An element handle's uploadFile takes paths only: its first argument is a file.
		expect(
			subjects(
				{
					action: "call",
					chain: [
						{ method: "id", args: [3] },
						{ method: "uploadFile", args: ["a.txt"] },
					],
				},
				nested,
			),
		).toEqual([{ kind: "read", target: path.join(nested, "a.txt") }]);
	});

	it("maps a percent-encoded file: URL, also inside view-source:, to the decoded path", () => {
		const dir = path.join(workspace, "my dir");
		const encoded = `file://${workspace}/my%20dir/a%23b.html`;
		expect(subjects({ action: "open", url: encoded })).toEqual([
			{ kind: "read", target: path.join(dir, "a#b.html") },
		]);
		expect(subjects({ action: "call", chain: [{ method: "goto", args: [`view-source:${encoded}`] }] })).toEqual([
			{ kind: "read", target: path.join(dir, "a#b.html") },
		]);
	});

	it("declares code spliced into the host run, not page-side evaluation", () => {
		const hostCode = [{ kind: "exec" as const, target: "browser:run" }];
		const call = (...chain: unknown[]) => subjects({ action: "call", chain });
		expect(call({ method: "waitFor", args: [{ predicate: { __omp_fn: "() => true" } }] })).toEqual(hostCode);
		expect(call({ method: "id", args: [1] }, { method: "evaluate", args: ["el => el.id"] })).toEqual(hostCode);
		expect(call({ method: "frame", args: ["#f"] }, { method: "evaluate", args: ["document.title"] })).toEqual([]);
		expect(call({ method: "evaluate", args: ["document.title"] })).toEqual([]);
	});

	it("declares the contact sheet beside a recording's destination", () => {
		const call = (method: string) => subjects({ action: "call", chain: [{ method, args: ["rec/out.mp4"] }] });
		for (const method of ["recordStart", "recordRestart"]) {
			expect(call(method)).toEqual([
				{ kind: "write", target: path.join(workspace, "rec", "out.mp4") },
				{ kind: "write", target: path.join(workspace, "rec", "out.mp4.contact.png") },
			]);
		}
		// A non-string destination names nothing.
		expect(subjects({ action: "call", chain: [{ method: "recordStart", args: [{}] }] })).toEqual([]);
	});

	it("declares an exec subject for clipboard operations of a headed Chromium only", () => {
		const clipboard = [{ kind: "exec" as const, target: "browser:clipboard" }];
		for (const method of ["clipboardRead", "clipboardWrite", "clipboardCopy", "clipboardPaste"]) {
			const call = { action: "call" as const, chain: [{ method, args: [] }] };
			expect(browserCallSubjects(call, workspace, true)).toEqual(clipboard);
			expect(browserCallSubjects(call, workspace, false)).toEqual([]);
			expect(browserCallSubjects(call, workspace)).toEqual([]);
		}
		// Other methods never declare it, headed or not.
		expect(
			browserCallSubjects({ action: "call", chain: [{ method: "click", args: ["#a"] }] }, workspace, true),
		).toEqual([]);
	});

	it("declares the clipboard exec subject for a copy/cut/paste key pressed in a headed Chromium only", () => {
		const clipboard = [{ kind: "exec" as const, target: "browser:clipboard" }];
		const tabCall = (method: string, ...args: unknown[]) => ({
			action: "call" as const,
			chain: [{ method, args }],
		});
		const elementPress = (key: string) => ({
			action: "call" as const,
			chain: [
				{ method: "id", args: [3] },
				{ method: "press", args: [key] },
			],
		});
		const shortcuts = ["Control+v", "Meta+C", "Control+x", "Shift+Insert", "insert", "v", "KeyV", "Control+KeyX"];
		for (const key of shortcuts) {
			for (const call of [tabCall("press", key), tabCall("keyDown", key), elementPress(key)]) {
				expect(browserCallSubjects(call, workspace, true)).toEqual(clipboard);
				expect(browserCallSubjects(call, workspace, false)).toEqual([]);
			}
		}
		// Other keys, and a non-string key, declare nothing even headed.
		for (const key of ["Enter", "Control+a", "Tab", "b", "Escape", "Control+Shift+K"]) {
			expect(browserCallSubjects(tabCall("press", key), workspace, true)).toEqual([]);
			expect(browserCallSubjects(tabCall("keyDown", key), workspace, true)).toEqual([]);
		}
		expect(browserCallSubjects(tabCall("press", 86), workspace, true)).toEqual([]);
		// `press(selector, key)` names the key second, an element's `press(key, options)` first: a clipboard
		// key in either string argument gates the call (a selector that looks like one over-declares).
		const elementPressWith = (...args: unknown[]) => ({
			action: "call" as const,
			chain: [
				{ method: "id", args: [3] },
				{ method: "press", args },
			],
		});
		const framePress = (...args: unknown[]) => ({
			action: "call" as const,
			chain: [
				{ method: "frame", args: ["iframe"] },
				{ method: "press", args },
			],
		});
		for (const key of ["Control+v", "Shift+Insert"]) {
			for (const call of [tabCall("press", "#q", key), framePress("#q", key), elementPressWith(key, "Enter")]) {
				expect(browserCallSubjects(call, workspace, true)).toEqual(clipboard);
				expect(browserCallSubjects(call, workspace, false)).toEqual([]);
			}
		}
		expect(browserCallSubjects(tabCall("press", "#q", "Enter"), workspace, true)).toEqual([]);
	});

	it("tells a headed omp Chromium from a headless one and from other browsers", () => {
		const tab = (kind: BrowserHandle["kind"]) => ({ kind }) as BrowserHandle;
		expect(isHeadedChromium(tab({ kind: "headless", headless: false }))).toBe(true);
		expect(isHeadedChromium(tab({ kind: "headless", headless: true }))).toBe(false);
		expect(isHeadedChromium(tab({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" }))).toBe(false);
	});

	it("declares omp's WebKit host when asked for by name, installed or not, and never picks it itself", () => {
		const webkit = [{ kind: "exec" as const, target: "browser:webkit" }];
		// Not installed: the open installs the engine on the host and then starts it.
		cfgBrowserWebKitPath.set(settings, path.join(workspace, "missing", "ABHost"));
		expect(subjects({ action: "open", app: "webkit" })).toEqual(webkit);
		const host = path.join(workspace, "ABHost");
		fs.writeFileSync(host, "");
		fs.chmodSync(host, 0o755);
		cfgBrowserWebKit.set(settings, true);
		cfgBrowserWebKitPath.set(settings, host);
		expect(subjects({ action: "open", app: "webkit" })).toEqual(webkit);
		// An automatic open takes the Chromium the sandbox contains instead.
		expect(subjects({ action: "open" })).toEqual([]);
	});

	it("reads an init_scripts entry spanning lines as source, never as a file, in the declaration and the open", async () => {
		const entry = "a\nb";
		fs.writeFileSync(path.join(workspace, entry), "FILE-CONTENT");
		fs.writeFileSync(path.join(workspace, "init.js"), "INIT");
		expect(subjects({ action: "open", init_scripts: [entry, "init.js"] })).toEqual([
			{ kind: "read", target: path.join(workspace, "init.js") },
		]);
		expect(await resolveInitScriptSources([entry, "init.js"], workspace)).toEqual([entry, "INIT"]);
	});

	it("refuses an attach to a CDP endpoint only while the sandbox is active", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "attached" }] }));
		const definition = { ...createBrowserPrelude(session()), invoke };
		const context = {
			session: { ...session(), getEvalPreludes: () => [definition] } as unknown as ToolSession,
			toolCallId: "b1",
		};
		const attach = () => invokeEvalPrelude("browser", { action: "open", app: "http://127.0.0.1:9222" }, context);
		await expect(attach()).rejects.toThrow("kind `exec`, target `browser:cdp`");
		expect(invoke).not.toHaveBeenCalled();
		cfgSandboxEnabled.set(settings, false);
		await attach();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
});

describe("omp's Chromium under the sandbox", () => {
	it("launches through the runtime's egress proxy without file access from file: pages", async () => {
		process.env.PUPPETEER_PROXY = "http://user-proxy:3128";
		const proxyServer = "http://127.0.0.1:4321";
		vi.spyOn(SandboxRuntime.prototype, "status").mockReturnValue({
			state: "active",
			backend: "seatbelt",
			network: "allowlist",
			warnings: [],
		});
		vi.spyOn(SandboxRuntime.prototype, "egressProxyUrl").mockResolvedValue(proxyServer);
		const sandbox = await chromiumSandbox(session());
		expect(sandbox).toEqual({ workspace, network: "allowlist", proxyServer });
		const args = buildHeadlessLaunchArgs(VIEWPORT, { sandbox });
		expect(args).toContain(`--proxy-server=${proxyServer}`);
		expect(args).toContain("--proxy-bypass-list=<-loopback>");
		expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
		expect(args).not.toContain("--allow-file-access-from-files");
		// The user's own proxy never replaces the sandbox's.
		expect(args.filter(arg => arg.startsWith("--proxy-server="))).toEqual([`--proxy-server=${proxyServer}`]);

		cfgSandboxEnabled.set(settings, false);
		expect(await chromiumSandbox(session())).toBeUndefined();
		delete process.env.PUPPETEER_PROXY;
		const plain = buildHeadlessLaunchArgs(VIEWPORT, {});
		expect(plain).toContain("--allow-file-access-from-files");
		expect(plain.some(arg => arg.startsWith("--proxy-"))).toBe(false);
	});

	it("asks for the network of mode allow under mode deny: on open, and at launch for an open that fell back to it", async () => {
		const networkAllow = "browser:chromium-network-allow";
		expect(subjects({ action: "open", app: "chromium" })).toEqual([]);
		cfgSandboxNetworkMode.set(settings, "deny");
		expect(subjects({ action: "open", app: "chromium" })).toEqual([{ kind: "exec", target: networkAllow }]);
		runtimes.push(await SandboxRuntime.for(workspace));
		await expect(chromiumSandbox(session())).rejects.toThrow(`target \`${networkAllow}\``);
		grantExecIn(networkAllow);
		expect(await chromiumSandbox(session())).toEqual({ workspace, network: "allow" });
	});

	it("asks for a tab's Chromium when its containment differs from the session's, and keys each containment apart", () => {
		const tab = (kind: BrowserHandle["kind"], shared?: boolean) =>
			({ kind, ...(shared ? { sharedDaemon: { name: "d", projectDir: workspace } } : {}) }) as BrowserHandle;
		const other = path.join(path.dirname(workspace), "other");
		fs.mkdirSync(other);
		const sandboxes = [
			{ workspace, network: "allow" as const },
			{ workspace, network: "allowlist" as const, proxyServer: "http://127.0.0.1:1" },
			{ workspace, network: "allowlist" as const, proxyServer: "http://127.0.0.1:2" },
			{ workspace: other, network: "allow" as const },
		];
		const [allow, proxied] = sandboxes.map(sandbox => tab({ kind: "headless", headless: true, sandbox }));
		expect(tabExecTarget(allow, "allow", workspace)).toBeUndefined();
		expect(tabExecTarget(allow, "allowlist", workspace)).toBe("browser:chromium-network-allow");
		expect(tabExecTarget(proxied, "allow", workspace)).toBeUndefined();
		expect(tabExecTarget(proxied, "deny", workspace)).toBe("browser:chromium-network-allowlist");
		// A session of another workspace never drives a Chromium contained for this one.
		expect(tabExecTarget(allow, "allow", other)).toBe(`browser:chromium-workspace ${workspace}`);
		expect(tabExecTarget(tab({ kind: "headless", headless: true }, true), "allow", workspace)).toBe("browser:shared");
		expect(tabExecTarget(tab({ kind: "headless", headless: true }), "allow", workspace)).toBe(
			"browser:chromium-unsandboxed",
		);
		const keys = [undefined, ...sandboxes].map(sandbox => browserKey({ kind: "headless", headless: true, sandbox }));
		expect(new Set(keys).size).toBe(keys.length);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"opened through the prelude, fails file: loads the sandbox denies and keeps page downloads out of the user's folders",
		async () => {
			cfgSandboxNetworkMode.set(settings, "allow");
			runtimes.push(await SandboxRuntime.for(workspace));
			const root = path.dirname(workspace);
			const secret = path.join(root, "secret");
			const home = path.join(root, "home");
			for (const dir of [secret, home]) fs.mkdirSync(dir);
			fs.writeFileSync(path.join(secret, "key.txt"), "SECRET-KEY");
			fs.writeFileSync(path.join(workspace, "notes.txt"), "PLAIN-NOTES");
			fs.writeFileSync(
				path.join(workspace, "a.html"),
				`<iframe id="notes" src="notes.txt"></iframe><iframe id="secret" src="file://${secret}/key.txt"></iframe>` +
					`<a id="dl" download="pwn.txt" href="data:text/plain,pwn">download</a>`,
			);
			cfgSandboxDenyRead.set(settings, [secret]);
			// Chromium's own download folder is under HOME (restored with the environment).
			process.env.HOME = home;
			const prelude = createBrowserPrelude(session());
			const invoke = (parameters: object) => prelude.invoke(parameters, { session: session(), toolCallId: "b1" });
			const call = async (name: string, ...chain: object[]) => {
				const { details } = await invoke({ action: "call", name, chain });
				return isRecord(details) ? details.value : undefined;
			};
			const frameText = (id: string) =>
				call(
					"main",
					{ method: "frame", args: [`#${id}`] },
					{ method: "evaluate", args: ["document.body.innerText"] },
				);
			let profile = "";
			try {
				await invoke({ action: "open", app: "chromium", url: `file://${workspace}/a.html` });
				const handle = getTab("main")?.browser;
				profile = (handle && "userDataDir" in handle && handle.userDataDir) || "";
				expect(profile).not.toBe("");
				expect(await frameText("notes")).toContain("PLAIN-NOTES");
				expect(await frameText("secret")).not.toContain("SECRET-KEY");
				// Denied at first; a tab that points downloads at its folder resets Chromium's to the profile's when it closes.
				await call("main", { method: "click", args: ["#dl"] });
				await invoke({ action: "open", name: "dl", app: "chromium", downloads: path.join(workspace, "dl") });
				await invoke({ action: "close", name: "dl" });
				await call("main", { method: "click", args: ["#dl"] });
				// Chromium reports no event for a download it denies: poll until the file lands, in the profile or anywhere under HOME.
				const downloads = path.join(profile, "Downloads");
				const underHome = () =>
					fs.readdirSync(home, { recursive: true }).filter(file => String(file).includes("pwn"));
				const deadline = Date.now() + 15_000;
				while (
					Date.now() < deadline &&
					!fs.existsSync(path.join(downloads, "pwn.txt")) &&
					underHome().length === 0
				) {
					await Bun.sleep(100);
				}
				expect(underHome()).toEqual([]);
				const landed = fs.readdirSync(downloads);
				expect(landed).toContain("pwn.txt");
				expect(landed).not.toContain("pwn (1).txt");
				const denied = await call("main", { method: "goto", args: [`file://${secret}/key.txt`] }).catch(
					(error: unknown) => error,
				);
				expect(String(denied)).toContain("ERR_ACCESS_DENIED");
			} finally {
				await releaseAllTabs({ kill: true });
			}
			expect(fs.existsSync(profile)).toBe(false);
		},
		60_000,
	);
});
