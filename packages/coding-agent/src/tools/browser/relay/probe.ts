/**
 * Client side of the browser relay: waiting for it to drive a browser, and asking an outdated one to restart.
 *
 * The relay is served by the omp extension's native host for as long as Chrome runs with the extension
 * (`native-relay.ts`). Nothing on the port therefore means no such browser is running, except right after a
 * restart, while Chrome starts the next host. A 503 means a relay is up and its browser has not said hello yet,
 * which takes moments.
 */
import { withTimeout } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { ToolError, throwIfAborted } from "../../tool-errors";
import { probeCdpResponse } from "../attach";
import type { RelayKind } from "./kind";
import { DISCARDED_TABS_PROTOCOL_VERSION, isOlderOmpVersion, RELAY_RESTART_PATH } from "./protocol";
import { discoverWindowsRelay } from "./windows-discovery";

/** How long a relay that is up may go without its browser's hello. */
const HELLO_WINDOW_MS = 10_000;
/**
 * How long a restarted relay may take to come back: the extension's reconnect backoff, Chrome starting the next
 * native host, its bind and the hello.
 */
const RESTART_WINDOW_MS = 20_000;
const PROBE_TIMEOUT_MS = 2_000;
const WSL_RELAY_PROBE_TIMEOUT_MS = 500;
const POLL_INTERVAL_MS = 150;

/** Outcome of {@link waitForRelayExtension}. */
export type RelayWaitOutcome =
	/** `/json/version` has the required relay and extension capabilities. */
	| "ready"
	/** Nothing (or something that is not a relay) is serving the endpoint. */
	| "unreachable"
	/** The relay is serving but its browser did not say hello within the hello window. */
	| "no-extension"
	/** An older relay server is still running. */
	| "outdated-relay"
	/** A compatible relay from an older OMP is ready and reports no CDP client connected to it. */
	| "idle-older-relay"
	/** The relay extension is older than the running server. */
	| "outdated-extension";

/** The OMP version a parsed `/json/version` body (ready or waiting) reports; empty when it reports none. */
export function relayVersionOf(parsed: object): string {
	return "ompRelayVersion" in parsed && typeof parsed.ompRelayVersion === "string" ? parsed.ompRelayVersion : "";
}

/** CDP clients a parsed `/json/version` body (ready or waiting) reports; null for a relay too old to report them. */
export function relayCdpClientsOf(parsed: object): number | null {
	return "ompRelayCdpClients" in parsed && typeof parsed.ompRelayCdpClients === "number"
		? parsed.ompRelayCdpClients
		: null;
}

/** A `/json/version` body (ready or waiting) as an object; null when it is not one. */
function parseVersionBody(body: string): object | null {
	try {
		const parsed: unknown = JSON.parse(body);
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

function reportedRelayInstance(info: object | null): string | undefined {
	if (info && relayVersionOf(info) && "ompRelayInstance" in info && typeof info.ompRelayInstance === "string") {
		return info.ompRelayInstance;
	}
}

async function probeRelayIdentity(cdpUrl: string, signal?: AbortSignal): Promise<string | undefined> {
	// The raw probe bounds its response but still awaits the TCP connect.
	const reply = await withTimeout(
		probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: WSL_RELAY_PROBE_TIMEOUT_MS, signal }),
		WSL_RELAY_PROBE_TIMEOUT_MS,
		"Relay identity probe timed out",
		signal,
	).catch(() => null);
	throwIfAborted(signal);
	if (reply && (reply.status === 200 || reply.status === 503))
		return reportedRelayInstance(parseVersionBody(reply.body));
}

/** A stale local record can outlive its relay even when the PID and port are both reused. */
export async function resolveWslRelay(local: RelayKind, signal?: AbortSignal, bound?: RelayKind): Promise<RelayKind> {
	const windows = bound?.windowsInstance === undefined ? undefined : bound;
	const instance = windows ? await probeRelayIdentity(windows.cdpUrl, signal) : undefined;
	if (windows && instance === windows.windowsInstance) return windows;
	if (local.cdpUrl && (local.cdpUrl === windows?.cdpUrl ? instance : await probeRelayIdentity(local.cdpUrl, signal)))
		return local;

	const discovered = await discoverWindowsRelay(signal);
	if (windows && discovered.cdpUrl === windows.cdpUrl && discovered.windowsInstance === windows.windowsInstance) {
		// Windows can still see its relay when WSL's loopback no longer reaches it.
		throw new ToolError(
			`The bound Windows omp browser relay at ${windows.cdpUrl} did not answer from WSL. Retry or close the tab before reopening it.`,
		);
	}
	return discovered;
}

/** The id of the relay server answering at `cdpUrl`, ready or waiting; null when none answers. */
async function relayInstanceAt(cdpUrl: string, signal?: AbortSignal): Promise<string | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (response === null) return null;
	const parsed = parseVersionBody(response.body);
	return parsed !== null && "ompRelayInstance" in parsed && typeof parsed.ompRelayInstance === "string"
		? parsed.ompRelayInstance
		: "";
}

function readyOutcome(parsed: object | null, windowsRelay: boolean): RelayWaitOutcome {
	if (
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
		// A local relay from another OMP version is the likelier culprit than the extension.
		return !windowsRelay && relayVersionOf(parsed) !== VERSION ? "outdated-relay" : "outdated-extension";
	}
	if (!windowsRelay && isOlderOmpVersion(relayVersionOf(parsed), VERSION) && relayCdpClientsOf(parsed) === 0)
		return "idle-older-relay";
	return "ready";
}

/**
 * Poll the relay at `cdpUrl` until its browser said hello. Gives up at once when nothing serves the endpoint, unless
 * `restarted` (then it waits for the next host), and after the hello window when a relay serves without a browser.
 */
export async function waitForRelayExtension(
	cdpUrl: string,
	signal?: AbortSignal,
	options?: { restarted?: boolean; windowsInstance?: string },
): Promise<RelayWaitOutcome> {
	const probeUrl = `${cdpUrl}/json/version`;
	const reachableBy = Date.now() + (options?.restarted ? RESTART_WINDOW_MS : 0);
	const windowsInstance = options?.windowsInstance;
	let helloBy: number | null = null;
	for (;;) {
		throwIfAborted(signal);
		const response = await probeCdpResponse(probeUrl, { timeoutMs: PROBE_TIMEOUT_MS, signal });
		throwIfAborted(signal);
		if (response === null) {
			if (Date.now() >= reachableBy) return "unreachable";
		} else {
			const parsed = parseVersionBody(response.body);
			if (windowsInstance !== undefined && reportedRelayInstance(parsed) !== windowsInstance) return "unreachable";
			if (response.status >= 200 && response.status < 300)
				return readyOutcome(parsed, windowsInstance !== undefined);
			if (response.status !== 503) return "unreachable";
			helloBy ??= Date.now() + HELLO_WINDOW_MS;
			if (Date.now() >= helloBy) {
				// A relay from another version reads as outdated: no browser is behind it to blame instead.
				return windowsInstance === undefined && parsed !== null && relayVersionOf(parsed) !== VERSION
					? "outdated-relay"
					: "no-extension";
			}
		}
		await Bun.sleep(POLL_INTERVAL_MS);
	}
}

/**
 * Ask the native host serving the relay at `cdpUrl` to exit, so Chrome starts the next one from the installed omp;
 * with `idleOnly`, only while no CDP client uses it. Resolves true once the old server stopped answering (the caller
 * then waits with `restarted`). False when it declined (it is not older than this omp, or it is busy) or stayed.
 */
export async function requestRelayRestart(
	cdpUrl: string,
	options: { idleOnly: boolean; signal?: AbortSignal },
): Promise<boolean> {
	const { signal } = options;
	const before = await relayInstanceAt(cdpUrl, signal);
	if (before === null) return false;
	const query = `version=${encodeURIComponent(VERSION)}${options.idleOnly ? "&idle=1" : ""}`;
	try {
		const response = await fetch(`${cdpUrl}${RELAY_RESTART_PATH}?${query}`, { method: "POST", signal });
		if (response.status !== 202) return false;
	} catch {
		throwIfAborted(signal);
		return false;
	}
	const deadline = Date.now() + RESTART_WINDOW_MS;
	while (Date.now() < deadline) {
		await Bun.sleep(POLL_INTERVAL_MS);
		throwIfAborted(signal);
		// Gone, or already replaced by another browser's host: either way the old server stopped.
		if ((await relayInstanceAt(cdpUrl, signal)) !== before) return true;
	}
	return false;
}

/** The steps that replace an out-of-date relay extension. */
export const UPDATE_RELAY_EXTENSION = "Run `omp browser-relay install` and reload the omp extension in Chrome.";

/**
 * Notice for an open through a ready relay where a connected extension was
 * installed by an older omp, or null. The extension still speaks the relay
 * protocol, so the open goes ahead; relay fixes shipped since that install
 * stay inactive until the user reinstalls it. A relay too old to report the
 * extension's version gets no notice: it cannot tell.
 */
export async function relayExtensionNotice(cdpUrl: string, signal?: AbortSignal): Promise<string | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (response === null || response.status < 200 || response.status >= 300) return null;
	let installedBy: unknown;
	try {
		const parsed: unknown = JSON.parse(response.body);
		if (typeof parsed !== "object" || parsed === null || !("ompExtensionVersion" in parsed)) return null;
		installedBy = parsed.ompExtensionVersion;
	} catch {
		return null;
	}
	if (typeof installedBy !== "string" || !isOlderOmpVersion(installedBy, VERSION)) return null;
	const origin = installedBy === "" ? "an older omp" : `omp ${installedBy}; this is omp ${VERSION}`;
	return `The omp extension is out of date (installed by ${origin}). ${UPDATE_RELAY_EXTENSION}`;
}
