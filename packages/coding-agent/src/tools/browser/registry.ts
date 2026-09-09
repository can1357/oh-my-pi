import * as path from "node:path";
import { isCompiledBinary, logger, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession } from "puppeteer-core";
import { ToolAbortError, ToolError } from "../tool-errors";
import { findFreeCdpPort, findReusableCdp, gracefulKillTreeOnce, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPuppeteer,
	removeUserDataDir,
	type UserAgentOverride,
} from "./launch";
import { reapOrphanSharedTargets } from "./orphan-registry";
import { ensureRelayDaemon, isLoopbackRelayUrl } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";
import { ensureSharedBrowser } from "./shared-daemon";

export type PuppeteerBrowserKind =
	| { kind: "headless"; headless: boolean }
	| { kind: "spawned"; path: string }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;

export type BrowserKind = PuppeteerBrowserKind | CmuxKind;

export type BrowserKindTag = BrowserKind["kind"];

/**
 * Upper bound on `browser.close()` for headless Chromium. Puppeteer waits for
 * the process to fully exit; a wedged Chromium would otherwise hang cleanup
 * forever (issue #5260), so we cap the wait and force-kill on timeout.
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;
/**
 * How long a relay open waits for the extension handshake (503 → 200). A
 * reaped extension service worker is revived by its 30s keepalive alarm, so
 * the wait must cover one full alarm period plus the dial.
 */
const RELAY_EXTENSION_WAIT_MS = 35_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

export interface PuppeteerBrowserHandle extends BrowserHandleCommon {
	kind: PuppeteerBrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	/** OMP-owned temp Chromium profile directory removed on dispose (process-local headless launches). */
	userDataDir?: string;
	/** Broker daemon backing this handle; dispose disconnects instead of closing, kill routes to the broker. */
	sharedDaemon?: { name: string; projectDir: string };
	subprocess?: Subprocess;
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = PuppeteerBrowserHandle | CmuxBrowserHandle;

/** Controls bounded browser-handle teardown and identifies the owning resource in timeout diagnostics. */
export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();
/** In-flight opens by browser key, so concurrent acquisitions share one launch instead of storming Chromium. */
const pendingOpens = new Map<string, Promise<BrowserHandle>>();

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing) return existing;
			if (existing.browser.connected) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing, { kill: false });
			continue;
		}
		// Short-circuit before launching: the tool wrapper's `untilAborted` only
		// rejects its outer promise on abort; without this check `openBrowserHandle`
		// would still fire and its result would land in `browsers` below.
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");

		// Single-flight per key: a concurrent caller already opening this browser
		// wins; everyone else waits and re-reads the registry. Without this, N
		// simultaneous opens each launch a Chromium and the last write wins,
		// leaking the rest as unreferenced process trees.
		const pending = pendingOpens.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			continue;
		}
		const open = openBrowserHandle(kind, opts).finally(() => pendingOpens.delete(key));
		pendingOpens.set(key, open);
		const handle = await open;
		// The launch may resolve AFTER the caller has already aborted (the outer
		// `untilAborted` rejects immediately on abort but does not cancel the
		// inner promise, and `launchHeadlessBrowser` does not accept a signal).
		// Without this branch the completed handle sits in `browsers` at
		// refCount:0 forever — no tab ever takes a hold, `releaseBrowser` never
		// fires, and `releaseAllTabs` walks `tabs`, not `browsers`, so the
		// orphaned Chromium/app process / puppeteer handle survives to process
		// exit. (Issue #3963.)
		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(err => {
				logger.debug("Failed to dispose orphan browser after abort", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
			throw new ToolAbortError("Browser open aborted");
		}
		browsers.set(key, handle);
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpUrl)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpUrl;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return {
			key: browserKey(kind),
			kind,
			client,
			surface: kind.surface,
			refCount: 0,
		};
	}
	if (kind.kind === "headless") {
		// Every real omp process (session, subagent, worker — anything with a CLI
		// worker host) MUST go through the project-shared broker-owned Chromium:
		// per-process launches are what produced launch storms and orphaned
		// process trees. The process-local launch survives only for hosts that
		// cannot spawn the broker (bun test, SDK embedding without a CLI entry).
		if (isCompiledBinary() || workerHostEntry() !== null) {
			return await openSharedHeadlessHandle(kind, opts);
		}
		const { browser, userDataDir } = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			userDataDir,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "relay") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		// Loopback relays are owned by a machine-global broker and auto-started
		// on demand (the extension dials in on its own). Hosts without a CLI
		// worker entry (bun test, SDK embedding) never spawn brokers. Remote
		// relay URLs must already be serving.
		let autoStarted = false;
		if (isLoopbackRelayUrl(cdpUrl) && (isCompiledBinary() || workerHostEntry() !== null)) {
			autoStarted = await ensureRelayDaemon({ cdpUrl, signal: opts.signal });
		}
		// The relay answers /json/version with 503 until its extension dials in.
		// A freshly revived extension service worker can take up to ~30s (its
		// keepalive alarm) to reconnect, so give the handshake that long.
		try {
			await waitForCdp(cdpUrl, RELAY_EXTENSION_WAIT_MS, opts.signal);
		} catch (err) {
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(
				autoStarted
					? `omp browser relay is serving at ${cdpUrl} but its extension never connected. Install it with \`omp browser-relay install\` and check the toolbar badge shows "on".`
					: `omp browser relay is not reachable at ${cdpUrl}. Start it with \`omp browser-relay\` (or check the endpoint), and make sure the OMP Browser Relay extension is loaded in Chrome.`,
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const reused = await findReusableCdp(exe, {
		signal: opts.signal,
		appArgs: opts.appArgs,
	});
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const port = await findFreeCdpPort();
		const launchArgs = [...(opts.appArgs ?? []), `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		// Only evict if the registry still points at THIS handle. After a disconnect,
		// `acquireBrowser` may have already replaced the entry with a fresh live handle
		// under the same key; deleting blindly would orphan that new browser.
		if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.sharedDaemon) {
			// The broker owns the Chromium; this process only drops its CDP
			// connection. `kill` is scoped to spawned-app browsers — stopping the
			// shared daemon here would tear down every other session's tabs. The
			// daemon dies with the last omp client in the project (broker idle
			// teardown), or via an explicit hub stop.
			if (handle.browser.connected) {
				try {
					handle.browser.disconnect();
				} catch (err) {
					logger.debug("Failed to disconnect from shared browser", { error: (err as Error).message });
				}
			}
			return;
		}
		if (handle.browser.connected) {
			// Puppeteer's `browser.close()` resolves only once the Chromium
			// process fully exits. A wedged Chromium (a known Windows failure
			// mode) leaves this await pending forever, freezing `releaseTab` in
			// the "Closing tab" phase (issue #5260). Bound it, then SIGKILL the
			// process tree so cleanup always completes.
			const proc = handle.browser.process();
			try {
				await withTimeout(handle.browser.close(), HEADLESS_CLOSE_TIMEOUT_MS, "Timed out closing headless browser");
			} catch (err) {
				logger.debug("Failed to close headless browser; force-killing", { error: (err as Error).message });
				if (proc?.pid !== undefined) await gracefulKillTreeOnce(proc.pid).catch(() => undefined);
			}
		}
		// OMP owns the profile directory (puppeteer's temp cleanup is disabled by
		// our explicit --user-data-dir), so remove it now the process tree has
		// exited. Tolerant of the Windows lock-held window (issue #7058).
		if (handle.userDataDir) await removeUserDataDir(handle.userDataDir);
		return;
	}
	// Connected and relay browsers belong to the user: drop our CDP link, never kill.
	if (handle.kind.kind === "connected" || handle.kind.kind === "relay") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: (err as Error).message });
		}
	}
	if (opts.kill && handle.pid !== undefined) await gracefulKillTreeOnce(handle.pid);
}

/**
 * Attach to the project-shared broker-owned Chromium. Failures surface as
 * `ToolError` — a CLI-host process never silently falls back to a private
 * Chromium, so a broken broker cannot quietly recreate per-process launch
 * storms.
 */
async function openSharedHeadlessHandle(
	kind: Extract<PuppeteerBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<PuppeteerBrowserHandle> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			projectDir: opts.cwd,
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"Shared browser daemon unavailable (broker start or Chromium launch failed); check `hub ps` for omp.browser.* daemons and ~/.omp/logs for details",
			);
		}
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserWSEndpoint: shared.wsEndpoint,
			defaultViewport: kind.headless
				? {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
					}
				: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		// Attaching to the shared daemon is the natural point to sweep targets
		// left behind by omp processes that died without teardown — bounds
		// accumulation without a background timer. Best-effort and detached so a
		// slow reap never delays the open (issue #10022).
		void reapOrphanSharedTargets(browser, { projectDir: shared.projectDir, daemonName: shared.daemonName });
		return {
			key: browserKey(kind),
			kind,
			browser,
			sharedDaemon: { name: shared.daemonName, projectDir: shared.projectDir },
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	} catch (err) {
		if (err instanceof ToolAbortError || err instanceof ToolError) throw err;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Shared browser attach failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Test-only accessor for the module-global browsers map. */
export function getBrowsersMapForTest(): ReadonlyMap<string, BrowserHandle> {
	return browsers;
}
