/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../../config/registry";

export const cfgBrowserEnabled = register({
	id: "browser.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Available Tools",
		label: "Browser",
		description: "Enable the browser eval prelude for scripted browser automation",
	},
});

export const cfgBrowserCdpUrl = register({
	id: "browser.cdpUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Browser CDP URL",
		description:
			"Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. An explicit app on the tool call takes precedence.",
	},
});

export const cfgBrowserRelay = register({
	id: "browser.relay",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Browser Relay",
		description:
			"Drive your own Chrome tabs through the omp browser relay. Install the extension once (`omp browser-relay install`); the relay server auto-starts when the browser prelude needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.",
	},
});

export const cfgBrowserRelayUrl = register({
	id: "browser.relayUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Browser Relay URL",
		description: "omp browser relay endpoint (default http://127.0.0.1:9224).",
	},
});

export const cfgBrowserHeadless = register({
	id: "browser.headless",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Headless Browser",
		description:
			"Run the browser without a window (disable to show it). omp's WebKit tabs gain or lose their windows at once where the engine ships its viewer (macOS); elsewhere a visible browser is Chromium, launched in the new mode by the next open.",
	},
});

export const cfgBrowserCmux = register({
	id: "browser.cmux",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "cmux Browser",
		description:
			"Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.",
	},
});

export const cfgBrowserTern = register({
	id: "browser.tern",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Tern Browser",
		description:
			"Inside a Tern pane, open browser tabs as picture-in-pictures over omp's pane (native web view) instead of omp's own headless browser; falls back to that browser when no Tern window can host them. An explicit app, the relay and Browser CDP URL take precedence; app \"own\" opts one open out. Set PI_BROWSER_TERN=0 or PI_BROWSER_TERN=1 to override.",
	},
});

export const cfgBrowserWebKit = register({
	id: "browser.webkit",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "WebKit Browser",
		description:
			'Open browser tabs in omp\'s own headless WebKit engine instead of managed Chromium when the engine is installed (omp downloads it to ~/.o2/lib/abkit before Chrome for Testing when no browser is installed; see Browser WebKit Path). Chromium still opens a visible browser where the engine ships no viewer, and tabs the engine fails to start; an explicit app, the relay, Browser CDP URL, Tern and cmux take precedence; app "chromium" opts one open out. Set PI_BROWSER_WEBKIT=0 or PI_BROWSER_WEBKIT=1 to override.',
	},
});

export const cfgBrowserWebKitPath = register({
	id: "browser.webkitPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Browser WebKit Path",
		description:
			"omp's WebKit engine: its host executable, or an ABKit engine directory (which holds it as ABHost; ABHost.exe on Windows). If unset, omp runs the installed engine, ~/.o2/lib/abkit/ABHost (ABHost.exe on Windows). Supports ~. PI_BROWSER_WEBKIT_PATH overrides it.",
	},
});

export const cfgBrowserFreezeOnTurnEnd = register({
	id: "browser.freezeOnTurnEnd",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Freeze Browser Tabs On Turn End",
		description:
			"Freeze OMP-owned headless Chromium tabs when a turn settles so animated pages stop burning CPU/GPU while idle (WebKit tabs draw nothing unless asked). Tabs unfreeze automatically on next use; pass persist:true on open to opt a tab out.",
	},
});

export const cfgBrowserIdleCloseSec = register({
	id: "browser.idleCloseSec",
	type: "number",
	default: 1800,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Browser Idle Close Timeout",
		description:
			"Close OMP-owned headless browser tabs and Tern browser picture-in-pictures idle longer than this many seconds (0 = never; session dispose still reaps). Never touches relay/CDP/spawned browsers or other sessions' tabs.",
		options: [
			{ value: "0", label: "Never" },
			{ value: "900", label: "15 minutes" },
			{ value: "1800", label: "30 minutes" },
			{ value: "3600", label: "1 hour" },
		],
	},
});

export const cfgBrowserScreenshotDir = register({
	id: "browser.screenshotDir",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Grep & Browser",
		label: "Screenshot Directory",
		description:
			"Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)",
	},
});
