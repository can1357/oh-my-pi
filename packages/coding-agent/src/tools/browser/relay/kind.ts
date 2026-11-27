/**
 * Browser relay mode: drive the user's own Chrome tabs through the local CDP
 * relay (sibling `server.ts`/`bridge.ts`), which the omp extension's native
 * host serves while Chrome runs (`native-relay.ts`; installed via
 * `omp browser-relay install`). The relay impersonates Chrome's CDP discovery
 * endpoint, so beyond kind resolution the entire connected-browser machinery
 * (registry, tab supervisor, tab workers) applies unchanged.
 */
import { discoverRelayEndpoints } from "./discovery";
import { parseFlag } from "@oh-my-pi/pi-utils";

/** Browser kind selecting the omp browser relay. */
export interface RelayKind {
	kind: "relay";
	cdpUrl: string;
	windowsInstance?: string;
}

/** Whether `cdpUrl` names this machine; a browser behind any other endpoint may be on another OS. */
export function isLoopbackRelayUrl(cdpUrl: string): boolean {
	try {
		const { hostname } = new URL(cdpUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/**
 * Whether the relay is the session's only browser (`PI_BROWSER_RELAY=only`), as for a session the
 * extension's native host started from Chrome's side panel: every open, a subagent's included, drives the
 * user's Chrome, and no `app` other than `"relay"` is accepted.
 */
export function isRelayOnly(env: Record<string, string | undefined> = process.env): boolean {
	return env.PI_BROWSER_RELAY?.trim().toLowerCase() === "only";
}

export interface ResolveRelayKindOptions {
	/** `browser.relay` setting; `PI_BROWSER_RELAY=0|1|only` overrides it. */
	settingEnabled?: boolean;
	/** `browser.relayUrl` setting; otherwise discovers a local host. */
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
): RelayKind | null {
	if (!isRelayOnly(env) && !parseFlag(env.PI_BROWSER_RELAY, options?.settingEnabled ?? false)) {
		return null;
	}
	const url = options?.url?.trim() || discoverRelayEndpoints()[0] || "";
	return { kind: "relay", cdpUrl: url.replace(/\/+$/, "") };
}
