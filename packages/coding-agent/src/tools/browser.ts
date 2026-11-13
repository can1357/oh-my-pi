import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getWebKitHostPath, isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { describeRelayTargets, listRelayTargets, type RelayTarget, resolveSpawnArgs } from "./browser/attach";
import {
	acquireBrowser,
	browserKey,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	normalizeConnectedCdpUrl,
	type PuppeteerBrowserKind,
	releaseBrowser,
} from "./browser/registry";
import { chromiumNeedsDownload, ensureChromiumExecutable } from "./browser/launch";
import { sameAddress } from "./browser/navigation";
import { resolveInitScriptSources } from "./browser/open-options";
import { resolveRelayKind } from "./browser/relay/kind";
import { relayExtensionNotice } from "./browser/relay/probe";
import { describeTernTargets, listTernBlocks, type TernTarget, ternTargets } from "./browser/tern/blocks";
import { resolveTernKind } from "./browser/tern/kind";
import { isTernUnavailable } from "./browser/tern/wire";
import { ownsTerminal } from "./browser/terminal-owner";
import { WebKitUnavailableError } from "./browser/webkit/host";
import { installWebKitEngine } from "./browser/webkit/install";
import { resolveWebKitKind, VIEWER_PLATFORMS, webKitEngineToInstall } from "./browser/webkit/kind";
import type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";
import type { ScreenshotResult } from "./browser/tab-protocol";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import {
	type AcquireTabResult,
	acquireTab,
	cancelIdleCloseForOwner,
	dropHeadlessTabs,
	getTab,
	listTabs,
	releaseAllTabs,
	releaseTabsForOwner,
	releaseIdleTabsForOwner,
	releaseTab,
	runInTab,
	setWebKitTabsShown,
	type TabSession,
	type TernTabSession,
	ternBlocksTaken,
} from "./browser/tab-supervisor";
import { renderTabCall, tabCallBudgetSeconds } from "./browser/tab-call";
import { resolveToCwd } from "./path-utils";
import { renderFunctionRun, renderStatusCallChain } from "./run-code";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

import {
	cfgBrowserCdpUrl,
	cfgBrowserCmux,
	cfgBrowserHeadless,
	cfgBrowserIdleCloseSec,
	cfgBrowserRelay,
	cfgBrowserRelayUrl,
	cfgBrowserTern,
	cfgBrowserWebKit,
	cfgBrowserWebKitPath,
} from "./browser/settings";
import { cfgToolsMaxTimeout } from "./settings";

export type { AriaSnapshotOptions } from "./browser/aria/aria-snapshot";

/** First-use boundary for the generated Playwright ARIA evaluator bundle. */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
	return require("./browser/aria/aria-snapshot").buildAriaSnapshotScript(selector, options);
}

/** First-use boundary for ARIA-ref parsing; keeps evaluator construction out of tool registration. */
export function parseAriaRefSelector(selector: string): string | null {
	return require("./browser/aria/aria-snapshot").parseAriaRefSelector(selector);
}

export { cmuxSnapshotToObservation, mapWaitUntil, resolveCmuxKind, serializeEval } from "./browser/cmux/rpc";
export { CmuxSocketClient } from "./browser/cmux/socket-client";
export {
	extractMarkdownOutline,
	extractReadableFromHtml,
	filterMarkdownSections,
	type ReadableExtractOptions,
	type ReadableFormat,
	type ReadableResult,
} from "./browser/readable";
export {
	ariaSnapshotBaselineKey,
	collectAriaSnapshotRefs,
	diffAriaSnapshot,
	postProcessAriaSnapshot,
	type AriaSnapshotBaseline,
	type AriaSnapshotDiffResult,
	type SnapshotPostProcessOptions,
} from "./browser/snapshot-plus";
export { DEFAULT_RELAY_URL, type RelayKind, resolveRelayKind } from "./browser/relay/kind";
export { type TernKind, resolveTernKind } from "./browser/tern/kind";
export { resolveWebKitKind, type WebKitKind } from "./browser/webkit/kind";
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";
const BROWSER_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

/** Browsers `app` names by keyword; any other `app` is a CDP endpoint URL or an executable path. */
const APP_KEYWORDS: readonly string[] = ["relay", "tern", "webkit", "chromium", "own", "auto"];

/** A `scheme://` string names a CDP endpoint to attach to; Windows drive paths (`C:\`) do not match. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const tabCallStepSchema = type({
	method: "string",
	args: "unknown[]",
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run' | 'call' | 'tabs' | 'targets'").describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"app?": type("string").describe(
		"browser to drive: 'relay' (the user's Chrome), 'tern' (Tern picture-in-picture), 'webkit', 'chromium' (managed), 'own' (omp's own browser: WebKit if installed, else Chromium), 'auto' (default choice without the relay), a CDP endpoint URL to attach to, or an executable path to spawn",
	),
	"argv?": type("string[]").describe("extra cli args when app is an executable path"),
	"target?": type("string").describe(
		"URL/title substring picking the page to drive; inside Tern, adopts the user's browser block (or its id)",
	),
	"viewport?": {
		width: "number",
		height: "number",
		"scale?": "number",
	},
	"wait_until?": type("'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'").describe(
		"navigation wait condition",
	),
	"dialogs?": type("'accept' | 'dismiss'").describe("auto-handle dialogs"),
	"allowed_domains?": type("string[]").describe("allowed request hostnames"),
	"init_scripts?": type("string[]").describe("document-start JavaScript sources or cwd-relative file paths"),
	"downloads?": type("string").describe("cwd-relative download directory"),
	"user_agent?": type("string").describe("tab user agent override"),
	"insecure?": type("boolean").describe("ignore invalid HTTPS certificates"),
	"headed?": type("boolean").describe("override the configured display mode: a window for the tab (true) or none"),
	"code?": type("string").describe("js body to run in tab"),
	"fn?": type("string").describe("serialized JavaScript function to run in tab"),
	"args?": type("unknown[]").describe("arguments passed to a serialized function"),
	"chain?": tabCallStepSchema.array(),
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("release every managed tab this agent opened"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
	"persist?": type("boolean").describe(
		"keep tab live across turn settle and idle close; on a relay tab omp opened, keep it open after the session ends",
	),
});

type BrowserParams = typeof browserSchema.infer;

interface BrowserPreludeDetails {
	meta?: OutputMeta;
	action: BrowserParams["action"];
	name: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	screenshots?: ScreenshotResult[];
	value?: unknown;
}

/**
 * The browser an open drives, by precedence: an explicit `app` (an executable
 * path or CDP URL, or a keyword: `relay`, `tern`, `webkit`, `chromium`, `own`),
 * the relay, `browser.cdpUrl`, Tern (inside a Tern pane; `target` selects it
 * over the `browser.tern` setting to adopt a block; `headed` does not opt out),
 * a cmux surface, then omp's own browser ({@link ownBrowserKind}). `app: "auto"`
 * is that chain without the relay. Tern and cmux are automatic only while no
 * other omp owns the terminal. `app: "tern"` and `app: "webkit"` are explicit:
 * they throw when Tern or omp's WebKit host is unavailable.
 */
export function resolveBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	env: Record<string, string | undefined> = process.env,
): BrowserKind {
	const app = params.app;
	if (app !== undefined && URL_SCHEME.test(app)) {
		return { kind: "connected", cdpUrl: app.replace(/\/+$/, "") };
	}
	if (app && !APP_KEYWORDS.includes(app)) {
		const exe = resolveToCwd(app, session.cwd);
		const args = resolveSpawnArgs(exe, params.argv, session.cwd);
		if (params.insecure && !args.includes("--ignore-certificate-errors")) {
			args.push("--ignore-certificate-errors");
		}
		if (!args.includes("--allow-file-access-from-files")) {
			args.push("--allow-file-access-from-files");
		}
		return { kind: "spawned", path: exe, args };
	}
	const relayUrl = cfgBrowserRelayUrl.get(session.settings);
	// Explicit app: "relay" wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch (a relay that is down would otherwise brick the tool).
	if (app === "relay") {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl }, env);
		if (relayKind) return relayKind;
	}
	if (app === "tern") {
		const ternKind = resolveTernKind({ settingEnabled: true }, env);
		if (!ternKind) {
			throw new ToolError(
				'app: "tern" requires running inside a Tern pane (TERN_PANE_SOCKET and TERN_PANE are not set) with PI_BROWSER_TERN not set to 0.',
			);
		}
		return ternKind;
	}
	if (app === "webkit") {
		const webkitKind = resolveWebKitKind(
			{ settingEnabled: true, settingPath: cfgBrowserWebKitPath.get(session.settings) },
			env,
		);
		if (!webkitKind) {
			throw new ToolError(
				`app: "webkit" requires omp's WebKit engine, and none is installed: its host executable must be ${getWebKitHostPath()}, or be named by PI_BROWSER_WEBKIT_PATH or the browser.webkitPath setting, with PI_BROWSER_WEBKIT not set to 0.`,
			);
		}
		return webkitKind;
	}
	if (app === "chromium") return chromiumKind(params, session);
	if (app === "own") return ownBrowserKind(params, session, env);
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate mode selection, while cdpUrl is a standing fallback
	// endpoint. A configured endpoint is a default, not an override: an
	// explicit app wins.
	if (app !== "auto") {
		const relayKind = resolveRelayKind(
			{
				settingEnabled: cfgBrowserRelay.get(session.settings),
				url: relayUrl,
			},
			env,
		);
		if (relayKind) return relayKind;
	}
	const configuredCdpUrl = cfgBrowserCdpUrl.get(session.settings)?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	// Tern and cmux show the tab beside the omp drawn in that terminal. An omp started from that
	// session's commands (`omp -p` from its bash tool, a script an eval cell runs) inherited the
	// pane env, and its tabs would float over the other session's work.
	const ownsPane = ownsTerminal(env);
	// `target` inside Tern names a browser block to adopt: an explicit request, like `app: "tern"`.
	const ternKind = resolveTernKind(
		{ settingEnabled: params.target !== undefined || (ownsPane && cfgBrowserTern.get(session.settings)) },
		env,
	);
	if (ternKind) return ternKind;
	const cmuxKind = resolveCmuxKind(
		{
			settingEnabled: ownsPane && cfgBrowserCmux.get(session.settings),
		},
		env,
	);
	if (cmuxKind) {
		return cmuxKind;
	}
	return ownBrowserKind(params, session, env);
}

/**
 * omp's own browser, where an open ends when nothing else takes it: its
 * WebKit host when that backend is on (`browser.webkit`,
 * `PI_BROWSER_WEBKIT`; `app: "chromium"` opts one open out) and its
 * executable is installed (`PI_BROWSER_WEBKIT_PATH`, `browser.webkitPath`,
 * else `~/.o2/lib/abkit/ABHost`), and managed Chromium otherwise and for a
 * visible window (`headed: true`, or `browser.headless` off) where the engine
 * ships no viewer to show one.
 */
function ownBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	env: Record<string, string | undefined> = process.env,
): BrowserKind {
	const chromium = chromiumKind(params, session);
	const webkit = resolveWebKitKind(
		{
			settingEnabled: cfgBrowserWebKit.get(session.settings),
			settingPath: cfgBrowserWebKitPath.get(session.settings),
		},
		env,
	);
	// A window is the viewer's to show: an engine without one leaves visible tabs to Chromium.
	if (!webkit || (!chromium.headless && !webkit.viewer)) return chromium;
	return webkit;
}

/** The Chromium browser an open launches when no attach/app mode applies and omp's WebKit host does not take it. */
function chromiumKind(
	params: BrowserParams,
	session: ToolSession,
): Extract<PuppeteerBrowserKind, { kind: "headless" }> {
	const headless = params.headed === undefined ? cfgBrowserHeadless.get(session.settings) : !params.headed;
	return {
		kind: "headless",
		headless,
		insecure: params.insecure,
	};
}

/** Create the enabled-only browser host prelude for one tool session. */
export function createBrowserPrelude(session: ToolSession): EvalPreludeDefinition {
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { createBrowserPreludeDefinition } = require("./browser/prelude-definition");
	return createBrowserPreludeDefinition(session, {
		invoke: (parameters: unknown, context: EvalPreludeContext) => invokeBrowser(session, parameters, context),
		status: describeBrowserCall,
		// The documentation promises omp's own browser for an open without `app`; while
		// the relay takes that open, the prompt names where `app: "auto"` goes instead.
		relayFallback:
			resolveBrowserKind({ action: "open" }, session).kind === "relay"
				? resolveBrowserKind({ action: "open", app: "auto" }, session)
				: undefined,
	});
}

/** Status-tree line for a completed browser call: `open main https://…`, `main.id(5).click()`, `close all`. */
function describeBrowserCall(parameters: unknown, result: AgentToolResult<unknown>): string | undefined {
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) return undefined;
	const name = parsed.name ?? DEFAULT_TAB_NAME;
	switch (parsed.action) {
		case "open": {
			const url = isRecord(result.details) ? result.details.url : undefined;
			return typeof url === "string" && url.length > 0 ? `open ${name} ${url}` : `open ${name}`;
		}
		case "close":
			return parsed.all ? "close all" : `close ${name}`;
		case "run":
			return `${name}.run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "call": {
			const chain = parsed.chain ?? [];
			return `${name}.${renderStatusCallChain(chain, (step, index) => browserTextStart(step.method, chain[index - 1]?.method))}`;
		}
		case "tabs":
			return "tabs";
		case "targets":
			return "targets";
	}
}

/**
 * Where the text a browser helper enters starts in its arguments: after the selector of a tab or
 * frame `fill`/`type`, first on an element handle and for clipboard and dialog text.
 */
function browserTextStart(method: string, previous: string | undefined): number | undefined {
	switch (method) {
		case "fill":
		case "type":
			return previous === undefined || previous === "frame" ? 1 : 0;
		case "clipboardWrite":
		case "handleDialog":
			return 0;
		default:
			return undefined;
	}
}

/**
 * Apply a change of the browser mode (`/browser headless|visible`). WebKit
 * tabs change now: each gains or loses its window, the page going on
 * untouched. A Chromium cannot change mode while it runs, so its headless
 * tabs are dropped and the next open launches it in the new mode.
 */
export async function applyBrowserModeChange(headless: boolean): Promise<void> {
	try {
		await setWebKitTabsShown(!headless);
	} finally {
		await dropHeadlessTabs();
	}
}

/**
 * Owner key for tabs this session opens: the agent's stable kernel owner id,
 * which survives `/new`, `/resume`, fork, and branch (unlike the conversation
 * session id) and is shared with its advisors, like eval kernels and computer
 * sessions. Subagents get their own.
 */
function tabOwnerId(session: ToolSession): string | undefined {
	return session.getEvalKernelOwnerId?.() ?? undefined;
}

/**
 * Best-effort idle-close sweep for the calling session's owned headless
 * tabs. Never throws — callers detach it (`void`) so a slow reap cannot
 * delay the open it follows.
 */
function sweepIdleOwnedTabs(session: ToolSession): Promise<number> {
	const ownerId = tabOwnerId(session);
	if (!ownerId) return Promise.resolve(0);
	const idleSec = cfgBrowserIdleCloseSec.get(session.settings);
	if (!(idleSec > 0)) {
		cancelIdleCloseForOwner(ownerId);
		return Promise.resolve(0);
	}
	return releaseIdleTabsForOwner(ownerId, { idleMs: idleSec * 1000 }).catch((error: unknown) => {
		logger.debug("Browser idle-close sweep failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	});
}

async function invokeBrowser(
	session: ToolSession,
	parameters: unknown,
	context: EvalPreludeContext,
): Promise<AgentToolResult<unknown>> {
	const parsed = browserSchema(parameters);
	if (parsed instanceof type.errors) {
		throw new ToolError(`browser received invalid arguments: ${parsed.summary}`);
	}

	try {
		throwIfAborted(context.signal);
		const requested =
			parsed.timeout ??
			(parsed.action === "call" || parsed.action === "run"
				? tabCallBudgetSeconds(parsed.chain, context.cellTimeoutMs)
				: undefined);
		const timeoutSeconds = clampTimeout("browser", requested, cfgToolsMaxTimeout.get(session.settings));
		const timeoutMs = timeoutSeconds * 1000;
		const name = parsed.name ?? DEFAULT_TAB_NAME;
		const details: BrowserPreludeDetails = { action: parsed.action, name };

		switch (parsed.action) {
			case "open":
				return await openBrowser(session, name, parsed, details, timeoutMs, context.signal);
			case "close":
				return await closeBrowser(session, name, parsed, details, timeoutMs, context.signal);
			case "tabs":
				details.value = listTabs();
				return toolResult(details).done();
			case "targets":
				return await listTargets(session, parsed, details, timeoutMs, context.signal);
			case "run":
			case "call":
				return await runBrowser(session, name, parsed, details, timeoutMs, context.signal);
		}
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		if (error instanceof Error && error.name === "AbortError") {
			throw new ToolAbortError();
		}
		throw error;
	}
}

/**
 * Open (or reuse) a tab, falling back when the browser chosen automatically
 * cannot host it, and saying so in the result:
 * - A Tern PiP (not forced with `app: "tern"`) that Tern cannot show — no
 *   window, an unsupported platform, a refused or failed connection — goes to
 *   omp's own browser, as an open outside Tern would. Adopting a Tern block
 *   (`target`) never falls back: no other browser has that page.
 * - omp's WebKit host (not forced with `app: "webkit"`) that cannot start,
 *   cannot open its first tab, or could not be downloaded
 *   ({@link installWebKitForOpen}) goes to managed Chromium.
 *
 * A tab that already fell back keeps its browser.
 */
async function openBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const webkitDownloadFailure = await installWebKitForOpen(session, params, signal);
	const resolved = resolveBrowserKind(params, session);
	const autoTern = resolved.kind === "tern" && params.app !== "tern" && params.target === undefined;
	const autoWebKit = params.app !== "webkit";
	const existing = getTab(name);
	let kind = resolved;
	if (autoTern && existing && existing.kindTag !== "tern") {
		kind = existing.browser.kind;
	} else if (resolved.kind === "webkit" && autoWebKit && existing) {
		// A tab that fell back to Chromium keeps it, as does one opened while the WebKit host was not installed.
		const chromium = chromiumKind(params, session);
		if (browserKey(existing.browser.kind) === browserKey(chromium)) kind = chromium;
	}
	const startedAt = performance.now();
	/** Why each browser tried before `kind` could not take the open. */
	const failures: Array<{ backend: "tern" | "webkit"; reason: string }> =
		webkitDownloadFailure === undefined ? [] : [{ backend: "webkit", reason: webkitDownloadFailure }];
	for (;;) {
		const opened = kind.kind === "webkit" ? "omp's WebKit browser" : "Chromium";
		const notes = failures.map(failure =>
			failure.backend === "tern"
				? `Tern cannot show a browser here (${failure.reason}); opened ${opened} instead. Pass app: "own" to skip Tern, or app: "tern" to require it.`
				: `omp's WebKit browser could not start (${failure.reason}); opened Chromium instead. Pass app: "chromium" to skip it, or app: "webkit" to require it.`,
		);
		const remainingMs = Math.max(1, timeoutMs - (performance.now() - startedAt));
		try {
			return await openOnKind(session, name, params, details, kind, remainingMs, notes, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			let next: BrowserKind;
			if (kind.kind === "tern" && autoTern && isTernUnavailable(error)) {
				failures.push({ backend: "tern", reason: error.message });
				next = ownBrowserKind(params, session);
			} else if (kind.kind === "webkit" && autoWebKit && error instanceof WebKitUnavailableError) {
				failures.push({ backend: "webkit", reason: error.message });
				next = chromiumKind(params, session);
			} else {
				throw error;
			}
			// A Tern or WebKit tab under this name whose window or host went away still holds the
			// name: release that one (and only that one) so the next browser's tab can take it.
			if (getTab(name)?.kindTag === kind.kind) {
				await releaseTab(name, { kill: false, timeoutMs }).catch(() => false);
			}
			logger.debug("Browser backend unavailable; falling back", {
				backend: kind.kind,
				next: next.kind,
				error: error.message,
			});
			kind = next;
		}
	}
}

/**
 * Download omp's WebKit engine before an open that needs it while it is
 * missing from its default location ({@link webKitEngineToInstall}): an open
 * with `app: "webkit"`, or one that otherwise ends at managed Chromium
 * (headless, or visible where released engines ship a viewer) while Chromium
 * itself would first be downloaded. With no browser installed, omp's own engine
 * comes before Chrome for Testing. Like that download, it runs before the
 * open's deadline starts.
 *
 * Returns why an automatic download failed, for the open to go on to Chromium
 * saying so; for `app: "webkit"` a failed download throws.
 */
async function installWebKitForOpen(
	session: ToolSession,
	params: BrowserParams,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const explicit = params.app === "webkit";
	const engineDir = webKitEngineToInstall({
		settingEnabled: explicit || cfgBrowserWebKit.get(session.settings),
		settingPath: cfgBrowserWebKitPath.get(session.settings),
	});
	if (engineDir === null) return undefined;
	if (!explicit) {
		const kind = resolveBrowserKind(params, session);
		if (kind.kind !== "headless" || params.app === "chromium") return undefined;
		if (!kind.headless && !VIEWER_PLATFORMS.includes(process.platform)) return undefined;
		if (!(await chromiumNeedsDownload())) return undefined;
	}
	try {
		await untilAborted(signal, () => installWebKitEngine(engineDir));
		return undefined;
	} catch (error) {
		if (signal?.aborted) throw error;
		const cause = error instanceof Error ? error.message : String(error);
		if (explicit)
			throw new ToolError(`app: "webkit" requires omp's WebKit engine, which could not be downloaded: ${cause}`);
		return `its engine could not be downloaded: ${cause}`;
	}
}

async function openOnKind(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	kind: BrowserKind,
	timeoutMs: number,
	notes: readonly string[],
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const downloadsPath = params.downloads === undefined ? undefined : resolveToCwd(params.downloads, session.cwd);
	details.browser = kind.kind;

	// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
	const existing = getTab(name);
	if (existing && browserKey(existing.browser.kind) !== browserKey(kind)) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
		);
	}
	// Chrome's extension debugger API exposes no Security domain, so the relay cannot honor the override.
	if (params.insecure && kind.kind === "relay") {
		throw new ToolError(
			'insecure is not supported through the Chrome relay: the extension debugger API does not expose the CDP Security domain. Pass app: "chromium" to use omp\'s Chromium instead.',
		);
	}
	// Chrome never lets an extension choose where downloads go. Refused here, before an existing tab is closed to reopen.
	if (params.downloads !== undefined && kind.kind === "relay") {
		throw new ToolError(
			"The omp browser relay cannot choose where Chrome saves downloads: open the tab without `downloads`, and tab.waitForDownload() and tab.downloads() report where Chrome saved each file.",
		);
	}

	// First browser use may have to download Chrome for Testing (~180 MB).
	// That is a one-time install, not part of the open, so it runs before the
	// deadline below starts: charged against the 30s default it timed out on
	// connections where installation alone exceeds that budget.
	// The download promise is module-cached, so a caller abort here leaves it
	// finishing in the background and the next open picks up the result.
	if (kind.kind === "headless") await untilAborted(signal, () => ensureChromiumExecutable());

	// The requested timeout must cover the *entire* open — browser
	// acquisition (CDP discovery/connect), queued tab acquisition, worker
	// creation, and navigation — not only `acquireTab`. Compose one deadline
	// from the caller signal and `params.timeout` and thread it through both
	// stages so a stalled acquisition rejects at the requested boundary.
	// Capture the deadline start as well: `acquireTab` counts its
	// worker-init time against this same budget via `deadlineStartMs`
	// instead of restarting the clock after acquisition.
	const deadlineStart = performance.now();
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const openSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	// The step in flight when the deadline fires; a timeout names it.
	let stage = `launching or connecting to the browser (${describeKind(kind)})`;
	try {
		const browser = await untilAborted(openSignal, () =>
			acquireBrowser(kind, {
				cwd: session.cwd,
				viewport: params.viewport
					? {
							width: params.viewport.width,
							height: params.viewport.height,
							deviceScaleFactor: params.viewport.scale,
						}
					: undefined,
				signal: openSignal,
			}),
		);

		// Hold one open-acquisition lease across the whole tab acquisition.
		// A freshly-created browser sits in the registry at refCount 0 until a
		// tab takes a hold; without this lease an abort/timeout mid-acquisition
		// (or a sibling open of a different tab name on the same browser that
		// fails) could dispose it out from under this operation. The lease is
		// released exactly once — the success and failure paths are mutually
		// exclusive — transferring ownership to the published tab on success or
		// rolling the fresh browser back on failure.
		holdBrowser(browser);
		let result: AcquireTabResult;
		let relayNotice: string | null = null;
		try {
			// Read before the tab is acquired, so a cancel or the deadline landing during the read leaves no tab to close.
			if (kind.kind === "relay") {
				stage = "reading the relay extension version";
				relayNotice = await relayExtensionNotice(normalizeConnectedCdpUrl(kind.cdpUrl), openSignal);
				throwIfAborted(openSignal);
			}
			stage = `opening tab ${JSON.stringify(name)}`;
			const initScripts = await untilAborted(openSignal, () =>
				resolveInitScriptSources(params.init_scripts, session.cwd),
			);
			// Worker-init options cannot be applied to a live tab: recycle it so the
			// reopened tab starts with them.
			if (
				existing &&
				(initScripts.length > 0 ||
					params.downloads !== undefined ||
					params.user_agent !== undefined ||
					params.insecure === true)
			) {
				stage = `closing tab ${JSON.stringify(name)} to reopen it`;
				await untilAborted(openSignal, () => releaseTab(name, { kill: false, timeoutMs }));
				stage = `opening tab ${JSON.stringify(name)}`;
			}
			result = await untilAborted(openSignal, () =>
				acquireTab(name, browser, {
					url: params.url,
					waitUntil: params.wait_until,
					viewport: params.viewport
						? {
								width: params.viewport.width,
								height: params.viewport.height,
								deviceScaleFactor: params.viewport.scale,
							}
						: undefined,
					target: params.target,
					timeoutMs,
					deadlineStartMs: deadlineStart,
					dialogs: params.dialogs,
					allowedDomains: params.allowed_domains,
					initScripts,
					downloadsPath,
					userAgent: params.user_agent,
					insecure: params.insecure,
					visible: params.headed ?? !cfgBrowserHeadless.get(session.settings),
					signal: openSignal,
					ownerSessionId: tabOwnerId(session),
					// Omitted stays undefined: creation defaults it to false
					// while reuse by the owner leaves a set value alone.
					persist: params.persist,
				}),
			);
		} catch (error) {
			await releaseBrowser(browser, {
				kill: "subprocess" in browser && browser.subprocess !== undefined,
			});
			throw error;
		}
		await releaseBrowser(browser, { kill: false });
		// Opportunistic idle-close sweep for long turns that rarely settle:
		// close owned tabs idle past the timeout. Detached by design (same
		// as the orphan-target sweep on attach) — failures only log. Freeze
		// is deliberately NOT done here: freezing a sibling with an
		// in-flight run would stall it mid-execution, while turn_end is
		// race-free by construction (all tool results are paired).
		void sweepIdleOwnedTabs(session);

		const tab = result.tab;
		const url = tab.info.url;
		const title = tab.info.title ?? "";
		details.url = url;
		details.viewport = tab.info.viewport;
		const verb = result.created ? "Opened" : "Reused";
		// One line: the tab and its browser, where it landed unless that is the URL the call asked for, and its title.
		let opened = `${verb} tab ${JSON.stringify(name)} on ${describeBrowser(tab)}`;
		if (!params.url || !sameAddress(params.url, url)) opened += `, at ${url}`;
		if (title) opened += `, titled ${JSON.stringify(title)}`;
		const lines = [
			opened,
			...(tab.backend === "tern" ? ternNotes(tab) : []),
			...notes,
			result.note,
			relayNotice,
		].filter((line): line is string => typeof line === "string");
		return toolResult(details).text(lines.join("\n")).done();
	} catch (error) {
		// Caller cancellation stays a ToolAbortError; the requested timeout
		// becomes a timeout ToolError naming the stalled step; anything else
		// passes through unchanged.
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms while ${stage}`);
		throw error;
	}
}

/**
 * The user's own pages `target` can adopt, from the browser an open with
 * `target` would drive: a Tern window's browser blocks, or the relay's
 * Chrome pages. The browser is acquired as an open does (the loopback relay
 * starts on demand) and released again.
 */
async function listTargets(
	session: ToolSession,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	// Resolve as an open naming a target: inside Tern that selects Tern even when the `browser.tern` setting is off.
	const kind = resolveBrowserKind({ ...params, target: params.target ?? "" }, session);
	if (kind.kind !== "tern" && kind.kind !== "relay") {
		throw new ToolError(
			`No pages to adopt here (the browser would be ${describeKind(kind)}): targets exist only inside a Tern pane (its browser blocks) or with the omp relay (app: "relay" or the browser.relay setting).`,
		);
	}
	details.browser = kind.kind;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const listSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const browser = await untilAborted(listSignal, () =>
			acquireBrowser(kind, { cwd: session.cwd, signal: listSignal }),
		);
		holdBrowser(browser);
		try {
			let targets: TernTarget[] | RelayTarget[];
			let text: string;
			if (kind.kind === "relay") {
				targets = await untilAborted(listSignal, () => listRelayTargets(kind.cdpUrl, listSignal));
				text = describeRelayTargets(targets);
			} else if ("tern" in browser) {
				const blocks = await listTernBlocks(browser.tern, { timeoutMs, signal: listSignal });
				const taken = ternBlocksTaken();
				targets = ternTargets(blocks, taken);
				text = describeTernTargets(blocks, taken);
			} else {
				throw new ToolError(`${describeKind(kind)} has no pages to adopt.`);
			}
			details.value = targets;
			return toolResult(details).text(text).done();
		} finally {
			await releaseBrowser(browser, { kill: false });
		}
	} catch (error) {
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Listing browser targets timed out after ${timeoutMs}ms`);
		throw error;
	}
}

async function closeBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const kill = !!params.kill;
	if (params.all) {
		// Only the caller's own tabs: another agent's tabs (a parent's, a sibling's)
		// are reaped when that agent disposes. No owner (SDK callers) keeps the
		// process-wide release.
		const ownerId = tabOwnerId(session);
		const count = await untilAborted(signal, () =>
			ownerId ? releaseTabsForOwner(ownerId, { kill, timeoutMs }) : releaseAllTabs({ kill, timeoutMs }),
		);
		const text = `Released ${count} managed tab${count === 1 ? "" : "s"}`;
		return toolResult(details).text(text).done();
	}
	const closed = await untilAborted(signal, () => releaseTab(name, { kill, timeoutMs }));
	const text = closed ? `Released managed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`;
	return toolResult(details).text(text).done();
}

function resolveBrowserRunCode(params: BrowserParams): string {
	if (params.action === "call") return renderTabCall(params.chain ?? []);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	if ((code === undefined || code.length === 0) === (fn === undefined || fn.length === 0)) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (fn !== undefined && fn.length > 0) {
		return renderFunctionRun(fn, BROWSER_RUN_SCOPE, params.args ?? []);
	}
	return code ?? "";
}

async function runBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const code = resolveBrowserRunCode(params);
	const tab = getTab(name);
	if (tab) {
		details.browser = tab.browser.kind.kind;
		details.url = tab.info.url;
	}

	const { displays, returnValue, screenshots } = await runInTab(name, {
		code,
		timeoutMs,
		signal,
		session,
		waitsForDownload: params.action === "call" && params.chain?.[0]?.method === "waitForDownload",
	});

	if (screenshots.length) details.screenshots = screenshots;

	if (returnValue !== undefined) details.value = returnValue;
	const content = [...displays];
	const textOnly = content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
	// Final defense at the host-result boundary: a single run can display
	// tens of KB (large JSON returns, dumped observations). Cap the combined
	// text inline; the full text stays recoverable via the artifact footer
	// when allocation succeeds.
	const cappedText = await enforceInlineByteCap(textOnly, {
		saveArtifact: full => saveBrowserOutputArtifact(session, full),
	});
	const nonText = content.filter(part => part.type !== "text");
	if (cappedText.length === 0) return toolResult(details).content(nonText).done();
	return toolResult(details)
		.content([...nonText, { type: "text", text: cappedText }])
		.done();
}

/** Persist over-cap browser run output as a session artifact; mirrors the bash minimizer's save path. */
async function saveBrowserOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("browser-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

function describeBrowser(tab: TabSession): string {
	if (tab.backend === "tern") {
		const adopted = tab.ternTab.adopted;
		if (!adopted) return `Tern browser picture-in-picture (pane ${tab.browser.kind.pane})`;
		return `the user's Tern browser block ${adopted.block} (${adopted.owner === null ? "docked" : "picture-in-picture"})`;
	}
	if (tab.backend === "webkit") {
		return tab.browser.webkit.isShown(tab.ternTab.block)
			? "omp's WebKit browser (in a window)"
			: "omp's headless WebKit browser";
	}
	const handle = tab.browser;
	if (!("browser" in handle)) {
		return `cmux browser (${handle.kind.surface ?? "split"})`;
	}
	switch (handle.kind.kind) {
		case "headless":
			return `headless browser (${handle.kind.headless ? "hidden" : "visible"}${handle.sharedDaemon ? ", shared" : ""})`;
		case "spawned":
			return `spawned ${handle.kind.path} (pid ${handle.pid ?? "?"})`;
		case "connected":
			return `connected ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
		case "relay":
			return `relay ${handle.cdpUrl ?? handle.kind.cdpUrl}`;
	}
}

/** Where a Tern tab's page is for the user: whose block it is, and whether it is on screen. */
function ternNotes(tab: TernTabSession): string[] {
	const notes: string[] = [];
	const adopted = tab.ternTab.adopted;
	if (adopted) {
		notes.push(
			`This is the user's own Tern browser block ${adopted.block} (${JSON.stringify(tab.info.title ?? "")} at ${tab.info.url}); closing the tab releases it to the user without closing it.`,
		);
	}
	if (tab.ternTab.shown === false) {
		notes.push(
			adopted
				? `Not on screen: the user is viewing another Tern tab or session. Block ${adopted.block} shows once they switch to the tab holding it; tell them where it is.`
				: `Not on screen: the user hid pictures in picture (⌃⌥⌘P), or this Tern shows them only in the tab holding this omp pane (block ${tab.browser.kind.pane}); tell them where it is.`,
		);
	}
	return notes;
}

function describeKind(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless ${kind.headless ? "hidden" : "visible"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.surface ?? "split"}`;
		case "tern":
			return `tern:pane ${kind.pane}`;
		case "webkit":
			return "omp's headless WebKit";
	}
}
