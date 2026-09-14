/**
 * Browser relay mode selection.
 *
 * Chromium drives the user's tabs through the local CDP relay and extension.
 * Firefox-family browsers connect directly to an existing WebDriver BiDi endpoint.
 */
import { parseFlag } from "@oh-my-pi/pi-utils";
import { DEFAULT_FIREFOX_BIDI_URL, validateFirefoxWebSocketUrl } from "./firefox";

export type RelayBrowser = "chromium" | "firefox";

/** Browser kind selecting the Chromium extension relay. */
export interface RelayKind {
	kind: "relay";
	cdpUrl: string;
}

/** Browser kind selecting a Firefox-family WebDriver BiDi endpoint. */
export interface FirefoxRelayKind {
	kind: "firefox-relay";
	webSocketUrl: string;
}

/** Default endpoint of the `omp-browser-relay` CLI. */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

export interface ResolveRelayKindOptions {
	/** `browser.relay` setting; `PI_BROWSER_RELAY=0|1` overrides it. */
	settingEnabled?: boolean;
	/** Selected relay browser; omitted preserves Chromium behavior. */
	browser?: RelayBrowser;
	/** Relay endpoint: HTTP for Chromium, WebSocket for Firefox. */
	url?: string;
}

/**
 * Resolve the relay browser kind, or null when relay mode is disabled.
 * Mirrors `resolveCmuxKind`: the setting opts in, the env var is the final
 * override in both directions.
 */
export function resolveRelayKind(
	options?: ResolveRelayKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): RelayKind | FirefoxRelayKind | null {
	if (!parseFlag(env.PI_BROWSER_RELAY, options?.settingEnabled ?? false)) {
		return null;
	}
	const url = options?.url?.trim();
	if (options?.browser === "firefox") {
		return {
			kind: "firefox-relay",
			webSocketUrl: validateFirefoxWebSocketUrl(url || DEFAULT_FIREFOX_BIDI_URL),
		};
	}
	return { kind: "relay", cdpUrl: (url || DEFAULT_RELAY_URL).replace(/\/+$/, "") };
}
