/**
 * Broker-owned browser relay daemon.
 *
 * The MV3 extension can only dial OUT (service workers cannot listen on
 * sockets), so a native process must own the relay port. Instead of making
 * the user run `omp browser-relay` by hand, the relay kind lazily starts one
 * under a profile-independent, machine-global daemon broker. Every relay
 * consumer holds a connection to that broker, so one project exiting cannot
 * tear down the fixed-port singleton while another project still uses it.
 *
 * A manually started relay may already own the port. Consumers still acquire
 * the global broker lease before probing, then adopt that external server
 * without attempting another bind.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { daemonClientForGlobal } from "../../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd } from "../../../subprocess/worker-client";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpResponse, probeCdpStatus } from "../attach";
import { DEFAULT_RELAY_URL } from "./kind";
import { relayVersionOf } from "./probe";

const DEFAULT_RELAY_PORT = new URL(DEFAULT_RELAY_URL).port;

/** Broker daemon name for the relay on `port`; one per port, so relays on different ports never replace each other. */
function relayDaemonName(port: string): string {
	return port === DEFAULT_RELAY_PORT ? "omp.browser.relay" : `omp.browser.relay.${port}`;
}

function relayPort(cdpUrl: string): string | null {
	try {
		return String(new URL(cdpUrl).port || 80);
	} catch {
		return null;
	}
}

const RELAY_BROKER_SCOPE = "browser-relay";
/** Matches the serve banner (`omp browser relay listening on http://…`). */
const READY_LOG_PATTERN = String.raw`browser relay listening on http://\S+`;
const READY_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_500;
/** probe→describe→start rounds; bounds cross-process races and wedged-relay replacement. */
const ENSURE_ATTEMPTS = 3;

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

/**
 * Ensure a relay server answers at `cdpUrl`, starting the broker-owned daemon
 * when nothing is serving. Returns true once the HTTP endpoint responds — the
 * extension handshake (503 → 200) is the caller's wait. False when the relay
 * could not be started (broker unavailable or start rounds exhausted).
 */
export async function ensureRelayDaemon(opts: { cdpUrl: string; signal?: AbortSignal }): Promise<boolean> {
	const port = relayPort(opts.cdpUrl);
	if (port === null) return false;
	const name = relayDaemonName(port);
	// Open the lazy client before probing. Merely caching SocketDaemonClient
	// would not create the broker connection (and therefore would hold no lease).
	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	throwIfAborted(opts.signal);
	await client.request({ op: "ping" }, opts.signal);
	if (await probeRelayServer(opts.cdpUrl)) return true;
	const spawn = resolveWorkerSpawnCmd("browser-relay");
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		// A manual serve or concurrent global-broker start may have won the
		// port since the last round; adopt it instead of fighting the bind.
		if (await probeRelayServer(opts.cdpUrl)) return true;
		const existing = await describeQuietly(client, name, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
			if (await probeRelayServer(opts.cdpUrl)) return true;
			// Live record but nothing listening: replace the wedged daemon.
			await stopQuietly(client, name, "Browser relay", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
						application: spawn.cmd[0]!,
						args: [...spawn.cmd.slice(1), "--port", port],
						env: {},
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			if (await probeRelayServer(opts.cdpUrl)) return true;
			await stopQuietly(client, name, "Browser relay", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Browser relay start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return false;
}

/**
 * Replace the broker-owned relay at `cdpUrl` with one from this OMP version
 * when it comes from an older one. True once the old relay has stopped (the
 * caller's wait reports whether the new one serves) or another process already
 * replaced it or stopped it to replace it. False when a relay the broker does
 * not run serves there (a manually started relay is left alone), the relay
 * comes from a newer OMP (a concurrently running newer omp owns it), or the old
 * relay did not stop.
 */
export async function restartRelayDaemon(opts: { cdpUrl: string; signal?: AbortSignal }): Promise<boolean> {
	const port = relayPort(opts.cdpUrl);
	if (port === null) return false;
	const name = relayDaemonName(port);
	const client = await daemonClientForGlobal(RELAY_BROKER_SCOPE);
	const existing = await describeQuietly(client, name, "Browser relay", opts.signal);
	if (!existing || existing.state === "exited" || existing.state === "failed") {
		// Another omp may have stopped the old relay and not yet registered its
		// replacement; start or adopt it unless a relay the broker does not run serves.
		const serving = await probeRelayServer(opts.cdpUrl);
		throwIfAborted(opts.signal);
		if (serving) return (await relayVersionAt(opts.cdpUrl, opts.signal)) === VERSION;
		// Returns true even if the start fails: the caller's next wait then reports
		// the relay unreachable, which is accurate, rather than out of date.
		await ensureRelayDaemon(opts);
		return true;
	}
	// Another omp of this version may have replaced it since the caller's probe,
	// possibly with a relay that has not printed its ready line yet.
	if (existing.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
	const version = await relayVersionAt(opts.cdpUrl, opts.signal);
	if (version === VERSION) return true;
	// A newer omp running alongside this one owns a newer relay; replacing it
	// would only make the two versions take turns killing each other's relay.
	if (version !== null && !isOlderRelayVersion(version)) return false;
	// Stops only the generation judged outdated, not one another omp started since.
	const stopped = await stopQuietly(client, name, "Browser relay", opts.signal, existing.id);
	if (stopped?.state === "exited" || stopped?.state === "failed") {
		// As above: a failed start surfaces as unreachable on the caller's wait.
		await ensureRelayDaemon(opts);
		return true;
	}
	if (stopped === undefined || stopped.id === existing.id) return false;
	if (stopped.readyAt === undefined) await waitReady(client, name, "Browser relay", opts.signal);
	return true;
}

/**
 * The OMP version the relay at `cdpUrl` reports on `/json/version` (ready or
 * waiting for its extension): empty for a relay too old to report one, null
 * when nothing parseable answers.
 */
async function relayVersionAt(cdpUrl: string, signal: AbortSignal | undefined): Promise<string | null> {
	const response = await probeCdpResponse(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS, signal });
	throwIfAborted(signal);
	if (!response) return null;
	try {
		const parsed: unknown = JSON.parse(response.body);
		return typeof parsed === "object" && parsed !== null ? relayVersionOf(parsed) : null;
	} catch {
		return null;
	}
}

/** Whether a relay reporting `version` predates this OMP; one reporting none predates version markers. */
function isOlderRelayVersion(version: string): boolean {
	if (version === "") return true;
	try {
		return Bun.semver.order(version, VERSION) < 0;
	} catch {
		// Unparseable: not provably older, so leave it to its owner.
		return false;
	}
}
