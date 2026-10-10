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
import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import { type DaemonBrokerClient, daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import { daemonRuntimeDir, placeRuntimeData } from "../../launch/paths";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import { resolveSharedBrowserLaunchSpec } from "./launch";
import type { SharedTargetScope } from "./orphan-registry";

/** Chrome prints this on stderr once the CDP listener is up; the broker's ready probe captures the line. */
const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
/** describe→start rounds before giving up; bounds cross-process start races and wedged-Chrome replacement. */
const ENSURE_ATTEMPTS = 3;
/**
 * Hard bound on one post-cleanup reachability check, covering both probes and
 * the broker stop request. Also the guarantee behind the single-flight entry:
 * whatever stalls underneath, the check settles and the entry clears.
 */
const HEALTH_CHECK_BUDGET_MS = 15_000;
/**
 * Hard cap on one probe attempt: the probe's own HTTP budget plus the connect
 * window that runs before that budget starts. `rawHttpGet` awaits `Bun.connect`
 * before its timer can settle the call, so without this cap a stalled TCP
 * connect outlives the whole health budget.
 */
const PROBE_ATTEMPT_CAP_MS = PROBE_TIMEOUT_MS + 1_500;
/** Marker for a probe the cap abandoned, as opposed to a probe that failed on its own terms. */
const PROBE_STALLED = "Shared browser probe did not settle";

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
 *
 * Per-open process flags are intentionally absent: a running shared Chromium
 * cannot be relaunched for one tab. `allow_file_access` is rejected before this
 * boundary; invalid-certificate handling remains page-scoped through CDP.
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
	// The launch spec relocates it when the executable cannot write there (Snap);
	// the standard path then becomes a link, so dead-scope pruning reclaims it.
	const profileDir = path.join(daemonRuntimeDir(client.projectDir), `${name}.profile`);
	const launch = await resolveSharedBrowserLaunchSpec({
		headless: opts.headless,
		userDataDir: profileDir,
		viewport: opts.viewport,
	});
	if (!launch) return null;
	await placeRuntimeData(profileDir, launch.userDataDir);
	await fs.mkdir(launch.userDataDir, { recursive: true });
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

/** Seams for {@link stopSharedBrowserIfUnreachable}; the defaults hit the real broker and CDP probe. */
export interface SharedBrowserHealthDeps {
	client?: DaemonBrokerClient;
	probe?: (wsEndpoint: string) => Promise<boolean>;
	signal?: AbortSignal;
	/** Override the per-attempt probe cap ({@link PROBE_ATTEMPT_CAP_MS}); slower values are only for tests. */
	probeCapMs?: number;
}

/** In-flight checks per broker daemon, so the tabs of one failed sweep share one stop round. */
const reachabilityChecks = new Map<string, Promise<boolean>>();

/**
 * Stop the project-shared browser when its CDP endpoint has stopped answering.
 *
 * `ensureSharedBrowser` makes this decision only while attaching, so a Chromium
 * that wedges *after* a session attached kept its whole process tree — and
 * every target whose close timed out — alive until the last omp client in the
 * project exited (a 9.1 GB, 44-process browser survived 19 h in the
 * 2026-09-27 incident). Cleanup failures re-run the same decision off the
 * acquire path: stop the daemon, so the next attach launches a fresh Chromium
 * and the leaked targets die with the old one.
 *
 * The liveness probe gates the stop — twice in a row, because one slow answer
 * on a loaded machine is not a wedge and stopping the shared browser costs
 * every session in the project its tabs — and the daemon is re-described
 * before the stop, so a browser another session replaced meanwhile is never
 * stopped under its name. A daemon that has not become ready is left to the
 * acquire path, which owns that race. Concurrent failed closes share one check.
 * Best-effort: never throws, and returns true only when the broker confirmed the stop.
 */
export function stopSharedBrowserIfUnreachable(
	scope: SharedTargetScope,
	deps: SharedBrowserHealthDeps = {},
): Promise<boolean> {
	const key = `${scope.projectDir}\u0000${scope.daemonName}`;
	const inFlight = reachabilityChecks.get(key);
	if (inFlight) return inFlight;
	// The body bounds every phase it can see. This outer race is what guarantees
	// the check — and therefore its single-flight entry — settles on schedule
	// even when an await underneath cannot be bounded from here (a broker socket
	// connect, a TCP connect that never opens).
	const run = withTimeout(
		checkSharedBrowserReachable(scope, deps),
		HEALTH_CHECK_BUDGET_MS,
		"Shared browser reachability check exceeded its budget",
	).catch(() => false);
	reachabilityChecks.set(key, run);
	void run.finally(() => {
		if (reachabilityChecks.get(key) === run) reachabilityChecks.delete(key);
	});
	return run;
}

/** True when a re-describe still names the daemon instance whose endpoint failed the probes. */
function isSameDaemonInstance(before: DaemonSnapshot, after: DaemonSnapshot | undefined): boolean {
	if (!after || after.state === "exited" || after.state === "failed") return false;
	return (
		after.id === before.id && after.startedAt === before.startedAt && wsEndpointOf(after) === wsEndpointOf(before)
	);
}

/** One reachability round. Resolves false for every non-destructive outcome; never rejects. */
async function checkSharedBrowserReachable(scope: SharedTargetScope, deps: SharedBrowserHealthDeps): Promise<boolean> {
	const signal = deps.signal ?? AbortSignal.timeout(HEALTH_CHECK_BUDGET_MS);
	const deadlineAt = Date.now() + HEALTH_CHECK_BUDGET_MS;
	try {
		const client = deps.client ?? (await daemonClientForProject(scope.projectDir));
		const existing = await describeQuietly(client, scope.daemonName, "Shared browser", signal);
		if (!existing || existing.state === "exited" || existing.state === "failed") return false;
		const wsEndpoint = wsEndpointOf(existing);
		// No endpoint stamped yet: still starting (or never became ready). The
		// acquire path owns that state; stopping here would race a cross-process
		// start that is about to succeed.
		if (!wsEndpoint) return false;
		const probe = deps.probe ?? probeEndpoint;
		/**
		 * `silent` when the endpoint did not answer 2xx in time — a refused or
		 * stalled connect, a non-2xx status, an answer slower than the probe's
		 * own 1.5 s budget, or an attempt the cap abandoned — `answered` only on
		 * a 2xx, and `unknown` when the health budget was already spent.
		 * `rawHttpGet` awaits `Bun.connect` before its own timer can settle the
		 * call, so the cap — not the probe's HTTP budget — is what a stalled
		 * connect runs into.
		 */
		async function probeAttempt(endpoint: string): Promise<"answered" | "silent" | "unknown"> {
			const capMs = Math.min(deps.probeCapMs ?? PROBE_ATTEMPT_CAP_MS, deadlineAt - Date.now());
			if (capMs <= 0) return "unknown";
			try {
				return (await withTimeout(probe(endpoint), capMs, PROBE_STALLED)) ? "answered" : "silent";
			} catch (error) {
				// Only the cap means "no answer". A probe that failed on its own
				// terms (a malformed endpoint, a broken dependency) is not
				// evidence against the browser and belongs to the caller's catch.
				if (error instanceof Error && error.message === PROBE_STALLED) return "silent";
				throw error;
			}
		}
		// Two silent attempts or nothing. `silent` is the only outcome that
		// counts against the browser, and it covers every way of not answering
		// 2xx in time (refused, non-2xx, slow past the 1.5 s budget, or an
		// attempt the cap abandoned): at that point the endpoint is not
		// servicing requests, so the sessions sharing the browser cannot drive it
		// either. Only `unknown` — no budget left to try — proves nothing, and
		// leaves the browser alone.
		if ((await probeAttempt(wsEndpoint)) !== "silent") return false;
		if ((await probeAttempt(wsEndpoint)) !== "silent") return false;
		// Two silent probes can have raced another session's replacement of the
		// same daemon name. Re-describe and stop only the instance that failed
		// them. (The stop op is still name-addressed, so this narrows rather than
		// closes that window; closing it needs a broker protocol change.)
		const confirmed = await describeQuietly(client, scope.daemonName, "Shared browser", signal);
		if (!isSameDaemonInstance(existing, confirmed)) return false;
		const stopped = await stopQuietly(client, scope.daemonName, "Shared browser", signal);
		// `stopQuietly` absorbs a rejected or unanswered stop, so only a terminal
		// snapshot proves the daemon actually ended. Reporting a stop that never
		// happened would let the caller forget targets that are still open —
		// exactly the leak this check exists to prevent.
		if (stopped?.state !== "exited" && stopped?.state !== "failed") {
			logger.debug("Shared browser stop was not confirmed", { daemon: scope.daemonName, state: stopped?.state });
			return false;
		}
		logger.warn("Stopped the project-shared browser after a cleanup failure", {
			daemon: scope.daemonName,
			projectDir: scope.projectDir,
			reason: "its CDP endpoint stopped answering",
		});
		return true;
	} catch (error) {
		logger.debug("Shared browser reachability check failed", {
			daemon: scope.daemonName,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
