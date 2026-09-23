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
import { daemonClientForGlobal } from "../../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../../launch/ensure";
import { resolveWorkerSpawnCmd } from "../../../subprocess/worker-client";
import { throwIfAborted } from "../../tool-errors";
import { probeCdpStatus } from "../attach";

/** Stable broker daemon name for the relay server. */
export const RELAY_DAEMON_NAME = "omp.browser.relay";
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
	let port: string;
	try {
		port = String(new URL(opts.cdpUrl).port || 80);
	} catch {
		return false;
	}
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
		const existing = await describeQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) await waitReady(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
			if (await probeRelayServer(opts.cdpUrl)) return true;
			// Live record but nothing listening: replace the wedged daemon.
			await stopQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: RELAY_DAEMON_NAME,
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
			await stopQuietly(client, RELAY_DAEMON_NAME, "Browser relay", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("Browser relay start contention", {
				name: RELAY_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return false;
}
