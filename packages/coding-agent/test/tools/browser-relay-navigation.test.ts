import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

/**
 * Native invariant: NavigationRequest::BeginNavigationImpl asserts url::IsAboutBlank
 * which checks parsed_.ref.len <= 0. If a fragment is present on about:blank,
 * Chrome encounters a fatal SIGTRAP / EXC_BREAKPOINT crash.
 */
export const FATAL_NATIVE_CRASH_PREFIX =
	"FATAL BROWSER CRASH (SIGTRAP/CHECK): NavigationRequest::BeginNavigationImpl failed url::IsAboutBlank";

export interface SimulatedFrame {
	id: string;
	loaderId: string;
	url: string;
}

export interface SimulatedTab {
	tabId: number;
	windowId: number;
	url: string;
	title: string;
	active: boolean;
	pinned: boolean;
	groupId: number;
	rootFrameId: string;
	loaderId: string;
	childFrames: SimulatedFrame[];
	isolatedWorlds: Map<string, number>;
	errorOnNavigate?: string;
	errorOnEvaluate?: string;
	stallCommit?: boolean;
}

export interface LethalAttempt {
	api: string;
	url: string;
	context?: string;
}

export interface CdpEventRecord {
	tabId: number;
	sessionId?: string;
	method: string;
	params: Record<string, unknown>;
}

export class SimulatedBrowserFixture {
	readonly tabs = new Map<number, SimulatedTab>();
	readonly lethalAttempts: LethalAttempt[] = [];
	readonly cdpCommands: Array<{
		tabId: number;
		sessionId?: string;
		method: string;
		params: Record<string, unknown>;
	}> = [];
	readonly cdpEventListeners: Array<
		(source: { tabId?: number; sessionId?: string }, method: string, params: Record<string, unknown>) => void
	> = [];
	readonly contextToFrame = new Map<number, { tabId: number; frameId: string }>();

	fastForwardTime = false;
	virtualTimeOffset = 0;

	#loaderSeq = 100;
	#contextSeq = 200;
	#tabSeq = 1;

	constructor() {
		// Default starter tab
		this.addTab({
			tabId: 1,
			url: "about:blank",
			title: "Initial Blank Tab",
		});
	}

	addTab(init: {
		tabId?: number;
		url?: string;
		title?: string;
		childFrames?: Array<{ id: string; url: string }>;
	}): SimulatedTab {
		const tabId = init.tabId ?? this.#tabSeq++;
		const rootFrameId = `FRAME_ROOT_${tabId}`;
		const loaderId = `LOADER_${++this.#loaderSeq}`;
		const tab: SimulatedTab = {
			tabId,
			windowId: 1,
			url: init.url ?? "about:blank",
			title: init.title ?? "New Tab",
			active: true,
			pinned: false,
			groupId: -1,
			rootFrameId,
			loaderId,
			childFrames: (init.childFrames ?? []).map(cf => ({
				id: cf.id,
				url: cf.url,
				loaderId: `LOADER_${++this.#loaderSeq}`,
			})),
			isolatedWorlds: new Map<string, number>(),
		};
		this.tabs.set(tabId, tab);
		return tab;
	}

	emitCdpEvent(source: { tabId?: number; sessionId?: string }, method: string, params: Record<string, unknown>): void {
		for (const listener of this.cdpEventListeners) {
			listener(source, method, params);
		}
	}

	getFrameTree(tab: SimulatedTab): {
		frameTree: {
			frame: { id: string; loaderId: string; url: string; securityOrigin: string; mimeType: string };
			childFrames: Array<{ frame: { id: string; loaderId: string; url: string } }>;
		};
	} {
		// If stalled, report previous uncommitted url and loaderId
		const reportedUrl = tab.stallCommit ? "https://example.com/slow-page" : tab.url;
		const reportedLoaderId = tab.stallCommit ? "LOADER_UNCOMMITTED" : tab.loaderId;

		return {
			frameTree: {
				frame: {
					id: tab.rootFrameId,
					loaderId: reportedLoaderId,
					url: reportedUrl,
					securityOrigin: reportedUrl.startsWith("http") ? new URL(reportedUrl).origin : "://",
					mimeType: "text/html",
				},
				childFrames: tab.childFrames.map(cf => ({
					frame: {
						id: cf.id,
						loaderId: cf.loaderId,
						url: cf.url,
					},
				})),
			},
		};
	}

	handleSendCommand(
		target: { tabId?: number; sessionId?: string },
		method: string,
		params?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const tabId = target.tabId ?? 1;
		const tab = this.tabs.get(tabId);
		if (!tab) {
			return Promise.reject(new Error(`No tab with id ${tabId}`));
		}

		this.cdpCommands.push({
			tabId,
			sessionId: target.sessionId,
			method,
			params: params ? { ...params } : {},
		});

		// Check native crash invariant for Page.navigate
		if (method === "Page.navigate") {
			const targetUrl = typeof params?.url === "string" ? params.url : "";
			if (/^about:blank#/i.test(targetUrl)) {
				this.lethalAttempts.push({
					api: "Page.navigate",
					url: targetUrl,
					context: "chrome.debugger.sendCommand",
				});
				throw new Error(`${FATAL_NATIVE_CRASH_PREFIX} for "${targetUrl}"`);
			}

			if (tab.errorOnNavigate) {
				return Promise.resolve({
					frameId: tab.rootFrameId,
					errorText: tab.errorOnNavigate,
				});
			}

			// Safe navigation (e.g. clean "about:blank" or normal "https://...")
			const newLoaderId = `LOADER_${++this.#loaderSeq}`;
			tab.loaderId = newLoaderId;
			if (!tab.stallCommit) {
				tab.url = targetUrl;
			}

			this.emitCdpEvent(target, "Page.frameNavigated", {
				frame: {
					id: tab.rootFrameId,
					loaderId: newLoaderId,
					url: targetUrl,
				},
			});
			this.emitCdpEvent(target, "Page.loadEventFired", { timestamp: Date.now() / 1000 });

			return Promise.resolve({
				frameId: tab.rootFrameId,
				loaderId: newLoaderId,
			});
		}

		if (method === "Page.getFrameTree") {
			return Promise.resolve(this.getFrameTree(tab));
		}

		if (method === "Page.createIsolatedWorld") {
			const frameId = typeof params?.frameId === "string" ? params.frameId : tab.rootFrameId;
			const contextId = ++this.#contextSeq;
			this.contextToFrame.set(contextId, { tabId, frameId });
			return Promise.resolve({ executionContextId: contextId });
		}
		if (method === "Runtime.evaluate") {
			if (tab.errorOnEvaluate) {
				return Promise.resolve({
					exceptionDetails: {
						text: tab.errorOnEvaluate,
						exception: { description: tab.errorOnEvaluate },
					},
				});
			}

			const expr = typeof params?.expression === "string" ? params.expression : "";
			// Match location.hash assignment, e.g. targetHash = "#..."
			const targetHashMatch = /targetHash\s*=\s*(".*?")/.exec(expr);
			if (targetHashMatch) {
				const targetHash = JSON.parse(targetHashMatch[1]) as string;

				// Target specific frame from contextId or explicit frameId
				const contextId = typeof params?.contextId === "number" ? params.contextId : undefined;
				const contextMapping = contextId ? this.contextToFrame.get(contextId) : undefined;
				const targetFrameId =
					contextMapping?.frameId ?? (typeof params?.frameId === "string" ? params.frameId : tab.rootFrameId);

				const targetChild = tab.childFrames.find(cf => cf.id === targetFrameId);

				if (targetChild) {
					const childBase = targetChild.url.split("#")[0];
					targetChild.url = childBase + targetHash;
					this.emitCdpEvent(target, "Page.navigatedWithinDocument", {
						frameId: targetChild.id,
						url: targetChild.url,
					});
					return Promise.resolve({
						result: {
							type: "string",
							value: targetChild.url,
						},
					});
				}

				const base = tab.url.split("#")[0];
				tab.url = base + targetHash;

				// Emulate Chrome's native Page.navigatedWithinDocument
				this.emitCdpEvent(target, "Page.navigatedWithinDocument", {
					frameId: tab.rootFrameId,
					url: tab.url,
				});

				return Promise.resolve({
					result: {
						type: "string",
						value: tab.url,
					},
				});
			}

			return Promise.resolve({
				result: {
					type: "string",
					value: "ok",
				},
			});
		}

		return Promise.resolve({});
	}
}

/**
 * Creates a sandboxed Chrome API object running against the simulated browser fixture.
 */
function createMockChrome(fixture: SimulatedBrowserFixture): Record<string, unknown> {
	const storageData = new Map<string, unknown>();
	const sessionStorageData = new Map<string, unknown>();

	return {
		storage: {
			local: {
				get: (query: Record<string, unknown>) => {
					const res: Record<string, unknown> = {};
					for (const [k, def] of Object.entries(query)) {
						res[k] = storageData.has(k) ? storageData.get(k) : def;
					}
					return Promise.resolve(res);
				},
				set: (items: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(items)) storageData.set(k, v);
					return Promise.resolve();
				},
			},
			session: {
				get: (query: Record<string, unknown>) => {
					const res: Record<string, unknown> = {};
					for (const [k, def] of Object.entries(query)) {
						res[k] = sessionStorageData.has(k) ? sessionStorageData.get(k) : def;
					}
					return Promise.resolve(res);
				},
				set: (items: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(items)) sessionStorageData.set(k, v);
					return Promise.resolve();
				},
			},
			onChanged: {
				addListener: () => {},
			},
		},
		tabs: {
			query: () => {
				const list = Array.from(fixture.tabs.values()).map(t => ({
					id: t.tabId,
					url: t.url,
					title: t.title,
					active: t.active,
					windowId: t.windowId,
					pinned: t.pinned,
					groupId: t.groupId,
				}));
				return Promise.resolve(list);
			},
			get: (tabId: number) => {
				const t = fixture.tabs.get(tabId);
				if (!t) return Promise.reject(new Error(`Tab ${tabId} not found`));
				return Promise.resolve({
					id: t.tabId,
					url: t.url,
					title: t.title,
					active: t.active,
					windowId: t.windowId,
					pinned: t.pinned,
					groupId: t.groupId,
				});
			},
			create: (props: { url?: string }) => {
				const targetUrl = props?.url ?? "";
				if (/^about:blank#/i.test(targetUrl)) {
					fixture.lethalAttempts.push({
						api: "chrome.tabs.create",
						url: targetUrl,
						context: "chrome.tabs.create",
					});
					throw new Error(`${FATAL_NATIVE_CRASH_PREFIX} for "${targetUrl}"`);
				}
				const tab = fixture.addTab({ url: targetUrl });
				return Promise.resolve({
					id: tab.tabId,
					url: tab.url,
					title: tab.title,
					active: tab.active,
					windowId: tab.windowId,
					pinned: tab.pinned,
					groupId: tab.groupId,
				});
			},
			update: (tabId: number, props: { url?: string; active?: boolean }) => {
				const t = fixture.tabs.get(tabId);
				if (!t) return Promise.reject(new Error(`Tab ${tabId} not found`));
				if (typeof props.url === "string") {
					if (/^about:blank#/i.test(props.url)) {
						fixture.lethalAttempts.push({
							api: "chrome.tabs.update",
							url: props.url,
							context: "chrome.tabs.update",
						});
						throw new Error(`${FATAL_NATIVE_CRASH_PREFIX} for "${props.url}"`);
					}
					t.url = props.url;
				}
				if (props.active !== undefined) t.active = props.active;
				return Promise.resolve({
					id: t.tabId,
					url: t.url,
					title: t.title,
					active: t.active,
					windowId: t.windowId,
					pinned: t.pinned,
					groupId: t.groupId,
				});
			},
			remove: (tabId: number) => {
				fixture.tabs.delete(tabId);
				return Promise.resolve();
			},
			group: () => Promise.resolve(10),
			ungroup: () => Promise.resolve(),
			onCreated: { addListener: () => {} },
			onUpdated: { addListener: () => {} },
			onActivated: { addListener: () => {} },
			onRemoved: { addListener: () => {} },
		},
		tabGroups: {
			query: () => Promise.resolve([]),
			group: () => Promise.resolve(10),
			update: () => Promise.resolve({ id: 10 }),
		},
		windows: {
			update: () => Promise.resolve({ id: 1 }),
		},
		debugger: {
			getTargets: () => {
				const targets = Array.from(fixture.tabs.values()).map(t => ({
					tabId: t.tabId,
					attached: true,
					type: "page",
				}));
				return Promise.resolve(targets);
			},
			attach: () => Promise.resolve(),
			detach: () => Promise.resolve(),
			sendCommand: (
				target: { tabId?: number; sessionId?: string },
				method: string,
				params?: Record<string, unknown>,
			) => fixture.handleSendCommand(target, method, params),
			onEvent: {
				addListener: (
					listener: (
						source: { tabId?: number; sessionId?: string },
						method: string,
						params: Record<string, unknown>,
					) => void,
				) => {
					fixture.cdpEventListeners.push(listener);
				},
			},
			onDetach: {
				addListener: () => {},
			},
		},
		action: {
			setBadgeText: () => Promise.resolve(),
			setBadgeBackgroundColor: () => Promise.resolve(),
			onClicked: { addListener: () => {} },
		},
		alarms: {
			create: () => {},
			onAlarm: { addListener: () => {} },
		},
		runtime: {
			openOptionsPage: () => {},
			onInstalled: { addListener: () => {} },
			onStartup: { addListener: () => {} },
		},
	};
}

export interface WorkerRpcResult {
	t: "rpcResult";
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string;
}

interface MockWebSocketInstance {
	readyState: number;
	onopen: ((event?: unknown) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onclose: ((event?: unknown) => void) | null;
	onerror: ((event?: unknown) => void) | null;
	send(data: string): void;
	close(): void;
}

export class WorkerTestHarness {
	readonly fixture: SimulatedBrowserFixture;
	readonly cdpEvents: CdpEventRecord[] = [];
	readonly rpcResults = new Map<number, WorkerRpcResult>();

	#workerWs: MockWebSocketInstance | null = null;
	#rpcSeq = 0;
	#helloPromiseResolvers = Promise.withResolvers<Record<string, unknown>>();
	#rpcDeferreds = new Map<number, { resolve: (res: WorkerRpcResult) => void; reject: (err: unknown) => void }>();

	constructor(workerSourceCode: string, fixture?: SimulatedBrowserFixture) {
		this.fixture = fixture ?? new SimulatedBrowserFixture();

		// Mock WebSocket class created for this private VM
		const self = this;
		class MockWebSocket implements MockWebSocketInstance {
			static readonly OPEN = 1;
			static readonly CONNECTING = 0;
			static readonly CLOSING = 2;
			static readonly CLOSED = 3;

			readyState = MockWebSocket.CONNECTING;
			onopen: ((event?: unknown) => void) | null = null;
			onmessage: ((event: { data: string }) => void) | null = null;
			onclose: ((event?: unknown) => void) | null = null;
			onerror: ((event?: unknown) => void) | null = null;

			constructor(_url: string) {
				self.#workerWs = this;
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.onopen?.({});
				});
			}

			send(data: string): void {
				try {
					const msg = JSON.parse(data) as Record<string, unknown>;
					if (msg.t === "hello") {
						self.#helloPromiseResolvers.resolve(msg);
					} else if (msg.t === "rpcResult") {
						const typedMsg = msg as unknown as WorkerRpcResult;
						self.rpcResults.set(typedMsg.id, typedMsg);
						const deferred = self.#rpcDeferreds.get(typedMsg.id);
						if (deferred) {
							self.#rpcDeferreds.delete(typedMsg.id);
							deferred.resolve(typedMsg);
						}
					} else if (msg.t === "cdpEvent") {
						self.cdpEvents.push({
							tabId: typeof msg.tabId === "number" ? msg.tabId : 1,
							sessionId: typeof msg.sessionId === "string" ? msg.sessionId : undefined,
							method: typeof msg.method === "string" ? msg.method : "",
							params: (msg.params as Record<string, unknown>) ?? {},
						});
					}
				} catch {
					// Ignore parse error
				}
			}

			close(): void {
				this.readyState = MockWebSocket.CLOSED;
				this.onclose?.({});
			}
		}

		// Private VM sandbox
		const sandbox = {
			chrome: createMockChrome(this.fixture),
			WebSocket: MockWebSocket,
			navigator: {
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
			},
			crypto: {
				randomUUID: () => "00000000-0000-4000-8000-000000000001",
			},
			Date: {
				now: () => Date.now() + this.fixture.virtualTimeOffset,
			},
			setTimeout: (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
				if (this.fixture.fastForwardTime) {
					this.fixture.virtualTimeOffset += 500;
					return setTimeout(fn, 1, ...args);
				}
				return setTimeout(fn, delay, ...args);
			},
			clearTimeout,
			setInterval,
			clearInterval,
			console: {
				log: () => {},
				error: () => {},
				warn: () => {},
				info: () => {},
			},
			Promise,
			Map,
			Set,
			JSON,
			Error,
			Number,
			String,
			Object,
			Array,
		};

		const context = vm.createContext(sandbox);
		vm.runInContext(workerSourceCode, context);
	}

	async waitForHello(timeoutMs = 1000): Promise<Record<string, unknown>> {
		const { promise: timerPromise, reject } = Promise.withResolvers<never>();
		const timer = setTimeout(() => reject(new Error("Timeout waiting for worker hello handshake")), timeoutMs);
		try {
			return await Promise.race([this.#helloPromiseResolvers.promise, timerPromise]);
		} finally {
			clearTimeout(timer);
		}
	}

	async sendRpc(rpc: { op: string; [key: string]: unknown }, timeoutMs = 2500): Promise<WorkerRpcResult> {
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<WorkerRpcResult>();
		this.#rpcDeferreds.set(id, { resolve, reject });

		const msg = { t: "rpc", id, ...rpc };
		if (!this.#workerWs || this.#workerWs.readyState !== 1) {
			throw new Error("Worker WebSocket is not connected");
		}
		this.#workerWs.onmessage?.({ data: JSON.stringify(msg) });

		const timer = setTimeout(() => {
			this.#rpcDeferreds.delete(id);
			reject(new Error(`Timeout waiting for RPC response for op=${rpc.op} id=${id}`));
		}, timeoutMs);

		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Loads the bundled worker code from extension assets or builds it if available.
 */
function getBundledWorkerSource(): string {
	if (process.env.TEST_WORKER_SOURCE_FILE && fs.existsSync(process.env.TEST_WORKER_SOURCE_FILE)) {
		return fs.readFileSync(process.env.TEST_WORKER_SOURCE_FILE, "utf-8");
	}
	const assetPath = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets/background.js.txt");
	if (!fs.existsSync(assetPath)) {
		throw new Error(`Extension asset background.js.txt not found at ${assetPath}`);
	}
	return fs.readFileSync(assetPath, "utf-8");
}

describe("Browser relay worker navigation behavioral regression", () => {
	it("preserves root frame and resolves same-document navigation without loaderId", async () => {
		const workerSource = getBundledWorkerSource();
		const harness = new WorkerTestHarness(workerSource);
		await harness.waitForHello();

		// Tab 1 is currently at "about:blank"
		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "about:blank#relay-proof-section" },
		});

		// Safe navigation must not trigger lethal native crash and must succeed
		expect(harness.fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(true);

		const result = rpcRes.result as { frameId: string; loaderId?: string };
		expect(result.frameId).toBe("FRAME_ROOT_1");
		// Crucial: same-document navigation must NOT return loaderId
		expect(result.loaderId).toBeUndefined();

		// Resulting document URL in fixture has the hash
		const tab = harness.fixture.tabs.get(1);
		expect(tab?.url).toBe("about:blank#relay-proof-section");

		// Page.navigatedWithinDocument event emitted for Puppeteer lifecycle watcher
		const withinDocEvent = harness.cdpEvents.find(e => e.method === "Page.navigatedWithinDocument");
		expect(withinDocEvent).toBeDefined();
		expect(withinDocEvent?.params.url).toBe("about:blank#relay-proof-section");
	});

	it("resolves same-hash navigation cleanly without cross-document reload", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		const tab = fixture.tabs.get(1)!;
		tab.url = "about:blank#relay-proof-existing";

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "about:blank#relay-proof-existing" },
		});

		expect(fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(true);
		const result = rpcRes.result as { frameId: string; loaderId?: string };
		expect(result.frameId).toBe("FRAME_ROOT_1");
		expect(result.loaderId).toBeUndefined();
		expect(tab.url).toBe("about:blank#relay-proof-existing");
	});

	it("commits canonical blank before setting hash and preserves loaderId lifecycle for cross-document navigation", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		// Tab 1 starts at a web URL
		const tab = fixture.tabs.get(1)!;
		tab.url = "https://example.com/start-page";
		tab.loaderId = "LOADER_INITIAL";

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "about:blank#relay-proof-crossdoc" },
		});

		// Safe navigation must not trigger lethal native crash and must succeed
		expect(fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(true);

		const result = rpcRes.result as { frameId: string; loaderId?: string };
		expect(result.frameId).toBe("FRAME_ROOT_1");
		// Crucial: cross-document navigation MUST preserve loaderId
		expect(result.loaderId).toBeDefined();
		expect(result.loaderId).not.toBe("LOADER_INITIAL");

		// Final URL has hash
		expect(tab.url).toBe("about:blank#relay-proof-crossdoc");

		// Check sequence of CDP commands: Page.navigate with clean "about:blank" occurred before Runtime.evaluate
		const navCommandIndex = fixture.cdpCommands.findIndex(
			c => c.method === "Page.navigate" && c.params.url === "about:blank",
		);
		const evalCommandIndex = fixture.cdpCommands.findIndex(c => c.method === "Runtime.evaluate");
		expect(navCommandIndex).toBeGreaterThanOrEqual(0);
		expect(evalCommandIndex).toBeGreaterThan(navCommandIndex);
	});

	it("rejects missing explicit frameId without mutating root document", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		const tab = fixture.tabs.get(1)!;
		tab.url = "https://example.com/root-doc";

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "about:blank#fail-frame", frameId: "NON_EXISTENT_FRAME_ID" },
		});

		expect(fixture.lethalAttempts).toHaveLength(0);
		// Missing frame must reject
		expect(rpcRes.ok).toBe(false);
		expect(rpcRes.error).toContain("NON_EXISTENT_FRAME_ID");

		// Root document must NOT be changed
		expect(tab.url).toBe("https://example.com/root-doc");
	});

	it("commit timeout rejects and does not evaluate hash on old document", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		fixture.fastForwardTime = true;
		const tab = fixture.tabs.get(1)!;
		tab.url = "https://example.com/slow-page";
		tab.stallCommit = true;

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "about:blank#stalled-commit" },
		});

		expect(fixture.lethalAttempts).toHaveLength(0);
		// Must reject with timeout error
		expect(rpcRes.ok).toBe(false);
		expect(rpcRes.error).toContain("Timed out waiting for frame");

		// Crucial: Old document must NOT have been evaluated with the hash
		expect(tab.url).not.toContain("#stalled-commit");
	});

	it("surfaces isolated world or runtime evaluate failures without corrupting document", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		const tab = fixture.tabs.get(1)!;
		tab.errorOnEvaluate = "SecurityError: The operation is insecure.";

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "about:blank#eval-failure-proof" },
		});

		expect(fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(false);
		expect(rpcRes.error).toContain("SecurityError: The operation is insecure.");
	});

	it("handles child sessions and routes commands without lethal attempts", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		const tab = fixture.tabs.get(1)!;
		tab.childFrames.push({
			id: "FRAME_CHILD_2",
			url: "about:blank",
			loaderId: "LOADER_CHILD_1",
		});

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			sessionId: "SESSION_CHILD_42",
			method: "Page.navigate",
			params: { url: "about:blank#generic-child-hash", frameId: "FRAME_CHILD_2" },
		});

		expect(fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(true);
		const result = rpcRes.result as { frameId: string };
		expect(result.frameId).toBe("FRAME_CHILD_2");

		const child = tab.childFrames.find(cf => cf.id === "FRAME_CHILD_2");
		expect(child?.url).toBe("about:blank#generic-child-hash");
	});

	it("passes normal HTTPS navigations through unaffected with standard loaderId", async () => {
		const workerSource = getBundledWorkerSource();
		const harness = new WorkerTestHarness(workerSource);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "https://example.com/target-page" },
		});

		expect(harness.fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(true);

		const result = rpcRes.result as { frameId: string; loaderId: string };
		expect(result.frameId).toBe("FRAME_ROOT_1");
		expect(result.loaderId).toBeDefined();

		const tab = harness.fixture.tabs.get(1);
		expect(tab?.url).toBe("https://example.com/target-page");
	});

	it("surfaces navigation failures honestly through RPC output", async () => {
		const workerSource = getBundledWorkerSource();
		const fixture = new SimulatedBrowserFixture();
		const tab = fixture.tabs.get(1)!;
		tab.errorOnNavigate = "net::ERR_CONNECTION_REFUSED";

		const harness = new WorkerTestHarness(workerSource, fixture);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "send",
			tabId: 1,
			method: "Page.navigate",
			params: { url: "https://invalid.domain.test/" },
		});

		expect(rpcRes.ok).toBe(true);
		const result = rpcRes.result as { frameId: string; errorText?: string };
		expect(result.errorText).toBe("net::ERR_CONNECTION_REFUSED");
	});

	it("preserves requested fragment on createTab without native crash", async () => {
		const workerSource = getBundledWorkerSource();
		const harness = new WorkerTestHarness(workerSource);
		await harness.waitForHello();

		const rpcRes = await harness.sendRpc({
			op: "createTab",
			url: "about:blank#preserved-proof-fragment",
		});

		expect(harness.fixture.lethalAttempts).toHaveLength(0);
		expect(rpcRes.ok).toBe(true);
		const result = rpcRes.result as { tab: { url: string; tabId: number } };
		expect(result.tab.url).toBe("about:blank#preserved-proof-fragment");
	});
});
