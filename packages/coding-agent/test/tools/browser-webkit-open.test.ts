/**
 * `browser.open` on omp's WebKit host, end to end through the prelude host
 * against a fake `ABHost` process: no real engine and no real Chromium.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { createFakeHost, type FakeHost, type FakeHostMode, isProcessAlive } from "./webkit-fake-host";

// Ambient browser env of the developer's shell (and of an omp running the suite) must not pick the backend.
const ENV_KEYS = [
	"PI_BROWSER_WEBKIT",
	"PI_BROWSER_WEBKIT_PATH",
	"PI_BROWSER_RELAY",
	"PI_BROWSER_TERN",
	"PI_BROWSER_CMUX",
	"TERN_PANE_SOCKET",
	"TERN_PANE",
	"CMUX_SOCKET_PATH",
	// Inherited from an interactive omp when the tests run from its bash tool.
	"PI_TERMINAL_OWNER_PID",
];

let savedEnv: Map<string, string | undefined>;
let fake: FakeHost | undefined;
const opened: string[] = [];

beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
	for (const name of opened.splice(0)) await supervisor.releaseTab(name, { kill: false }).catch(() => undefined);
	vi.restoreAllMocks();
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fake?.remove();
	fake = undefined;
});

async function useFakeHost(mode?: FakeHostMode): Promise<FakeHost> {
	fake = await createFakeHost(mode);
	process.env.PI_BROWSER_WEBKIT_PATH = fake.dir;
	return fake;
}

function makeSession(sessionId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalKernelOwnerId: () => sessionId,
		settings: Settings.isolated({ "browser.enabled": true, "browser.relay": false, "tools.maxTimeout": 0 }),
	};
}

async function open(session: ToolSession, name: string, extra: Record<string, unknown> = {}): Promise<string> {
	opened.push(name);
	const result = await createBrowserPrelude(session).invoke(
		{ action: "open", name, timeout: 10, ...extra },
		{ session, toolCallId: "webkit-open" },
	);
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/** A Chromium that opens without launching anything: its handle and its tab are stand-ins. Returns the spy on its executable preflight. */
function stubChromium() {
	const chromium = {
		key: "headless:1::",
		kind: { kind: "headless", headless: true },
		refCount: 0,
		browser: { connected: false },
		wsEndpoint: "ws://127.0.0.1/devtools/browser/stub",
		stealth: { browserSession: null, override: null },
	} as unknown as registry.BrowserHandle;
	const acquireBrowser = registry.acquireBrowser;
	const acquireTab = supervisor.acquireTab;
	const preflight = spyOn(launch, "ensureChromiumExecutable").mockResolvedValue("/stub/chromium");
	spyOn(registry, "acquireBrowser").mockImplementation(async (kind, opts) =>
		kind.kind === "headless" ? chromium : await acquireBrowser(kind, opts),
	);
	spyOn(supervisor, "acquireTab").mockImplementation(async (name, browser, opts) => {
		if (browser !== chromium) return await acquireTab(name, browser, opts);
		const tab = {
			name,
			browser,
			backend: "worker",
			kindTag: "headless",
			state: "alive",
			info: { url: "about:blank", title: "", viewport: { width: 1280, height: 800 }, targetId: "stub" },
		} as unknown as supervisor.TabSession;
		return { tab, created: true };
	});
	return preflight;
}

describe("browser.open on omp's WebKit host", () => {
	it("opens each tab as one block of a single host and seeds its identity once, per session", async () => {
		const host = await useFakeHost();
		const sessionA = makeSession("session-a");
		const text = await open(sessionA, "wk-a1");
		expect(text).toStartWith('Opened tab "wk-a1" on omp\'s headless WebKit browser');
		// The host reports its views as not shown; that is not the Tern "not on screen" situation.
		expect(text).not.toContain("Not on screen");
		await open(sessionA, "wk-a2");
		await open(makeSession("session-b"), "wk-b");

		const requests = await host.requests();
		const opens = requests.filter(request => request.op === "open");
		// One process hosts all three tabs: its block ids keep counting.
		expect(opens).toHaveLength(3);
		const identities = requests.filter(request => request.op === "identity");
		expect(identities.map(request => request.block)).toEqual([1, 2, 3]);
		// Sent right after the open, before anything configures or reads the page.
		for (const identity of identities) {
			const index = requests.indexOf(identity);
			expect(requests[index - 1]?.op).toBe("open");
		}
		const [a1, a2, b] = identities.map(request => request.seed);
		expect(typeof a1 === "string" && a1.length > 0).toBe(true);
		expect(a2).toBe(a1);
		expect(b).not.toBe(a1);

		// The process belongs to omp: closing its last tab ends its input and it exits.
		const pid = await host.pid();
		for (const name of opened.splice(0)) await supervisor.releaseTab(name, { kill: false });
		expect(await host.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it.each([
		["the host cannot start", "exit-on-hello", "exited with code 3"],
		["the host cannot open its first tab", "fail-open", "no display to create a view on"],
	] as const)("falls back to Chromium, naming the reason, when %s", async (_case, mode, reason) => {
		const host = await useFakeHost(mode);
		const preflight = stubChromium();
		const text = await open(makeSession("session-fallback"), "wk-fallback");
		expect(text).toStartWith('Opened tab "wk-fallback" on headless browser (hidden)');
		expect(text).toContain("opened Chromium instead");
		expect(text).toContain(reason);
		// The driver is shared with Tern; nothing a WebKit tab reports may call the backend Tern.
		expect(text).not.toContain("Tern");
		expect(preflight).toHaveBeenCalledTimes(1);
		// The unusable host is not left running behind the Chromium tab.
		expect(isProcessAlive(await host.pid())).toBe(false);
	});

	it("enables file access on every tab before its page loads", async () => {
		const host = await useFakeHost();
		const session = makeSession("session-files");
		await open(session, "wk-a", { url: "file:///tmp/a.html" });
		await open(session, "wk-b", { url: "file:///tmp/b.html" });

		const requests = await host.requests();
		const switches = requests.filter(request => request.op === "fileAccess");
		expect(switches.map(request => [request.block, request.value])).toEqual([
			[1, true],
			[2, true],
		]);
		for (const change of switches) {
			const goto = requests.find(request => request.op === "goto" && request.block === change.block);
			expect(requests.indexOf(change)).toBeLessThan(requests.indexOf(goto!));
		}
	});

	it("fails an open that requires WebKit instead of opening Chromium, naming WebKit as the backend", async () => {
		await useFakeHost("fail-open");
		const preflight = stubChromium();
		const failure = await open(makeSession("session-required"), "wk-required", { app: "webkit" }).catch(
			(error: unknown) => error,
		);
		expect(String(failure)).toContain("WebKit browser open failed (failed): no display to create a view on");
		expect(String(failure)).not.toContain("Tern");
		expect(preflight).not.toHaveBeenCalled();
		expect(supervisor.getTab("wk-required")).toBeUndefined();
	});

	it("names WebKit, not Tern, in what a tab's failing op and unsupported helper report", async () => {
		await useFakeHost();
		await open(makeSession("session-product"), "wk-product");
		const tab = supervisor.getTab("wk-product");
		if (tab?.backend !== "webkit") throw new Error("expected a WebKit tab");

		const refused = await tab.ternTab.setViewport({ width: 99_999, height: 600 }).catch((error: unknown) => error);
		expect(String(refused)).toContain("WebKit browser viewport failed (invalid): width is out of range");
		const unsupported = await tab.ternTab.traceStart().catch((error: unknown) => error);
		expect(String(unsupported)).toContain("tab.traceStart() is not supported on the WebKit browser backend");
		const webmcp = await tab.ternTab.webmcpList().catch((error: unknown) => error);
		// The way out it names is this backend's own open option.
		expect(String(webmcp)).toContain('app: "chromium"');
		for (const message of [refused, unsupported, webmcp, await tab.ternTab.browser.version()]) {
			expect(String(message)).not.toContain("Tern");
		}
	});

	it("opens omp's WebKit browser when Tern, chosen automatically, cannot show one", async () => {
		const host = await useFakeHost();
		// A Tern pane whose daemon is gone.
		process.env.TERN_PANE_SOCKET = `${host.dir}/no-tern.sock`;
		process.env.TERN_PANE = "3";
		const text = await open(makeSession("session-tern"), "wk-after-tern");
		expect(text).toStartWith('Opened tab "wk-after-tern" on omp\'s headless WebKit browser');
		expect(text).toContain("Tern cannot show a browser here");
		expect(text).toContain("opened omp's WebKit browser instead");
	});

	it("goes on to Chromium when neither Tern nor the WebKit host can open the tab", async () => {
		const host = await useFakeHost("exit-on-hello");
		stubChromium();
		process.env.TERN_PANE_SOCKET = `${host.dir}/no-tern.sock`;
		process.env.TERN_PANE = "3";
		const text = await open(makeSession("session-chain"), "wk-chain");
		expect(text).toStartWith('Opened tab "wk-chain" on headless browser (hidden)');
		// Both notes say where the tab ended up, not where the first fallback meant to go.
		expect(text).toMatch(/Tern cannot show a browser here \(.*\); opened Chromium instead/);
		expect(text).toMatch(/omp's WebKit browser could not start \(.*exited with code 3.*\); opened Chromium instead/);
	});

	it("reports a failed navigation as the page's failure instead of switching browsers", async () => {
		await useFakeHost("fail-navigation");
		const preflight = stubChromium();
		const failure = await open(makeSession("session-nav"), "wk-nav", { url: "https://nowhere.invalid/" }).catch(
			(error: unknown) => error,
		);
		expect(String(failure)).toContain("host not found");
		expect(preflight).not.toHaveBeenCalled();
		expect(supervisor.getTab("wk-nav")).toBeUndefined();
	});
});
