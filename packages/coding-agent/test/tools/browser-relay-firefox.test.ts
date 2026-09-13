import { describe, expect, it } from "bun:test";
import type { Page } from "puppeteer-core";
import { acquireBrowser, releaseBrowser, type FirefoxRelayBrowserHandle } from "../../src/tools/browser/registry";
import type { WorkerInbound, WorkerOutbound } from "../../src/tools/browser/tab-protocol";
import { DEFAULT_FIREFOX_BIDI_URL, validateFirefoxWebSocketUrl } from "../../src/tools/browser/relay/firefox";
import {
	acquireTab,
	FirefoxSharedTabRegistry,
	forceKillTab,
	getFirefoxSharedTabsForTest,
	getTabsMapForTest,
	handleTabMessage,
	releaseTab,
	runInTab,
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
	it("serializes sibling aliases using localhost and its IPv4 loopback endpoint", async () => {
		const listeners = new Set<(message: WorkerOutbound) => void>();
		const started = Promise.withResolvers<void>();
		const order: string[] = [];
		let runMessage: Extract<WorkerInbound, { type: "run" }> | undefined;
		const browser = (await acquireBrowser(
			{ kind: "firefox-relay", webSocketUrl: "ws://127.0.0.1:9337/session" },
			{ cwd: "/tmp" },
		)) as FirefoxRelayBrowserHandle;
		const siblingBrowser = await acquireBrowser(
			{ kind: "firefox-relay", webSocketUrl: "ws://localhost:9337/session" },
			{ cwd: "/tmp" },
		);
		browser.refCount = 1;
		const info = { url: "about:blank", viewport: { width: 1280, height: 720 }, targetId: "shared" };
		const worker: WorkerHandle = {
			mode: "inline",
			send(message) {
				if (message.type === "select") {
					if (message.name === "waiting-open") order.push("select");
					queueMicrotask(() => {
						for (const listener of listeners) listener({ type: "selected", id: message.id, info });
					});
				} else if (message.type === "run") {
					runMessage = message;
					order.push("run");
					started.resolve();
				} else if (message.type === "close") {
					queueMicrotask(() => {
						for (const listener of listeners) listener({ type: "closed" });
					});
				}
			},
			onMessage(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => {},
			async terminate() {},
		};
		const first = createFirefoxTab("active-open", browser, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		worker.onMessage(message => handleTabMessage(first, message));
		getFirefoxSharedTabsForTest().set(first);
		try {
			const running = runInTab(first.name, {
				code: "return 1",
				timeoutMs: 1000,
				session: { cwd: "/tmp", settings: { get: () => undefined } } as never,
			});
			void running.catch(() => {});
			await started.promise;
			const opening = acquireTab("waiting-open", siblingBrowser, { timeoutMs: 1000 });
			void opening.catch(() => {});
			await Bun.sleep(0);
			expect(order).toEqual(["run"]);
			if (!runMessage) throw new Error("Expected run to start");
			order.push("finished");
			handleTabMessage(first, {
				type: "result",
				id: runMessage.id,
				ok: true,
				payload: { returnValue: 1, displays: [], screenshots: [] },
			});
			await running;
			await expect(opening).resolves.toMatchObject({ created: true });
			expect(order).toEqual(["run", "finished", "select"]);
		} finally {
			await forceKillTab(first.name, "test cleanup", { sharedFirefoxWorker: true });
			await releaseBrowser(siblingBrowser, { kill: false });
		}
	});

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
					'  - text: "Hello: \\"world\\""',
					'    - /url: "/ignored"',
					'    - /placeholder: "Ignored hint"',
					'    - /value: "Ignored value"',
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
			{ ref: undefined, role: "text", name: 'Hello: "world"', states: [] },
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

	it("refreshes same-target aliases from a Firefox selected acknowledgement", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				if (msg.type !== "select") return;
				for (const listener of listeners) {
					listener({
						type: "selected",
						id: msg.id,
						info: {
							url: "https://updated.example/path",
							title: "Updated title",
							viewport: { width: 1280, height: 720 },
							targetId: "shared-context",
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
		};
		const browser = createFirefoxHandle("ws://127.0.0.1:9333/session");
		const first = createFirefoxTab("selected-context-first", browser, worker);
		const second = createFirefoxTab("selected-context-second", browser, worker);
		const unrelated = createFirefoxTab("selected-context-unrelated", browser, worker);
		first.targetId = "shared-context";
		second.targetId = "shared-context";
		unrelated.targetId = "unrelated-context";
		const unrelatedInfo = unrelated.info;
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);
		tabs.set(unrelated.name, unrelated);

		try {
			const selected = await selectFirefoxWorkerTab(worker, {
				name: second.name,
				targetId: second.targetId,
				timeoutMs: 1_000,
			});

			expect(selected.url).toBe("https://updated.example/path");
			expect(first.info.url).toBe("https://updated.example/path");
			expect(first.info.title).toBe("Updated title");
			expect(second.info.url).toBe("https://updated.example/path");
			expect(second.info.title).toBe("Updated title");
			expect(unrelated.info).toBe(unrelatedInfo);
		} finally {
			tabs.delete(first.name);
			tabs.delete(second.name);
			tabs.delete(unrelated.name);
		}
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

	for (const caughtResult of [false, true])
		it(`invalidates Firefox aliases after ${caughtResult ? "caught navigation cleanup" : "an inline recoverable worker failure"}`, async () => {
			const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
			let terminations = 0;
			const worker: WorkerHandle = {
				mode: caughtResult ? "worker" : "inline",
				send: msg => {
					if (msg.type === "run") {
						queueMicrotask(() => {
							if (caughtResult) {
								handleTabMessage(first, {
									type: "result",
									id: msg.id,
									ok: true,
									payload: { returnValue: 1, displays: [], screenshots: [], recoverTab: true },
								});
								return;
							}
							handleTabMessage(first, {
								type: "result",
								id: msg.id,
								ok: false,
								error: {
									name: "ToolError",
									message: "request interception cleanup failed",
									isAbort: false,
									isToolError: true,
									recoverTab: true,
								},
							});
						});
					} else if (msg.type === "close") {
						queueMicrotask(() => {
							for (const listener of listeners) listener({ type: "closed" });
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
			};
			const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
			endpoint.refCount = 2;
			const first = createFirefoxTab("firefox-recoverable-first", endpoint, worker);
			const second = createFirefoxTab("firefox-recoverable-second", endpoint, worker);
			const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
			tabs.set(first.name, first);
			tabs.set(second.name, second);

			const run = runInTab(first.name, {
				code: "return 1",
				timeoutMs: 1_000,
				session: { cwd: "/tmp", settings: { get: () => undefined } } as never,
			});
			if (caughtResult) await expect(run).resolves.toMatchObject({ returnValue: 1 });
			else await expect(run).rejects.toThrow("request interception cleanup failed");

			expect(terminations).toBe(1);
			expect(first.state).toBe("dead");
			expect(second.state).toBe("dead");
			expect(tabs.has(first.name)).toBe(false);
			expect(tabs.has(second.name)).toBe(false);
			expect(endpoint.refCount).toBe(0);
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
	it("keeps a registered sibling selectable after alias close", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		let terminated = false;
		let terminations = 0;
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				if (terminated) throw new Error("worker terminated");
				if (msg.type !== "select") return;
				queueMicrotask(() => {
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
				});
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => {
				terminated = true;
				terminations++;
			},
		};
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const closed = createFirefoxTab("firefox-closed-alias", endpoint, worker);
		const surviving = createFirefoxTab("firefox-surviving-alias", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(closed.name, closed);
		tabs.set(surviving.name, surviving);
		try {
			await releaseTab(closed.name);
			expect(tabs.has(closed.name)).toBe(false);
			const selected = await selectFirefoxWorkerTab(worker, {
				name: surviving.name,
				targetMatcher: "surviving",
				timeoutMs: 1_000,
			});
			expect(selected.targetId).toBe("surviving");
			expect(terminations).toBe(0);
		} finally {
			if (tabs.has(surviving.name))
				await forceKillTab(surviving.name, "test cleanup", { sharedFirefoxWorker: true });
		}
	});

	it("times out while waiting for a sibling reservation without later closing the alias", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sent: string[] = [];
		let selectedId: string | undefined;
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				sent.push(msg.type);
				if (msg.type === "select") selectedId = msg.id;
				if (msg.type === "close") {
					queueMicrotask(() => {
						for (const listener of listeners) listener({ type: "closed" });
					});
				}
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		};
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const closing = createFirefoxTab("firefox-timeout-close", endpoint, worker);
		const busy = createFirefoxTab("firefox-timeout-busy", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(closing.name, closing);
		tabs.set(busy.name, busy);
		const selection = selectFirefoxWorkerTab(worker, {
			name: busy.name,
			targetId: busy.targetId,
			timeoutMs: 1_000,
		});
		await Bun.sleep(0);

		const startedAt = performance.now();
		await expect(releaseTab(closing.name, { timeoutMs: 10 })).rejects.toThrow("Timed out");
		expect(performance.now() - startedAt).toBeLessThan(250);
		expect(tabs.has(closing.name)).toBe(true);
		expect(closing.state).toBe("alive");
		expect(sent).not.toContain("release-runtime");

		for (const listener of listeners) {
			listener({
				type: "selected",
				id: selectedId!,
				info: busy.info,
			});
		}
		await selection;
		await Bun.sleep(20);

		expect(tabs.has(closing.name)).toBe(true);
		expect(closing.state).toBe("alive");
		expect(sent).not.toContain("release-runtime");
		await forceKillTab(closing.name, "test cleanup", { sharedFirefoxWorker: true });
	});

	for (const operation of ["close", "replace"] as const)
		it(`does not ${operation} a Firefox alias after its queued caller is canceled`, async () => {
			const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
			const sent: string[] = [];
			let selectedId: string | undefined;
			const worker: WorkerHandle = {
				mode: "inline",
				send: msg => {
					sent.push(msg.type);
					if (msg.type === "select") selectedId = msg.id;
				},
				onMessage: listener => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				onError: () => () => undefined,
				terminate: async () => undefined,
			};
			const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
			endpoint.refCount = 2;
			const closing = createFirefoxTab("firefox-canceled-close", endpoint, worker);
			const sibling = createFirefoxTab("firefox-canceled-sibling", endpoint, worker);
			const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
			tabs.set(closing.name, closing);
			tabs.set(sibling.name, sibling);
			const selection = selectFirefoxWorkerTab(worker, {
				name: sibling.name,
				targetId: sibling.targetId,
				timeoutMs: 1_000,
			});
			await Bun.sleep(0);
			const controller = new AbortController();
			const close =
				operation === "close"
					? releaseTab(closing.name, { signal: controller.signal, timeoutMs: 1_000 })
					: acquireTab(closing.name, endpoint, { dialogs: "accept", signal: controller.signal, timeoutMs: 1_000 });
			await Bun.sleep(0);
			controller.abort();
			await expect(close).rejects.toThrow();
			for (const listener of listeners) {
				listener({ type: "selected", id: selectedId!, info: sibling.info });
			}
			await selection;
			await Bun.sleep(0);
			expect(tabs.has(closing.name)).toBe(true);
			expect(closing.state).toBe("alive");
			expect(sent).not.toContain("release-runtime");
			await forceKillTab(closing.name, "test cleanup", { sharedFirefoxWorker: true });
			await forceKillTab(sibling.name, "test cleanup", { sharedFirefoxWorker: true });
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

	it("bounds runInTab reservation by the caller deadline without closing the healthy alias", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		let selectedId: string | undefined;
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				if (msg.type === "select") selectedId = msg.id;
				if (msg.type === "close")
					queueMicrotask(() => {
						for (const listener of listeners) listener({ type: "closed" });
					});
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		};
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const owner = createFirefoxTab("firefox-run-owner", endpoint, worker);
		const waiting = createFirefoxTab("firefox-run-waiting", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(owner.name, owner);
		tabs.set(waiting.name, waiting);
		const selection = selectFirefoxWorkerTab(worker, {
			name: owner.name,
			targetId: owner.targetId,
			timeoutMs: 1_000,
		});
		await Bun.sleep(0);
		const startedAt = performance.now();
		await expect(
			runInTab(waiting.name, {
				code: "return 1",
				timeoutMs: 50,
				deadlineStartMs: startedAt - 40,
				session: { cwd: "/tmp", settings: { get: () => undefined } } as never,
			}),
		).rejects.toThrow(/Timed out after [\d.]+ms waiting for Firefox worker reservation/);
		expect(tabs.get(owner.name)?.state).toBe("alive");
		expect(tabs.get(waiting.name)?.state).toBe("alive");
		for (const listener of listeners) {
			listener({ type: "selected", id: selectedId!, info: owner.info });
		}
		await selection;
		await forceKillTab(owner.name, "test cleanup", { sharedFirefoxWorker: true });
		await forceKillTab(waiting.name, "test cleanup", { sharedFirefoxWorker: true });
	});
	it("passes only the caller deadline remainder to Firefox execution after reservation", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		let runTimeoutMs: number | undefined;
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				if (msg.type === "select") {
					setTimeout(() => {
						for (const listener of listeners) listener({ type: "selected", id: msg.id, info: owner.info });
					}, 25);
				} else if (msg.type === "run") {
					runTimeoutMs = msg.timeoutMs;
					queueMicrotask(() =>
						handleTabMessage(waiting, {
							type: "result",
							id: msg.id,
							ok: true,
							payload: { displays: [], returnValue: 1, screenshots: [] },
						}),
					);
				}
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		};
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const owner = createFirefoxTab("firefox-budget-owner", endpoint, worker);
		const waiting = createFirefoxTab("firefox-budget-waiting", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(owner.name, owner);
		tabs.set(waiting.name, waiting);
		const selection = selectFirefoxWorkerTab(worker, {
			name: owner.name,
			targetId: owner.targetId,
			timeoutMs: 1_000,
		});
		await expect(
			runInTab(waiting.name, {
				code: "return 1",
				timeoutMs: 100,
				session: { cwd: "/tmp", settings: { get: () => undefined } } as never,
			}),
		).resolves.toMatchObject({ returnValue: 1 });
		expect(runTimeoutMs).toBeGreaterThan(0);
		expect(runTimeoutMs).toBeLessThan(100);
		await selection;
		await forceKillTab(owner.name, "test cleanup", { sharedFirefoxWorker: true });
		await forceKillTab(waiting.name, "test cleanup", { sharedFirefoxWorker: true });
	});

	it("aborts nested host tools before force-killing the shared worker", async () => {
		const worker = {
			mode: "inline",
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const controller = new AbortController();
		let rejectedAfterAbort = false;
		const pending = new Map([
			[
				"busy-run",
				{
					resolve: () => undefined,
					reject: () => {
						rejectedAfterAbort = controller.signal.aborted;
					},
					session: {},
					toolCalls: new Map([["nested-host-tool", controller]]),
				},
			],
		]) as unknown as WorkerTabSession["pending"];
		const first = createFirefoxTab("firefox-force-first", endpoint, worker);
		const second = createFirefoxTab("firefox-force-second", endpoint, worker);
		first.pending = pending;
		second.pending = pending;
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		await forceKillTab(first.name, "shared worker failed", { sharedFirefoxWorker: true });

		expect(controller.signal.aborted).toBe(true);
		expect(rejectedAfterAbort).toBe(true);
		expect(tabs.has(first.name)).toBe(false);
		expect(tabs.has(second.name)).toBe(false);
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
