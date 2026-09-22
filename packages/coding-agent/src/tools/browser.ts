import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import type { ToolSession } from "../sdk";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCmuxKind } from "./browser/cmux/rpc";
import { resolveSpawnArgs } from "./browser/attach";
import {
	acquireBrowser,
	browserKey,
	type BrowserHandle,
	type BrowserKind,
	type BrowserKindTag,
	holdBrowser,
	releaseBrowser,
} from "./browser/registry";
import { ensureChromiumExecutable } from "./browser/launch";
import { resolveInitScriptSources } from "./browser/open-options";
import { resolveRelayKind } from "./browser/relay/kind";
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
	releaseIdleTabsForOwner,
	releaseTab,
	runInTab,
} from "./browser/tab-supervisor";
import { renderTabCall } from "./browser/tab-call";
import { resolveToCwd } from "./path-utils";
import { renderCallChain, renderFunctionRun } from "./run-code";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

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
export type { Observation, ObservationEntry } from "./browser/tab-protocol";

const DEFAULT_TAB_NAME = "main";
const BROWSER_RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

const appSchema = type({
	"path?": type("string").describe("binary path to spawn"),
	"cdp_url?": type("string").describe("existing cdp endpoint"),
	"relay?": type("boolean").describe("drive the user's own tabs via the omp browser relay"),
	"args?": type("string[]").describe("extra cli args"),
	"target?": type("string").describe("substring to pick a window"),
});

const tabCallStepSchema = type({
	method: "string",
	args: "unknown[]",
});

const browserSchema = type({
	action: type("'open' | 'close' | 'run' | 'call' | 'tabs'").describe("operation"),
	"name?": type("string").describe("tab id (default 'main')"),
	"url?": type("string").describe("url to open"),
	"app?": appSchema,
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
	"ignore_https_errors?": type("boolean").describe("ignore invalid HTTPS certificates"),
	"allow_file_access?": type("boolean").describe("allow file URLs to read local files"),
	"headed?": type("boolean").describe("override the configured browser display mode"),
	"code?": type("string").describe("js body to run in tab"),
	"fn?": type("string").describe("serialized JavaScript function to run in tab"),
	"args?": type("unknown[]").describe("arguments passed to a serialized function"),
	"chain?": tabCallStepSchema.array(),
	"timeout?": type("number").describe("timeout in seconds"),
	"all?": type("boolean").describe("release every managed tab"),
	"kill?": type("boolean").describe("also kill spawned-app browsers"),
	"persist?": type("boolean").describe("keep tab live across turn settle and idle close"),
});

type BrowserParams = typeof browserSchema.infer;

interface BrowserPreludeDetails {
	meta?: OutputMeta;
	action: "open" | "close" | "run" | "call" | "tabs";
	name: string;
	url?: string;
	browser?: BrowserKindTag;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	screenshots?: ScreenshotResult[];
	value?: unknown;
}

function resolveBrowserKind(params: BrowserParams, session: ToolSession): BrowserKind {
	const app = params.app;
	if (app?.cdp_url) {
		return { kind: "connected", cdpUrl: app.cdp_url.replace(/\/+$/, "") };
	}
	if (app?.path) {
		const exe = resolveToCwd(app.path, session.cwd);
		const args = resolveSpawnArgs(exe, app.args, session.cwd);
		if (params.ignore_https_errors && !args.includes("--ignore-certificate-errors")) {
			args.push("--ignore-certificate-errors");
		}
		if (params.allow_file_access && !args.includes("--allow-file-access-from-files")) {
			args.push("--allow-file-access-from-files");
		}
		return { kind: "spawned", path: exe, args };
	}
	const relayUrl = session.settings.get("browser.relayUrl");
	// Explicit app.relay wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch (a relay that is down would otherwise brick the tool).
	if (app?.relay) {
		const relayKind = resolveRelayKind({ settingEnabled: true, url: relayUrl });
		if (relayKind) return relayKind;
	}
	// Relay before cdpUrl among settings: enabling the opt-out-by-default relay
	// is a deliberate mode selection, while cdpUrl is a standing fallback
	// endpoint. A configured endpoint is a default, not an override: explicit
	// app options win.
	if (app?.relay !== false) {
		const relayKind = resolveRelayKind({
			settingEnabled: session.settings.get("browser.relay"),
			url: relayUrl,
		});
		if (relayKind) return relayKind;
	}
	const configuredCdpUrl = session.settings.get("browser.cdpUrl")?.trim();
	if (configuredCdpUrl) {
		return { kind: "connected", cdpUrl: configuredCdpUrl.replace(/\/+$/, "") };
	}
	const cmuxKind = resolveCmuxKind({
		settingEnabled: session.settings.get("browser.cmux"),
	});
	if (cmuxKind) {
		return cmuxKind;
	}
	const headless = params.headed === undefined ? session.settings.get("browser.headless") : !params.headed;
	return {
		kind: "headless",
		headless,
		ignoreHttpsErrors: params.ignore_https_errors,
		allowFileAccess: params.allow_file_access,
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
		case "call":
			return `${name}.${renderCallChain(parsed.chain ?? [])}`;
		case "tabs":
			return "tabs";
	}
}

/** Drop headless tabs so a browser mode change applies to the next open. */
export async function restartBrowserForModeChange(): Promise<void> {
	await dropHeadlessTabs();
}

/**
 * Best-effort idle-close sweep for the calling session's owned headless
 * tabs. Never throws — callers detach it (`void`) so a slow reap cannot
 * delay the open it follows.
 */
function sweepIdleOwnedTabs(session: ToolSession): Promise<number> {
	const ownerId = session.getSessionId?.() ?? undefined;
	if (!ownerId) return Promise.resolve(0);
	const idleSec = session.settings.get("browser.idleCloseSec");
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
		const timeoutSeconds = clampTimeout("browser", parsed.timeout, session.settings.get("tools.maxTimeout"));
		const timeoutMs = timeoutSeconds * 1000;
		const name = parsed.name ?? DEFAULT_TAB_NAME;
		const details: BrowserPreludeDetails = { action: parsed.action, name };

		switch (parsed.action) {
			case "open":
				return await openBrowser(session, name, parsed, details, timeoutMs, context.signal);
			case "close":
				return await closeBrowser(name, parsed, details, timeoutMs, context.signal);
			case "tabs":
				details.value = listTabs();
				return toolResult(details).done();
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

async function openBrowser(
	session: ToolSession,
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const kind = resolveBrowserKind(params, session);
	const downloadsPath = params.downloads === undefined ? undefined : resolveToCwd(params.downloads, session.cwd);
	details.browser = kind.kind;

	// If a tab with this name already exists on a different browser kind, fail fast — caller must close first.
	const existing = getTab(name);
	if (existing && browserKey(existing.browser.kind) !== browserKey(kind)) {
		throw new ToolError(
			`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.browser.kind)}). Close it first.`,
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
		try {
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
					params.ignore_https_errors === true)
			) {
				await untilAborted(openSignal, () => releaseTab(name, { kill: false, timeoutMs }));
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
					target: params.app?.target,
					timeoutMs,
					deadlineStartMs: deadlineStart,
					dialogs: params.dialogs,
					allowedDomains: params.allowed_domains,
					initScripts,
					downloadsPath,
					userAgent: params.user_agent,
					ignoreHttpsErrors: params.ignore_https_errors,
					signal: openSignal,
					ownerSessionId: session.getSessionId?.() ?? undefined,
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
		const lines = [
			`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(browser)}`,
			`URL: ${url}`,
			title ? `Title: ${title}` : null,
		].filter((line): line is string => typeof line === "string");
		return toolResult(details).text(lines.join("\n")).done();
	} catch (error) {
		// Caller cancellation stays a ToolAbortError; the requested timeout
		// becomes a timeout ToolError; anything else passes through unchanged.
		if (signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
		if (timeoutSignal.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
		throw error;
	}
}

async function closeBrowser(
	name: string,
	params: BrowserParams,
	details: BrowserPreludeDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const kill = !!params.kill;
	if (params.all) {
		const count = await untilAborted(signal, () => releaseAllTabs({ kill, timeoutMs }));
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

function describeBrowser(handle: BrowserHandle): string {
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
	}
}
