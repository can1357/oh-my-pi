import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as rewriteImports from "@oh-my-pi/pi-coding-agent/eval/js/shared/rewrite-imports";
import * as toolBridge from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	closeLaunchedBrowser,
	ensureChromiumExecutable,
	RENDERER_PRIORITY_ARGS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { DISCARDED_TABS_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { getTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { isRecord } from "@oh-my-pi/pi-utils";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const TAB_ID = 1;
/** Chrome's refusal while another extension's frame is in the tab. */
const FOREIGN_FRAME_REFUSAL = "Cannot access a chrome-extension:// URL of different extension";
/** A call that stays in flight until something ends it; its evaluation names `ompHang`, so the test can tell it apart. */
const HANG = { code: "await page.evaluate(() => new Promise(function ompHang() {}));", timeout: 30 };

/**
 * The relay extension's side of the wire, played over a real headless Chromium's CDP endpoint: `attach`,
 * `send` and `detach` drive one page target the way `chrome.debugger` drives a tab. {@link chromeDetach}
 * does what Chrome does when another extension's frame loads in the tab: it ends the attachment and its
 * cross-site frames' sessions, fails the command in flight, and reports the detach.
 */
class ChromeBackedExtension {
	readonly #relay: WebSocket;
	readonly #chrome: WebSocket;
	#seq = 0;
	readonly #replies = new Map<number, (message: Record<string, unknown>) => void>();
	/** The page target's flat session while "chrome.debugger" is attached. */
	#root: string | undefined;
	/** Flat sessions of the cross-site frames Chrome auto-attached under the root. */
	readonly #children = new Set<string>();
	/** Chrome command id → relay RPC id of in-flight `send`s, answered with Chrome's error when the attachment ends. */
	readonly #inFlight = new Map<number, number>();
	/** Resolved by the next forwarded command each one matches. */
	readonly #sendWaiters = new Set<{ method: string; match: (params: unknown) => boolean; resolve: () => void }>();
	/**
	 * Answer attaches with this refusal of Chrome's: {@link FOREIGN_FRAME_REFUSAL} while another extension's frame is in
	 * the tab.
	 */
	refuseAttach: string | undefined;
	attachAttempts = 0;

	private constructor(
		relay: WebSocket,
		chrome: WebSocket,
		public targetId: string,
	) {
		this.#relay = relay;
		this.#chrome = chrome;
		chrome.addEventListener("message", event => this.#onChrome(JSON.parse(String(event.data))));
		relay.addEventListener("message", event => void this.#onRelay(JSON.parse(String(event.data))));
	}

	static async connect(
		relayPort: number,
		chromeWs: string,
		targetId: string,
		url: string,
	): Promise<ChromeBackedExtension> {
		const chrome = new WebSocket(chromeWs);
		const relay = new WebSocket(`ws://127.0.0.1:${relayPort}/ext`);
		await Promise.all(
			[chrome, relay].map(socket => {
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
				return promise;
			}),
		);
		const extension = new ChromeBackedExtension(relay, chrome, targetId);
		relay.send(
			JSON.stringify({
				t: "hello",
				instanceId: "chrome-backed",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
				tabs: [
					{
						tabId: TAB_ID,
						url,
						title: "Sign in",
						active: true,
						discarded: false,
						windowId: 1,
						pinned: false,
						groupId: -1,
					},
				],
				attachedTabIds: [],
			}),
		);
		return extension;
	}

	#chromeSend(method: string, params: Record<string, unknown>, sessionId?: string) {
		const id = ++this.#seq;
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		this.#replies.set(id, resolve);
		this.#chrome.send(JSON.stringify({ id, method, params, sessionId }));
		return { id, promise };
	}

	#onChrome(message: Record<string, unknown>): void {
		if (typeof message.id === "number") {
			this.#replies.get(message.id)?.(message);
			this.#replies.delete(message.id);
			return;
		}
		const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
		if (!sessionId || this.#root === undefined) return;
		const child = isRecord(message.params) ? message.params.sessionId : undefined;
		if (typeof child === "string" && message.method === "Target.attachedToTarget") this.#children.add(child);
		if (typeof child === "string" && message.method === "Target.detachedFromTarget") this.#children.delete(child);
		this.#relay.send(
			JSON.stringify({
				t: "cdpEvent",
				tabId: TAB_ID,
				sessionId: sessionId === this.#root ? undefined : sessionId,
				method: message.method,
				params: message.params,
			}),
		);
	}

	#reply(id: number, outcome: { result: unknown } | { error: string }): void {
		this.#relay.send(
			JSON.stringify(
				"error" in outcome
					? { t: "rpcResult", id, ok: false, error: outcome.error }
					: { t: "rpcResult", id, ok: true, result: outcome.result ?? {} },
			),
		);
	}

	async #onRelay(message: Record<string, unknown>): Promise<void> {
		if (message.t !== "rpc" || typeof message.id !== "number") return;
		const id = message.id;
		switch (message.op) {
			case "attach": {
				this.attachAttempts++;
				if (this.refuseAttach) return this.#reply(id, { error: this.refuseAttach });
				const answer = await this.#chromeSend("Target.attachToTarget", { targetId: this.targetId, flatten: true })
					.promise;
				const result = answer.result;
				if (!isRecord(result) || typeof result.sessionId !== "string")
					return this.#reply(id, { error: "attach failed" });
				this.#root = result.sessionId;
				return this.#reply(id, { result: {} });
			}
			case "detach": {
				const root = this.#root;
				this.#root = undefined;
				if (root) await this.#chromeSend("Target.detachFromTarget", { sessionId: root }).promise;
				this.#relay.send(
					JSON.stringify({ t: "detached", tabId: TAB_ID, reason: "target_closed", relayInitiated: true }),
				);
				return this.#reply(id, { result: {} });
			}
			case "createTab": {
				const url = String(message.url ?? "about:blank");
				const answer = await this.#chromeSend("Target.createTarget", { url }).promise;
				if (!isRecord(answer.result) || typeof answer.result.targetId !== "string")
					return this.#reply(id, { error: "create failed" });
				this.targetId = answer.result.targetId;
				this.refuseAttach = undefined;
				return this.#reply(id, {
					result: {
						tab: { tabId: TAB_ID, url, title: "", active: true, discarded: false, windowId: 1, pinned: false, groupId: -1 },
					},
				});
			}
			case "closeTab": {
				await this.#chromeSend("Target.closeTarget", { targetId: this.targetId }).promise;
				return this.#reply(id, { result: {} });
			}
			case "send": {
				const root = this.#root;
				if (!root) return this.#reply(id, { error: "Debugger is not attached to the tab with id: 1." });
				const method = String(message.method);
				const sent = this.#chromeSend(
					method,
					isRecord(message.params) ? message.params : {},
					typeof message.sessionId === "string" ? message.sessionId : root,
				);
				this.#inFlight.set(sent.id, id);
				for (const waiter of this.#sendWaiters) {
					if (waiter.method !== method || !waiter.match(message.params)) continue;
					this.#sendWaiters.delete(waiter);
					waiter.resolve();
				}
				const answer = await sent.promise;
				// Chrome already answered this RPC when the attachment ended under it.
				if (!this.#inFlight.delete(sent.id)) return;
				if (isRecord(answer.error)) return this.#reply(id, { error: String(answer.error.message) });
				return this.#reply(id, { result: answer.result });
			}
			default:
				return this.#reply(id, { result: {} });
		}
	}

	/** Resolves once the relay forwards a command of `method` whose params `match` accepts to the tab. */
	nextSend(method: string, match: (params: unknown) => boolean = () => true): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#sendWaiters.add({ method, match, resolve });
		return promise;
	}

	/**
	 * Resolves once the relay forwards the evaluation of {@link HANG}. omp itself also evaluates in the page between
	 * and before calls (holding the page's `print()`), so any `Runtime.callFunctionOn` is not yet the call's code.
	 */
	hanging(): Promise<void> {
		return this.nextSend(
			"Runtime.callFunctionOn",
			params => isRecord(params) && String(params.functionDeclaration).includes("ompHang"),
		);
	}

	/** The tab's URL changed in Chrome (`chrome.tabs.onUpdated`). */
	urlChanged(url: string): void {
		this.#relay.send(
			JSON.stringify({
				t: "tabUpdated",
				tab: {
					tabId: TAB_ID,
					url,
					title: "Sign in",
					active: true,
					discarded: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			}),
		);
	}

	/**
	 * Chrome ends the attachment by itself: its cross-site frames' sessions detach, the command in flight fails,
	 * then `onDetach` fires, all before the extension handles any later request.
	 */
	async chromeDetach(reason: string): Promise<void> {
		const root = this.#root;
		this.#root = undefined;
		for (const sessionId of this.#children) {
			const event = { t: "cdpEvent", tabId: TAB_ID, method: "Target.detachedFromTarget", params: { sessionId } };
			this.#relay.send(JSON.stringify(event));
		}
		this.#children.clear();
		for (const rpcId of this.#inFlight.values()) this.#reply(rpcId, { error: "Detached while handling command." });
		this.#inFlight.clear();
		this.#relay.send(JSON.stringify({ t: "detached", tabId: TAB_ID, reason }));
		if (root) await this.#chromeSend("Target.detachFromTarget", { sessionId: root }).promise;
	}

	close(): void {
		this.#relay.close();
		this.#chrome.close();
	}
}

describe("relay tabs Chrome detaches omp from", () => {
	let chromium: Browser | undefined;
	let site: Bun.Server<undefined> | undefined;
	let relay: RelayServer | undefined;
	let extension: ChromeBackedExtension | undefined;
	let page: Page | undefined;
	let pageUrl = "";
	let tool: ToolSession;
	const name = `relay-detach-${process.pid}`;

	beforeAll(async () => {
		if (!CHROMIUM_AVAILABLE) return;
		const executablePath = await ensureChromiumExecutable();
		if (!executablePath) throw new Error("Chromium executable missing");
		chromium = await puppeteer.launch({
			executablePath,
			headless: true,
			args: ["--no-first-run", ...RENDERER_PRIORITY_ARGS],
		});
		site = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const url = new URL(request.url);
				// `?frame` embeds the sign-in form from another site, which Chrome runs as an out-of-process frame.
				const body = url.searchParams.has("frame")
					? `<title>Sign in</title><iframe src="http://localhost:${url.port}/form"></iframe>`
					: '<title>Sign in</title><input id="user"><input id="pw" type="password">';
				return new Response(body, { headers: { "content-type": "text/html" } });
			},
		});
	});

	afterAll(async () => {
		if (chromium) await closeLaunchedBrowser(chromium);
		site?.stop(true);
	});

	afterEach(async () => {
		await releaseTab(name, { kill: false }).catch(() => undefined);
		extension?.close();
		relay?.stop();
	});

	async function invoke(parameters: Record<string, unknown>, signal?: AbortSignal) {
		const result = await createBrowserPrelude(tool).invoke(
			{ name, ...parameters },
			{ session: tool, toolCallId: "relay-detach", signal },
		);
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		return { text, value: isRecord(result.details) ? result.details.value : undefined };
	}

	/** Adopt a page through the relay and leave state on it that only survives a re-adoption without reload. */
	async function openRelayTab(query = "", owned = false): Promise<ChromeBackedExtension> {
		if (!chromium || !site) throw new Error("Chromium not launched");
		page = await chromium.newPage();
		pageUrl = `${site.url}login?case=${crypto.randomUUID()}${query}`;
		await page.goto(pageUrl);
		// Puppeteer exposes a target's CDP id only on the private field.
		const target = page.target() as unknown as { _targetId: string };
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port, group: false });
		extension = await ChromeBackedExtension.connect(port, chromium.wsEndpoint(), target._targetId, pageUrl);
		tool = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.relay": true,
				"browser.relayUrl": `http://127.0.0.1:${port}`,
				"browser.cmux": false,
				"browser.tern": false,
				"tools.maxTimeout": 0,
			}),
		};
		await invoke({ action: "open", app: "relay", ...(owned ? { url: pageUrl } : { target: "case=" }), timeout: 20 });
		if (owned) {
			page = (await chromium.pages()).find(candidate => {
				// Puppeteer exposes the CDP target id only on its private field.
				const target = candidate.target() as unknown as { _targetId: string };
				return target._targetId === extension?.targetId;
			});
			if (!page) throw new Error("created relay page missing");
		}
		await invoke({ action: "run", code: "await page.evaluate(() => { window.mark = 'kept'; });", timeout: 10 });
		return extension;
	}

	const readMark = { action: "run", code: "return await page.evaluate(() => window.mark);", timeout: 10 };

	/** Resolves once the bridge has handled the extension's next detach report, which sends the tab's worker `OMP.debuggerDetached`. */
	function bridgeHandlesDetach(): Promise<void> {
		if (!relay) throw new Error("relay not started");
		const bridge = relay.bridge;
		const extMessage = bridge.extMessage.bind(bridge);
		const { promise, resolve } = Promise.withResolvers<void>();
		const spy = spyOn(bridge, "extMessage").mockImplementation((socket, raw) => {
			extMessage(socket, raw);
			if (JSON.parse(raw).t !== "detached") return;
			spy.mockRestore();
			resolve();
		});
		return promise;
	}

	/**
	 * {@link openRelayTab} on an inline tab worker, which runs in this process. Worker threads failing to start is what
	 * puts a tab on one; it cannot be re-adopted, so a detach releases the tab.
	 */
	async function openInlineRelayTab(): Promise<ChromeBackedExtension> {
		try {
			return await withoutWorkerThreads(openRelayTab);
		} finally {
			expect(getTab(name)).toMatchObject({ worker: { mode: "inline" } });
		}
	}

	/** Runs `fn` while worker threads cannot start, so every tab worker it spawns falls back to an inline one. */
	async function withoutWorkerThreads<T>(fn: () => Promise<T>): Promise<T> {
		// `Worker` is typed as a constructor, which a throwing mock implementation does not satisfy.
		const unavailable = spyOn(globalThis, "Worker").mockImplementation((() => {
			throw new Error("Worker threads unavailable");
		}) as never);
		try {
			return await fn();
		} finally {
			unavailable.mockRestore();
		}
	}

	it.skipIf(!CHROMIUM_AVAILABLE).each(["fresh", "reuse", "refused", "cancelled"] as const)(
		"keeps an open's page unless the open was cancelled (%s)",
		async mode => {
			const ext = await openRelayTab();
			if (mode !== "reuse") await releaseTab(name, { keepPage: true });
			const ac = new AbortController();
			const requested = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<Response>();
			const login = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: request => {
					if (new URL(request.url).pathname === "/pending.png") {
						requested.resolve();
						return finish.promise;
					}
					return new Response('<title>Login</title><input id="user"><img src="/pending.png">', {
						headers: { "content-type": "text/html" },
					});
				},
			});
			const settled = Promise.withResolvers<void>();
			const acquire = tabSupervisor.acquireTab;
			const acquiring = spyOn(tabSupervisor, "acquireTab").mockImplementation(async (...args) => {
				try {
					return await acquire(...args);
				} finally {
					settled.resolve();
				}
			});
			try {
				const opened = invoke(
					{
						action: "open",
						app: "relay",
						target: "case=",
						url: String(login.url),
						timeout: 20,
					},
					ac.signal,
				).then(
					result => ({ result }),
					(error: unknown) => ({ error }),
				);
				await requested.promise;
				if (mode === "refused") ext.refuseAttach = FOREIGN_FRAME_REFUSAL;
				const tab = getTab(name);
				if (tab?.backend !== "worker") throw new Error("expected a worker tab");
				const terminate = tab.worker.terminate.bind(tab.worker);
				const held = spyOn(tab.worker, "terminate").mockImplementation(async () => {
					await terminate();
					if (mode === "cancelled") ac.abort();
				});
				try {
					await ext.chromeDetach("target_closed");
					finish.resolve(new Response(""));
					const outcome = await opened;
					await settled.promise;
					if (mode === "cancelled") {
						if (!("error" in outcome)) throw new Error("expected open to fail");
						expect(outcome.error).toBeInstanceOf(ToolAbortError);
						expect(getTab(name)).toBeUndefined();
						return;
					}
					if (mode === "refused") {
						// Chrome refused the re-adoption over another extension's frame: the open fails, the tab stays.
						if (!("error" in outcome)) throw new Error("expected open to fail");
						expect(String(outcome.error)).toContain("omp kept the tab open");
						expect(getTab(name)).toBeDefined();
						expect(page?.isClosed()).toBe(false);
						return;
					}
					if ("error" in outcome) throw outcome.error;
					expect(outcome.result.text).toContain("reattached to the same tab");
					if (mode === "reuse") expect(outcome.result.text).toContain("Reused");
					expect((await invoke({ action: "run", code: "return await tab.title();", timeout: 10 })).value).toBe(
						"Login",
					);
					expect(page?.isClosed()).toBe(false);
				} finally {
					held.mockRestore();
				}
			} finally {
				finish.resolve(new Response(""));
				acquiring.mockRestore();
				login.stop(true);
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the recovered tab but fails an open whose navigation never started before its budget ran out",
		async () => {
			const ext = await openRelayTab();
			await invoke({ action: "run", code: 'await tab.emulate({ userAgent: "omp-detach-test" });', timeout: 10 });
			const handled = bridgeHandlesDetach();
			await ext.chromeDetach("target_closed");
			await handled;
			const tab = getTab(name);
			if (tab?.backend !== "worker") throw new Error("expected a worker tab");
			const now = spyOn(performance, "now").mockReturnValue(0);
			const terminate = tab.worker.terminate.bind(tab.worker);
			const held = spyOn(tab.worker, "terminate").mockImplementation(async () => {
				await terminate();
				now.mockReturnValue(30_000);
			});
			try {
				const result = await invoke({ action: "open", url: `${pageUrl}&never`, timeout: 20 }).catch(
					(error: unknown) => error,
				);
				expect(String(result)).toContain("call was not run again");
				expect(String(result)).toContain("stays open on what loaded");
				expect(getTab(name)?.state).toBe("alive");
				expect(page?.url()).toBe(pageUrl);
			} finally {
				now.mockRestore();
				held.mockRestore();
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"re-adopts a kept relay tab after release and reads the state left on it",
		async () => {
			await openRelayTab();
			for (let attempt = 0; attempt < 4; attempt++) {
				await releaseTab(name, { keepPage: true });
				await invoke({ action: "open", app: "relay", target: "case=", timeout: 20 });
				expect((await invoke(readMark)).value).toBe("kept");
			}
		},
		120_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"fails the call in flight at once, names the cause, and re-adopts the same page for the next call",
		async () => {
			const ext = await openRelayTab();
			const evaluating = ext.hanging();
			const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			const failure = String(await stalled);
			expect(failure).toContain("Chrome detached omp from this tab (target_closed) during this call");
			expect(failure).toContain("password manager");
			expect(failure).toContain("may already have landed");
			expect(failure).toContain("reattached to the same tab");
			expect((await invoke(readMark)).value).toBe("kept");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"names the detach to a call running in a cross-site frame, whose session Chrome ends first",
		async () => {
			const ext = await openRelayTab("&frame");
			const evaluating = ext.hanging();
			const inForm = HANG.code.replace("page.evaluate", "form.evaluate");
			const code = `const form = page.frames().find(frame => frame.url().endsWith("/form")); ${inForm}`;
			const stalled = invoke({ action: "run", code, timeout: HANG.timeout }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			const failure = String(await stalled);
			expect(failure).toContain("Chrome detached omp from this tab (target_closed) during this call");
			expect(failure).toContain("reattached to the same tab");
			expect((await invoke(readMark)).value).toBe("kept");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"aborts the host tool calls the detached call had in flight",
		async () => {
			const ext = await openRelayTab();
			const started = Promise.withResolvers<AbortSignal>();
			const callTool = spyOn(toolBridge, "callSessionTool").mockImplementation(async (_name, _args, options) => {
				const signal = options.signal!;
				started.resolve(signal);
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				throw signal.reason;
			});
			try {
				const evaluating = ext.hanging();
				const code = `void __omp_call_tool__("probe", {}); ${HANG.code}`;
				const stalled = invoke({ action: "run", code, timeout: HANG.timeout }).catch((error: unknown) => error);
				const signal = await started.promise;
				await evaluating;
				await ext.chromeDetach("target_closed");
				expect(String(await stalled)).toContain(
					"Chrome detached omp from this tab (target_closed) during this call",
				);
				expect(signal.aborted).toBe(true);
			} finally {
				callTool.mockRestore();
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"re-adopts a tab Chrome detached between calls and runs the next call there",
		async () => {
			const ext = await openRelayTab();
			// The call's first page command (reapplying this user agent) goes out behind the bridge's
			// `OMP.debuggerDetached` on the worker's socket, so the worker sees the detach before the call's code starts.
			await invoke({ action: "run", code: 'await tab.emulate({ userAgent: "omp-detach-test" });', timeout: 10 });
			const handled = bridgeHandlesDetach();
			await ext.chromeDetach("target_closed");
			await handled;
			const next = await invoke(readMark);
			expect(next.value).toBe("kept");
			expect(next.text).toContain("Chrome had detached omp from this tab since the last call");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"runs a call on the re-adopted tab when Chrome detached omp before its code started",
		async () => {
			const ext = await openRelayTab();
			// A user agent set by an earlier call is reapplied before each call's code starts.
			await invoke({ action: "run", code: 'await tab.emulate({ userAgent: "omp-detach-test" });', timeout: 10 });
			const reapplying = ext.nextSend("Network.setUserAgentOverride");
			const next = invoke(readMark);
			await reapplying;
			await ext.chromeDetach("target_closed");
			const result = await next;
			expect(result.value).toBe("kept");
			expect(result.text).toContain(
				"omp reattached to the same tab on a new worker, without reloading it, and then ran this call",
			);
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"counts a detach while the call's code is still compiling as before it ran",
		async () => {
			// An inline tab worker runs in this process, so the compile step can be held.
			const ext = await openInlineRelayTab();
			const wrapCode = rewriteImports.wrapCode;
			const compiling = Promise.withResolvers<void>();
			const compiled = Promise.withResolvers<void>();
			const held = spyOn(rewriteImports, "wrapCode").mockImplementation(async code => {
				compiling.resolve();
				await compiled.promise;
				return await wrapCode(code);
			});
			const probe = `OMP_DETACH_PROBE_${process.pid}`;
			try {
				const code = `process.env.${probe} = "ran"; return await page.evaluate(() => window.mark);`;
				const next = invoke({ action: "run", code, timeout: 10 }).catch((error: unknown) => error);
				await compiling.promise;
				await ext.chromeDetach("target_closed");
				expect(String(await next)).toContain(
					"Chrome detached omp from this tab (target_closed) before this call, so its code did not run",
				);
				// The compile finishing after the detach must not evaluate the cell late. The runtime awaits the
				// compile before this test does, so its evaluation, if any, has run once this await returns.
				compiled.resolve();
				await held.mock.results[0]?.value;
				expect(process.env[probe]).toBeUndefined();
			} finally {
				compiled.resolve();
				held.mockRestore();
				delete process.env[probe];
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"closes an inline worker before releasing the tab it cannot re-adopt",
		async () => {
			const ext = await openInlineRelayTab();
			const tab = getTab(name);
			if (tab?.backend !== "worker") throw new Error("expected a worker tab");
			// The inline core reports `closed` once it has disconnected from the relay; a core left running keeps its
			// connection and claim, and could take the tab again when the relay re-announces it.
			let closed = false;
			const unsubscribe = tab.worker.onMessage(msg => {
				if (msg.type === "closed") closed = true;
			});
			try {
				const evaluating = ext.hanging();
				const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
				await evaluating;
				await ext.chromeDetach("target_closed");
				expect(String(await stalled)).toContain("could not reattach");
				expect(closed).toBe(true);
			} finally {
				unsubscribe();
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps a tab Chrome refuses to re-adopt, and re-adopts it at a later call",
		async () => {
			const ext = await openRelayTab();
			ext.refuseAttach = FOREIGN_FRAME_REFUSAL;
			const evaluating = ext.hanging();
			const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			const failure = String(await stalled);
			expect(failure).toContain("Chrome detached omp from this tab (target_closed) during this call");
			expect(failure).toContain("omp kept the tab open");
			expect(getTab(name)).toBeDefined();
			// While the frame stays, each call says so and the tab stays.
			const refused = String(await invoke(readMark).catch((error: unknown) => error));
			expect(refused).toContain("Chrome still keeps omp out of tab");
			expect(getTab(name)).toBeDefined();
			// An open of the same tab re-adopts it too, rather than reporting it reused with no worker driving it.
			const reopened = String(
				await invoke({ action: "open", app: "relay", target: "case=", timeout: 20 }).catch(
					(error: unknown) => error,
				),
			);
			expect(reopened).toContain("Chrome still keeps omp out of tab");
			expect(getTab(name)).toBeDefined();
			// Once it is gone, the next call reattaches to the same page, its state intact, and says so.
			ext.refuseAttach = undefined;
			const later = await invoke(readMark);
			expect(later.value).toBe("kept");
			expect(later.text).toContain("Chrome had kept omp out of this tab");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE).each([
		{ owned: true, label: "owned tab closed" },
		{ owned: false, label: "adopted tab left open" },
	])("replaces a held-out tab without re-adopting ($label)", async ({ owned }) => {
		const ext = await openRelayTab("", owned);
		const original = page!;
		const originalTab = getTab(name);
		ext.refuseAttach = FOREIGN_FRAME_REFUSAL;
		const evaluating = ext.hanging();
		const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
		await evaluating;
		await ext.chromeDetach("target_closed");
		expect(String(await stalled)).toContain("omp kept the tab open");
		const attempts = ext.attachAttempts;
		const started = Date.now();
		await invoke({ action: "open", app: "relay", url: pageUrl, dialogs: "accept", timeout: 20 });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(ext.attachAttempts - attempts).toBe(1);
		expect(getTab(name)).not.toBe(originalTab);
		expect(original.isClosed()).toBe(owned);
	}, 60_000);

	it.skipIf(!CHROMIUM_AVAILABLE).each(["release", "release keeping the page"] as const)(
		"lets go of a tab Chrome keeps omp out of (%s)",
		async mode => {
			await openRelayTab("", mode === "release");
			const ext = extension!;
			ext.refuseAttach = FOREIGN_FRAME_REFUSAL;
			const evaluating = ext.hanging();
			const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			expect(String(await stalled)).toContain("omp kept the tab open");
			// No worker drives the held-out tab, so nothing waits for one to answer the release.
			await releaseTab(name, mode === "release" ? {} : { keepPage: true });
			expect(getTab(name)).toBeUndefined();
			expect(page?.isClosed()).toBe(mode === "release");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"still lets go of a tab Chrome refuses for any other reason, until its address changes",
		async () => {
			const ext = await openRelayTab();
			ext.refuseAttach = "Another debugger is already attached to the tab with id: 1.";
			const evaluating = ext.hanging();
			const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
			await evaluating;
			await ext.chromeDetach("target_closed");
			const failure = String(await stalled);
			expect(failure).toContain("Chrome detached omp from this tab (target_closed) during this call");
			expect(failure).toContain("could not reattach");
			const later = String(await invoke(readMark).catch((error: unknown) => error));
			expect(later).toContain("could not reattach");
			expect(later).toContain("navigate it in Chrome first");
			// The guidance holds: once the tab's URL changed, it opens again, page state intact.
			ext.refuseAttach = undefined;
			await page?.evaluate("location.hash = 'moved'");
			ext.urlChanged(`${pageUrl}#moved`);
			await invoke({ action: "open", app: "relay", target: "case=", timeout: 20 });
			expect((await invoke(readMark)).value).toBe("kept");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"releases the tab without re-adopting it when the user cancels Chrome's debugging bar",
		async () => {
			const ext = await openRelayTab();
			const respawn = spyOn(globalThis, "Worker");
			try {
				const evaluating = ext.hanging();
				const stalled = invoke({ action: "run", ...HANG }).catch((error: unknown) => error);
				await evaluating;
				await ext.chromeDetach("canceled_by_user");
				const failure = String(await stalled);
				expect(failure).toContain("Chrome detached omp from this tab (canceled_by_user) during this call");
				expect(failure).toContain("The user cancelled Chrome's debugging bar");
				expect(failure).toContain("navigate it in Chrome, then open it again");
				expect(failure).not.toContain("password manager");
				// No new worker was started for a re-adoption the relay cannot grant.
				expect(respawn).not.toHaveBeenCalled();
			} finally {
				respawn.mockRestore();
			}
			const later = String(await invoke(readMark).catch((error: unknown) => error));
			expect(later).toContain("The user cancelled Chrome's debugging bar");
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"reports a cancel that lands during the re-adoption as a cancel",
		async () => {
			const ext = await openRelayTab();
			const tab = getTab(name);
			if (tab?.backend !== "worker") throw new Error("expected a worker tab");
			// Hold the re-adoption once the detached worker is gone, so the cancel lands while it is under way.
			const terminate = tab.worker.terminate.bind(tab.worker);
			const readopting = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const held = spyOn(tab.worker, "terminate").mockImplementation(async () => {
				await terminate();
				readopting.resolve();
				await resume.promise;
			});
			try {
				const ac = new AbortController();
				const evaluating = ext.hanging();
				const stalled = runInTab(name, {
					code: HANG.code,
					timeoutMs: 30_000,
					session: tool,
					signal: ac.signal,
				}).catch((error: unknown) => error);
				await evaluating;
				await ext.chromeDetach("target_closed");
				await readopting.promise;
				ac.abort();
				resume.resolve();
				// Whether the tab survives depends on the re-adoption beating the cancel grace; the report must not.
				expect(await stalled).toBeInstanceOf(ToolAbortError);
			} finally {
				resume.resolve();
				held.mockRestore();
			}
		},
		60_000,
	);
});
