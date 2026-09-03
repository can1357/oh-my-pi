/**
 * Shared automation Chromium owned by the per-project daemon broker.
 *
 * Instead of every omp process launching (and sometimes orphaning) a private
 * Chromium, the headless browser kind attaches to one broker-supervised Chrome
 * per project directory — sessions and subagents each open their own tabs in
 * it. The broker stops the daemon when the last omp client in the project
 * exits, so Chrome can never outlive omp, and concurrent acquisitions across
 * processes converge on a single launch instead of a launch storm.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import { daemonRuntimeDir } from "../../launch/paths";
import type { DaemonSnapshot } from "../../launch/protocol";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import { resolveSharedBrowserLaunchSpec } from "./launch";

/** Chrome prints this on stderr once the CDP listener is up; the broker's ready probe captures the line. */
const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
/** describe→start rounds before giving up; bounds cross-process start races and wedged-Chrome replacement. */
const ENSURE_ATTEMPTS = 3;

/** Broker-owned browser endpoint one omp process can attach to. */
export interface SharedBrowserEndpoint {
	wsEndpoint: string;
	daemonName: string;
	/** Canonical project directory owning the broker (used to address later stop requests). */
	projectDir: string;
}

/** Stable broker daemon name for the shared automation browser. */
export function sharedBrowserDaemonName(headless: boolean): string {
	return headless ? "omp.browser.headless" : "omp.browser.headed";
}

function wsEndpointOf(snapshot: DaemonSnapshot | undefined): string | undefined {
	return snapshot?.readyMatch?.match(/ws:\/\/\S+/)?.[0];
}

/** CDP liveness probe: the ws endpoint host must answer /json/version. */
async function probeEndpoint(wsEndpoint: string): Promise<boolean> {
	let host: string;
	try {
		host = new URL(wsEndpoint).host;
	} catch {
		return false;
	}
	const status = await probeCdpStatus(`http://${host}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status !== null && status >= 200 && status < 300;
}

/**
 * Ensure the project-shared automation Chromium is running and reachable,
 * launching it under the daemon broker when needed. Idempotent across
 * processes: losers of the start race adopt the winner's endpoint on the next
 * describe round. Returns null when the shared path is unavailable (no
 * resolvable Chromium, broker failure, or a daemon that never becomes
 * reachable); callers fall back to a process-local launch.
 */
export async function ensureSharedBrowser(opts: {
	projectDir: string;
	headless: boolean;
	viewport?: { width: number; height: number };
	signal?: AbortSignal;
}): Promise<SharedBrowserEndpoint | null> {
	const client = await daemonClientForProject(opts.projectDir);
	const name = sharedBrowserDaemonName(opts.headless);
	// Stable profile under the broker's runtime dir: reused across launches, and
	// never contended by pre-daemon Chromiums that used throwaway temp profiles.
	const userDataDir = path.join(daemonRuntimeDir(client.projectDir), `${name}.profile`);
	const launch = await resolveSharedBrowserLaunchSpec({
		headless: opts.headless,
		userDataDir,
		viewport: opts.viewport,
	});
	if (!launch) return null;
	await fs.mkdir(userDataDir, { recursive: true });
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		const existing = await describeQuietly(client, name, "Shared browser", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			const settled =
				existing.readyAt !== undefined ? existing : await waitReady(client, name, "Shared browser", opts.signal);
			const wsEndpoint = wsEndpointOf(settled);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
				return { wsEndpoint, daemonName: name, projectDir: client.projectDir };
			}
			// Live record but unreachable Chrome (wedged, or readiness never
			// matched): replace it rather than handing out a dead endpoint.
			await stopQuietly(client, name, "Shared browser", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
						application: launch.executablePath,
						args: launch.args,
						env: {},
						cwd: client.projectDir,
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
			const wsEndpoint = started.readyTimedOut ? undefined : wsEndpointOf(started.daemon);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
				return { wsEndpoint, daemonName: name, projectDir: client.projectDir };
			}
			await stopQuietly(client, name, "Shared browser", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);
			// Lost a cross-process start race ("already starting/ready"); the next
			// describe round adopts the winner's endpoint.
			logger.debug("Shared browser start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}
