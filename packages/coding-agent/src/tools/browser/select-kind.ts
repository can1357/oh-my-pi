import { getWebKitHostPath } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../registry";
import { resolveToCwd } from "../path-utils";
import { ToolError } from "../tool-errors";
import type { BrowserParams } from "./actions";
import { normalizeAppArgs } from "./attach";
import { resolveCmuxKind } from "./cmux/rpc";
import type { BrowserKind, PuppeteerBrowserKind } from "./registry";
import { isRelayOnly, resolveRelayEndpoint, selectRelayKind } from "./relay/kind";
import { ownsTerminal } from "./terminal-owner";
import { resolveTernKind } from "./tern/kind";
import { resolveWebKitKind } from "./webkit/kind";
import {
	cfgBrowserCdpUrl,
	cfgBrowserCmux,
	cfgBrowserHeadless,
	cfgBrowserRelay,
	cfgBrowserRelayUrl,
	cfgBrowserTern,
	cfgBrowserWebKit,
	cfgBrowserWebKitPath,
} from "./settings";

/** Browsers `app` names by keyword; any other `app` is a CDP endpoint URL or an executable path. */
const APP_KEYWORDS: readonly string[] = ["relay", "tern", "webkit", "chromium", "own", "auto"];

/** A `scheme://` string names a CDP endpoint to attach to; Windows drive paths (`C:\`) do not match. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function configuredRelayUrl(session: ToolSession, env: Record<string, string | undefined>): string | undefined {
	const url = cfgBrowserRelayUrl.get(session.settings);
	return isRelayOnly(env) ? (env.PI_PANEL_RELAY_URL ?? url) : url;
}

/**
 * The browser an open drives, by precedence: an explicit `app` (an executable
 * path or CDP URL, or a keyword: `relay`, `tern`, `webkit`, `chromium`, `own`),
 * the relay, `browser.cdpUrl`, Tern (inside a Tern pane; `target` selects it
 * over the `browser.tern` setting to adopt a block; `headed` does not opt out),
 * a cmux surface, then omp's own browser ({@link ownBrowserKind}). `app: "auto"`
 * is that chain without the relay. Tern and cmux are automatic only while no
 * other omp owns the terminal, and none of the user's own surfaces (relay, Tern,
 * cmux) is automatic for a subagent. With `PI_BROWSER_RELAY=only` (a session
 * started from the extension's side panel) every open, a subagent's included,
 * goes to the relay, and any `app` but `"relay"` throws. `app: "tern"` and `app: "webkit"` are explicit:
 * they throw when Tern or omp's WebKit host is unavailable.
 */
export function selectBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	env: Record<string, string | undefined> = process.env,
): BrowserKind {
	const app = params.app;
	if (isRelayOnly(env)) {
		if (app !== undefined && app !== "relay") {
			throw new ToolError(
				`This session drives the user's Chrome through the omp extension and has no other browser; app: ${JSON.stringify(app)} is unavailable. Omit app or pass app: "relay".`,
			);
		}
		const relayKind = selectRelayKind({ url: configuredRelayUrl(session, env) }, env);
		if (relayKind) return relayKind;
	}
	if (app !== undefined && URL_SCHEME.test(app)) {
		return { kind: "connected", cdpUrl: app.replace(/\/+$/, "") };
	}
	if (app && !APP_KEYWORDS.includes(app)) {
		const exe = resolveToCwd(app, session.cwd);
		const args = params.argv ?? [];
		const required =
			params.insecure && !args.includes("--ignore-certificate-errors")
				? [...args, "--ignore-certificate-errors"]
				: args;
		return { kind: "spawned", path: exe, args: normalizeAppArgs(exe, required, session.cwd) };
	}
	const relayUrl = cfgBrowserRelayUrl.get(session.settings);
	// Explicit app: "relay" wins over every setting; PI_BROWSER_RELAY stays the
	// final kill switch (a relay that is down would otherwise brick the tool).
	if (app === "relay") {
		const relayKind = selectRelayKind({ settingEnabled: true, url: relayUrl }, env);
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
	// explicit app wins. A `/tan` clone (task depth 0) keeps its parent's defaults.
	const subagent = (session.taskDepth ?? 0) > 0;
	if (app !== "auto" && !subagent) {
		const relayKind = selectRelayKind(
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
	// pane env, and its tabs would float over the other session's work. A subagent has no pane of
	// its own either: its tabs would pile up over the parent's, so it skips both even when
	// PI_BROWSER_TERN=1 or PI_BROWSER_CMUX=1 forces them for the parent.
	const ownsPane = ownsTerminal(env);
	if (!subagent || params.target !== undefined) {
		// `target` inside Tern names a browser block to adopt: an explicit request, like `app: "tern"`.
		const ternKind = resolveTernKind(
			{ settingEnabled: params.target !== undefined || (ownsPane && cfgBrowserTern.get(session.settings)) },
			env,
		);
		if (ternKind) return ternKind;
	}
	if (!subagent) {
		const cmuxKind = resolveCmuxKind({ settingEnabled: ownsPane && cfgBrowserCmux.get(session.settings) }, env);
		if (cmuxKind) return cmuxKind;
	}
	return ownBrowserKind(params, session, env);
}

/** Select the browser and, for a relay operation, discover the live endpoint. */
export async function resolveBrowserKind(
	params: BrowserParams,
	session: ToolSession,
	env: Record<string, string | undefined> = process.env,
): Promise<BrowserKind> {
	const kind = selectBrowserKind(params, session, env);
	return kind.kind === "relay" ? resolveRelayEndpoint(kind) : kind;
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
export function ownBrowserKind(
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
export function chromiumKind(
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
