/**
 * The daemon's unit table: identity, find-or-start, connection-bound leases,
 * idle timers, caps, supervision of `proc` units, module unit wrapping, the
 * board, completion/notify delivery, and persistence of all of it.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
// node:net only serves the TCP readiness probe of supervised services.
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Process, type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { truncateHead, truncateHeadBytes, truncateTail, truncateTailBytes } from "../tools/streaming-output";
import type { DaemonReadySpec } from "./daemon-types";
import { isEnoent, logger, sanitizeText, withTimeout } from "@oh-my-pi/pi-utils";
import { TerminalQueryResponder } from "@oh-my-pi/pi-utils/vterm";
import { compileNotifyPattern, type NotifyBatch, OutputNotifier } from "../async/notify";
import { hostHasInheritableConsole } from "../eval/py/spawn-options";
import { TextTap } from "../job-widgets/text-tap";
import { resolveDaemonSpawnOptions } from "../launch/spawn-options";
import { renderTerminalOutput } from "../launch/terminal-output";
import { adoptChild, isSameProcess, processStartTime, spawnManagedChild } from "./children";
import type { DaemonModule, ManagedChild, ModuleClient, ModuleContext, ModuleTunnel, ModuleUnit } from "./module";
import { moduleStateDir, unitLogDir } from "./paths";
import {
	DAEMON_OUTPUT_PATTERN_FLAGS,
	DAEMON_PTY_COLUMNS,
	DAEMON_PTY_ROWS,
	type DaemonCompletionEvent,
	type DaemonEvent,
	type DaemonLogs,
	type DaemonOp,
	type DaemonResults,
	type DaemonSignal,
	type OpenRequest,
	type OpenResult,
	type ProcSpec,
	scopeKey,
	type UnitPolicy,
	type UnitRef,
	type UnitScope,
	type UnitSnapshot,
} from "./protocol";
import type { DaemonStore, StoredChildFds, StoredCompletionState, StoredUnit } from "./store";

const MAX_LOG_BYTES = 25 * 1024 * 1024;
const LOG_READ_BYTES = 2 * 1024 * 1024;
const READINESS_BUFFER_CHARS = 64 * 1024;
const RESTART_MAX_DELAY_MS = 30_000;
const RESTART_BACKOFF_BASE_MS = 1_000;
/** Uptime after which a crash no longer counts toward the restart backoff. */
const RESTART_STABLE_MS = 30_000;
/** Terminal `proc` units kept per scope for `logs`/`describe`; older history is deleted. */
const MAX_TERMINAL_UNITS_PER_SCOPE = 10;
/** How often a detached unit's log and liveness are polled. */
const DETACHED_POLL_MS = 250;
/** How often an unleased unit that reports in-flight work is re-checked for idleness. */
const BUSY_RECHECK_MS = 1_000;
/** Store meta key: fds the previous image kept across its re-exec, claimed by restored units or closed. */
const INHERITED_FDS_META = "inherited_fds";
const LOG_FILE = "output.log";
const PREVIOUS_LOG_FILE = "output.previous.log";
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const DAEMON_SPAWN_OPTIONS = resolveDaemonSpawnOptions({
	platform: process.platform,
	hostHasInheritableConsole: hostHasInheritableConsole(),
});

const SIGNAL_NUMBER: Record<DaemonSignal, number> = {
	SIGINT: os.constants.signals.SIGINT,
	SIGTERM: os.constants.signals.SIGTERM,
	SIGHUP: os.constants.signals.SIGHUP,
	SIGQUIT: os.constants.signals.SIGQUIT,
	SIGKILL: os.constants.signals.SIGKILL,
};

const EXTERNAL_POLICY: UnitPolicy = { hold: "persist", idleMs: 0, onIdle: "stop", restart: "no", survive: "none" };

/** One control connection, as the unit table sees it. */
export interface UnitConnection {
	readonly client: ModuleClient;
	readonly closed: boolean;
	send(event: DaemonEvent): void;
}

export interface UnitTableOptions {
	store: DaemonStore;
	modules: readonly DaemonModule[];
	/** Started from a re-exec: restore `survive: "exec"` units and hold idle timers for the grace period. */
	resumed: boolean;
	/** How long dropped and restored leases are waited for before idle timers resume (`DAEMON_RESUME_LEASE_GRACE_MS` by default). */
	leaseGraceMs: number;
	/** Any unit became live or terminal; the server re-evaluates its own idle exit. */
	onLivenessChange(): void;
}

type Op<O extends DaemonOp["op"]> = Extract<DaemonOp, { op: O }>;

interface ProcRuntime {
	/** Bumped on every launch; callbacks of an older launch are ignored. */
	launch: number;
	log?: UnitLog;
	child?: ManagedChild;
	pty?: PtySession;
	/** Detached launch of this daemon image; absent for a re-adopted one. */
	detached?: { exited: boolean };
	stopRequested: boolean;
	/** Why the pending stop was requested; becomes `exitReason` when the process exits without its own error. */
	stopReason?: string;
	logReady: boolean;
	portReady: boolean;
	readinessBuffer: string;
	readyPattern?: RegExp;
	notify?: { tap: TextTap; notifier: OutputNotifier };
	restartTimer?: NodeJS.Timeout;
	consecutiveFailures: number;
	terminalSettled?: Promise<void>;
	/** Serializes detached log reads so no byte is tracked twice. */
	detachedRead?: Promise<void>;
	monitoring: boolean;
}

interface ModuleRuntime {
	module: DaemonModule;
	unit?: ModuleUnit;
	params: unknown;
	/** Last module snapshot (persisted for `survive: "detached"` modules). */
	state?: unknown;
	calls: number;
}

interface UnitEntry {
	snapshot: UnitSnapshot;
	proc?: ProcSpec;
	procRuntime?: ProcRuntime;
	moduleRuntime?: ModuleRuntime;
	/** Connection that registered an `external` unit. */
	externalConnection?: string;
	leases: Set<string>;
	lastUsed: number;
	idleTimer?: NodeJS.Timeout;
	/** The idle timer fires no earlier than this: a lease holder's connection dropped and it may reconnect. */
	idleNotBefore?: number;
	pidStartedAt?: number;
	outputOffset: number;
	completion: StoredCompletionState;
	pendingCompletions: DaemonCompletionEvent[];
	/** Re-checked on every state change or output. */
	waiters: Set<() => void>;
	tunnels: Set<ModuleTunnel>;
	/** Resolves when the unit is ready (or failed to be). */
	ready: Promise<void>;
	childFds?: StoredChildFds;
}

interface LogRead {
	text: string;
	terminalOutput: string;
	cursor: number;
}

function isTerminal(state: UnitSnapshot["state"]): boolean {
	return state === "exited" || state === "failed";
}

function isSettled(state: UnitSnapshot["state"]): boolean {
	return isTerminal(state) || state === "restarting";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function identity(kind: string, scope: UnitScope, key: string): string {
	return `${kind}\u0000${scopeKey(scope)}\u0000${key}`;
}

function copySnapshot(snapshot: UnitSnapshot): UnitSnapshot {
	return { ...snapshot, pids: [...snapshot.pids], readyPending: snapshot.readyPending && [...snapshot.readyPending] };
}

async function fileTextSlice(filePath: string, head: boolean): Promise<string> {
	try {
		const stat = await fsp.stat(filePath);
		const file = Bun.file(filePath);
		if (stat.size <= LOG_READ_BYTES) return await file.text();
		return head
			? await file.slice(0, LOG_READ_BYTES).text()
			: await file.slice(Math.max(0, stat.size - LOG_READ_BYTES)).text();
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}

/** Last `maxLines` lines; a trailing newline terminates the last line instead of counting as an empty one. */
function tailLines(text: string, options: { maxLines: number; maxBytes: number }): string {
	if (!text.endsWith("\n")) return truncateTail(text, options).content;
	return `${truncateTail(text.slice(0, -1), options).content}\n`;
}

async function readLogFiles(
	dir: string,
	head: boolean,
	lines: number,
	cursor: number,
	grep?: string,
): Promise<LogRead> {
	const [previous, current] = await Promise.all([
		fileTextSlice(path.join(dir, PREVIOUS_LOG_FILE), head),
		fileTextSlice(path.join(dir, LOG_FILE), head),
	]);
	const combined = `${previous}${previous && current && !previous.endsWith("\n") ? "\n" : ""}${current}`;
	const terminalOutput = head
		? truncateHeadBytes(combined, LOG_READ_BYTES).text
		: truncateTailBytes(combined, LOG_READ_BYTES).text;
	let text = sanitizeText(terminalOutput);
	if (grep) {
		let pattern: RegExp;
		try {
			pattern = new RegExp(grep, "u");
		} catch (error) {
			throw new Error(`Invalid log regex: ${errorMessage(error)}`);
		}
		text = text
			.split("\n")
			.filter(line => pattern.test(line))
			.join("\n");
	}
	const options = { maxLines: lines, maxBytes: 256 * 1024 };
	return {
		text: head ? truncateHead(text, options).content : tailLines(text, options),
		terminalOutput,
		cursor,
	};
}

/**
 * Rotating output log of one unit (`output.log` + one `output.previous.log`).
 * Opened in append mode so a re-exec'd daemon continues the file in place.
 */
class UnitLog {
	readonly #dir: string;
	readonly #path: string;
	#handle: fsp.FileHandle;
	#currentBytes: number;
	#queue: Promise<void> = Promise.resolve();
	#closed = false;
	#closing: Promise<void> | undefined;
	/** Set by {@link release}: the handle is closed and appends go straight to the file, holding no fd. */
	#released = false;

	private constructor(dir: string, handle: fsp.FileHandle, currentBytes: number) {
		this.#dir = dir;
		this.#path = path.join(dir, LOG_FILE);
		this.#handle = handle;
		this.#currentBytes = currentBytes;
	}

	static async #append(dir: string): Promise<UnitLog> {
		const handle = await fsp.open(path.join(dir, LOG_FILE), "a", 0o600);
		try {
			return new UnitLog(dir, handle, (await handle.stat()).size);
		} catch (error) {
			await handle.close();
			throw error;
		}
	}

	/** `fresh`: discard earlier output; otherwise keep the last generation's log as the previous one. */
	static async open(dir: string, fresh: boolean): Promise<UnitLog> {
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
		const logPath = path.join(dir, LOG_FILE);
		const previousPath = path.join(dir, PREVIOUS_LOG_FILE);
		await fsp.rm(previousPath, { force: true });
		if (fresh) await fsp.rm(logPath, { force: true });
		else {
			try {
				await fsp.rename(logPath, previousPath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return UnitLog.#append(dir);
	}

	/** Continue an existing log in place after a re-exec. */
	static async resume(dir: string): Promise<UnitLog> {
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
		return UnitLog.#append(dir);
	}

	append(text: string): void {
		if (text.length === 0 || this.#closed) return;
		const data = Buffer.from(text, "utf8");
		if (this.#released) {
			this.#writeSync(data);
			return;
		}
		this.#queue = this.#queue
			.then(async () => {
				// Queued while `release` closed the handle.
				if (this.#released) return this.#writeSync(data);
				if (this.#currentBytes > 0 && this.#currentBytes + data.byteLength > MAX_LOG_BYTES) await this.#rotate();
				await this.#handle.write(data);
				this.#currentBytes += data.byteLength;
			})
			.catch(error => logger.warn("Unit log write failed", { dir: this.#dir, error: errorMessage(error) }));
	}

	/**
	 * Close the handle ahead of a re-exec but keep the output: once this resolves
	 * every append so far is on disk and later ones are written synchronously
	 * (open, write, close), so output delivered up to the exec lands in the log
	 * and no log fd crosses it. {@link reacquire} undoes it.
	 */
	async release(): Promise<void> {
		if (this.#released || this.#closed) return;
		this.#queue = this.#queue.then(async () => {
			try {
				await this.#handle.close();
			} catch (error) {
				logger.warn("Unit log close failed", { dir: this.#dir, error: errorMessage(error) });
			}
			this.#released = true;
		});
		// Appends queued behind the close write synchronously once it is done; wait for those too.
		let queue: Promise<void>;
		do {
			queue = this.#queue;
			await queue;
		} while (queue !== this.#queue);
	}

	/** The re-exec failed: reopen the file and go back to queued appends. */
	async reacquire(): Promise<void> {
		if (!this.#released || this.#closed) return;
		const handle = await fsp.open(this.#path, "a", 0o600);
		try {
			this.#currentBytes = (await handle.stat()).size;
		} catch (error) {
			await handle.close();
			throw error;
		}
		this.#handle = handle;
		this.#released = false;
	}

	#writeSync(data: Buffer): void {
		try {
			fs.appendFileSync(this.#path, data, { mode: 0o600 });
			this.#currentBytes += data.byteLength;
		} catch (error) {
			logger.warn("Unit log write failed", { dir: this.#dir, error: errorMessage(error) });
		}
	}

	/** Resolves once every queued append is on disk. */
	flush(): Promise<void> {
		return this.#queue;
	}

	read(head: boolean, lines: number, cursor: number, grep?: string): Promise<LogRead> {
		const snapshot = this.#queue.then(() => readLogFiles(this.#dir, head, lines, cursor, grep));
		// Later appends queue behind the file snapshot; a failed read must not poison the queue.
		this.#queue = snapshot.then(
			() => undefined,
			() => undefined,
		);
		return snapshot;
	}

	close(): Promise<void> {
		this.#closed = true;
		this.#closing ??= this.#queue.then(() => (this.#released ? undefined : this.#handle.close()));
		return this.#closing;
	}

	async #rotate(): Promise<void> {
		await this.#handle.close();
		const previousPath = path.join(this.#dir, PREVIOUS_LOG_FILE);
		await fsp.rm(previousPath, { force: true });
		await fsp.rename(this.#path, previousPath);
		this.#handle = await fsp.open(this.#path, "a", 0o600);
		this.#currentBytes = 0;
	}
}

function connectPort(host: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host, port });
	let settled = false;
	const finish = (connected: boolean): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => finish(true));
	socket.once("error", () => finish(false));
	socket.setTimeout(250, () => finish(false));
	return promise;
}

/** Hosts the port probe tries: the configured one, else both loopbacks (`localhost` servers may bind only `::1`). */
function readinessHosts(ready: DaemonReadySpec): readonly string[] {
	return ready.host === undefined ? ["127.0.0.1", "::1"] : [ready.host];
}

async function listeningHost(hosts: readonly string[], port: number): Promise<string | undefined> {
	const connected = await Promise.all(hosts.map(host => connectPort(host, port)));
	return hosts[connected.indexOf(true)];
}

function syncReadyPending(entry: UnitEntry): void {
	const runtime = entry.procRuntime;
	if (!runtime || entry.snapshot.state !== "starting") {
		entry.snapshot.readyPending = undefined;
		return;
	}
	const pending: ("log" | "port")[] = [];
	if (!runtime.logReady) pending.push("log");
	if (!runtime.portReady) pending.push("port");
	entry.snapshot.readyPending = pending.length > 0 ? pending : undefined;
}

function defaultProcPolicy(proc: ProcSpec, hold: UnitPolicy["hold"] | undefined): UnitPolicy {
	const detached = hold === "detached";
	return {
		hold: hold ?? "leases",
		idleMs: 0,
		onIdle: "stop",
		restart: "no",
		survive: detached ? "detached" : proc.pty || process.platform !== "win32" ? "exec" : "none",
	};
}

/** The unit table of one daemon process. */
export class UnitTable {
	readonly #store: DaemonStore;
	readonly #modules = new Map<string, DaemonModule>();
	readonly #contexts = new Map<string, ModuleContext>();
	readonly #resumed: boolean;
	readonly #leaseGraceMs: number;
	readonly #onLivenessChange: () => void;
	readonly #units = new Map<string, UnitEntry>();
	readonly #byIdentity = new Map<string, UnitEntry>();
	/** In-flight creations, so concurrent opens of one identity converge. */
	readonly #starting = new Map<string, Promise<UnitEntry>>();
	readonly #leases = new Map<string, { entry: UnitEntry; connection: UnitConnection }>();
	readonly #connectionLeases = new Map<string, Set<string>>();
	readonly #watchers = new Set<UnitConnection>();
	/** Owner -> subscription id of the client that receives its completions. */
	readonly #subscriptions = new Map<string, string | undefined>();
	/** Owner -> connection currently reading its events. */
	readonly #ownerConnections = new Map<string, { connection: UnitConnection; subscriptionId: string }>();
	/** Live children module units spawned or adopted; their fds are kept across a re-exec. */
	readonly #moduleChildren = new Set<ManagedChild>();
	/** Fds the previous image kept across the re-exec that no unit has claimed yet. */
	readonly #inheritedFds = new Set<number>();
	#holdIdleUntil = 0;
	#shuttingDown = false;

	constructor(options: UnitTableOptions) {
		this.#store = options.store;
		this.#resumed = options.resumed;
		this.#leaseGraceMs = options.leaseGraceMs;
		this.#onLivenessChange = options.onLivenessChange;
		for (const module of options.modules) this.#modules.set(module.kind, module);
	}

	/** Module kind -> protocol version, for the welcome. */
	caps(): Record<string, number> {
		const caps: Record<string, number> = {};
		for (const [kind, module] of this.#modules) caps[kind] = module.version;
		return caps;
	}

	/** Initialize modules, then rebuild the table from the store. */
	async start(): Promise<void> {
		for (const module of this.#modules.values()) {
			try {
				await module.init?.(this.#context(module));
			} catch (error) {
				logger.error("Daemon module init failed", { kind: module.kind, error: errorMessage(error) });
			}
		}
		if (this.#resumed) {
			this.#holdIdleUntil = Date.now() + this.#leaseGraceMs;
			// The daemon's own idle exit is held too; look again once the grace ends.
			setTimeout(() => this.#onLivenessChange(), this.#leaseGraceMs + 50);
			for (const fd of this.#readInheritedFds()) this.#inheritedFds.add(fd);
		}
		this.#store.setMeta(INHERITED_FDS_META, "[]");
		for (const stored of this.#store.loadUnits()) {
			try {
				await this.#restore(stored);
			} catch (error) {
				logger.warn("Failed to restore daemon unit", { id: stored.id, error: errorMessage(error) });
				this.#store.deleteUnit(stored.id);
			}
		}
		this.#closeUnclaimedFds();
		for (const entry of this.#units.values()) this.#evaluateIdle(entry);
	}

	#readInheritedFds(): number[] {
		try {
			const value: unknown = JSON.parse(this.#store.getMeta(INHERITED_FDS_META) ?? "[]");
			return Array.isArray(value) ? value.filter((fd): fd is number => Number.isSafeInteger(fd) && fd > 2) : [];
		} catch {
			return [];
		}
	}

	/** Close fds the previous image kept for units that did not come back. */
	#closeUnclaimedFds(): void {
		for (const fd of this.#inheritedFds) {
			try {
				fs.closeSync(fd);
			} catch {
				// Already closed.
			}
		}
		this.#inheritedFds.clear();
	}

	/** Whether a unit other than a `hold: "detached"` one is live, or restored units still wait for their clients. */
	keepsDaemonAlive(): boolean {
		if (Date.now() < this.#holdIdleUntil) return true;
		for (const entry of this.#units.values()) {
			if (entry.externalConnection !== undefined) continue;
			if (!isTerminal(entry.snapshot.state) && entry.snapshot.policy.hold !== "detached") return true;
		}
		return this.#starting.size > 0;
	}

	// ── ops ────────────────────────────────────────────────────────────────

	list(operation: Op<"list">): DaemonResults["list"] {
		const active: UnitSnapshot[] = [];
		const terminal: UnitSnapshot[] = [];
		for (const entry of this.#units.values()) {
			const snapshot = entry.snapshot;
			if (operation.kind !== undefined && snapshot.kind !== operation.kind) continue;
			if (operation.scope !== undefined && scopeKey(snapshot.scope) !== scopeKey(operation.scope)) continue;
			(isTerminal(snapshot.state) ? terminal : active).push(copySnapshot(snapshot));
		}
		active.sort((left, right) => left.createdAt - right.createdAt);
		terminal.sort((left, right) => (right.exitedAt ?? right.createdAt) - (left.exitedAt ?? left.createdAt));
		return { units: [...active, ...terminal] };
	}

	async describe(operation: Op<"describe">): Promise<DaemonResults["describe"]> {
		const entry = this.#resolve(operation.unit);
		await this.#refreshDetached(entry);
		return { unit: copySnapshot(entry.snapshot), proc: entry.proc };
	}

	watch(connection: UnitConnection): DaemonResults["watch"] {
		this.#watchers.add(connection);
		return {};
	}

	async open(connection: UnitConnection, request: OpenRequest): Promise<OpenResult> {
		const id = identity(request.kind, request.scope, request.key);
		for (;;) {
			const inFlight = this.#starting.get(id);
			if (!inFlight) break;
			await inFlight.catch(() => undefined);
		}
		let entry = this.#byIdentity.get(id);
		let created = false;
		if (entry && !isTerminal(entry.snapshot.state) && entry.snapshot.state !== "stopping" && !request.replace) {
			// Adopt the live unit.
		} else {
			const creation = this.#create(connection, request, entry);
			this.#starting.set(id, creation);
			try {
				entry = await creation;
			} finally {
				if (this.#starting.get(id) === creation) this.#starting.delete(id);
			}
			created = true;
		}
		entry.lastUsed = Date.now();
		let lease: string | undefined;
		if (request.lease !== false) lease = this.#addLease(entry, connection);
		if (request.awaitReady !== false) {
			try {
				if (entry.procRuntime && entry.proc?.ready) {
					const target = entry;
					await this.#waitFor(
						target,
						() => target.snapshot.readyAt !== undefined || isTerminal(target.snapshot.state),
						entry.proc.ready.timeoutMs,
					);
				} else {
					await entry.ready;
				}
			} catch (error) {
				if (lease !== undefined) this.#dropLease(lease);
				throw error;
			}
		}
		return { unit: copySnapshot(entry.snapshot), lease, created };
	}

	release(connection: UnitConnection, leaseId: string): DaemonResults["release"] {
		const lease = this.#leases.get(leaseId);
		if (!lease || lease.connection.client.connectionId !== connection.client.connectionId) return {};
		this.#dropLease(leaseId);
		return {};
	}

	async stop(operation: Op<"stop">): Promise<DaemonResults["stop"]> {
		const entry = this.#resolve(operation.unit);
		if (operation.generation === undefined || operation.generation === entry.snapshot.generation) {
			await this.#stopEntry(entry, operation.timeoutMs, "stopped");
		}
		return { unit: copySnapshot(entry.snapshot) };
	}

	async restart(operation: Op<"restart">): Promise<DaemonResults["restart"]> {
		const entry = this.#resolve(operation.unit);
		await this.#restartEntry(entry);
		return { unit: copySnapshot(entry.snapshot) };
	}

	async mode(operation: Op<"mode">): Promise<DaemonResults["mode"]> {
		const entry = this.#resolve(operation.unit);
		const proc = entry.proc;
		if (!proc || !entry.procRuntime) throw new Error(`Unit ${entry.snapshot.key} is not a supervised process`);
		await this.#refreshDetached(entry);
		if (isTerminal(entry.snapshot.state) || entry.snapshot.state === "stopping") {
			throw new Error(`Unit ${entry.snapshot.key} is ${entry.snapshot.state}`);
		}
		const policy = entry.snapshot.policy;
		if (operation.mode === "detached") {
			if (policy.survive === "detached") {
				// Already launched in its own session: only the hold changes.
				entry.snapshot.policy = { ...policy, hold: "detached" };
				this.#transition(entry);
				this.#evaluateIdle(entry);
			} else {
				entry.proc = { ...proc, pty: false };
				entry.snapshot.policy = { ...policy, hold: "detached", survive: "detached" };
				await this.#restartEntry(entry);
			}
		} else {
			if (policy.hold === "detached" && operation.mode === "session") {
				throw new Error(`Detached unit ${entry.snapshot.key} must remain persistent`);
			}
			entry.snapshot.policy = { ...policy, hold: operation.mode === "persist" ? "persist" : "leases" };
			this.#transition(entry);
			this.#evaluateIdle(entry);
		}
		return { unit: copySnapshot(entry.snapshot) };
	}

	async logs(operation: Op<"logs">, signal?: AbortSignal): Promise<DaemonLogs> {
		const entry = this.#resolve(operation.unit);
		await this.#refreshDetached(entry);
		const cursor = operation.cursor ?? entry.snapshot.outputBytes;
		if (operation.follow && entry.snapshot.outputBytes <= cursor && !isTerminal(entry.snapshot.state)) {
			await this.#waitFor(
				entry,
				() => entry.snapshot.outputBytes > cursor || isTerminal(entry.snapshot.state),
				operation.timeoutMs,
				signal,
			);
			if (signal?.aborted) throw new Error(`Unit ${entry.snapshot.key} logs request cancelled`);
		}
		const lines = Math.max(1, Math.min(1_000, Math.floor(operation.lines)));
		const log = entry.procRuntime?.log;
		const output = log
			? await log.read(operation.head, lines, entry.snapshot.outputBytes, operation.grep)
			: await readLogFiles(
					unitLogDir(entry.snapshot.id),
					operation.head,
					lines,
					entry.snapshot.outputBytes,
					operation.grep,
				);
		let terminalOutput = "";
		if (entry.proc?.pty && operation.grep === undefined) {
			const rows = await renderTerminalOutput(output.terminalOutput, { head: operation.head, maxRows: lines });
			terminalOutput = rows === undefined ? output.terminalOutput : rows.join("\n");
		}
		return { text: output.text, terminalOutput, cursor: output.cursor, unit: copySnapshot(entry.snapshot) };
	}

	async wait(operation: Op<"wait">, signal?: AbortSignal): Promise<DaemonResults["wait"]> {
		const entry = this.#resolve(operation.unit);
		await this.#refreshDetached(entry);
		const boundGeneration = entry.snapshot.generation;
		let pattern: RegExp | undefined;
		if (operation.pattern) {
			try {
				pattern = new RegExp(operation.pattern, DAEMON_OUTPUT_PATTERN_FLAGS);
			} catch (error) {
				throw new Error(`Invalid wait regex: ${errorMessage(error)}`);
			}
		}
		let match: string | undefined;
		const readyObserved = (): boolean =>
			entry.snapshot.readyAt !== undefined ||
			entry.snapshot.state === "ready" ||
			(entry.snapshot.state === "running" && !entry.proc?.ready);
		const generationEnded = (): boolean =>
			entry.snapshot.generation !== boundGeneration || entry.snapshot.state === "restarting";
		const condition = (): boolean => {
			if (generationEnded()) return true;
			if (pattern) {
				const found = pattern.exec(entry.procRuntime?.readinessBuffer ?? "");
				if (found) {
					match = found[0].slice(0, 500);
					return true;
				}
				return isTerminal(entry.snapshot.state);
			}
			if (operation.for === "exit") return isTerminal(entry.snapshot.state);
			return readyObserved() || isTerminal(entry.snapshot.state);
		};
		const woke = await this.#waitFor(entry, condition, operation.timeoutMs, signal);
		if (signal?.aborted) throw new Error(`Unit ${entry.snapshot.key} wait cancelled`);
		if (generationEnded()) {
			const exit = entry.snapshot.exitCode === undefined ? "" : ` with exit code ${entry.snapshot.exitCode}`;
			throw new Error(
				`Unit ${entry.snapshot.key} generation ${boundGeneration} exited${exit}; ` +
					"the wait was rejected instead of continuing against a replacement generation",
			);
		}
		const matched = pattern ? match !== undefined : operation.for === "ready" ? readyObserved() : woke;
		if (isTerminal(entry.snapshot.state)) await entry.procRuntime?.terminalSettled;
		return { unit: copySnapshot(entry.snapshot), matched, match };
	}

	async send(operation: Op<"send">): Promise<DaemonResults["send"]> {
		const entry = this.#resolve(operation.unit);
		const runtime = entry.procRuntime;
		if (!runtime) throw new Error(`Unit ${entry.snapshot.key} accepts no input`);
		await this.#refreshDetached(entry);
		if (isTerminal(entry.snapshot.state) || entry.snapshot.state === "stopping") {
			throw new Error(`Unit ${entry.snapshot.key} is ${entry.snapshot.state}`);
		}
		if (operation.data === undefined && operation.signal === undefined) {
			throw new Error("send requires data or signal");
		}
		if (operation.data !== undefined) {
			if (entry.snapshot.policy.survive === "detached") {
				throw new Error(`Unit ${entry.snapshot.key} runs detached and has no stdin; only signals can be sent`);
			}
			if (runtime.pty) runtime.pty.write(operation.data);
			else if (runtime.child) {
				// PTYs interpret Enter as CR; pipe-backed programs need LF to end a line.
				const data = operation.data.endsWith("\r") ? `${operation.data.slice(0, -1)}\n` : operation.data;
				if (!runtime.child.write(data)) await runtime.child.drained();
			} else throw new Error(`Unit ${entry.snapshot.key} stdin is unavailable`);
		}
		if (operation.signal) {
			if (process.platform === "win32" && runtime.pty) {
				if (operation.signal === "SIGINT") runtime.pty.write("\u0003");
				else runtime.pty.kill();
			} else {
				const pid = entry.snapshot.pids[0];
				const processRef = pid === undefined ? null : Process.fromPid(pid);
				if (!processRef) throw new Error(`Unit ${entry.snapshot.key} process is unavailable`);
				processRef.killTree(SIGNAL_NUMBER[operation.signal]);
			}
		}
		return { unit: copySnapshot(entry.snapshot) };
	}

	async call(connection: UnitConnection, operation: Op<"call">): Promise<DaemonResults["call"]> {
		const module = this.#modules.get(operation.module);
		if (!module?.call) throw new Error(`Daemon module ${operation.module} has no calls`);
		let target: { snapshot: UnitSnapshot; unit: ModuleUnit } | undefined;
		let entry: UnitEntry | undefined;
		if (operation.unit !== undefined) {
			entry = this.#resolve(operation.unit);
			await entry.ready;
			const unit = entry.moduleRuntime?.unit;
			if (entry.snapshot.kind !== module.kind || !unit) {
				throw new Error(`Unit ${entry.snapshot.id} is not a ${module.kind} unit`);
			}
			target = { snapshot: copySnapshot(entry.snapshot), unit };
			entry.lastUsed = Date.now();
			entry.moduleRuntime!.calls++;
			this.#evaluateIdle(entry);
		}
		try {
			return {
				result: await module.call(
					this.#context(module),
					operation.method,
					operation.params,
					connection.client,
					target,
				),
			};
		} finally {
			if (entry?.moduleRuntime) {
				entry.moduleRuntime.calls--;
				entry.lastUsed = Date.now();
				this.#evaluateIdle(entry);
			}
		}
	}

	/** Check that `ref` accepts a tunnel, before the connection leaves control mode. */
	async attachable(ref: UnitRef): Promise<UnitSnapshot> {
		const entry = this.#resolve(ref);
		await entry.ready;
		if (entry.moduleRuntime?.unit) return copySnapshot(entry.snapshot);
		if (entry.procRuntime && !isTerminal(entry.snapshot.state)) return copySnapshot(entry.snapshot);
		throw new Error(`Unit ${entry.snapshot.key} does not accept tunnels`);
	}

	/** Hand an attached tunnel to the unit. */
	async attach(ref: UnitRef, channel: string | undefined, tunnel: ModuleTunnel): Promise<void> {
		const entry = this.#resolve(ref);
		entry.lastUsed = Date.now();
		const unit = entry.moduleRuntime?.unit;
		if (unit) {
			await unit.attach(tunnel, channel);
			return;
		}
		const runtime = entry.procRuntime;
		if (!runtime) throw new Error(`Unit ${entry.snapshot.key} does not accept tunnels`);
		entry.tunnels.add(tunnel);
		tunnel.start(
			chunk => {
				if (runtime.pty) runtime.pty.write(new TextDecoder().decode(chunk));
				else runtime.child?.write(chunk);
			},
			() => {
				entry.tunnels.delete(tunnel);
			},
		);
	}

	register(connection: UnitConnection, operation: Op<"register">): DaemonResults["register"] {
		const now = Date.now();
		const id = crypto.randomUUID();
		const entry = this.#newEntry({
			id,
			kind: operation.kind,
			scope: operation.scope,
			key: operation.key,
			label: operation.label,
			policy: EXTERNAL_POLICY,
			now,
			supervised: false,
		});
		entry.snapshot.state = "running";
		entry.snapshot.pids = [operation.pid];
		entry.externalConnection = connection.client.connectionId;
		this.#units.set(id, entry);
		this.#emit(entry);
		return { unit: copySnapshot(entry.snapshot) };
	}

	/** Remove a unit `connection` registered; unknown units resolve quietly, anything else is refused. */
	unregister(connection: UnitConnection, operation: Op<"unregister">): DaemonResults["unregister"] {
		const ref = operation.unit;
		let entry: UnitEntry | undefined;
		if (typeof ref === "string") {
			entry = this.#units.get(ref);
		} else {
			// External units stay out of the identity index: match the triple among registrations.
			const wanted = identity(ref.kind, ref.scope, ref.key);
			for (const candidate of this.#units.values()) {
				if (candidate.externalConnection !== connection.client.connectionId) continue;
				const { kind, scope, key } = candidate.snapshot;
				if (identity(kind, scope, key) === wanted) {
					entry = candidate;
					break;
				}
			}
		}
		if (!entry) return { removed: false };
		if (entry.externalConnection !== connection.client.connectionId) {
			throw new Error(`Unit ${entry.snapshot.key} was not registered by this connection`);
		}
		this.#removeEntry(entry);
		return { removed: true };
	}

	subscribe(connection: UnitConnection, operation: Op<"subscribe">): DaemonResults["subscribe"] {
		const subscriptionId = operation.subscriptionId;
		for (const owner of operation.unsubscribes ?? []) {
			const current = this.#subscriptions.get(owner);
			if (!this.#subscriptions.has(owner) || (current !== undefined && current !== subscriptionId)) continue;
			this.#ownerConnections.delete(owner);
			this.#subscriptions.delete(owner);
			this.#setCompletionCapability(owner, false);
		}
		const acks = operation.acks ?? [];
		for (const completionId of acks) {
			for (const entry of this.#units.values()) {
				const index = entry.pendingCompletions.findIndex(item => item.completionId === completionId);
				if (index < 0) continue;
				const registration = this.#ownerConnections.get(entry.pendingCompletions[index].owner);
				if (
					!registration ||
					registration.connection.client.connectionId !== connection.client.connectionId ||
					registration.subscriptionId !== subscriptionId
				) {
					continue;
				}
				entry.pendingCompletions.splice(index, 1);
				this.#persist(entry);
			}
		}
		if (acks.length > 0) return {};
		const replays = new Set(operation.replays ?? []);
		const active = new Set(operation.owners);
		const detached = new Set(operation.detachedOwners ?? []);
		for (const [owner, current] of this.#subscriptions) {
			if (current !== subscriptionId || active.has(owner) || detached.has(owner)) continue;
			this.#ownerConnections.delete(owner);
			this.#subscriptions.delete(owner);
			this.#setCompletionCapability(owner, false);
		}
		for (const owner of active) {
			this.#subscriptions.set(owner, subscriptionId);
			this.#setCompletionCapability(owner, true);
			const previous = this.#ownerConnections.get(owner);
			const sameConnection = previous?.connection.client.connectionId === connection.client.connectionId;
			// A returning owner does not get notify reports of output printed while it was away.
			if (!sameConnection) this.#skipUnwatchedOutput(owner);
			this.#ownerConnections.set(owner, { connection, subscriptionId });
			if (sameConnection && !replays.has(owner)) continue;
			for (const entry of this.#units.values()) {
				for (const completion of entry.pendingCompletions) {
					if (completion.owner === owner) connection.send(completion);
				}
			}
		}
		for (const owner of detached) {
			const current = this.#subscriptions.get(owner);
			if (this.#subscriptions.has(owner) && current !== subscriptionId) continue;
			this.#subscriptions.set(owner, subscriptionId);
			this.#setCompletionCapability(owner, true);
			if (this.#ownerConnections.get(owner)?.subscriptionId === subscriptionId) this.#ownerConnections.delete(owner);
		}
		return {};
	}

	/** A connection closed: drop its leases, registrations, watches, and owner bindings. */
	disconnected(connection: UnitConnection): void {
		const connectionId = connection.client.connectionId;
		this.#watchers.delete(connection);
		// A dropped connection is not a release: give its client time to reconnect and retake the lease.
		const graceUntil = Date.now() + this.#leaseGraceMs;
		for (const leaseId of this.#connectionLeases.get(connectionId) ?? []) {
			const entry = this.#leases.get(leaseId)?.entry;
			if (entry) entry.idleNotBefore = Math.max(entry.idleNotBefore ?? 0, graceUntil);
			this.#dropLease(leaseId);
		}
		this.#connectionLeases.delete(connectionId);
		for (const [owner, registration] of this.#ownerConnections) {
			if (registration.connection.client.connectionId === connectionId) this.#ownerConnections.delete(owner);
		}
		// Deleting the current Map entry while iterating is safe.
		for (const entry of this.#units.values()) {
			if (entry.externalConnection === connectionId) this.#removeEntry(entry);
		}
		for (const module of this.#modules.values()) {
			try {
				module.disconnected?.(connection.client);
			} catch (error) {
				logger.warn("Daemon module disconnect hook failed", { kind: module.kind, error: errorMessage(error) });
			}
		}
	}

	/**
	 * First step of an in-place re-exec: flush every module unit, snapshot the
	 * surviving ones, and stop the rest along with `survive: "none"` processes.
	 * Surviving processes keep logging until {@link pauseOutput}, then
	 * {@link releaseLogs} is the last awaited step; {@link reexecFds} runs
	 * synchronously right before the exec,
	 * and {@link abortReexec} undoes all of it when the exec fails.
	 */
	async prepareReexec(): Promise<void> {
		this.#shuttingDown = true;
		// Deleting the current Map entry while iterating is safe.
		for (const entry of this.#units.values()) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
			entry.snapshot.idleAt = undefined;
			if (entry.externalConnection !== undefined) {
				this.#removeEntry(entry);
				continue;
			}
			if (isTerminal(entry.snapshot.state)) continue;
			const survive = entry.snapshot.policy.survive;
			if (entry.moduleRuntime) {
				if (!(await this.#flushModule(entry, survive !== "none"))) {
					await this.#stopEntry(entry, 2_000, "daemon replaced");
				}
				continue;
			}
			const runtime = entry.procRuntime;
			if (!runtime) continue;
			if (survive === "none") await this.#stopEntry(entry, 2_000, "daemon replaced");
			else if (runtime.restartTimer) {
				// A relaunch racing the exec opens fds this image never records; the successor (or abortReexec) relaunches.
				clearTimeout(runtime.restartTimer);
				runtime.restartTimer = undefined;
			}
		}
		await this.#disposeModules();
	}

	/**
	 * Re-exec step after {@link prepareReexec}: stop reading the output of every
	 * process and module child. Resolves once each has delivered what it already
	 * read; what it has not read stays in the pipe or pty for the successor, so
	 * no byte is lost or logged twice across the exec.
	 */
	async pauseOutput(): Promise<void> {
		const paused: Promise<void>[] = [];
		for (const entry of this.#units.values()) {
			const runtime = entry.procRuntime;
			if (runtime?.child) paused.push(runtime.child.pauseOutput());
			// The pty pause is Unix-only in the natives; Windows never re-execs.
			else if (typeof runtime?.pty?.pauseOutput === "function") paused.push(runtime.pty.pauseOutput());
		}
		for (const child of this.#moduleChildren) paused.push(child.pauseOutput());
		const results = await Promise.allSettled(paused);
		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn("Failed to pause child output before re-exec", { error: errorMessage(result.reason) });
			}
		}
	}

	/**
	 * Last awaited step of a re-exec, after {@link pauseOutput}: take every unit
	 * log off its fd. The successor continues the files in place, and no log fd
	 * crosses the exec whatever its close-on-exec flag.
	 */
	async releaseLogs(): Promise<void> {
		await Promise.all(Array.from(this.#units.values(), entry => entry.procRuntime?.log?.release()));
	}

	/**
	 * Second half of a re-exec, run synchronously right before it: record the
	 * fds of every surviving process and module child, persist them, and return
	 * them as the exec's keep list.
	 */
	reexecFds(): number[] {
		const keep = new Set<number>();
		for (const entry of this.#units.values()) {
			const runtime = entry.procRuntime;
			if (!runtime || isTerminal(entry.snapshot.state) || entry.snapshot.policy.survive !== "exec") continue;
			if (runtime.child) {
				const state = runtime.child.state();
				entry.childFds = { kind: "pipe", stdin: state.stdin, stdout: state.stdout, stderr: state.stderr };
				keep.add(state.stdin).add(state.stdout).add(state.stderr);
			} else if (runtime.pty) {
				const master = runtime.pty.masterFd();
				if (master !== null) {
					entry.childFds = { kind: "pty", master };
					keep.add(master);
				}
			}
			this.#persist(entry);
		}
		for (const child of this.#moduleChildren) {
			const state = child.state();
			keep.add(state.stdin).add(state.stdout).add(state.stderr);
		}
		const fds = Array.from(keep);
		this.#store.setMeta(INHERITED_FDS_META, JSON.stringify(fds));
		return fds;
	}

	/** The exec failed: undo {@link prepareReexec} for what survived it and keep serving. */
	async abortReexec(): Promise<void> {
		this.#store.setMeta(INHERITED_FDS_META, "[]");
		this.#shuttingDown = false;
		for (const module of this.#modules.values()) {
			try {
				await module.init?.(this.#context(module));
			} catch (error) {
				logger.error("Daemon module init failed", { kind: module.kind, error: errorMessage(error) });
			}
		}
		for (const entry of this.#units.values()) {
			entry.childFds = undefined;
			const runtime = entry.procRuntime;
			if (runtime?.log) {
				try {
					await runtime.log.reacquire();
				} catch (error) {
					// The log keeps appending synchronously.
					logger.warn("Failed to reopen unit log", { id: entry.snapshot.id, error: errorMessage(error) });
				}
			}
			if (runtime && !isTerminal(entry.snapshot.state) && entry.snapshot.policy.survive === "detached") {
				this.#monitorDetached(entry, runtime.launch);
			}
			if (runtime?.child) runtime.child.resumeOutput();
			else if (typeof runtime?.pty?.resumeOutput === "function") runtime.pty.resumeOutput();
			if (runtime && entry.snapshot.state === "restarting" && !runtime.restartTimer) {
				void this.#relaunch(entry).catch(error =>
					logger.warn("Service restart failed", { id: entry.snapshot.id, error: errorMessage(error) }),
				);
			}
			this.#persist(entry);
			this.#evaluateIdle(entry);
		}
		for (const child of this.#moduleChildren) child.resumeOutput();
	}

	/** Stop everything except units that outlive the daemon; used by `shutdown`, the Windows `upgrade`, and daemon exit. */
	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		// Deleting the current Map entry while iterating is safe.
		for (const entry of this.#units.values()) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
			entry.snapshot.idleAt = undefined;
			if (entry.externalConnection !== undefined) {
				this.#removeEntry(entry);
				continue;
			}
			const runtime = entry.procRuntime;
			if (entry.moduleRuntime) {
				if (isTerminal(entry.snapshot.state)) continue;
				// `survive: "detached"` module units (their workers run in their own session) are re-adopted by the next daemon.
				if (!(await this.#flushModule(entry, entry.snapshot.policy.survive === "detached"))) {
					await this.#stopEntry(entry, 2_000, "daemon exited");
				}
				continue;
			}
			const detached =
				entry.snapshot.policy.survive === "detached" &&
				!runtime?.stopRequested &&
				!isTerminal(entry.snapshot.state);
			if (detached) {
				// Outlives this daemon; the next one re-adopts it. Retire this launch's callbacks.
				if (runtime) {
					runtime.launch++;
					runtime.notify?.notifier.stop();
					await runtime.log?.close();
				}
				this.#persist(entry);
				continue;
			}
			if (!isTerminal(entry.snapshot.state)) await this.#stopEntry(entry, 2_000, "daemon exited");
			clearTimeout(runtime?.restartTimer);
			await runtime?.log?.close();
		}
		await this.#disposeModules();
	}

	/**
	 * Flush a live module unit and, with `capture`, persist its snapshot. True
	 * when the unit keeps running (captured); false when it must be stopped.
	 */
	async #flushModule(entry: UnitEntry, capture: boolean): Promise<boolean> {
		const runtime = entry.moduleRuntime!;
		const unit = runtime.unit;
		if (!unit) return true;
		try {
			await unit.flush?.();
		} catch (error) {
			logger.warn("Module unit flush failed", { id: entry.snapshot.id, error: errorMessage(error) });
		}
		if (!capture) return false;
		try {
			runtime.state = unit.snapshot?.();
		} catch (error) {
			runtime.state = undefined;
			logger.warn("Module unit could not be snapshotted", { id: entry.snapshot.id, error: errorMessage(error) });
		}
		if (runtime.state === undefined) return false;
		this.#persist(entry);
		return true;
	}

	async #disposeModules(): Promise<void> {
		for (const module of this.#modules.values()) {
			try {
				await module.dispose?.();
			} catch (error) {
				logger.warn("Daemon module dispose failed", { kind: module.kind, error: errorMessage(error) });
			}
		}
	}

	// ── creation ───────────────────────────────────────────────────────────

	#newEntry(init: {
		id: string;
		kind: string;
		scope: UnitScope;
		key: string;
		label: string;
		policy: UnitPolicy;
		now: number;
		owner?: string;
		supervised: boolean;
		proc?: ProcSpec;
	}): UnitEntry {
		return {
			snapshot: {
				id: init.id,
				kind: init.kind,
				scope: init.scope,
				key: init.key,
				label: init.label,
				generation: crypto.randomUUID(),
				state: "starting",
				pids: [],
				createdAt: init.now,
				startedAt: init.now,
				restartCount: 0,
				outputBytes: 0,
				owner: init.owner,
				leases: 0,
				policy: init.policy,
				command: init.proc ? [init.proc.application, ...init.proc.args].join(" ") : undefined,
				cwd: init.proc?.cwd,
				supervised: init.supervised,
			},
			proc: init.proc,
			leases: new Set(),
			lastUsed: init.now,
			outputOffset: 0,
			completion: { capable: false },
			pendingCompletions: [],
			waiters: new Set(),
			tunnels: new Set(),
			ready: Promise.resolve(),
		};
	}

	async #create(
		connection: UnitConnection,
		request: OpenRequest,
		existing: UnitEntry | undefined,
	): Promise<UnitEntry> {
		if (request.kind === "proc") return this.#createProc(request, existing);
		const module = this.#modules.get(request.kind);
		if (!module) throw new Error(`Unknown daemon unit kind ${request.kind}`);
		if (existing && !isTerminal(existing.snapshot.state)) await this.#stopEntry(existing, 2_000, "replaced");
		if (existing) this.#removeEntry(existing);
		const policy: UnitPolicy = { ...module.policy(request.params), ...request.policy };
		await this.#enforceCap(request.kind, request.scope, policy.cap);
		const now = Date.now();
		const entry = this.#newEntry({
			id: crypto.randomUUID(),
			kind: request.kind,
			scope: request.scope,
			key: request.key,
			label: request.label ?? `${request.kind} ${request.key}`,
			policy,
			now,
			owner: request.owner,
			supervised: true,
			proc: request.proc,
		});
		const moduleRuntime: ModuleRuntime = { module, params: request.params, calls: 0 };
		entry.moduleRuntime = moduleRuntime;
		this.#insert(entry);
		try {
			const unit = await module.open(this.#context(module), {
				unitId: entry.snapshot.id,
				scope: request.scope,
				key: request.key,
				params: request.params,
				proc: request.proc,
				client: connection.client,
			});
			this.#bindModuleUnit(entry, unit);
		} catch (error) {
			this.#removeEntry(entry);
			throw error;
		}
		return entry;
	}

	/** Wire a live module unit into its entry. */
	#bindModuleUnit(entry: UnitEntry, unit: ModuleUnit): void {
		const runtime = entry.moduleRuntime!;
		runtime.unit = unit;
		entry.snapshot.label = unit.label;
		entry.snapshot.pids = unit.pids();
		entry.snapshot.state = "running";
		entry.snapshot.startedAt = Date.now();
		if (entry.snapshot.policy.survive !== "none") runtime.state = unit.snapshot?.();
		this.#trackPidStart(entry);
		this.#transition(entry);
		entry.ready = unit.ready.then(
			() => {
				if (isTerminal(entry.snapshot.state)) return;
				entry.snapshot.state = "ready";
				entry.snapshot.readyAt = Date.now();
				this.#transition(entry);
				this.#evaluateIdle(entry);
			},
			error => {
				logger.warn("Daemon module unit failed to become ready", {
					id: entry.snapshot.id,
					error: errorMessage(error),
				});
				const reason = `not ready: ${errorMessage(error)}`;
				void unit.stop(reason).catch(() => undefined);
				// Leave the board now so the next `open` starts a fresh unit instead of adopting this one.
				this.#settleModule(entry, unit, 1, reason);
				throw error;
			},
		);
		// Readiness failures surface through `open`/`attach`; unobserved ones must not crash the daemon.
		entry.ready.catch(() => undefined);
		void unit.exited.then(
			exit => this.#settleModule(entry, unit, exit.exitCode, exit.reason),
			error => this.#settleModule(entry, unit, undefined, errorMessage(error)),
		);
		this.#evaluateIdle(entry);
	}

	#settleModule(entry: UnitEntry, unit: ModuleUnit, exitCode: number | undefined, reason: string | undefined): void {
		if (entry.moduleRuntime?.unit !== unit || isTerminal(entry.snapshot.state)) return;
		entry.moduleRuntime.unit = undefined;
		entry.snapshot.state = exitCode !== undefined && exitCode !== 0 ? "failed" : "exited";
		entry.snapshot.exitCode = exitCode;
		entry.snapshot.exitReason = reason;
		entry.snapshot.exitedAt = Date.now();
		entry.snapshot.pids = [];
		entry.snapshot.idleAt = undefined;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		for (const tunnel of entry.tunnels) tunnel.close();
		this.#wake(entry);
		this.#removeEntry(entry);
		this.#onLivenessChange();
	}

	async #createProc(request: OpenRequest, existing: UnitEntry | undefined): Promise<UnitEntry> {
		const proc = request.proc;
		if (!proc) throw new Error("A proc unit needs a proc spec");
		if (!SERVICE_NAME.test(request.key)) {
			throw new Error("Service name must be 1-48 letters, numbers, dots, underscores, or hyphens");
		}
		const policy: UnitPolicy = { ...defaultProcPolicy(proc, request.policy?.hold), ...request.policy };
		if (policy.hold === "detached") policy.survive = "detached";
		if (policy.survive === "detached" && proc.pty) throw new Error("A detached service cannot allocate a PTY");
		if (
			proc.pty &&
			process.platform === "win32" &&
			[".bat", ".cmd"].includes(path.extname(proc.application).toLowerCase())
		) {
			throw new Error('Windows batch files require application "cmd.exe" with the batch path after "/c"');
		}
		if (existing) {
			await this.#refreshDetached(existing);
			if (!isTerminal(existing.snapshot.state)) {
				await this.#stopEntry(existing, 2_000, "replaced");
				if (!isTerminal(existing.snapshot.state)) throw new Error(`Service ${request.key} did not stop`);
			}
			if (existing.pendingCompletions.length > 0 && !request.replace) {
				throw new Error(`Service ${request.key} has unacknowledged completion notifications`);
			}
		}
		if (proc.ready?.log) {
			try {
				new RegExp(proc.ready.log, DAEMON_OUTPUT_PATTERN_FLAGS);
			} catch (error) {
				throw new Error(`Invalid readiness regex: ${errorMessage(error)}`);
			}
		}
		if (proc.notify) compileNotifyPattern(proc.notify);
		const stat = await fsp.stat(proc.cwd);
		if (!stat.isDirectory()) throw new Error(`Service cwd is not a directory: ${proc.cwd}`);
		// A listener already on the port would satisfy the probe before this service binds it.
		if (proc.ready?.port !== undefined) {
			const busy = await listeningHost(readinessHosts(proc.ready), proc.ready.port);
			if (busy !== undefined) {
				throw new Error(
					`Port ${proc.ready.port} already accepts connections on ${busy} before ${request.key} started; another process holds it, so ready.port cannot tell when ${request.key} is ready. Stop that process or use another port.`,
				);
			}
		}
		await this.#enforceCap("proc", request.scope, policy.cap);
		const now = Date.now();
		const entry = this.#newEntry({
			id: crypto.randomUUID(),
			kind: "proc",
			scope: request.scope,
			key: request.key,
			label: request.label ?? request.key,
			policy,
			now,
			owner: request.owner,
			supervised: true,
			proc,
		});
		if (existing) {
			await existing.procRuntime?.log?.close();
			if (request.replace) entry.pendingCompletions = existing.pendingCompletions;
			existing.pendingCompletions = [];
			this.#removeEntry(existing);
		}
		const owner = request.owner;
		entry.completion = {
			capable: owner !== undefined && this.#subscriptions.has(owner),
			subscriptionId: owner === undefined ? undefined : this.#subscriptions.get(owner),
		};
		entry.procRuntime = {
			launch: 0,
			log: await UnitLog.open(unitLogDir(entry.snapshot.id), true),
			stopRequested: false,
			logReady: !proc.ready?.log,
			portReady: proc.ready?.port === undefined,
			readinessBuffer: "",
			readyPattern: proc.ready?.log ? new RegExp(proc.ready.log, DAEMON_OUTPUT_PATTERN_FLAGS) : undefined,
			consecutiveFailures: 0,
			monitoring: false,
		};
		this.#insert(entry);
		await this.#launch(entry);
		return entry;
	}

	#insert(entry: UnitEntry): void {
		this.#units.set(entry.snapshot.id, entry);
		this.#byIdentity.set(identity(entry.snapshot.kind, entry.snapshot.scope, entry.snapshot.key), entry);
		this.#transition(entry);
		this.#onLivenessChange();
	}

	#removeEntry(entry: UnitEntry): void {
		const id = entry.snapshot.id;
		if (this.#units.get(id) !== entry) return;
		clearTimeout(entry.idleTimer);
		clearTimeout(entry.procRuntime?.restartTimer);
		this.#units.delete(id);
		const key = identity(entry.snapshot.kind, entry.snapshot.scope, entry.snapshot.key);
		if (this.#byIdentity.get(key) === entry) this.#byIdentity.delete(key);
		for (const leaseId of entry.leases) this.#leases.delete(leaseId);
		entry.leases.clear();
		if (entry.externalConnection === undefined) this.#store.deleteUnit(id);
		if (entry.procRuntime) {
			const runtime = entry.procRuntime;
			void (async () => {
				await runtime.log?.close();
				await fsp.rm(unitLogDir(id), { recursive: true, force: true });
			})().catch(error => logger.debug("Failed to delete unit logs", { id, error: errorMessage(error) }));
		}
		this.#broadcast({ ev: "unit", unit: copySnapshot(entry.snapshot), removed: true });
	}

	/** Evict least recently used unleased, idle units of `(kind, scope)` until one more fits under `cap`. */
	async #enforceCap(kind: string, scope: UnitScope, cap: number | undefined): Promise<void> {
		if (cap === undefined || cap <= 0) return;
		const scopeText = scopeKey(scope);
		const live = (): UnitEntry[] =>
			[...this.#units.values()].filter(
				entry =>
					entry.snapshot.kind === kind &&
					scopeKey(entry.snapshot.scope) === scopeText &&
					!isTerminal(entry.snapshot.state) &&
					entry.snapshot.state !== "stopping",
			);
		for (let units = live(); units.length >= cap; units = live()) {
			const victim = units
				.filter(entry => entry.leases.size === 0 && !this.#busy(entry))
				.sort((left, right) => left.lastUsed - right.lastUsed)[0];
			if (!victim) return;
			await this.#stopEntry(victim, 2_000, "evicted", true);
		}
	}

	// ── leases & idle ──────────────────────────────────────────────────────

	#addLease(entry: UnitEntry, connection: UnitConnection): string {
		const leaseId = crypto.randomUUID();
		this.#leases.set(leaseId, { entry, connection });
		entry.leases.add(leaseId);
		const connectionId = connection.client.connectionId;
		let leases = this.#connectionLeases.get(connectionId);
		if (!leases) {
			leases = new Set();
			this.#connectionLeases.set(connectionId, leases);
		}
		leases.add(leaseId);
		entry.snapshot.leases = entry.leases.size;
		this.#evaluateIdle(entry);
		this.#emit(entry);
		return leaseId;
	}

	#dropLease(leaseId: string): void {
		const lease = this.#leases.get(leaseId);
		if (!lease) return;
		this.#leases.delete(leaseId);
		this.#connectionLeases.get(lease.connection.client.connectionId)?.delete(leaseId);
		const entry = lease.entry;
		entry.leases.delete(leaseId);
		entry.snapshot.leases = entry.leases.size;
		entry.lastUsed = Date.now();
		const unit = entry.moduleRuntime?.unit;
		if (unit?.released) {
			try {
				unit.released(lease.connection.client);
			} catch (error) {
				logger.warn("Module unit release hook failed", { id: entry.snapshot.id, error: errorMessage(error) });
			}
		}
		this.#evaluateIdle(entry);
		this.#emit(entry);
	}

	#busy(entry: UnitEntry): boolean {
		const runtime = entry.moduleRuntime;
		if (!runtime) return false;
		if (runtime.calls > 0) return true;
		try {
			return runtime.unit?.busy() ?? false;
		} catch {
			return false;
		}
	}

	/** Arm or clear the idle timer from the unit's policy, leases, and in-flight work. */
	#evaluateIdle(entry: UnitEntry): void {
		const policy = entry.snapshot.policy;
		const eligible =
			!this.#shuttingDown &&
			policy.hold === "leases" &&
			entry.leases.size === 0 &&
			entry.externalConnection === undefined &&
			!isSettled(entry.snapshot.state) &&
			entry.snapshot.state !== "stopping" &&
			entry.snapshot.state !== "starting";
		if (!eligible) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
			entry.snapshot.idleAt = undefined;
			return;
		}
		if (this.#busy(entry)) {
			// Work can end without a notification; look again shortly.
			clearTimeout(entry.idleTimer);
			entry.snapshot.idleAt = undefined;
			entry.idleTimer = setTimeout(() => {
				entry.idleTimer = undefined;
				this.#evaluateIdle(entry);
			}, BUSY_RECHECK_MS);
			return;
		}
		if (entry.snapshot.idleAt !== undefined && entry.idleTimer) return;
		clearTimeout(entry.idleTimer);
		const now = Date.now();
		const at = Math.max(now + Math.max(0, policy.idleMs), this.#holdIdleUntil, entry.idleNotBefore ?? 0);
		entry.idleNotBefore = undefined;
		entry.snapshot.idleAt = at;
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = undefined;
			entry.snapshot.idleAt = undefined;
			if (entry.leases.size > 0 || isSettled(entry.snapshot.state)) return;
			if (this.#busy(entry)) {
				this.#evaluateIdle(entry);
				return;
			}
			void this.#stopEntry(entry, 2_000, "idle", policy.onIdle === "flush-stop").catch(error =>
				logger.warn("Idle stop failed", { id: entry.snapshot.id, error: errorMessage(error) }),
			);
		}, at - now);
	}

	// ── proc supervision ───────────────────────────────────────────────────

	async #launch(entry: UnitEntry): Promise<void> {
		const runtime = entry.procRuntime!;
		const proc = entry.proc!;
		runtime.launch++;
		const launch = runtime.launch;
		runtime.stopRequested = false;
		runtime.stopReason = undefined;
		runtime.terminalSettled = undefined;
		const snapshot = entry.snapshot;
		snapshot.generation = crypto.randomUUID();
		snapshot.state = proc.ready ? "starting" : "running";
		snapshot.startedAt = Date.now();
		snapshot.readyAt = undefined;
		snapshot.exitedAt = undefined;
		snapshot.exitCode = undefined;
		snapshot.exitReason = undefined;
		snapshot.pids = [];
		snapshot.readyMatch = undefined;
		snapshot.outputBytes = 0;
		snapshot.supervised = true;
		runtime.logReady = !proc.ready?.log;
		runtime.portReady = proc.ready?.port === undefined;
		runtime.readinessBuffer = "";
		entry.outputOffset = 0;
		entry.childFds = undefined;
		entry.pidStartedAt = undefined;
		syncReadyPending(entry);
		runtime.notify?.notifier.stop();
		runtime.notify = this.#armNotify(entry);
		this.#transition(entry);
		try {
			if (snapshot.policy.survive === "detached") await this.#launchDetached(entry, launch);
			else if (proc.pty) await this.#launchPty(entry, launch);
			else this.#launchPipe(entry, launch);
			if (proc.ready?.port !== undefined) void this.#pollPort(entry, launch, proc.ready);
			this.#markReady(entry);
		} catch (error) {
			const message = errorMessage(error);
			runtime.log?.append(`Service launch failed: ${message}\n`);
			await this.#settleProc(entry, launch, undefined, message);
		}
		this.#evaluateIdle(entry);
		this.#onLivenessChange();
	}

	#setPid(entry: UnitEntry, pid: number): void {
		entry.snapshot.pids = [pid];
		entry.pidStartedAt = processStartTime(pid);
		this.#transition(entry);
	}

	#trackPidStart(entry: UnitEntry): void {
		const pid = entry.snapshot.pids[0];
		entry.pidStartedAt = pid === undefined ? undefined : processStartTime(pid);
	}

	#ptyHandlers(entry: UnitEntry, launch: number, session: PtySession): (error: Error | null, chunk: string) => void {
		const runtime = entry.procRuntime!;
		// Nothing plays terminal for a supervised PTY, so a program probing for cursor
		// position or device attributes would block on the reply. Answer those queries
		// from the output stream. On Windows ConPTY's INHERIT_CURSOR handshake is answered
		// by the PTY layer (crates/natives/src/pty.rs), so it must not be answered twice.
		const responder = new TerminalQueryResponder({ hostCursorHandshake: process.platform === "win32" });
		return (error, chunk) => {
			if (launch !== runtime.launch) return;
			if (error) runtime.log?.append(`PTY output error: ${error.message}\n`);
			if (!chunk) return;
			const reply = responder.feed(chunk);
			if (reply) {
				try {
					session.write(reply);
				} catch {
					// The PTY may exit between its final output and the reply.
				}
			}
			for (const tunnel of entry.tunnels) tunnel.send(chunk);
			this.#onOutput(entry, launch, chunk);
		};
	}

	#watchPtyRun(entry: UnitEntry, launch: number, run: Promise<PtyRunResult>): void {
		void run.then(
			result => this.#settleProc(entry, launch, result.exitCode, result.timedOut ? "timed out" : undefined),
			error => this.#settleProc(entry, launch, undefined, errorMessage(error)),
		);
	}

	async #launchPty(entry: UnitEntry, launch: number): Promise<void> {
		const runtime = entry.procRuntime!;
		const proc = entry.proc!;
		const session = new PtySession();
		runtime.pty = session;
		const started = Promise.withResolvers<number | undefined>();
		const run = session.startArgv(
			{
				application: proc.application,
				args: proc.args,
				cwd: proc.cwd,
				env: { TERM: "xterm-256color", ...proc.env },
				cols: DAEMON_PTY_COLUMNS,
				rows: DAEMON_PTY_ROWS,
			},
			this.#ptyHandlers(entry, launch, session),
			(error, pid) => {
				if (error) {
					runtime.log?.append(`PTY startup callback failed: ${error.message}\n`);
					started.resolve(undefined);
					return;
				}
				started.resolve(Number.isSafeInteger(pid) && pid > 0 ? pid : undefined);
			},
		);
		this.#watchPtyRun(entry, launch, run);
		void run.then(
			() => started.resolve(undefined),
			() => started.resolve(undefined),
		);
		const pid = await started.promise;
		if (pid !== undefined && launch === runtime.launch) this.#setPid(entry, pid);
	}

	#wirePipeChild(entry: UnitEntry, launch: number, child: ManagedChild): void {
		const runtime = entry.procRuntime!;
		runtime.child = child;
		const stdoutDecoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();
		const forward = (decoder: TextDecoder) => (chunk: Uint8Array) => {
			if (launch !== runtime.launch) return;
			for (const tunnel of entry.tunnels) tunnel.send(chunk);
			this.#onOutput(entry, launch, decoder.decode(chunk, { stream: true }));
		};
		child.onStdout(forward(stdoutDecoder));
		child.onStderr(forward(stderrDecoder));
		void child.exited.then(
			exit => {
				const tail = stdoutDecoder.decode() + stderrDecoder.decode();
				if (tail) this.#onOutput(entry, launch, tail);
				const code = exit.exitCode ?? (exit.signal === undefined ? undefined : 128 + exit.signal);
				return this.#settleProc(entry, launch, code);
			},
			error => this.#settleProc(entry, launch, undefined, errorMessage(error)),
		);
	}

	#launchPipe(entry: UnitEntry, launch: number): void {
		const proc = entry.proc!;
		const child = spawnManagedChild({ application: proc.application, args: proc.args, env: proc.env, cwd: proc.cwd });
		this.#wirePipeChild(entry, launch, child);
		this.#setPid(entry, child.pid);
	}

	async #launchDetached(entry: UnitEntry, launch: number): Promise<void> {
		const runtime = entry.procRuntime!;
		const proc = entry.proc!;
		// The process writes its log itself; this daemon only reads it.
		await runtime.log?.close();
		runtime.log = undefined;
		const dir = unitLogDir(entry.snapshot.id);
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
		const output = await fsp.open(path.join(dir, LOG_FILE), "a", 0o600);
		try {
			const child = Bun.spawn([proc.application, ...proc.args], {
				cwd: proc.cwd,
				env: proc.env,
				stdio: ["ignore", output.fd, output.fd],
				...DAEMON_SPAWN_OPTIONS,
			});
			child.unref();
			const state = { exited: false };
			runtime.detached = state;
			this.#setPid(entry, child.pid);
			void child.exited.then(
				exitCode => {
					state.exited = true;
					return this.#settleProc(entry, launch, exitCode);
				},
				error => this.#settleProc(entry, launch, undefined, errorMessage(error)),
			);
		} finally {
			await output.close();
		}
		this.#monitorDetached(entry, launch);
	}

	/** Poll a detached unit's log and liveness while it runs; nothing else sees its output land. */
	#monitorDetached(entry: UnitEntry, launch: number): void {
		const runtime = entry.procRuntime!;
		if (runtime.monitoring) return;
		runtime.monitoring = true;
		void (async () => {
			try {
				while (!this.#shuttingDown && launch === runtime.launch && !isSettled(entry.snapshot.state)) {
					await Bun.sleep(DETACHED_POLL_MS);
					if (this.#shuttingDown || launch !== runtime.launch) return;
					await this.#refreshDetached(entry);
				}
			} finally {
				runtime.monitoring = false;
			}
		})().catch(error =>
			logger.warn("Failed to monitor detached unit", { id: entry.snapshot.id, error: errorMessage(error) }),
		);
	}

	#onOutput(entry: UnitEntry, launch: number, raw: string): void {
		const runtime = entry.procRuntime!;
		if (launch !== runtime.launch) return;
		const text = raw.toWellFormed();
		runtime.log?.append(text);
		entry.snapshot.outputBytes += Buffer.byteLength(text, "utf8");
		this.#trackOutput(entry, launch, sanitizeText(text));
	}

	#readDetachedOutput(entry: UnitEntry, launch: number, report = true): Promise<void> {
		const runtime = entry.procRuntime;
		if (!runtime || entry.snapshot.policy.survive !== "detached" || launch !== runtime.launch)
			return Promise.resolve();
		const read = (runtime.detachedRead ?? Promise.resolve()).then(async () => {
			if (launch !== runtime.launch) return;
			const logPath = path.join(unitLogDir(entry.snapshot.id), LOG_FILE);
			let size: number;
			try {
				size = (await fsp.stat(logPath)).size;
			} catch (error) {
				if (isEnoent(error)) return;
				throw error;
			}
			if (size < entry.outputOffset) entry.outputOffset = 0;
			if (size === entry.outputOffset) return;
			const raw = await Bun.file(logPath).slice(entry.outputOffset, size).text();
			if (launch !== runtime.launch) return;
			entry.outputOffset = size;
			entry.snapshot.outputBytes = size;
			for (const tunnel of entry.tunnels) tunnel.send(raw);
			if (report) this.#trackOutput(entry, launch, sanitizeText(raw));
			else runtime.readinessBuffer = (runtime.readinessBuffer + sanitizeText(raw)).slice(-READINESS_BUFFER_CHARS);
		});
		runtime.detachedRead = read.catch(() => undefined);
		return read;
	}

	#trackOutput(entry: UnitEntry, launch: number, text: string): void {
		const runtime = entry.procRuntime!;
		if (launch !== runtime.launch) return;
		runtime.readinessBuffer = (runtime.readinessBuffer + text).slice(-READINESS_BUFFER_CHARS);
		if (!runtime.logReady && runtime.readyPattern) {
			const match = runtime.readyPattern.exec(runtime.readinessBuffer);
			if (match) {
				runtime.logReady = true;
				entry.snapshot.readyMatch = match[0].slice(0, 500);
				syncReadyPending(entry);
			}
		}
		this.#markReady(entry);
		// Output printed while the owner is away is read past: neither reported nor counted.
		if (runtime.notify) {
			runtime.notify.tap.append(text);
			if (this.#ownerConnection(entry)) runtime.notify.notifier.poll();
			else runtime.notify.notifier.skip();
		}
		this.#wake(entry);
	}

	/** The notifier of a new launch; nothing without a `notify` regex or when it does not compile. */
	#armNotify(entry: UnitEntry): ProcRuntime["notify"] {
		const pattern = entry.proc?.notify;
		if (pattern === undefined) return undefined;
		try {
			const tap = new TextTap("out", entry.snapshot.key);
			// A service has no deadline: without refill its matches stop after one burst per start.
			const notifier = new OutputNotifier(
				compileNotifyPattern(pattern),
				tap,
				batch => this.#publishNotify(entry, pattern, batch),
				{ refill: false },
			);
			return { tap, notifier };
		} catch (error) {
			logger.warn("Service notify regex does not compile", { key: entry.snapshot.key, error: errorMessage(error) });
			return undefined;
		}
	}

	#ownerConnection(entry: UnitEntry): UnitConnection | undefined {
		const owner = entry.snapshot.owner;
		const registration = owner === undefined ? undefined : this.#ownerConnections.get(owner);
		return registration && !registration.connection.closed ? registration.connection : undefined;
	}

	#publishNotify(entry: UnitEntry, pattern: string, batch: NotifyBatch): void {
		if (batch.stopped && entry.procRuntime) entry.procRuntime.notify = undefined;
		const owner = entry.snapshot.owner;
		const connection = this.#ownerConnection(entry);
		if (owner === undefined || !connection) return;
		connection.send({ ev: "notify", owner, unit: copySnapshot(entry.snapshot), pattern, ...batch });
	}

	/** Read past what `owner`'s detached units wrote while it was away. */
	#skipUnwatchedOutput(owner: string): void {
		for (const entry of this.#units.values()) {
			const runtime = entry.procRuntime;
			if (entry.snapshot.owner !== owner || !runtime?.notify || entry.snapshot.policy.survive !== "detached")
				continue;
			void this.#readDetachedOutput(entry, runtime.launch).catch(error =>
				logger.warn("Failed to read detached unit output", { id: entry.snapshot.id, error: errorMessage(error) }),
			);
		}
	}

	/** Catch up a detached unit's output and notice its exit when no process handle reports it. */
	async #refreshDetached(entry: UnitEntry): Promise<void> {
		const runtime = entry.procRuntime;
		if (!runtime || entry.snapshot.policy.survive !== "detached" || isSettled(entry.snapshot.state)) return;
		const launch = runtime.launch;
		await this.#readDetachedOutput(entry, launch);
		if (launch !== runtime.launch || (runtime.detached && !runtime.detached.exited)) return;
		const pid = entry.snapshot.pids[0];
		if (pid !== undefined && isSameProcess(pid, entry.pidStartedAt)) return;
		await this.#settleProc(entry, launch);
	}

	async #pollPort(entry: UnitEntry, launch: number, ready: DaemonReadySpec): Promise<void> {
		const runtime = entry.procRuntime!;
		const port = ready.port;
		if (port === undefined) return;
		const hosts = readinessHosts(ready);
		while (launch === runtime.launch && !isTerminal(entry.snapshot.state)) {
			if ((await listeningHost(hosts, port)) !== undefined) {
				runtime.portReady = true;
				syncReadyPending(entry);
				this.#markReady(entry);
				return;
			}
			await Bun.sleep(100);
		}
	}

	#markReady(entry: UnitEntry): void {
		const runtime = entry.procRuntime!;
		if (!entry.proc?.ready || entry.snapshot.state !== "starting") return;
		if (!runtime.logReady || !runtime.portReady) return;
		entry.snapshot.state = "ready";
		entry.snapshot.readyAt = Date.now();
		this.#transition(entry);
		this.#evaluateIdle(entry);
	}

	async #settleProc(entry: UnitEntry, launch: number, exitCode?: number, error?: string): Promise<void> {
		const runtime = entry.procRuntime!;
		// `restarting` is settled: re-settling would double-count restarts and orphan the timer.
		if (launch !== runtime.launch || isSettled(entry.snapshot.state)) return;
		await this.#readDetachedOutput(entry, launch);
		if (launch !== runtime.launch || isSettled(entry.snapshot.state)) return;
		// The last matches, the unterminated line included, go out ahead of the exit notice.
		runtime.notify?.notifier.finish();
		runtime.notify = undefined;
		runtime.child = undefined;
		runtime.pty = undefined;
		runtime.detached = undefined;
		const snapshot = entry.snapshot;
		snapshot.pids = [];
		snapshot.exitedAt = Date.now();
		snapshot.exitCode = exitCode;
		snapshot.exitReason = error ?? (runtime.stopRequested ? runtime.stopReason : undefined);
		snapshot.readyPending = undefined;
		snapshot.idleAt = undefined;
		entry.pidStartedAt = undefined;
		entry.childFds = undefined;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		const failed = error !== undefined || (exitCode !== undefined && exitCode !== 0);
		const restart = snapshot.policy.restart;
		const shouldRestart = !runtime.stopRequested && (restart === "always" || (restart === "on-failure" && failed));
		if (shouldRestart && !this.#shuttingDown) {
			const uptime = Date.now() - snapshot.startedAt;
			runtime.consecutiveFailures = uptime >= RESTART_STABLE_MS ? 0 : runtime.consecutiveFailures + 1;
			snapshot.restartCount++;
			snapshot.readyAt = undefined;
			snapshot.readyMatch = undefined;
			snapshot.state = "restarting";
			const delay = Math.min(
				RESTART_BACKOFF_BASE_MS * 2 ** Math.min(runtime.consecutiveFailures, 5),
				RESTART_MAX_DELAY_MS,
			);
			runtime.log?.append(
				`\n[service exited${exitCode === undefined ? "" : ` with code ${exitCode}`}; restarting in ${delay}ms]\n`,
			);
			this.#transition(entry);
			runtime.restartTimer = setTimeout(() => {
				runtime.restartTimer = undefined;
				void this.#relaunch(entry).catch(err =>
					logger.warn("Service restart failed", { id: snapshot.id, error: errorMessage(err) }),
				);
			}, delay);
			return;
		}
		snapshot.state = failed && !runtime.stopRequested ? "failed" : "exited";
		for (const tunnel of entry.tunnels) tunnel.close();
		runtime.terminalSettled = this.#publishTerminal(entry);
		await runtime.terminalSettled;
	}

	async #relaunch(entry: UnitEntry): Promise<void> {
		const runtime = entry.procRuntime!;
		if (entry.snapshot.policy.survive !== "detached") {
			await runtime.log?.close();
			runtime.log = await UnitLog.open(unitLogDir(entry.snapshot.id), false);
		}
		await this.#launch(entry);
	}

	async #publishTerminal(entry: UnitEntry): Promise<void> {
		const runtime = entry.procRuntime!;
		const owner = entry.snapshot.owner;
		const completion: DaemonCompletionEvent | undefined =
			owner !== undefined && !runtime.stopRequested && this.#subscriptions.has(owner)
				? { ev: "completed", completionId: crypto.randomUUID(), owner, unit: copySnapshot(entry.snapshot) }
				: undefined;
		if (completion) entry.pendingCompletions.push(completion);
		await runtime.log?.close();
		runtime.log = undefined;
		this.#transition(entry);
		if (completion) this.#ownerConnections.get(completion.owner)?.connection.send(completion);
		this.#pruneHistory(entry.snapshot.scope);
		this.#onLivenessChange();
	}

	/** Keep the newest terminal `proc` units of a scope; older ones (without pending completions) are deleted. */
	#pruneHistory(scope: UnitScope): void {
		const scopeText = scopeKey(scope);
		const terminal = [...this.#units.values()]
			.filter(
				entry =>
					entry.procRuntime !== undefined &&
					isTerminal(entry.snapshot.state) &&
					entry.pendingCompletions.length === 0 &&
					scopeKey(entry.snapshot.scope) === scopeText,
			)
			.sort((left, right) => (right.snapshot.exitedAt ?? 0) - (left.snapshot.exitedAt ?? 0));
		for (const entry of terminal.slice(MAX_TERMINAL_UNITS_PER_SCOPE)) this.#removeEntry(entry);
	}

	async #stopEntry(entry: UnitEntry, timeoutMs: number, reason: string, flush = false): Promise<void> {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		entry.snapshot.idleAt = undefined;
		const moduleRuntime = entry.moduleRuntime;
		if (moduleRuntime) {
			const unit = moduleRuntime.unit;
			if (!unit || isTerminal(entry.snapshot.state)) return;
			entry.snapshot.state = "stopping";
			this.#transition(entry);
			if (flush) {
				try {
					await unit.flush?.();
				} catch (error) {
					logger.warn("Module unit flush failed", { id: entry.snapshot.id, error: errorMessage(error) });
				}
			}
			try {
				await unit.stop(reason);
			} catch (error) {
				logger.warn("Module unit stop failed", { id: entry.snapshot.id, error: errorMessage(error) });
			}
			// Not a bare sleep race: its pending timer would hold a shut-down daemon open for the full timeout.
			await withTimeout(unit.exited, timeoutMs + 1_000, "module unit exit timed out").catch(() => {});
			this.#settleModule(entry, unit, undefined, reason);
			return;
		}
		const runtime = entry.procRuntime;
		if (!runtime) {
			this.#removeEntry(entry);
			return;
		}
		await this.#refreshDetached(entry);
		if (isTerminal(entry.snapshot.state)) return;
		runtime.stopRequested = true;
		runtime.stopReason = reason;
		runtime.notify?.notifier.stop();
		if (runtime.restartTimer) {
			clearTimeout(runtime.restartTimer);
			runtime.restartTimer = undefined;
			entry.snapshot.state = "exited";
			entry.snapshot.exitedAt = Date.now();
			entry.snapshot.exitReason = reason;
			runtime.terminalSettled = this.#publishTerminal(entry);
			await runtime.terminalSettled;
			return;
		}
		entry.snapshot.state = "stopping";
		this.#transition(entry);
		const pid = entry.snapshot.pids[0];
		const processRef = pid === undefined ? null : Process.fromPid(pid);
		if (processRef) await processRef.terminate({ group: true, gracefulMs: timeoutMs, timeoutMs: timeoutMs + 1_000 });
		else runtime.pty?.kill();
		const settled = await this.#waitFor(entry, () => isTerminal(entry.snapshot.state), timeoutMs + 1_000);
		if (!settled && runtime.pty) runtime.pty.kill();
		if (!settled && !isTerminal(entry.snapshot.state)) {
			// A process this image cannot wait on (re-adopted after a crash) settles once it is gone.
			await this.#settleProc(entry, runtime.launch);
		}
	}

	async #restartEntry(entry: UnitEntry): Promise<void> {
		const moduleRuntime = entry.moduleRuntime;
		if (moduleRuntime) throw new Error(`Module unit ${entry.snapshot.key} restarts by being opened again`);
		const runtime = entry.procRuntime;
		if (!runtime) throw new Error(`Unit ${entry.snapshot.key} cannot be restarted`);
		await this.#stopEntry(entry, 2_000, "restarting");
		await runtime.log?.close();
		runtime.log =
			entry.snapshot.policy.survive === "detached"
				? undefined
				: await UnitLog.open(unitLogDir(entry.snapshot.id), false);
		runtime.stopRequested = false;
		const owner = entry.snapshot.owner;
		entry.completion = {
			capable: owner !== undefined && this.#subscriptions.has(owner),
			subscriptionId: owner === undefined ? undefined : this.#subscriptions.get(owner),
		};
		// A restarted unit is live again under its identity.
		this.#byIdentity.set(identity(entry.snapshot.kind, entry.snapshot.scope, entry.snapshot.key), entry);
		await this.#launch(entry);
	}

	#setCompletionCapability(owner: string, capable: boolean): void {
		const subscriptionId = capable ? this.#subscriptions.get(owner) : undefined;
		for (const entry of this.#units.values()) {
			if (entry.snapshot.owner !== owner) continue;
			// Settled history without pending events has nothing more to deliver.
			if (isTerminal(entry.snapshot.state) && entry.pendingCompletions.length === 0) continue;
			const clearPending = !capable && entry.pendingCompletions.length > 0;
			if (
				entry.completion.capable === capable &&
				entry.completion.subscriptionId === subscriptionId &&
				!clearPending
			) {
				continue;
			}
			entry.completion = { capable, subscriptionId };
			if (!capable) entry.pendingCompletions = [];
			this.#persist(entry);
		}
	}

	// ── restore ────────────────────────────────────────────────────────────

	async #restore(stored: StoredUnit): Promise<void> {
		const entry = this.#newEntry({
			id: stored.id,
			kind: stored.kind,
			scope: stored.scope,
			key: stored.key,
			label: stored.label,
			policy: stored.policy,
			now: stored.snapshot.createdAt,
			owner: stored.owner,
			supervised: stored.snapshot.supervised,
			proc: stored.proc,
		});
		entry.snapshot = { ...stored.snapshot, leases: 0, idleAt: undefined };
		entry.pidStartedAt = stored.pidStartedAt;
		entry.outputOffset = stored.outputOffset;
		entry.completion = stored.completion;
		entry.pendingCompletions = stored.pendingCompletions;
		if (stored.owner && stored.completion.capable)
			this.#subscriptions.set(stored.owner, stored.completion.subscriptionId);
		const wasLive = !isTerminal(stored.snapshot.state);
		const survive = stored.policy.survive;

		if (stored.kind !== "proc") {
			const module = this.#modules.get(stored.kind);
			const restorable =
				wasLive &&
				module?.restore !== undefined &&
				stored.moduleState !== undefined &&
				(survive === "detached" || (survive === "exec" && this.#resumed));
			if (!module || !restorable) {
				this.#store.deleteUnit(stored.id);
				return;
			}
			entry.moduleRuntime = { module, params: undefined, calls: 0, state: stored.moduleState };
			this.#units.set(entry.snapshot.id, entry);
			this.#byIdentity.set(identity(entry.snapshot.kind, entry.snapshot.scope, entry.snapshot.key), entry);
			let unit: ModuleUnit | undefined;
			try {
				unit = await module.restore!(
					this.#context(module),
					{ unitId: stored.id, scope: stored.scope, key: stored.key, proc: stored.proc },
					stored.moduleState,
				);
			} catch (error) {
				logger.warn("Module unit restore failed", { id: stored.id, error: errorMessage(error) });
			}
			if (!unit) {
				this.#removeEntry(entry);
				return;
			}
			this.#bindModuleUnit(entry, unit);
			return;
		}

		const proc = stored.proc;
		if (!proc) {
			this.#store.deleteUnit(stored.id);
			return;
		}
		entry.procRuntime = {
			launch: 1,
			stopRequested: false,
			logReady: !proc.ready?.log || stored.snapshot.state === "ready",
			portReady: proc.ready?.port === undefined || stored.snapshot.state === "ready",
			readinessBuffer: "",
			readyPattern: proc.ready?.log ? new RegExp(proc.ready.log, DAEMON_OUTPUT_PATTERN_FLAGS) : undefined,
			consecutiveFailures: 0,
			monitoring: false,
		};
		this.#units.set(entry.snapshot.id, entry);
		this.#byIdentity.set(identity(entry.snapshot.kind, entry.snapshot.scope, entry.snapshot.key), entry);
		const runtime = entry.procRuntime;
		const pid = stored.snapshot.pids[0] ?? stored.pid;
		const alive =
			wasLive &&
			stored.snapshot.state !== "stopping" &&
			pid !== undefined &&
			isSameProcess(pid, stored.pidStartedAt);
		if (alive && survive === "detached") {
			if (stored.snapshot.state === "restarting") entry.snapshot.state = proc.ready ? "starting" : "running";
			// The saved offset lags what the last daemon reported: read to the end before arming notify.
			try {
				await this.#readDetachedOutput(entry, runtime.launch, false);
			} catch (error) {
				logger.warn("Failed to read recovered detached output", { id: stored.id, error: errorMessage(error) });
			}
			entry.snapshot.supervised = false;
			// Its clients' leases died with the last daemon: give them time to reconnect and retake them.
			entry.idleNotBefore = Date.now() + this.#leaseGraceMs;
			runtime.notify = this.#armNotify(entry);
			if (proc.ready?.port !== undefined && entry.snapshot.state !== "ready") {
				void this.#pollPort(entry, runtime.launch, proc.ready);
			}
			this.#monitorDetached(entry, runtime.launch);
			this.#persist(entry);
			return;
		}
		if (alive && survive === "exec" && this.#resumed && stored.childFds) {
			if (await this.#adoptExec(entry, stored.childFds, pid)) return;
		}
		if (survive === "exec" && this.#resumed && stored.snapshot.state === "restarting") {
			// prepareReexec held this pending restart across the exec.
			this.#persist(entry);
			void this.#relaunch(entry).catch(error =>
				logger.warn("Service restart failed", { id: stored.id, error: errorMessage(error) }),
			);
			return;
		}
		if (wasLive && pid !== undefined && isSameProcess(pid, stored.pidStartedAt)) {
			await Process.fromPid(pid)?.terminate({ group: true, gracefulMs: 500, timeoutMs: 2_000 });
		}
		if (wasLive) {
			entry.snapshot.state = "exited";
			entry.snapshot.pids = [];
			entry.snapshot.exitedAt = Date.now();
			entry.snapshot.exitReason = "daemon exited";
			entry.snapshot.readyPending = undefined;
			entry.pidStartedAt = undefined;
			runtime.stopRequested = true;
			const owner = stored.owner;
			if (owner && entry.completion.capable && entry.pendingCompletions.length === 0) {
				entry.pendingCompletions.push({
					ev: "completed",
					completionId: crypto.randomUUID(),
					owner,
					unit: copySnapshot(entry.snapshot),
				});
			}
		} else {
			runtime.stopRequested = true;
		}
		this.#persist(entry);
	}

	/** Re-attach a pipe or PTY unit whose fds this image inherited from its predecessor. */
	async #adoptExec(entry: UnitEntry, fds: StoredChildFds, pid: number): Promise<boolean> {
		const runtime = entry.procRuntime!;
		const launch = runtime.launch;
		const owned = fds.kind === "pipe" ? [fds.stdin, fds.stdout, fds.stderr] : [fds.master];
		// Only fds the previous image kept name this unit's pipes; any other number may alias a live fd.
		if (!owned.every(fd => this.#inheritedFds.has(fd))) return false;
		try {
			runtime.log = await UnitLog.resume(unitLogDir(entry.snapshot.id));
			if (fds.kind === "pipe") {
				const child = adoptChild({
					pid,
					startedAt: entry.pidStartedAt ?? processStartTime(pid) ?? Date.now(),
					stdin: fds.stdin,
					stdout: fds.stdout,
					stderr: fds.stderr,
				});
				if (!child) {
					await runtime.log.close();
					runtime.log = undefined;
					return false;
				}
				this.#claimInherited(...owned);
				this.#wirePipeChild(entry, launch, child);
			} else {
				const session = PtySession.adopt(fds.master, pid);
				this.#claimInherited(...owned);
				runtime.pty = session;
				this.#watchPtyRun(entry, launch, session.resume(this.#ptyHandlers(entry, launch, session)));
			}
		} catch (error) {
			logger.warn("Failed to adopt unit across re-exec", { id: entry.snapshot.id, error: errorMessage(error) });
			await runtime.log?.close();
			runtime.log = undefined;
			return false;
		}
		entry.childFds = undefined;
		if (entry.snapshot.state === "restarting") entry.snapshot.state = entry.proc?.ready ? "starting" : "running";
		runtime.notify = this.#armNotify(entry);
		if (entry.proc?.ready?.port !== undefined && entry.snapshot.state !== "ready") {
			void this.#pollPort(entry, launch, entry.proc.ready);
		}
		this.#persist(entry);
		return true;
	}

	// ── plumbing ───────────────────────────────────────────────────────────

	#context(module: DaemonModule): ModuleContext {
		let context = this.#contexts.get(module.kind);
		if (context) return context;
		const stateDir = moduleStateDir(module.kind);
		let created = false;
		const table = this;
		context = {
			get stateDir(): string {
				if (!created) {
					fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
					created = true;
				}
				return stateDir;
			},
			spawn: spec => table.#trackModuleChild(spawnManagedChild(spec)),
			adoptChild: state => {
				// Only fds inherited from the previous image name this child's pipes; any other number may alias a live fd.
				const fds = [state.stdin, state.stdout, state.stderr];
				if (!fds.every(fd => table.#inheritedFds.has(fd))) return undefined;
				const child = adoptChild(state);
				if (!child) return undefined;
				table.#claimInherited(...fds);
				return table.#trackModuleChild(child);
			},
			changed: unitId => table.#moduleChanged(unitId),
			unit: (scope, key) => {
				const entry = table.#byIdentity.get(identity(module.kind, scope, key));
				return entry && !isTerminal(entry.snapshot.state) ? entry.moduleRuntime?.unit : undefined;
			},
		};
		this.#contexts.set(module.kind, context);
		return context;
	}

	/** Remember a module's child until it exits, so its fds cross a re-exec. */
	#trackModuleChild(child: ManagedChild): ManagedChild {
		this.#moduleChildren.add(child);
		void child.exited.then(
			() => this.#moduleChildren.delete(child),
			() => this.#moduleChildren.delete(child),
		);
		return child;
	}

	/** Inherited fds now owned by an adopted unit or child; the rest are closed after restore. */
	#claimInherited(...fds: number[]): void {
		for (const fd of fds) this.#inheritedFds.delete(fd);
	}

	#moduleChanged(unitId: string): void {
		const entry = this.#units.get(unitId);
		const unit = entry?.moduleRuntime?.unit;
		if (!entry || !unit) return;
		// Work over long-lived tunnels reports itself here; it counts as use for cap eviction.
		entry.lastUsed = Date.now();
		entry.snapshot.label = unit.label;
		entry.snapshot.pids = unit.pids();
		this.#trackPidStart(entry);
		if (entry.snapshot.policy.survive !== "none") {
			try {
				entry.moduleRuntime!.state = unit.snapshot?.();
			} catch (error) {
				logger.warn("Module unit snapshot failed", { id: unitId, error: errorMessage(error) });
			}
		}
		this.#transition(entry);
		this.#evaluateIdle(entry);
	}

	#resolve(ref: UnitRef): UnitEntry {
		if (typeof ref === "string") {
			const byId = this.#units.get(ref);
			if (byId) return byId;
			// A bare service name resolves when exactly one `proc` unit carries it.
			const named = [...this.#units.values()].filter(
				entry => entry.snapshot.kind === "proc" && entry.snapshot.key === ref,
			);
			if (named.length === 1) return named[0];
			const names = [...this.#units.values()]
				.filter(entry => entry.snapshot.kind === "proc")
				.map(entry => entry.snapshot.key);
			throw new Error(`Unknown unit ${ref}${names.length ? `. Available: ${names.join(", ")}` : ""}`);
		}
		const entry = this.#byIdentity.get(identity(ref.kind, ref.scope, ref.key));
		if (!entry) throw new Error(`Unknown ${ref.kind} unit ${ref.key} in ${scopeKey(ref.scope)}`);
		return entry;
	}

	/** Resolve after `condition` holds (true) or `timeoutMs`/`signal` end the wait (its last value). */
	#waitFor(entry: UnitEntry, condition: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		if (condition()) return Promise.resolve(true);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			entry.waiters.delete(check);
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve(condition());
		};
		const check = (): void => {
			if (condition()) finish();
		};
		entry.waiters.add(check);
		const timer = setTimeout(finish, Math.max(0, timeoutMs));
		if (signal?.aborted) finish();
		else signal?.addEventListener("abort", finish, { once: true });
		return promise;
	}

	#wake(entry: UnitEntry): void {
		// A satisfied waiter removes only itself; Set iteration tolerates that.
		for (const waiter of entry.waiters) waiter();
	}

	/** A state transition: persist, publish to the board, wake waiters. */
	#transition(entry: UnitEntry): void {
		this.#persist(entry);
		this.#emit(entry);
		this.#wake(entry);
	}

	#emit(entry: UnitEntry): void {
		this.#broadcast({ ev: "unit", unit: copySnapshot(entry.snapshot) });
	}

	#broadcast(event: DaemonEvent): void {
		for (const watcher of this.#watchers) {
			if (watcher.closed) this.#watchers.delete(watcher);
			else watcher.send(event);
		}
	}

	#persist(entry: UnitEntry): void {
		if (entry.externalConnection !== undefined || this.#units.get(entry.snapshot.id) !== entry) return;
		const snapshot = entry.snapshot;
		try {
			this.#store.saveUnit({
				id: snapshot.id,
				kind: snapshot.kind,
				scope: snapshot.scope,
				key: snapshot.key,
				label: snapshot.label,
				policy: snapshot.policy,
				proc: entry.proc,
				snapshot: { ...snapshot, leases: 0, idleAt: undefined },
				pid: snapshot.pids[0],
				pidStartedAt: entry.pidStartedAt,
				childFds: entry.childFds,
				moduleState: entry.moduleRuntime?.state,
				outputOffset: entry.outputOffset,
				owner: snapshot.owner,
				completion: entry.completion,
				pendingCompletions: entry.pendingCompletions,
			});
		} catch (error) {
			logger.warn("Failed to persist daemon unit", { id: snapshot.id, error: errorMessage(error) });
		}
	}
}
