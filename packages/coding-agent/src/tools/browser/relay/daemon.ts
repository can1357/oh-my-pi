/**
 * Daemon-supervised browser relay.
 *
 * The MV3 extension can only dial OUT (service workers cannot listen on
 * sockets), so a native process must own the relay port. Instead of making
 * the user run `omp browser-relay` by hand, the relay kind lazily starts one
 * as a global `proc` unit of the omp daemon. Every relay consumer holds a
 * lease on it, so one project exiting cannot tear down the fixed-port
 * singleton while another project still uses it; a daemon upgrade re-exec
 * keeps it (the daemon's default `survive` for pipe services).
 *
 * A manually started relay may already own the port; consumers adopt that
 * external server without attempting another bind (and hold no lease).
 */
import * as os from "node:os";
import type { UnitPolicy, UnitSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { logger } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { daemonClient } from "../../../daemon/client";
import { type DaemonClient, GLOBAL_SCOPE, type OpenRequest } from "../../../daemon/protocol";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../../../subprocess/worker-client";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpResponse, probeCdpStatus } from "../attach";
import { describeUnit, isLiveUnit, type UnitIdentity, UnitLease } from "../unit-lease";
import { DEFAULT_RELAY_URL } from "./kind";
import { relayCdpClientsOf, relayVersionOf } from "./probe";
import { isOlderOmpVersion } from "./protocol";

const DEFAULT_RELAY_PORT = new URL(DEFAULT_RELAY_URL).port;

/** Unit key of the relay on `port`; one per port, so relays on different ports never replace each other. */
function relayUnitIdentity(port: string): UnitIdentity {
	return {
		kind: "proc",
		scope: GLOBAL_SCOPE,
		key: port === DEFAULT_RELAY_PORT ? "omp.browser.relay" : `omp.browser.relay.${port}`,
	};
}

function relayPort(cdpUrl: string): string | null {
	try {
		return String(new URL(cdpUrl).port || 80);
	} catch {
		return null;
	}
}

/** Matches the serve banner (`omp browser relay listening on http://…`). */
const READY_LOG_PATTERN = String.raw`browser relay listening on http://\S+`;
const READY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 5_000;
/**
 * The relay dies shortly after its last consumer lets go. `survive` keeps the
 * daemon's default for pipe services (`exec`: kept across an upgrade re-exec);
 * `detached` belongs to `hold: "detached"` units only.
 */
const RELAY_POLICY: Partial<UnitPolicy> = {
	hold: "leases",
	idleMs: 3_000,
	onIdle: "stop",
	restart: "no",
};

/** True when the relay HTTP server answers /json/version at all (200 = extension connected, 503 = waiting for it). */
export async function probeRelayServer(cdpUrl: string): Promise<boolean> {
	const status = await probeCdpStatus(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status === 503 || (status !== null && status >= 200 && status < 300);
}

/** Auto-start is only safe for endpoints this machine can own. */
export function isLoopbackRelayUrl(cdpUrl: string): boolean {
	try {
		const { hostname } = new URL(cdpUrl);
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

function relayOpenRequest(port: string): OpenRequest {
	const spawn = resolveWorkerSpawnCmd("browser-relay");
	return {
		...relayUnitIdentity(port),
		label: `Browser relay :${port}`,
		proc: {
			application: spawn.cmd[0]!,
			args: [...spawn.cmd.slice(1), "--port", port],
			env: workerEnvFromParent(),
			cwd: spawn.cwd ?? os.homedir(),
			pty: false,
			ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
		},
		policy: RELAY_POLICY,
	};
}

/** Open the relay unit and keep its lease when it serves `cdpUrl`; otherwise drop the lease and resolve null. */
async function openRelay(
	client: DaemonClient,
	request: OpenRequest,
	cdpUrl: string,
	replace: boolean,
	signal?: AbortSignal,
): Promise<UnitLease | null> {
	let lease: UnitLease;
	try {
		lease = new UnitLease(client, request, await client.open({ ...request, replace }, signal));
	} catch (error) {
		throwIfAborted(signal);
		logger.debug("Browser relay open failed", {
			key: request.key,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
	if (await probeRelayServer(cdpUrl)) return lease;
	await lease.release();
	return null;
}

/**
 * Ensure a relay server answers at `cdpUrl`, starting the daemon-supervised
 * relay when nothing is serving, and lease it. The extension handshake
 * (503 → 200) is the caller's wait. Resolves the lease the caller holds while
 * it uses the relay, or null when a relay the daemon does not run serves
 * there, or when the relay could not be started (the caller's wait then
 * reports it unreachable). A live relay unit that does not answer is
 * replaced once.
 */
export async function ensureRelayDaemon(opts: { cdpUrl: string; signal?: AbortSignal }): Promise<UnitLease | null> {
	const port = relayPort(opts.cdpUrl);
	if (port === null) return null;
	const client = await daemonClient();
	throwIfAborted(opts.signal);
	const request = relayOpenRequest(port);
	if (await probeRelayServer(opts.cdpUrl)) {
		// Serving: lease our own unit, but never start one against a manual relay.
		const existing = await describeUnit(client, relayUnitIdentity(port), opts.signal);
		return isLiveUnit(existing) ? openRelay(client, request, opts.cdpUrl, false, opts.signal) : null;
	}
	const opened = await openRelay(client, request, opts.cdpUrl, false, opts.signal);
	if (opened) return opened;
	// A manual serve may have won the port meanwhile (ours then failed to bind); adopt it.
	if (await probeRelayServer(opts.cdpUrl)) return null;
	// Live unit but nothing listening: replace the wedged relay.
	return openRelay(client, request, opts.cdpUrl, true, opts.signal);
}

/** Outcome of {@link restartRelayDaemon}. */
export interface RelayRestart {
	/** The outdated relay stopped, or another process already replaced it. */
	restarted: boolean;
	/** The lease the caller holds from now on; the old one was released when this differs from it. */
	lease: UnitLease | null;
}

/**
 * Replace the daemon-supervised relay at `cdpUrl` with one from this OMP
 * version when it comes from an older one; with `idleOnly`, only while it
 * reports no CDP client connected. `restarted` is true once the old relay has
 * stopped (the caller's wait reports whether the new one serves) or another
 * process already replaced it or stopped it to replace it. False when a relay
 * the daemon does not run serves there (a manually started relay is left
 * alone), the relay comes from a newer OMP (a concurrently running newer omp
 * owns it), an `idleOnly` relay has a client or does not report its clients,
 * or the old relay did not stop.
 */
export async function restartRelayDaemon(opts: {
	cdpUrl: string;
	lease: UnitLease | null;
	signal?: AbortSignal;
	idleOnly?: boolean;
}): Promise<RelayRestart> {
	const kept: RelayRestart = { restarted: false, lease: opts.lease };
	const port = relayPort(opts.cdpUrl);
	if (port === null) return kept;
	const client = await daemonClient();
	const identity = relayUnitIdentity(port);
	const existing = await describeUnit(client, identity, opts.signal);
	if (!existing || !isLiveUnit(existing)) {
		// Another omp may have stopped the old relay and not yet registered its
		// replacement; start or adopt it unless a relay the daemon does not run serves.
		const serving = await probeRelayServer(opts.cdpUrl);
		throwIfAborted(opts.signal);
		if (serving) return { ...kept, restarted: (await relayStatusAt(opts.cdpUrl, opts.signal))?.version === VERSION };
		// Restarted even if the start fails: the caller's next wait then reports
		// the relay unreachable, which is accurate, rather than out of date.
		return { restarted: true, lease: await swapLease(opts.lease, await ensureRelayDaemon(opts)) };
	}
	// Another omp of this version may have replaced it since the caller's probe,
	// possibly with a relay that has not printed its ready line yet.
	if (existing.state === "starting") await waitRelayReady(client, existing, opts.signal);
	const status = await relayStatusAt(opts.cdpUrl, opts.signal);
	if (status?.version === VERSION) {
		// Possibly another omp's replacement: move the lease onto it.
		const lease =
			opts.lease?.unit.generation === existing.generation
				? opts.lease
				: await swapLease(opts.lease, await ensureRelayDaemon(opts));
		return { restarted: true, lease };
	}
	// A newer omp running alongside this one owns a newer relay; replacing it
	// would only make the two versions take turns killing each other's relay.
	if (status !== null && !isOlderOmpVersion(status.version, VERSION)) return kept;
	// The last read before the stop: a client that connected since the caller's
	// probe keeps the relay. One connecting during the stop request itself loses
	// its connection, as on any relay restart.
	if (opts.idleOnly && status?.cdpClients !== 0) return kept;
	// Stops only the generation judged outdated, not one another omp started since.
	const stopped = await stopRelay(client, existing, opts.signal);
	if (stopped && !isLiveUnit(stopped)) {
		// As above: a failed start surfaces as unreachable on the caller's wait.
		return { restarted: true, lease: await swapLease(opts.lease, await ensureRelayDaemon(opts)) };
	}
	if (stopped === undefined || stopped.generation === existing.generation) return kept;
	// Another omp replaced it meanwhile: lease the replacement.
	if (stopped.state === "starting") await waitRelayReady(client, stopped, opts.signal);
	return { restarted: true, lease: await swapLease(opts.lease, await ensureRelayDaemon(opts)) };
}

/** Release `previous` in favour of `next` (which may be the same lease or null). */
async function swapLease(previous: UnitLease | null, next: UnitLease | null): Promise<UnitLease | null> {
	if (previous && previous !== next) await previous.release();
	return next;
}

async function waitRelayReady(client: DaemonClient, unit: UnitSnapshot, signal?: AbortSignal): Promise<void> {
	try {
		await client.request({ op: "wait", unit: unit.id, for: "ready", timeoutMs: READY_TIMEOUT_MS }, signal);
	} catch (error) {
		throwIfAborted(signal);
		logger.debug("Browser relay ready wait failed", {
			key: unit.key,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function stopRelay(
	client: DaemonClient,
	unit: UnitSnapshot,
	signal?: AbortSignal,
): Promise<UnitSnapshot | undefined> {
	try {
		return (
			await client.request(
				{ op: "stop", unit: unit.id, timeoutMs: STOP_TIMEOUT_MS, generation: unit.generation },
				signal,
			)
		).unit;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug("Browser relay stop failed", {
			key: unit.key,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * The OMP version (empty for a relay too old to report one) and connected CDP
 * client count the relay at `cdpUrl` reports on `/json/version`, ready or
 * waiting for its extension; null when nothing parseable answers.
 */
async function relayStatusAt(
	cdpUrl: string,
	signal: AbortSignal | undefined,
): Promise<{ version: string; cdpClients: number | null } | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	throwIfAborted(signal);
	if (!response) return null;
	try {
		const parsed: unknown = JSON.parse(response.body);
		return typeof parsed === "object" && parsed !== null
			? { version: relayVersionOf(parsed), cdpClients: relayCdpClientsOf(parsed) }
			: null;
	} catch {
		return null;
	}
}
