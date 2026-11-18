/**
 * Shared automation Chromium supervised by the omp daemon.
 *
 * Instead of every omp process launching (and sometimes orphaning) a private
 * Chromium, the headless browser kind attaches to one daemon-supervised Chrome
 * per project directory — sessions and subagents each open their own tabs in
 * it. Every attached omp process holds a lease on the unit; the daemon stops
 * Chrome shortly after the last lease is released (or its connection closes),
 * so Chrome never outlives omp, while a daemon upgrade re-exec keeps it.
 * `open` is find-or-start in the daemon, so concurrent
 * acquisitions across processes converge on a single launch.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { UnitPolicy, UnitSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	acquireFileLock,
	type FileLockHandle,
	getDaemonRuntimeDir,
	logger,
	sanitizeText,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { daemonClient } from "../../daemon/client";
import { canonicalProjectDir } from "../../daemon/paths";
import { type DaemonClient, type OpenRequest, projectScope } from "../../daemon/protocol";
import { workerEnvFromParent } from "../../subprocess/worker-client";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import { discardOwnedProfileSessions, resolveSharedBrowserLaunchSpec, seedOwnedProfilePreferences } from "./launch";
import type { SharedTargetScope } from "./orphan-registry";
import { describeUnit, isLiveUnit, type UnitIdentity, UnitLease } from "./unit-lease";

/** Chrome prints this on stderr once the CDP listener is up; the daemon's ready check captures the line. */
const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;
/** Lines of Chrome's output a failed start reports. */
const OUTPUT_TAIL_LINES = 6;
/**
 * Chrome dies shortly after the last omp client in the project lets go. It is
 * a pipe child of the daemon, so `survive` keeps the daemon's default: an
 * upgrade re-exec keeps its pipes (`exec`) where the platform can re-exec.
 * `survive: "detached"` is reserved for `hold: "detached"` units, which never
 * idle-stop.
 */
const SHARED_BROWSER_POLICY: Partial<UnitPolicy> = {
	hold: "leases",
	idleMs: 3_000,
	onIdle: "stop",
	restart: "no",
};
/**
 * Longest one client holds the profile claim through a cold start: the
 * daemon's ready wait plus the endpoint probe and IPC slack. A waiter that
 * gives up after this may still adopt a running browser, but never starts one.
 */
const PROFILE_CLAIM_WAIT_MS = READY_TIMEOUT_MS + 15_000;
const PROFILE_CLAIM_RETRY_MS = 100;
/** Grace given to Chrome to exit before the daemon kills it; matches `omp ps stop`. */
const STOP_TIMEOUT_MS = 5_000;
/**
 * Hard bound on one post-cleanup reachability check, covering both probes and
 * the daemon stop request. Also the guarantee behind the single-flight entry:
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

/** Daemon-supervised browser endpoint one omp process attached to. */
export interface SharedBrowserEndpoint {
	wsEndpoint: string;
	/** The daemon-launched Chrome's process, which owns its windows on screen. */
	pid?: number;
	/** Unit key (`omp.browser.headless`/`omp.browser.headed`). */
	daemonName: string;
	/** Canonical project directory of the unit's scope. */
	projectDir: string;
	/** Keeps Chrome alive while this process uses it; release on dispose. */
	lease: UnitLease;
}

/** Stable unit key of the shared automation browser. */
export function sharedBrowserDaemonName(headless: boolean): string {
	return headless ? "omp.browser.headless" : "omp.browser.headed";
}

/** True for the project-shared browser units. */
export function isSharedBrowserUnit(unit: UnitSnapshot): boolean {
	return (
		unit.kind === "proc" &&
		unit.scope.kind === "project" &&
		(unit.key === sharedBrowserDaemonName(true) || unit.key === sharedBrowserDaemonName(false))
	);
}

/**
 * Stable per-project profile: reused across launches, and never contended by
 * pre-daemon Chromiums that used throwaway temp profiles.
 */
function sharedBrowserProfileDir(projectDir: string, name: string): string {
	return path.join(getDaemonRuntimeDir(projectDir), `${name}.profile`);
}

function wsEndpointOf(unit: UnitSnapshot | undefined): string | undefined {
	return unit?.readyMatch?.match(/ws:\/\/\S+/)?.[0];
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
 * launching it under the daemon when needed, and take a lease on it.
 *
 * Chromium reads Preferences only at startup and rewrites them from memory,
 * so only the client that launches it may prepare the profile, and only
 * before the launch. The profile claim makes adopt-or-start one decision per
 * profile: a racing client describes after the winner's start settled and
 * adopts it. A live but unreachable Chrome (wedged, or readiness never
 * matched) is replaced once, on a freshly prepared profile.
 *
 * Throws a ToolError naming why the shared path is unavailable (no resolvable
 * Chromium, a daemon failure, Chrome exiting or never becoming reachable, the
 * profile held by another process), with the tail of Chrome's output; a
 * CLI-host process never falls back to a process-local launch.
 *
 * Per-open process flags are intentionally absent: a running shared Chromium
 * cannot be relaunched for one tab, so invalid-certificate handling stays
 * page-scoped through CDP.
 */
export async function ensureSharedBrowser(opts: {
	projectDir: string;
	headless: boolean;
	viewport?: { width: number; height: number };
	signal?: AbortSignal;
}): Promise<SharedBrowserEndpoint> {
	const projectDir = await canonicalProjectDir(opts.projectDir);
	const name = sharedBrowserDaemonName(opts.headless);
	const userDataDir = sharedBrowserProfileDir(projectDir, name);
	const launch = await resolveSharedBrowserLaunchSpec({
		headless: opts.headless,
		userDataDir,
		viewport: opts.viewport,
	});
	if (!launch) throw new ToolError("Shared browser daemon unavailable: no Chromium executable could be resolved");
	await fs.mkdir(userDataDir, { recursive: true });
	const client = await daemonClient();
	throwIfAborted(opts.signal);
	const identity: UnitIdentity = { kind: "proc", scope: projectScope(projectDir), key: name };
	const request: OpenRequest = {
		...identity,
		label: opts.headless ? "Shared headless Chromium" : "Shared Chromium",
		proc: {
			application: launch.executablePath,
			args: launch.args,
			env: workerEnvFromParent(),
			cwd: projectDir,
			pty: false,
			ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
		},
		policy: SHARED_BROWSER_POLICY,
	};
	const claim = await claimProfile(userDataDir, opts.signal);
	try {
		const existing = await describeUnit(client, identity, opts.signal);
		let reason: string | undefined;
		if (isLiveUnit(existing)) {
			const adopted = await openShared(client, request, projectDir, launch.executablePath, false, opts.signal);
			if (typeof adopted !== "string") return adopted;
			reason = `the running Chrome (pid ${existing?.pids[0] ?? "?"}) was unusable (${adopted}), so it was stopped`;
		}
		// Without the claim the profile cannot be prepared, and an unprepared
		// start restores the stale session; the claim holder starts Chrome instead.
		if (!claim) {
			throw new ToolError(
				`Shared browser daemon unavailable: ${reason ? `${reason}, and ` : ""}another omp process held the shared browser profile while starting Chrome. \`omp ps\` lists the ${name} unit.`,
			);
		}
		await seedOwnedProfilePreferences(userDataDir);
		await discardOwnedProfileSessions(userDataDir);
		const started = await openShared(
			client,
			request,
			projectDir,
			launch.executablePath,
			reason !== undefined,
			opts.signal,
		);
		if (typeof started !== "string") return started;
		throw new ToolError(
			`Shared browser daemon unavailable: ${reason ? `${reason}; its replacement failed: ` : ""}${started}. \`omp ps\` lists the ${name} unit.`,
		);
	} finally {
		claim?.release();
	}
}

/**
 * Open (adopt or start) the shared browser unit and probe its endpoint.
 * Resolves the endpoint with a held lease, or why it got none, after stopping
 * the unusable unit.
 */
async function openShared(
	client: DaemonClient,
	request: OpenRequest,
	projectDir: string,
	executablePath: string,
	replace: boolean,
	signal?: AbortSignal,
): Promise<SharedBrowserEndpoint | string> {
	let lease: UnitLease;
	try {
		lease = new UnitLease(client, request, await client.open({ ...request, replace }, signal));
	} catch (error) {
		throwIfAborted(signal);
		const message = error instanceof Error ? error.message : String(error);
		logger.debug("Shared browser open failed", { name: request.key, error: message });
		return `the daemon refused to start Chrome (${executablePath}): ${message}`;
	}
	const unit = lease.unit;
	const wsEndpoint = wsEndpointOf(unit);
	if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
		return { wsEndpoint, pid: unit.pids[0], daemonName: request.key, projectDir, lease };
	}
	await lease.release();
	const failure = !isLiveUnit(unit)
		? `Chrome (${executablePath}) exited${unit.exitCode === undefined ? "" : ` with code ${unit.exitCode}`}${unit.exitReason ? ` (${unit.exitReason})` : ""} before it was ready`
		: !wsEndpoint
			? `Chrome (${executablePath}) printed no DevTools endpoint within ${READY_TIMEOUT_MS / 1000}s`
			: `Chrome (${executablePath}) did not answer on its DevTools endpoint`;
	const tail = await outputTail(client, unit.id, signal);
	await stopUnit(client, unit, signal);
	return tail ? `${failure}; its last output: ${tail}` : failure;
}

/** Claim the shared profile; null when another client held it past the wait. */
async function claimProfile(userDataDir: string, signal?: AbortSignal): Promise<FileLockHandle | null> {
	try {
		return await acquireFileLock(userDataDir, {
			retries: Math.ceil(PROFILE_CLAIM_WAIT_MS / PROFILE_CLAIM_RETRY_MS),
			retryDelayMs: PROFILE_CLAIM_RETRY_MS,
			signal,
		});
	} catch (error) {
		throwIfAborted(signal);
		logger.warn("Shared browser profile stayed claimed", {
			userDataDir,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** Stop exactly this generation of the unit; the resulting snapshot, or undefined when the daemon refused. */
async function stopUnit(
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
		logger.debug("Shared browser stop failed", {
			name: unit.key,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Restart a project-shared browser for `omp ps`. The daemon's own restart
 * relaunches the retained spec on the same profile, where Chromium would
 * reopen every page the stopped process had open. This holds the profile
 * claim throughout, so no other client starts Chrome in between, stops the
 * unit, prepares the profile as for a cold start once the stop is confirmed,
 * and only then asks the daemon to relaunch.
 */
export async function restartSharedBrowser(unit: UnitSnapshot, signal?: AbortSignal): Promise<UnitSnapshot> {
	if (unit.scope.kind !== "project") throw new Error(`${unit.key} is not a project-shared browser`);
	const userDataDir = sharedBrowserProfileDir(unit.scope.dir, unit.key);
	const client = await daemonClient();
	const claim = await claimProfile(userDataDir, signal);
	if (!claim) throw new Error(`${unit.key} is being started by another omp process; try again shortly`);
	try {
		const stopped = (await client.request({ op: "stop", unit: unit.id, timeoutMs: STOP_TIMEOUT_MS }, signal)).unit;
		if (isLiveUnit(stopped)) {
			throw new Error(`${unit.key} is still ${stopped.state} after the stop; it was not restarted`);
		}
		await seedOwnedProfilePreferences(userDataDir);
		await discardOwnedProfileSessions(userDataDir);
		return (await client.request({ op: "restart", unit: unit.id }, signal)).unit;
	} finally {
		claim.release();
	}
}

/** The last lines Chrome printed under the daemon, one line; empty when the daemon has none to give. */
async function outputTail(client: DaemonClient, unitId: string, signal?: AbortSignal): Promise<string> {
	try {
		const result = await client.request(
			{ op: "logs", unit: unitId, lines: OUTPUT_TAIL_LINES, head: false, follow: false, timeoutMs: 1_000 },
			signal,
		);
		return sanitizeText(result.text)
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.join(" | ");
	} catch {
		throwIfAborted(signal);
		return "";
	}
}

/** Seams for {@link stopSharedBrowserIfUnreachable}; the defaults hit the real daemon and CDP probe. */
export interface SharedBrowserHealthDeps {
	client?: DaemonClient;
	probe?: (wsEndpoint: string) => Promise<boolean>;
	signal?: AbortSignal;
	/** Override the per-attempt probe cap ({@link PROBE_ATTEMPT_CAP_MS}); slower values are only for tests. */
	probeCapMs?: number;
}

/** In-flight checks per shared browser unit, so the tabs of one failed sweep share one stop round. */
const reachabilityChecks = new Map<string, Promise<boolean>>();

/**
 * Stop the project-shared browser when its CDP endpoint has stopped answering.
 *
 * `ensureSharedBrowser` makes this decision only while attaching, so a Chromium
 * that wedges *after* a session attached kept its whole process tree — and
 * every target whose close timed out — alive until the last omp client in the
 * project exited (a 9.1 GB, 44-process browser survived 19 h in the
 * 2026-09-27 incident). Cleanup failures re-run the same decision off the
 * acquire path: stop the unit, so the next attach launches a fresh Chromium
 * and the leaked targets die with the old one.
 *
 * The liveness probe gates the stop — twice in a row, because one slow answer
 * on a loaded machine is not a wedge and stopping the shared browser costs
 * every session in the project its tabs — and the stop names the generation
 * that failed them, so a browser another session replaced meanwhile is never
 * stopped under its name. A unit that has not become ready is left to the
 * acquire path, which owns that race. Concurrent failed closes share one check.
 * Best-effort: never throws, and returns true only when the daemon confirmed the stop.
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
	// even when an await underneath cannot be bounded from here (a daemon socket
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

/** One reachability round. Resolves false for every non-destructive outcome; never rejects. */
async function checkSharedBrowserReachable(scope: SharedTargetScope, deps: SharedBrowserHealthDeps): Promise<boolean> {
	const signal = deps.signal ?? AbortSignal.timeout(HEALTH_CHECK_BUDGET_MS);
	const deadlineAt = Date.now() + HEALTH_CHECK_BUDGET_MS;
	try {
		const client = deps.client ?? (await daemonClient());
		const identity: UnitIdentity = { kind: "proc", scope: projectScope(scope.projectDir), key: scope.daemonName };
		const existing = await describeUnit(client, identity, signal);
		if (!existing || !isLiveUnit(existing)) return false;
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
		// same unit. The stop targets only the generation that failed them.
		const stopped = await stopUnit(client, existing, signal);
		// `stopUnit` absorbs a rejected or unanswered stop, so only a terminal
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
