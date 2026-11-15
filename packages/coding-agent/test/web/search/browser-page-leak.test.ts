/**
 * Regression tests for web_search leaking pages into the project-shared headless
 * Chromium: targets of a page open aborted or failed mid-flight, failed or hung
 * closes, and pages never claimed in the shared-target ownership registry.
 *
 * The fake Chromium keeps its own target list (`Target.getTargets`) and emits
 * `Target.targetDestroyed` on its root connection; its `page.close()` never settles.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type { PuppeteerBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { browserFetch } from "@oh-my-pi/pi-coding-agent/web/search/providers/browser-page";
import type { Page } from "puppeteer-core";

const DAEMON_NAME = "omp.browser.headless";
const SEARCH_URL = "https://search.example/html?q=leak";
const FINAL_URL = "https://search.example/html?q=leak&page=1";
const RESULT_HTML = "<html><body><a class='result'>hit</a></body></html>";
/** Target id of the first page the fake Chromium opens. */
const FIRST_TARGET = "TARGET-1";

const scopes: SharedTargetScope[] = [];

/** Unique per-test scope; `afterEach` removes its registry dir even when a test fails. */
function trackedScope(): SharedTargetScope {
	const scope = {
		projectDir: path.join("/tmp", `omp-search-leak-test-${crypto.randomUUID()}`),
		daemonName: DAEMON_NAME,
	};
	scopes.push(scope);
	return scope;
}

/** Targets this process still claims ownership of, straight from the durable record. */
async function ownedTargets(scope: SharedTargetScope): Promise<string[]> {
	// Ownership writes are fire-and-forget; a record→forget pair joins the
	// registry's write chain, so the read below sees every earlier write.
	const probe = `chain-probe-${crypto.randomUUID()}`;
	await recordSharedTarget(scope, probe);
	await forgetSharedTarget(scope, probe);
	const file = Bun.file(
		path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`, `${process.pid}.json`),
	);
	if (!(await file.exists())) return [];
	return ((await file.json()) as { targets: string[] }).targets;
}

interface FakeChromiumOptions {
	/** `Target.closeTarget` answers `success: true` but leaves the page open. */
	linger?: boolean;
	/** Holds the `Target.createTarget` reply after the target exists. */
	createTargetGate?: Promise<void>;
	/** Protocol time the `Target.createTarget` reply takes, once `createTargetGate` opens. */
	createTargetDelayMs?: number;
	/** `target.page()` rejects, as puppeteer's attach can after the target exists. */
	pageFails?: boolean;
	/** Runs inside every navigation, while the search page is open. */
	onGoto?: () => Promise<void>;
	/** Keep the real cleanup deadlines instead of scaling them down. */
	realTimeouts?: boolean;
}

interface FakeChromium {
	handle: PuppeteerBrowserHandle;
	/** Targets Chromium still has open, as `Target.getTargets` reports them. */
	open: Set<string>;
	/** See {@link FakeChromiumOptions.linger}; tests may change it mid-run. */
	linger: boolean;
	/** Resolves once `Target.createTarget` has created its target. */
	pageCreated: Promise<void>;
	/** Resolves when the last browser hold is released (the shared handle disconnects). */
	disconnected: Promise<void>;
	/** Connect again for a later search, re-arming {@link FakeChromium.disconnected}. */
	reconnect(): void;
}

function fakeChromium(scope: SharedTargetScope, options: FakeChromiumOptions = {}): FakeChromium {
	const { createTargetGate, createTargetDelayMs, onGoto } = options;
	const open = new Set<string>();
	const pageCreated = Promise.withResolvers<void>();
	let disconnected = Promise.withResolvers<void>();
	let nextTarget = 0;

	const makePage = (): Page =>
		({
			goto: async () => {
				await onGoto?.();
				return { status: () => 200 };
			},
			waitForSelector: async () => null,
			content: async () => RESULT_HTML,
			url: () => FINAL_URL,
			// Like puppeteer's on a connection that outlives the search: never settles.
			close: (): Promise<void> => new Promise<void>(() => {}),
		}) as unknown as Page;

	const makeTarget = (targetId: string) => ({
		_targetId: targetId,
		page: async () => {
			if (options.pageFails) throw new Error("Target closed");
			return makePage();
		},
	});

	const destroyedHandlers = new Set<(event: { targetId: string }) => void>();
	/** Root CDP connection (`browserConnection`), where browser-level `Target.*` commands go. */
	const rootConnection = {
		send: async (method: string, params?: { targetId?: string }, sendOptions?: { timeout?: number }) => {
			if (method === "Target.createTarget") {
				const targetId = `TARGET-${++nextTarget}`;
				open.add(targetId);
				pageCreated.resolve();
				await createTargetGate;
				// Like puppeteer's `Connection.send`: the per-call timeout overrides the connection's, and a
				// late reply rejects though Chromium still created the target.
				const timeout = sendOptions?.timeout ?? launch.BROWSER_PROTOCOL_TIMEOUT_MS;
				if (timeout && (createTargetDelayMs ?? 0) > timeout) throw new Error("Target.createTarget timed out");
				return { targetId };
			}
			if (method === "Target.closeTarget") {
				const targetId = params?.targetId ?? "";
				if (!chromium.linger && open.delete(targetId)) {
					queueMicrotask(() => {
						for (const handler of destroyedHandlers) handler({ targetId });
					});
				}
				return { success: true };
			}
			if (method === "Target.getTargets") {
				return { targetInfos: [...open].map(targetId => ({ targetId, type: "page" })) };
			}
			throw new Error(`unexpected CDP method ${method}`);
		},
		on: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.add(handler),
		off: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.delete(handler),
		// `browserConnection` requires it; page cleanup must never attach.
		createSession: async () => {
			throw new Error("page cleanup must not attach to targets");
		},
	};

	const browser = {
		connected: true,
		waitForTarget: async (predicate: (target: object) => boolean) => {
			const target = [...open].map(makeTarget).find(predicate);
			if (!target) throw new Error("Waiting for target failed: timeout");
			return target;
		},
		_connection: rootConnection,
		disconnect: () => {
			browser.connected = false;
			disconnected.resolve();
		},
	};

	const handle = {
		key: `headless:search-leak-${crypto.randomUUID()}`,
		kind: { kind: "headless", headless: true },
		refCount: 0,
		browser,
		sharedDaemon: { name: scope.daemonName, projectDir: scope.projectDir },
		stealth: { browserSession: null, override: null },
	} as unknown as PuppeteerBrowserHandle;

	spyOn(registry, "acquireBrowser").mockResolvedValue(handle);
	spyOn(launch, "applyViewport").mockResolvedValue(undefined);
	spyOn(launch, "applyStealthPatches").mockResolvedValue(undefined);
	// The plain fetch is blocked, so `browserFetch` escalates to the browser.
	spyOn(globalThis, "fetch").mockResolvedValue(new Response("blocked", { status: 403 }));
	if (!options.realTimeouts) {
		// Scale the cleanup deadlines down 250x, keeping their order; only page
		// cleanup uses `AbortSignal.timeout` on this path.
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms / 250));
	}

	const chromium: FakeChromium = {
		handle,
		open,
		linger: options.linger ?? false,
		pageCreated: pageCreated.promise,
		get disconnected() {
			return disconnected.promise;
		},
		reconnect() {
			browser.connected = true;
			disconnected = Promise.withResolvers<void>();
		},
	};
	return chromium;
}

function search(signal: AbortSignal = new AbortController().signal) {
	return browserFetch(SEARCH_URL, { signal, browser: { shouldFallback: () => false } });
}

/** Wait for background page cleanup to drop its browser hold. */
async function cleanupFinished(chromium: FakeChromium): Promise<void> {
	// Only bounds a failing test; a passing one resolves as soon as cleanup releases the browser.
	await withTimeout(chromium.disconnected, 10_000, "web search page cleanup never released the browser");
}

afterEach(async () => {
	vi.restoreAllMocks();
	resetOrphanRegistryForTest();
	for (const scope of scopes.splice(0)) {
		await fs.rm(daemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("web search browser page cleanup in the shared Chromium", () => {
	it("closes a target whose create replies after the search was aborted", async () => {
		const scope = trackedScope();
		const gate = Promise.withResolvers<void>();
		const chromium = fakeChromium(scope, { createTargetGate: gate.promise });
		const controller = new AbortController();

		const searching = search(controller.signal);
		await chromium.pageCreated;
		controller.abort(new Error("soft deadline"));
		await expect(searching).rejects.toMatchObject({ name: "AbortError" });
		gate.resolve();
		await cleanupFinished(chromium);

		expect([...chromium.open]).toEqual([]);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("closes a target whose create replies after the protocol timeout", async () => {
		const scope = trackedScope();
		const gate = Promise.withResolvers<void>();
		// A 75 s Chromium stall, beyond the 60 s protocol timeout.
		const chromium = fakeChromium(scope, { createTargetGate: gate.promise, createTargetDelayMs: 75_000 });
		const controller = new AbortController();

		const searching = search(controller.signal);
		await chromium.pageCreated;
		controller.abort(new Error("soft deadline"));
		await expect(searching).rejects.toMatchObject({ name: "AbortError" });
		gate.resolve();
		await cleanupFinished(chromium);

		expect([...chromium.open]).toEqual([]);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("closes a created target whose page never resolves", async () => {
		const scope = trackedScope();
		const chromium = fakeChromium(scope, { pageFails: true });

		await expect(search()).rejects.toThrow("Target closed");
		await cleanupFinished(chromium);

		expect([...chromium.open]).toEqual([]);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("returns without waiting on page.close() and keeps the page claimed only while open", async () => {
		const scope = trackedScope();
		let ownedDuringSearch: string[] = [];
		// Real deadlines: a teardown waiting on the never-settling `page.close()` would take the full 5 s cap.
		const chromium = fakeChromium(scope, {
			realTimeouts: true,
			onGoto: async () => {
				ownedDuringSearch = await ownedTargets(scope);
			},
		});

		const started = performance.now();
		const loaded = await search();

		expect(performance.now() - started).toBeLessThan(1_000);
		expect(loaded).toEqual({ html: RESULT_HTML, status: 200, url: FINAL_URL });
		// Claimed while open, so the orphan reaper finds it if this process dies mid-search.
		expect(ownedDuringSearch).toEqual([FIRST_TARGET]);
		expect([...chromium.open]).toEqual([]);
		expect(chromium.handle.browser.connected).toBe(false);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("keeps an unconfirmed page claimed until a later search's retry closes it", async () => {
		const scope = trackedScope();
		const chromium = fakeChromium(scope, { linger: true });

		await search();
		await cleanupFinished(chromium);
		// Still open in Chromium, so it must stay claimed for the orphan reaper.
		expect([...chromium.open]).toEqual([FIRST_TARGET]);
		expect(await ownedTargets(scope)).toEqual([FIRST_TARGET]);

		// The owner is alive, so the orphan reaper skips its pages; later
		// searches retry the closes, and a failed retry keeps them for the next.
		chromium.reconnect();
		await search();
		await cleanupFinished(chromium);
		chromium.linger = false;
		chromium.reconnect();
		await search();
		await cleanupFinished(chromium);

		expect([...chromium.open]).toEqual([]);
		expect(await ownedTargets(scope)).toEqual([]);
	});
});
