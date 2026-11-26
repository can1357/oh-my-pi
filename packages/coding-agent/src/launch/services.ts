/** Session-owned named services: `proc` units of the omp daemon in the session's project scope. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TERMINAL_STATES } from "../cli/ps-model";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "../utils/text-width";
import { ToolError } from "../tools/tool-errors";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { compileNotifyPattern } from "../async/notify";
import { canonicalProjectDir, DaemonTimeoutError, daemonClient } from "../daemon/client";
import { daemonDir, unitLogDir } from "../daemon/paths";
import {
	DAEMON_OUTPUT_PATTERN_FLAGS,
	type DaemonClient,
	type DaemonOp,
	type DaemonResult,
	type ProcSpec,
	projectScope,
	type UnitPolicy,
	type UnitScope,
	type UnitSnapshot,
} from "../daemon/protocol";
import { shellProcessCommand } from "../exec/shell-process";
import { isUrlPath } from "../internal-urls/url-filesystem";
import type { ToolSession } from "../tools";
import { isSharedBrowserUnit } from "../tools/browser/shared-daemon";
import { sessionUrlRouter } from "../internal-urls/context";
import type { InternalUrlRouter } from "../internal-urls/router";
import { resolveToCwd } from "../tools/path-utils";
import { cfgLaunchEnabled, cfgLaunchPersist } from "../tools/settings";

/** Unit kind of every named service. */
const SERVICE_KIND = "proc";
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const SERVICE_NAME_RULE = "Service name must be 1-48 letters, numbers, dots, underscores, or hyphens";

export interface ServiceReady {
	log?: string;
	port?: number;
	host?: string;
	timeout?: number;
}
export interface ServiceStart {
	name: string;
	command: string;
	cwd?: string;
	pty?: boolean;
	ready?: ServiceReady;
	/** Regex; each output line it matches is reported to the owning session while the service runs. */
	notify?: string;
	/** Overlay on the configured shell env; wins over it. */
	env?: Record<string, string>;
	/**
	 * Script the service's shell sources first: the mounts behind the URL paths its command may
	 * name (`local://…`, a URL `cwd`), then the functions and aliases of the session starting it.
	 */
	seed?: string;
}

/** The script a service's shell sources, beside the daemon's other per-service files. */
const SERVICE_SEED_FILE = "shell.sh";

const serviceStateKey = Symbol("ownedServices");
interface OwnedService {
	id: string;
	startedAt: number;
	scope: UnitScope;
	/** The unit lives on this process's lease, which must be retaken after a daemon reconnect. */
	leased: boolean;
}
interface ServiceSession extends ToolSession {
	[serviceStateKey]?: {
		owned: Map<string, OwnedService>;
		listeners: Set<() => void>;
		subscribed: boolean;
	};
}
function serviceState(session: ToolSession): NonNullable<ServiceSession[typeof serviceStateKey]> {
	return ((session as ServiceSession)[serviceStateKey] ??= {
		owned: new Map(),
		listeners: new Set(),
		subscribed: false,
	});
}

async function sessionScope(session: ToolSession): Promise<UnitScope> {
	return projectScope(await canonicalProjectDir(session.cwd));
}

/** Directory of the daemon-side files omp keeps for one named service in one project. */
function serviceFilesDir(scope: UnitScope, name: string): string {
	const scopeHash = Bun.hash
		.wyhash(scope.kind === "project" ? scope.dir : scope.kind)
		.toString(16)
		.padStart(16, "0");
	return path.join(daemonDir(), "services", scopeHash, name);
}

/** Write the script `name`'s shell sources at each start, where a daemon-side relaunch finds it again. */
async function writeServiceSeed(scope: UnitScope, name: string, seed: string): Promise<string> {
	const dir = serviceFilesDir(scope, name);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, SERVICE_SEED_FILE);
	await fs.writeFile(file, seed, { mode: 0o600 });
	return file;
}

export function hasLiveOwnedService(session: ToolSession): boolean {
	return ((session as ServiceSession)[serviceStateKey]?.owned.size ?? 0) > 0;
}

export function waitForOwnedServiceCompletion(session: ToolSession, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted || !hasLiveOwnedService(session)) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const pending = serviceState(session).listeners;
	const finish = (): void => {
		pending.delete(finish);
		signal?.removeEventListener("abort", finish);
		resolve();
	};
	pending.add(finish);
	signal?.addEventListener("abort", finish, { once: true });
	return promise;
}

function serviceOwner(session: ToolSession): string | null | undefined {
	return session.getSessionId?.() ?? session.getAgentId?.();
}

function track(session: ToolSession, unit: UnitSnapshot): void {
	if (unit.kind !== SERVICE_KIND) return;
	const owner = serviceOwner(session);
	if (unit.owner !== owner) return;
	const services = serviceState(session).owned;
	if (TERMINAL_STATES[unit.state]) services.delete(unit.key);
	else
		services.set(unit.key, {
			id: unit.id,
			startedAt: unit.startedAt,
			scope: unit.scope,
			leased: unit.policy.hold === "leases",
		});
}

function notifyListeners(session: ToolSession): void {
	for (const listener of serviceState(session).listeners) listener();
}

function subscribe(session: ToolSession, client: DaemonClient): void {
	const owner = serviceOwner(session);
	if (!owner) return;
	const state = serviceState(session);
	if (state.subscribed) return;
	state.subscribed = true;
	const unsubscribe = client.onCompletion(owner, event => {
		const tracked = serviceState(session).owned.get(event.unit.key);
		if (tracked?.id === event.unit.id && tracked.startedAt === event.unit.startedAt) {
			track(session, event.unit);
			notifyListeners(session);
		}
		return session.queueLaunchCompletion?.(event);
	});
	const unsubscribeNotify = client.onNotify(owner, event => {
		const { unit } = event;
		// The match proves the service live: track it, so `running` answers even before this session lists its services.
		track(session, unit);
		session.queueServiceNotify?.({
			id: unit.key,
			type: "service",
			pattern: event.pattern,
			running: () => serviceState(session).owned.get(unit.key)?.id === unit.id,
			owner,
			lines: event.lines,
			omitted: event.omitted,
			stopped: event.stopped,
		});
	});
	// Leases died with the old connection: retake them before the units' idle grace runs out.
	const unsubscribeReconnect = client.onReconnect(() => {
		for (const [key, service] of serviceState(session).owned) {
			if (!service.leased) continue;
			client
				.open({ kind: SERVICE_KIND, scope: service.scope, key, owner, awaitReady: false })
				.then(result => track(session, result.unit))
				.catch(error => {
					logger.warn("Failed to retake a service lease after a daemon reconnect", {
						service: key,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}
	});
	const detach = (): void => {
		unsubscribeNotify();
		unsubscribeReconnect();
		unsubscribe({ preservePending: true });
		state.subscribed = false;
		state.owned.clear();
		notifyListeners(session);
	};
	session.registerDisposeCallback?.(detach);
	// The previous session stays resumable (`/resume`, fork parent), so keep its completions
	// queued in the daemon for replay when that session id re-subscribes. Its services' `notify`
	// matches are not kept: they reach it again once it does.
	session.registerSessionChangeCallback?.(detach);
}

async function request<O extends DaemonOp>(
	session: ToolSession,
	operation: O,
	signal?: AbortSignal,
): Promise<DaemonResult<O["op"]>> {
	const client = await daemonClient();
	subscribe(session, client);
	return client.request(operation, signal);
}

async function serviceRef(
	session: ToolSession,
	name: string,
): Promise<{ kind: string; scope: UnitScope; key: string }> {
	return { kind: SERVICE_KIND, scope: await sessionScope(session), key: name };
}

export async function listServices(session: ToolSession, signal?: AbortSignal): Promise<UnitSnapshot[]> {
	const { units } = await request(
		session,
		{ op: "list", scope: await sessionScope(session), kind: SERVICE_KIND },
		signal,
	);
	const owner = serviceOwner(session);
	serviceState(session).owned.clear();
	for (const unit of units) if (unit.owner === owner) track(session, unit);
	return units;
}

/**
 * {@link listServices} for callers whose jobs and agents live in-process (`wait`,
 * `proc://`): a daemon failure (timeout, crash) must not hide that state. Returns
 * the failure message alongside an empty list; owned-service tracking keeps its
 * last known state. A caller abort still throws.
 */
export async function listServicesTolerant(
	session: ToolSession,
	signal?: AbortSignal,
): Promise<{ services: UnitSnapshot[]; error?: string }> {
	try {
		return { services: await listServices(session, signal) };
	} catch (error) {
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("Daemon list failed; continuing without service state", { error: message });
		return { services: [], error: message };
	}
}

export async function findService(
	session: ToolSession,
	name: string,
	signal?: AbortSignal,
): Promise<UnitSnapshot | undefined> {
	return (await listServices(session, signal)).find(unit => unit.key === name);
}

/** Output log of a service unit, as the daemon writes it. */
export function serviceUnitLogPath(unit: UnitSnapshot): string {
	return path.join(unitLogDir(unit.id), "output.log");
}

/** Output log of service `name`; undefined when the daemon has no such service. */
export async function serviceLogPath(session: ToolSession, name: string): Promise<string | undefined> {
	const unit = await findService(session, name);
	return unit ? serviceUnitLogPath(unit) : undefined;
}

export async function serviceLogsWithRows(
	session: ToolSession,
	name: string,
	signal?: AbortSignal,
): Promise<{ text: string; terminalRows?: string[] }> {
	const result = await request(
		session,
		{
			op: "logs",
			unit: await serviceRef(session, name),
			lines: 1_000,
			head: false,
			follow: false,
			timeoutMs: 1_000,
		},
		signal,
	);
	track(session, result.unit);
	const rows = result.terminalOutput ? result.terminalOutput.split("\n") : undefined;
	return {
		text: replaceTabs(sanitizeText(rows?.join("\n") ?? result.text)),
		...(rows ? { terminalRows: rows } : {}),
	};
}

export async function serviceLogs(session: ToolSession, name: string, signal?: AbortSignal): Promise<string> {
	return (await serviceLogsWithRows(session, name, signal)).text;
}

/**
 * Directory a service process starts in. An absolute path is already resolved —
 * a hoisted shell `cd /` is the filesystem root — so it must not be passed
 * through the tool-input alias again. Relative paths still use that alias.
 */
function serviceDirectory(cwd: string | undefined, sessionCwd: string, router: InternalUrlRouter): string {
	const requested = cwd ?? sessionCwd;
	return path.isAbsolute(requested) ? requested : resolveToCwd(requested, sessionCwd, router);
}

/**
 * Start a session-owned service and wait for its requested readiness condition.
 * `readyInterrupt` ends only the readiness wait, after the daemon acknowledged
 * the launch: the call then resolves `readyInterrupted` with the launched
 * snapshot while the service keeps starting. Validation, connection, and launch
 * failures still reject. `notifyArmed` reports whether a `notify` regex is watched.
 */
export async function startService(
	session: ToolSession,
	params: ServiceStart,
	signal?: AbortSignal,
	readyInterrupt?: AbortSignal,
): Promise<{
	daemon: UnitSnapshot;
	readyTimedOut: boolean;
	readyInterrupted: boolean;
	notifyArmed: boolean;
}> {
	if (!cfgLaunchEnabled.get(session.settings)) throw new ToolError("Service launch is disabled in this session.");
	if (!SERVICE_NAME.test(params.name)) throw new ToolError(SERVICE_NAME_RULE);
	const ready = params.ready;
	if (ready?.port !== undefined && (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535))
		throw new ToolError("ready.port must be an integer from 1 to 65535");
	if (ready && !ready.log && ready.port === undefined) throw new ToolError("ready requires log or port");
	if (ready?.log) {
		try {
			new RegExp(ready.log, DAEMON_OUTPUT_PATTERN_FLAGS);
		} catch (error) {
			throw new ToolError(`Invalid readiness regex: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (params.notify) compileNotifyPattern(params.notify);
	const scope = await sessionScope(session);
	const shell = session.settings.getShellConfig();
	// The service is a shell process: the bash tool's shell, with omp's utilities and the mounts
	// its script makes. A URL directory is entered by that shell; the process starts on the host.
	const urlCwd = params.cwd !== undefined && isUrlPath(params.cwd) ? params.cwd : undefined;
	const source = params.seed ? await writeServiceSeed(scope, params.name, params.seed) : undefined;
	const proc: ProcSpec = {
		...shellProcessCommand({
			command: `${shell.prefix ? `${shell.prefix} ` : ""}${params.command}`,
			source,
			cwd: urlCwd,
		}),
		env: { ...shell.env, ...params.env },
		cwd: serviceDirectory(urlCwd === undefined ? params.cwd : undefined, session.cwd, sessionUrlRouter(session)),
		pty: params.pty ?? true,
		ready: ready
			? {
					log: ready.log,
					port: ready.port,
					host: ready.host,
					timeoutMs: Math.round(Math.max(0.05, Math.min(3_600, ready.timeout ?? 30)) * 1_000),
				}
			: undefined,
		notify: params.notify,
	};
	const persist = cfgLaunchPersist.get(session.settings);
	// Session services live on this process's lease; persistent ones until stopped.
	const policy: Partial<UnitPolicy> = persist
		? { hold: "persist", restart: "no", survive: "exec" }
		: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" };
	const ref = { kind: SERVICE_KIND, scope, key: params.name };
	const opened = await request(
		session,
		{
			op: "open",
			...ref,
			label: params.name,
			proc,
			policy,
			owner: serviceOwner(session) ?? undefined,
			replace: true,
			awaitReady: readyInterrupt === undefined,
			lease: !persist,
		},
		signal,
	).catch(async (error: unknown) => {
		if (!(error instanceof DaemonTimeoutError)) throw error;
		// The daemon may have started the service anyway: say where it stands.
		const described = await request(session, { op: "describe", unit: ref }, signal).catch(() => undefined);
		const pid = described?.unit.pids[0];
		const state = described
			? `${params.name} is ${described.unit.state}${pid === undefined ? "" : ` (pid ${pid})`}; read proc://${params.name}`
			: "the daemon did not answer a status request either";
		throw new ToolError(`Service start request timed out; ${state}.`);
	});
	const launched = opened.unit;
	track(session, launched);
	const notifyArmed = params.notify !== undefined;
	const readyPending = (unit: UnitSnapshot): boolean =>
		proc.ready !== undefined && unit.readyAt === undefined && !TERMINAL_STATES[unit.state];
	if (!readyInterrupt || !readyPending(launched))
		return { daemon: launched, readyTimedOut: readyPending(launched), readyInterrupted: false, notifyArmed };
	const timeoutMs = Math.max(0, (proc.ready?.timeoutMs ?? 0) - (Date.now() - launched.startedAt));
	try {
		const waited = await request(
			session,
			{ op: "wait", unit: ref, for: "ready", timeoutMs },
			signal ? AbortSignal.any([signal, readyInterrupt]) : readyInterrupt,
		);
		track(session, waited.unit);
		// A pre-ready exit is reported by its terminal state, not as a timeout.
		return {
			daemon: waited.unit,
			readyTimedOut: !waited.matched && !TERMINAL_STATES[waited.unit.state],
			readyInterrupted: false,
			notifyArmed,
		};
	} catch (error) {
		if (readyInterrupt.aborted && !signal?.aborted)
			return { daemon: launched, readyTimedOut: false, readyInterrupted: true, notifyArmed };
		throw error;
	}
}

/**
 * Adopt the running process `pid` as session service `name` (`o2ctl services add`), without
 * restarting it: listed, supervised, and stopped like a started service, with the file its
 * stdout (else stderr) writes to as its output. Fails when `name` is taken by a live service,
 * `pid` is no live process of this user, or it is already a unit's process.
 */
export async function adoptService(
	session: ToolSession,
	name: string,
	pid: number,
	signal?: AbortSignal,
): Promise<UnitSnapshot> {
	if (!cfgLaunchEnabled.get(session.settings)) throw new ToolError("Service launch is disabled in this session.");
	if (!SERVICE_NAME.test(name)) throw new ToolError(SERVICE_NAME_RULE);
	if (pid === process.pid) throw new ToolError(`pid ${pid} is this omp process`);
	const persist = cfgLaunchPersist.get(session.settings);
	const { unit } = await request(
		session,
		{
			op: "open",
			...(await serviceRef(session, name)),
			label: name,
			adopt: pid,
			// Held like a started service: on this process's lease, or until stopped.
			policy: persist ? { hold: "persist" } : { hold: "leases", idleMs: 0, onIdle: "stop" },
			owner: serviceOwner(session) ?? undefined,
			awaitReady: false,
			lease: !persist,
		},
		signal,
	);
	track(session, unit);
	return unit;
}

export async function sendService(
	session: ToolSession,
	name: string,
	content: string,
	signal?: AbortSignal,
): Promise<UnitSnapshot> {
	const data = /[\r\n]$/.test(content) ? content : `${content}\r`;
	const { unit } = await request(session, { op: "send", unit: await serviceRef(session, name), data }, signal);
	track(session, unit);
	return unit;
}

export async function stopService(session: ToolSession, name: string, signal?: AbortSignal): Promise<UnitSnapshot> {
	const { unit } = await request(
		session,
		{ op: "stop", unit: await serviceRef(session, name), timeoutMs: 5_000 },
		signal,
	);
	track(session, unit);
	return unit;
}

export async function modeService(
	session: ToolSession,
	name: string,
	mode: "persist" | "session" | "detached",
	signal?: AbortSignal,
): Promise<UnitSnapshot> {
	const ref = await serviceRef(session, name);
	// Detaching relaunches the service, which would start the shared Chrome on an
	// unprepared profile and reopen its previous pages.
	if (mode === "detached" && isSharedBrowserUnit((await request(session, { op: "describe", unit: ref }, signal)).unit))
		throw new Error(`${name} is omp's project-shared browser and cannot be detached`);
	// A session-held service lives on a lease and `mode` takes none: hold one first, or the
	// daemon's idle policy (idleMs 0) stops the service the moment it turns session-held.
	const lease =
		mode === "session"
			? (
					await request(
						session,
						{ op: "open", ...ref, owner: serviceOwner(session) ?? undefined, awaitReady: false },
						signal,
					)
				).lease
			: undefined;
	let unit: UnitSnapshot;
	try {
		({ unit } = await request(session, { op: "mode", unit: ref, mode }, signal));
	} catch (error) {
		// The service did not turn session-held: the lease taken for it would pin it until this connection closes.
		if (lease !== undefined) {
			await request(session, { op: "release", lease }).catch(releaseError =>
				logger.debug("Failed to release a service lease after a failed mode change", {
					service: name,
					error: releaseError instanceof Error ? releaseError.message : String(releaseError),
				}),
			);
		}
		throw error;
	}
	track(session, unit);
	return unit;
}

export function serviceStatus(unit: UnitSnapshot): string {
	const age = formatDuration(Math.max(0, (unit.exitedAt ?? Date.now()) - unit.startedAt));
	const pid = unit.pids[0];
	return `${unit.key} [service] — ${unit.state} — up ${age}${pid === undefined ? "" : ` — pid ${pid}`}${unit.policy.hold === "persist" ? " — persistent" : ""}${unit.policy.hold === "detached" ? " — detached" : ""}${unit.adopted ? " — adopted" : ""}`;
}
