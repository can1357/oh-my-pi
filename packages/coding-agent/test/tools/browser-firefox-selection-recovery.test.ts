import { afterEach, describe, expect, it } from "bun:test";
import type { FirefoxRelayBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type {
	ReadyInfo,
	RunErrorPayload,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	forceKillTab,
	getFirefoxSharedTabsForTest,
	getTabsMapForTest,
	releaseAllTabs,
	type AcquireTabResult,
	type WorkerHandle,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
class FakeSelectionWorker implements WorkerHandle {
	readonly mode = "inline" as const;
	readonly sent: WorkerInbound[] = [];
	terminateCalls = 0;
	#handlers = new Set<(message: WorkerOutbound) => void>();
	send(message: WorkerInbound): void {
		this.sent.push(message);
	}
	onMessage(handler: (message: WorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}
	onError(): () => void {
		return () => undefined;
	}
	async terminate(): Promise<void> {
		this.terminateCalls++;
	}
	failSelection(error: RunErrorPayload): void {
		const request = this.sent.at(-1);
		if (!request || request.type !== "select") throw new Error("Expected pending selection");
		for (const handler of this.#handlers) handler({ type: "select-failed", id: request.id, error });
	}
	completeSelection(info: ReadyInfo): void {
		const request = this.sent.at(-1);
		if (!request || request.type !== "select") throw new Error("Expected pending selection");
		for (const handler of this.#handlers) handler({ type: "selected", id: request.id, info });
	}
}
function makeBrowser(): FirefoxRelayBrowserHandle {
	return {
		key: "firefox-relay:ws://127.0.0.1:9222/session",
		kind: { kind: "firefox-relay", webSocketUrl: "ws://127.0.0.1:9222/session" },
		webSocketUrl: "ws://127.0.0.1:9222/session",
		refCount: 2,
	};
}
function makeTab(name: string, browser: FirefoxRelayBrowserHandle, worker: WorkerHandle): WorkerTabSession {
	return {
		name,
		browser,
		worker,
		backend: "worker",
		targetId: `${name}-target`,
		state: "alive",
		info: { url: "about:blank", title: name, viewport: { width: 1280, height: 720 }, targetId: `${name}-target` },
		pending: new Map(),
		kindTag: "firefox-relay",
		activateForScreenshot: false,
	} as WorkerTabSession;
}
describe("Firefox shared worker selection recovery", () => {
	afterEach(() => {
		(getTabsMapForTest() as Map<string, WorkerTabSession>).clear();
	});
	it("releases an unpublished selected alias when its caller cancels", async () => {
		const worker = new FakeSelectionWorker();
		const browser = makeBrowser();
		const primary = makeTab("primary", browser, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(primary.name, primary);
		getFirefoxSharedTabsForTest().set(primary);
		const abort = new AbortController();
		const opening = acquireTab("unpublished", browser, {
			timeoutMs: 1000,
			dialogs: "accept",
			signal: abort.signal,
		});
		await Bun.sleep(0);
		worker.completeSelection(primary.info);
		abort.abort();
		await expect(opening).rejects.toThrow();
		expect(worker.sent).toContainEqual({ type: "release-runtime", name: "unpublished" });
		expect(tabs.has("unpublished")).toBe(false);
		expect(primary.state).toBe("alive");
	});

	it("releases an unpublished alias after an ordinary navigation failure", async () => {
		const worker = new FakeSelectionWorker();
		const browser = makeBrowser();
		const primary = makeTab("primary", browser, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(primary.name, primary);
		getFirefoxSharedTabsForTest().set(primary);
		const opening = acquireTab("failed-alias", browser, {
			dialogs: "accept",
			url: "https://invalid.test",
			timeoutMs: 1000,
		});
		await Bun.sleep(0);
		worker.failSelection({ name: "Error", message: "DNS lookup failed", isToolError: false, isAbort: false });
		await expect(opening).rejects.toThrow("DNS lookup failed");
		expect(worker.sent).toContainEqual({ type: "release-runtime", name: "failed-alias" });
		expect(tabs.has("failed-alias")).toBe(false);
		expect(primary.state).toBe("alive");
	});

	it("invalidates every alias when acquireTab selection fails recoverably", async () => {
		const worker = new FakeSelectionWorker();
		const browser = makeBrowser();
		const primary = makeTab("primary", browser, worker);
		const alias = makeTab("alias", browser, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(primary.name, primary);
		tabs.set(alias.name, alias);
		getFirefoxSharedTabsForTest().set(primary);
		const opening = acquireTab("new-alias", browser, { target: "requested", timeoutMs: 1_000 });
		await Bun.sleep(0);
		worker.failSelection({
			name: "TimeoutError",
			message: "Selection navigation timed out",
			isToolError: true,
			isAbort: false,
			recoverTab: true,
		});
		await expect(opening).rejects.toThrow("Selection navigation timed out");
		expect(worker.terminateCalls).toBe(1);
		expect(primary.state).toBe("dead");
		expect(alias.state).toBe("dead");
		expect(tabs.has("primary")).toBe(false);
		expect(tabs.has("alias")).toBe(false);
		expect(browser.refCount).toBe(0);
	});
	it("blocks a same-endpoint acquisition until close-all finishes shared worker teardown", async () => {
		const teardown = Promise.withResolvers<void>();
		const terminationStarted = Promise.withResolvers<void>();
		const order: string[] = [];
		const oldSent: WorkerInbound[] = [];
		const replacementSent: WorkerInbound[] = [];
		const replacementHandlers = new Set<(message: WorkerOutbound) => void>();
		const browser = makeBrowser();
		let replacementPublished = false;
		let replacementAnchor: WorkerTabSession | undefined;
		const replacementWorker: WorkerHandle = {
			mode: "inline",
			send(message) {
				replacementSent.push(message);
				if (message.type !== "select") return;
				order.push("replacement-select");
				queueMicrotask(() => {
					for (const handler of replacementHandlers) {
						handler({
							type: "selected",
							id: message.id,
							info: {
								url: "about:blank",
								title: "replacement",
								viewport: { width: 1280, height: 720 },
								targetId: "replacement-target",
							},
						});
					}
				});
			},
			onMessage(handler) {
				replacementHandlers.add(handler);
				return () => replacementHandlers.delete(handler);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		};
		const oldHandlers = new Set<(message: WorkerOutbound) => void>();
		const oldWorker: WorkerHandle = {
			mode: "inline",
			send(message) {
				oldSent.push(message);
				if (message.type !== "close") return;
				order.push("old-close");
				queueMicrotask(() => {
					for (const handler of oldHandlers) handler({ type: "closed" });
				});
			},
			onMessage(handler) {
				oldHandlers.add(handler);
				return () => oldHandlers.delete(handler);
			},
			onError: () => () => undefined,
			async terminate() {
				order.push("old-terminate-start");
				terminationStarted.resolve();
				await teardown.promise;
				replacementPublished = true;
				order.push("replacement-published");
				replacementAnchor = makeTab("replacement-anchor", browser, replacementWorker);
				getFirefoxSharedTabsForTest().set(replacementAnchor);
			},
		};
		const primary = makeTab("close-all-primary", browser, oldWorker);
		const alias = makeTab("close-all-alias", browser, oldWorker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(primary.name, primary);
		tabs.set(alias.name, alias);
		getFirefoxSharedTabsForTest().set(primary);
		let closing: Promise<number> | undefined;
		let opening: Promise<AcquireTabResult> | undefined;
		try {
			closing = releaseAllTabs({ timeoutMs: 1_000 });
			await terminationStarted.promise;
			expect(oldSent.map(message => message.type)).toEqual(["close"]);
			expect(primary.state).toBe("dead");
			expect(alias.state).toBe("dead");
			expect(getFirefoxSharedTabsForTest().get(browser)).toBeUndefined();

			let openingSettled = false;
			opening = acquireTab("post-close-all", browser, { timeoutMs: 1_000 });
			void opening.then(
				() => {
					openingSettled = true;
				},
				() => {
					openingSettled = true;
				},
			);
			await Promise.resolve();

			expect(openingSettled).toBe(false);
			expect(replacementPublished).toBe(false);
			expect(replacementSent).toEqual([]);
			expect(oldSent.map(message => message.type)).toEqual(["close"]);

			teardown.resolve();
			await expect(closing).resolves.toBe(2);
			await expect(opening).resolves.toMatchObject({ created: true });

			expect(order).toEqual(["old-close", "old-terminate-start", "replacement-published", "replacement-select"]);
			expect(tabs.has(primary.name)).toBe(false);
			expect(tabs.has(alias.name)).toBe(false);
			expect(tabs.get("post-close-all")).toMatchObject({
				state: "alive",
				worker: replacementWorker,
				targetId: "replacement-target",
			});
		} finally {
			teardown.resolve();
			await closing?.catch(() => undefined);
			await opening?.catch(() => undefined);
			await forceKillTab("post-close-all", "test cleanup", { sharedFirefoxWorker: true });
			if (replacementAnchor) getFirefoxSharedTabsForTest().delete(replacementAnchor);
			tabs.delete(primary.name);
			tabs.delete(alias.name);
		}
	});
});
