import { describe, expect, it } from "bun:test";
import type { Page } from "puppeteer-core";
import type { FirefoxRelayBrowserHandle } from "../../src/tools/browser/registry";
import { DEFAULT_FIREFOX_BIDI_URL, validateFirefoxWebSocketUrl } from "../../src/tools/browser/relay/firefox";
import {
	FirefoxSharedTabRegistry,
	forceKillTab,
	getTabsMapForTest,
	handleTabMessage,
	publishRecycledWorker,
	releaseTab,
	selectFirefoxWorkerTab,
	type WorkerHandle,
	type WorkerTabSession,
} from "../../src/tools/browser/tab-supervisor";
import {
	findBiDiPageByTargetId,
	isInteractiveAriaSnapshotNode,
	normalizeAriaSnapshotStates,
	parseAriaSnapshotLines,
	resolveAriaState,
} from "../../src/tools/browser/tab-worker";

function createFirefoxHandle(webSocketUrl: string): FirefoxRelayBrowserHandle {
	return {
		key: `firefox-relay:${webSocketUrl}`,
		kind: { kind: "firefox-relay", webSocketUrl },
		webSocketUrl,
		refCount: 0,
	};
}

function createFirefoxTab(name: string, browser: FirefoxRelayBrowserHandle, worker: WorkerHandle): WorkerTabSession {
	return {
		name,
		browser,
		worker,
		backend: "worker",
		activateForScreenshot: false,
		state: "alive",
		kindTag: "firefox-relay",
		pending: new Map(),
		info: { url: "about:blank", viewport: { width: 1280, height: 720 }, targetId: name },
	} as unknown as WorkerTabSession;
}
describe("Firefox WebDriver BiDi relay", () => {
	it("accepts local WebSocket endpoints used by Firefox-family browsers", () => {
		expect(validateFirefoxWebSocketUrl(DEFAULT_FIREFOX_BIDI_URL)).toBe(DEFAULT_FIREFOX_BIDI_URL);
		expect(validateFirefoxWebSocketUrl("ws://localhost:9333/session/")).toBe("ws://localhost:9333/session");
	});

	it("rejects non-WebSocket and non-loopback endpoints", () => {
		expect(() => validateFirefoxWebSocketUrl("http://127.0.0.1:9222/session")).toThrow("must use ws:// or wss://");
		expect(() => validateFirefoxWebSocketUrl("ws://example.com:9222/session")).toThrow("Refusing non-loopback");
	});

	it("converts BiDi-safe ARIA snapshot rows into observation metadata", () => {
		expect(
			parseAriaSnapshotLines(
				[
					'- button "Save \\"draft\\"" [ref=e7] [disabled] [cursor=pointer]',
					'  - textbox "Title" [ref=e8]',
					`  - 'button "Save: draft" [ref=e9]'`,
					'- button "Escape\\x1bkey" [ref=e10]',
					'- button "Open [ref=e999]" [ref=e11] [focused]',
					"- button /search/ [ref=e12]",
					'- checkbox "Keep me" [ref=e13] checked=false',
					'- checkbox "Bracketed" [ref=e14] [checked=false]',
					"- paragraph:",
					"  - text: Hello",
					'    - /url: "/ignored"',
				].join("\n"),
			),
		).toEqual([
			{ ref: "e7", role: "button", name: 'Save "draft"', states: ["disabled"] },
			{ ref: "e8", role: "textbox", name: "Title", states: [] },
			{ ref: "e9", role: "button", name: "Save: draft", states: [] },
			{ ref: "e10", role: "button", name: "Escape\u001bkey", states: [] },
			{ ref: "e11", role: "button", name: "Open [ref=e999]", states: ["focused"] },
			{ ref: "e12", role: "button", name: "/search/", states: [] },
			{ ref: "e13", role: "checkbox", name: "Keep me", states: ["checked=false"] },
			{ ref: "e14", role: "checkbox", name: "Bracketed", states: ["checked=false"] },
			{ ref: undefined, role: "paragraph", name: undefined, states: [] },
			{ ref: undefined, role: "text", name: "Hello", states: [] },
		]);
	});

	it("retains inaccessible Firefox controls that have no actionable ref", () => {
		expect(parseAriaSnapshotLines('- button "Unavailable" [disabled]')).toEqual([
			{ ref: undefined, role: "button", name: "Unavailable", states: ["disabled"] },
		]);
	});

	it("ignores structural ARIA metadata while retaining actionable serializer states", () => {
		expect(isInteractiveAriaSnapshotNode("heading", ["level=2"])).toBe(false);
		expect(isInteractiveAriaSnapshotNode("heading", ["invalid=false"])).toBe(false);
		expect(isInteractiveAriaSnapshotNode("treeitem", ["expanded"])).toBe(true);
		expect(isInteractiveAriaSnapshotNode("generic", ["active"])).toBe(true);
		expect(isInteractiveAriaSnapshotNode("checkbox", [])).toBe(true);
	});

	it("reads false and mixed states from custom ARIA widgets", () => {
		expect(resolveAriaState(undefined, "false")).toBe(false);
		expect(resolveAriaState(undefined, "mixed")).toBe("mixed");
		expect(resolveAriaState(true, "false")).toBe(true);
		expect(resolveAriaState(undefined, null)).toBeUndefined();
	});

	it("normalizes Firefox focus and bare boolean states", () => {
		expect(normalizeAriaSnapshotStates(["active", "disabled", "focused", "checked", "expanded"])).toEqual([
			"focused",
			"disabled",
			"checked=true",
			"expanded=true",
		]);
	});

	it("keeps worker ownership isolated by Firefox endpoint through close", () => {
		const registry = new FirefoxSharedTabRegistry();
		const endpointA = createFirefoxHandle("ws://127.0.0.1:9222/session");
		const endpointB = createFirefoxHandle("ws://127.0.0.1:9333/session");
		const workerA = {} as WorkerHandle;
		const workerB = {} as WorkerHandle;
		const tabA = createFirefoxTab("firefox-a", endpointA, workerA);
		const tabB = createFirefoxTab("firefox-b", endpointB, workerB);

		registry.set(tabA);
		expect(registry.get(endpointA)).toBe(tabA);

		registry.set(tabB);
		expect(registry.get(endpointA)).toBe(tabA);
		expect(registry.get(endpointB)).toBe(tabB);

		registry.delete(tabA);
		expect(registry.get(endpointA)).toBeUndefined();
		expect(registry.get(endpointB)).toBe(tabB);
	});

	it("reuses the endpoint worker after one of two named aliases closes", () => {
		const registry = new FirefoxSharedTabRegistry();
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		const worker = {} as WorkerHandle;
		const original = createFirefoxTab("firefox-first", endpoint, worker);
		const alias = createFirefoxTab("firefox-second", endpoint, worker);

		registry.set(original);
		// Closing an alias removes only that name from the supervisor's tabs map.
		// The endpoint registry continues to own the original live worker.
		alias.state = "dead";

		const third = registry.get(endpoint);
		expect(third).toBe(original);
		expect(third?.worker).toBe(worker);
	});

	it("refreshes every Firefox alias that shares the selected context", () => {
		const browser = createFirefoxHandle("ws://127.0.0.1:9333/session");
		const worker = {} as WorkerHandle;
		const first = createFirefoxTab("shared-context-first", browser, worker);
		const second = createFirefoxTab("shared-context-second", browser, worker);
		first.targetId = "shared-context";
		second.targetId = "shared-context";
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		const info = {
			url: "https://updated.example",
			title: "Updated",
			viewport: { width: 1280, height: 720 },
			targetId: "shared-context",
		};
		handleTabMessage(first, { type: "ready", info });

		expect(first.info).toBe(info);
		expect(second.info).toBe(info);
		tabs.delete(first.name);
		tabs.delete(second.name);
	});
	it("rejects a closed Firefox browsing context instead of falling back to another tab", async () => {
		const page = { mainFrame: () => ({ _id: "live-context" }) } as unknown as Page;
		await expect(findBiDiPageByTargetId([page], "closed-context")).rejects.toThrow(
			"Target closed-context is no longer available",
		);
	});

	it("serializes concurrent selections on the shared Firefox worker", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sends: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				if (msg.type !== "select") return;
				sends.push(msg.targetMatcher ?? "");
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				setTimeout(() => {
					inFlight--;
					for (const listener of listeners) {
						listener({
							type: "selected",
							id: msg.id,
							info: {
								url: `https://${msg.targetMatcher}.example`,
								viewport: { width: 1280, height: 720 },
								targetId: msg.targetMatcher ?? "",
							},
						});
					}
				}, 5);
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		};

		const [first, second] = await Promise.all([
			selectFirefoxWorkerTab(worker, { name: "first-alias", targetMatcher: "first", timeoutMs: 1_000 }),
			selectFirefoxWorkerTab(worker, { name: "second-alias", targetMatcher: "second", timeoutMs: 1_000 }),
		]);

		expect(sends).toEqual(["first", "second"]);
		expect(maxInFlight).toBe(1);
		expect(first.targetId).toBe("first");
		expect(second.targetId).toBe("second");
	});

	it("cancels an in-flight Firefox selection before publishing an alias", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sent: string[] = [];
		let terminations = 0;
		const worker = {
			mode: "inline",
			send: msg => {
				sent.push(msg.type);
				if (msg.type !== "abort-select") return;
				for (const listener of listeners) {
					listener({
						type: "select-failed",
						id: msg.id,
						error: {
							name: "ToolAbortError",
							message: "Selection aborted",
							isAbort: true,
							isToolError: true,
						},
					});
				}
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => {
				terminations++;
			},
		} satisfies WorkerHandle;
		const selection = selectFirefoxWorkerTab(worker, {
			name: "cancelled-alias",
			targetMatcher: "cancelled",
			timeoutMs: 1,
		});
		await Bun.sleep(0);

		await expect(selection).rejects.toThrow();
		expect(sent).toEqual(["select", "abort-select"]);
		expect(terminations).toBe(0);
	});

	it("releases the selection lock when cancellation precedes dispatch", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sent: string[] = [];
		const worker = {
			mode: "inline",
			send: msg => {
				sent.push(msg.type);
				if (msg.type !== "select") return;
				for (const listener of listeners) {
					listener({
						type: "selected",
						id: msg.id,
						info: {
							url: "https://second.example",
							viewport: { width: 1280, height: 720 },
							targetId: "second",
						},
					});
				}
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const ac = new AbortController();
		ac.abort();

		await expect(
			selectFirefoxWorkerTab(worker, {
				name: "cancelled-alias",
				targetMatcher: "cancelled",
				timeoutMs: 1_000,
				signal: ac.signal,
			}),
		).rejects.toThrow();
		const second = await selectFirefoxWorkerTab(worker, {
			name: "second-alias",
			targetMatcher: "second",
			timeoutMs: 1_000,
		});

		expect(second.targetId).toBe("second");
		expect(sent).toEqual(["select"]);
	});

	it("force-kills one Firefox alias without terminating its shared worker", async () => {
		let terminations = 0;
		const sent: string[] = [];
		const worker = {
			mode: "inline",
			send: msg => sent.push(msg.type),
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => {
				terminations++;
			},
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const first = createFirefoxTab("firefox-drop-first", endpoint, worker);
		const second = createFirefoxTab("firefox-keep-second", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		await forceKillTab(first.name, "first alias failed");

		expect(terminations).toBe(0);
		expect(sent).toContain("release-runtime");
		expect(first.state).toBe("dead");
		expect(second.state).toBe("alive");
		expect(tabs.has(first.name)).toBe(false);
		expect(tabs.get(second.name)?.worker).toBe(worker);
		expect(endpoint.refCount).toBe(1);
		await forceKillTab(second.name, "test cleanup", { sharedFirefoxWorker: true });
		expect(tabs.has(second.name)).toBe(false);
		expect(endpoint.refCount).toBe(0);
	});

	it("releases an idle Firefox alias while its sibling owns the shared run", async () => {
		const worker = {
			mode: "inline",
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const idle = createFirefoxTab("firefox-idle-owner", endpoint, worker);
		const busy = createFirefoxTab("firefox-busy-sibling", endpoint, worker);
		const sharedPending = new Map([
			[
				"busy-run",
				{
					tabName: busy.name,
					resolve: () => undefined,
					reject: () => undefined,
					session: {},
					toolCalls: new Map(),
				},
			],
		]) as unknown as WorkerTabSession["pending"];
		idle.pending = sharedPending;
		busy.pending = sharedPending;
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(idle.name, idle);
		tabs.set(busy.name, busy);

		await releaseTab(idle.name);

		expect(tabs.has(idle.name)).toBe(false);
		expect(tabs.get(busy.name)?.state).toBe("alive");
		sharedPending.clear();
		await forceKillTab(busy.name, "test cleanup", { sharedFirefoxWorker: true });
	});

	it("repoints every Firefox alias when its shared worker is recycled", async () => {
		const oldWorker = {
			mode: "worker",
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const replacement = {
			...oldWorker,
			onMessage: () => () => undefined,
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const first = createFirefoxTab("firefox-recycle-first", endpoint, oldWorker);
		const second = createFirefoxTab("firefox-recycle-second", endpoint, oldWorker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		publishRecycledWorker(first, oldWorker, replacement, first.info);

		expect(tabs.get(first.name)?.worker).toBe(replacement);
		expect(tabs.get(second.name)?.worker).toBe(replacement);
		await forceKillTab(first.name, "test cleanup", { sharedFirefoxWorker: true });
	});

	it("gracefully closes an inline Firefox worker before invalidating every alias", async () => {
		let terminations = 0;
		const sent: string[] = [];
		const worker = {
			mode: "inline",
			send: msg => sent.push(msg.type),
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => {
				terminations++;
			},
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const first = createFirefoxTab("firefox-kill-first", endpoint, worker);
		const second = createFirefoxTab("firefox-kill-second", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		await forceKillTab(first.name, "shared Firefox worker failed", { sharedFirefoxWorker: true });

		expect(sent).toContain("close");
		expect(terminations).toBe(1);
		expect(first.state).toBe("dead");
		expect(second.state).toBe("dead");
		expect(tabs.has(first.name)).toBe(false);
		expect(tabs.has(second.name)).toBe(false);
		expect(endpoint.refCount).toBe(0);
	});
});
