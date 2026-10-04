/**
 * Client-side wait for the relay's extension handshake.
 *
 * `/json/version` answers 503 until the extension dials in, and the 503 body
 * ({@link RelayUnavailableInfo}) says whether an extension has ever done so.
 * That splits the two reasons for a 503 that used to look identical:
 * - Extension seen before: Chrome reaped its MV3 service worker; the
 *   extension's 30s keepalive alarm revives it, so waiting one alarm period
 *   pays off.
 * - Extension never seen: an installed extension dials within one alarm
 *   period of the server starting, so once the server has been up that long
 *   nothing is coming and the open fails at once instead of burning the
 *   whole window every call.
 */
import { throwIfAborted } from "../../tool-errors";
import { probeCdpResponse } from "../attach";
import type { RelayUnavailableInfo } from "./server";
import { DISCARDED_TABS_PROTOCOL_VERSION } from "./protocol";

/**
 * One extension keepalive alarm period (30s, `background.js`) plus the dial
 * and hello. Both the reconnect wait and the "never connected" verdict use it.
 */
const EXTENSION_DIAL_WINDOW_MS = 35_000;
const PROBE_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 150;

/** Outcome of {@link waitForRelayExtension}. */
export type RelayWaitOutcome =
	/** `/json/version` has the required relay and extension capabilities. */
	| "ready"
	/** Nothing (or something that is not a relay) is serving the endpoint. */
	| "unreachable"
	/** The relay is serving but no extension connected within the dial window. */
	| "no-extension"
	/** An older relay server is still running. */
	| "outdated-relay"
	/** The relay extension is older than the running server. */
	| "outdated-extension";

function parseUnavailableInfo(body: string): RelayUnavailableInfo | null {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"extensionSeen" in parsed &&
			typeof parsed.extensionSeen === "boolean" &&
			"uptimeMs" in parsed &&
			typeof parsed.uptimeMs === "number"
		) {
			return { error: "", extensionSeen: parsed.extensionSeen, uptimeMs: parsed.uptimeMs };
		}
	} catch {
		// Not a relay body (older relay or foreign server); treated as opaque 503 below.
	}
	return null;
}

function readyOutcome(body: string): RelayWaitOutcome {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("ompRelayDiscardedTabsProtocol" in parsed) ||
			parsed.ompRelayDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)
		) {
			return "outdated-relay";
		}
		if (
			!("ompExtensionDiscardedTabsProtocol" in parsed) ||
			parsed.ompExtensionDiscardedTabsProtocol !== String(DISCARDED_TABS_PROTOCOL_VERSION)
		) {
			return "outdated-extension";
		}
		return "ready";
	} catch {
		return "outdated-relay";
	}
}

/**
 * Poll the relay at `cdpUrl` until its extension is connected. Gives up
 * immediately when nothing serves the endpoint, after one dial window when
 * an extension has connected before (service-worker revival), or as soon as
 * the server has been up a full dial window without ever seeing one.
 */
export async function waitForRelayExtension(cdpUrl: string, signal?: AbortSignal): Promise<RelayWaitOutcome> {
	const probeUrl = `${cdpUrl}/json/version`;
	let deadline = Date.now() + EXTENSION_DIAL_WINDOW_MS;
	for (;;) {
		throwIfAborted(signal);
		const response = await probeCdpResponse(probeUrl, { timeoutMs: PROBE_TIMEOUT_MS, signal });
		throwIfAborted(signal);
		if (response === null) return "unreachable";
		if (response.status >= 200 && response.status < 300) return readyOutcome(response.body);
		if (response.status !== 503) return "unreachable";
		const info = parseUnavailableInfo(response.body);
		if (info && !info.extensionSeen) {
			// Never connected: the window is measured from server start, not from now.
			deadline = Math.min(deadline, Date.now() - info.uptimeMs + EXTENSION_DIAL_WINDOW_MS);
		}
		if (Date.now() >= deadline) return "no-extension";
		await Bun.sleep(POLL_INTERVAL_MS);
	}
}
