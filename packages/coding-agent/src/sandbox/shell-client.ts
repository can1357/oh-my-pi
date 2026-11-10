/**
 * Parent side of the sandbox host ({@link ./host}): {@link SandboxedShell} and
 * {@link SandboxedPtySession} stand in for the native `Shell` / `PtySession` and forward every
 * call to an `omp __omp_sandbox_host` process running inside the MXC container.
 *
 * Shell hosts are pooled per (agent session, policy fingerprint, extra readable and writable paths).
 * A host that fails to start, dies, or stops answering is an error for the calls on it; nothing
 * here ever falls back to an unsandboxed shell.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type PipeStreams,
	Process,
	type PtyRunResult,
	type PtyStartOptions,
	type ShellFilesystem,
	type ShellFsResponse,
	type ShellRunResult,
	sandboxSupport,
} from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { SANDBOX_HOST_ARG } from "../cli/worker-selectors";
import { resolveCliEntryCmd, StderrTail, workerEnvFromParent } from "../subprocess/worker-client";
import { quotePosixArgv } from "../utils/shell-quote";
import {
	decodeHostMessage,
	encodeHostMessage,
	type HostEvent,
	type HostPtyStart,
	type HostRequest,
	type HostResults,
	type HostShellOptions,
	readHostLines,
	SANDBOX_HOST_PROTOCOL_VERSION,
} from "./host-protocol";
import { isWithin } from "./platform";
import { type SandboxChild, SandboxRuntime } from "./runtime";
import type { SandboxNetworkMode } from "./types";

/** How long a host may take to announce `ready`. */
const HOST_START_TIMEOUT_MS = 30_000;
/**
 * How long an aborted run may take to settle before its host is treated as wedged and killed.
 * Native cancellation itself takes up to ~2s.
 */
const ABORT_SETTLE_GRACE_MS = 5_000;
/** Host stderr kept for the error of a host that died. */
const STDERR_TAIL_BYTES = 4 * 1024;
/** Proxy variables MXC sets inside the container in `allowlist` mode (its egress proxy). */
const PROXY_ENV_RE = /^(?:https?|all|no)_proxy$/i;

/**
 * `env` for a process contained by `runtime` (host, shell session, PTY): in `allowlist` mode
 * (effective, or `network` when a request overrides it) the parent's proxy variables are dropped so
 * MXC's egress proxy applies; in `allow`/`deny` mode they pass through (a proxy-only network still
 * needs them under `allow`). `TMPDIR`/`TMP`/`TEMP` always name the runtime's private temp dir.
 */
export function sandboxProcessEnv(
	runtime: SandboxRuntime,
	env: Record<string, string>,
	network?: SandboxNetworkMode,
): Record<string, string> {
	const status = runtime.status();
	const effective = network ?? (status.state === "active" ? status.network : undefined);
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (effective !== "allowlist" || !PROXY_ENV_RE.test(key)) result[key] = value;
	}
	// Last, so neither the parent env nor the shell config can point them back: the system temp
	// dir is not writable in the container, the runtime's private one is.
	const tempDir = runtime.tempDir();
	result.TMPDIR = tempDir;
	result.TMP = tempDir;
	result.TEMP = tempDir;
	return result;
}

/** argv that starts the sandbox host under the running distribution (source, npm bundle, binary). */
export function sandboxHostArgv(): string[] {
	return [...resolveCliEntryCmd(), SANDBOX_HOST_ARG];
}

/** Live trace of a sandboxed run: the latest `RunTrace` snapshot the host sent. */
export class SandboxRunTrace {
	#version = -1;
	#snapshot = "";

	version(): number {
		return this.#version;
	}

	snapshot(): string {
		return this.#snapshot;
	}

	/** @internal */
	update(snapshot: string): void {
		this.#snapshot = snapshot;
		this.#version++;
	}
}

/** Per-run callbacks the connection routes host events to. */
interface RunRoutes {
	onChunk?: (chunk: string) => void;
	trace?: SandboxRunTrace;
	filesystem?: ShellFilesystem;
	onPids?: (pids: number[]) => void;
}

/** Numeric fields each host event must carry; a reply carries `id`. */
const HOST_EVENT_FIELDS: Record<Exclude<HostEvent, { ok: boolean }>["ev"], readonly string[]> = {
	ready: ["version"],
	"shell.chunk": ["id"],
	"shell.trace": ["id"],
	"shell.pids": ["id"],
	"fs.request": ["id", "req"],
	"pty.data": ["pty"],
	"pty.exit": ["pty"],
	log: [],
};

/** Shallow shape check: a malformed event must fail the connection, not throw deep in dispatch. */
function isHostEvent(value: unknown): value is HostEvent {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if ("ok" in record) return typeof record.id === "number" && typeof record.ok === "boolean";
	const fields =
		typeof record.ev === "string" ? HOST_EVENT_FIELDS[record.ev as keyof typeof HOST_EVENT_FIELDS] : undefined;
	return fields !== undefined && fields.every(field => typeof record[field] === "number");
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	run?: RunRoutes;
}

interface PtyRoutes {
	onData(data: string): void;
	onExit(result: PtyRunResult, error?: string): void;
	onFail(error: Error): void;
}

type Notification = Extract<HostRequest, { op: "pty.write" | "pty.resize" | "fs.reply" }>;
/** A request awaiting a reply, before the connection numbers it. */
type HostCall =
	Exclude<HostRequest, Notification> extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** One JSONL connection to a running host process. */
export class SandboxHostConnection {
	readonly #child: SandboxChild;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #ptys = new Map<number, PtyRoutes>();
	readonly #ready = Promise.withResolvers<void>();
	#nextId = 0;
	#failure: Error | undefined;
	readonly #stderrTail = new StderrTail(STDERR_TAIL_BYTES);
	#closeWhenIdle = false;
	readonly #exitListeners = new Set<() => void>();

	private constructor(child: SandboxChild) {
		this.#child = child;
	}

	/** Attaches to `child` (a host process) and resolves once it announced a compatible `ready`. */
	static async connect(child: SandboxChild): Promise<SandboxHostConnection> {
		const connection = new SandboxHostConnection(child);
		connection.#start();
		const timer = setTimeout(
			() => connection.kill(`Sandbox host did not start within ${HOST_START_TIMEOUT_MS / 1000}s`),
			HOST_START_TIMEOUT_MS,
		);
		try {
			await connection.#ready.promise;
		} finally {
			clearTimeout(timer);
		}
		return connection;
	}

	get pid(): number {
		return this.#child.pid;
	}

	/** True once the host died or was shut down; every later request rejects. */
	get closed(): boolean {
		return this.#failure !== undefined;
	}

	/** Runs `listener` once the connection fails or closes. */
	onExit(listener: () => void): void {
		if (this.#failure) listener();
		else this.#exitListeners.add(listener);
	}

	request<M extends HostCall>(message: M, run?: RunRoutes): Promise<HostResults[M["op"]]> {
		if (this.#failure) return Promise.reject(this.#failure);
		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<HostResults[M["op"]]>();
		this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, run });
		const call: HostCall = message;
		this.#write({ ...call, id });
		return promise;
	}

	notify(message: Notification): void {
		if (!this.#failure) this.#write(message);
	}

	/** Routes `pty.data`/`pty.exit` of `pty` until it exits. */
	attachPty(pty: number, routes: PtyRoutes): void {
		if (this.#failure) {
			routes.onFail(this.#failure);
			return;
		}
		this.#ptys.set(pty, routes);
	}

	/** Kills the host and everything it started now; in-flight calls reject with `reason`. */
	kill(reason: string): void {
		this.#fail(new Error(reason));
		this.#killDescendants();
		this.#child.kill();
	}

	/** Lets the host exit (stdin EOF) once no call is in flight; its background jobs end with it. */
	retire(): void {
		this.#closeWhenIdle = true;
		this.#closeIfIdle();
	}

	/**
	 * Ends the processes the host's shells started. They `setsid` into their own sessions, so neither
	 * the host's exit nor the backend's kill of the host reaches them; they are still its descendants.
	 */
	#killDescendants(): void {
		if (this.#child.exitCode !== null || this.#child.pid <= 0) return;
		try {
			for (const child of Process.fromPid(this.#child.pid)?.children() ?? []) child.killTree();
		} catch (error) {
			logger.warn("sandbox host: could not end its child processes", { error: String(error) });
		}
	}

	#start(): void {
		void this.#readStdout();
		const stderrDone = this.#readStderr();
		void this.#child.exited.then(async code => {
			// Let the last stderr lines (the reason it died) land first.
			await Promise.race([stderrDone, Bun.sleep(200)]);
			this.#fail(new Error(`Sandbox host exited unexpectedly (exit code ${code})${this.#stderrTail.suffix()}`));
		});
	}

	#write(message: HostRequest): void {
		try {
			this.#child.stdin.write(encodeHostMessage(message));
			this.#child.stdin.flush();
		} catch (error) {
			this.kill(`Sandbox host stdin failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#fail(error: Error): void {
		if (this.#failure) return;
		this.#failure = error;
		this.#ready.reject(error);
		// Settle `connect()`'s await without an unhandled rejection when nobody awaits `ready` anymore.
		this.#ready.promise.catch(() => {});
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		for (const pty of this.#ptys.values()) pty.onFail(error);
		this.#ptys.clear();
		for (const listener of this.#exitListeners) listener();
		this.#exitListeners.clear();
	}

	#closeIfIdle(): void {
		if (!this.#closeWhenIdle || this.#pending.size > 0 || this.#ptys.size > 0 || this.#failure) return;
		this.#fail(new Error("Sandbox host was shut down"));
		this.#killDescendants();
		try {
			this.#child.stdin.end();
		} catch {
			this.#child.kill();
		}
	}

	async #readStdout(): Promise<void> {
		try {
			for await (const line of readHostLines(this.#child.stdout)) {
				try {
					const event: unknown = decodeHostMessage<HostEvent>(line);
					if (!isHostEvent(event)) throw new Error("unexpected shape");
					this.#dispatch(event);
				} catch (error) {
					const reason = `Sandbox host sent an invalid message (${error instanceof Error ? error.message : String(error)}): ${line.slice(0, 200)}`;
					// A host that died mid-line leaves a cut line; its exit (with the stderr tail) is the real cause.
					const exited = await Promise.race([
						this.#child.exited.then(() => true),
						Bun.sleep(200).then(() => false),
					]);
					if (!exited) this.kill(reason);
					return;
				}
			}
		} catch (error) {
			this.kill(`Sandbox host output failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #readStderr(): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of this.#child.stderr) {
				this.#stderrTail.append(chunk);
				logger.debug("sandbox host stderr", {
					pid: this.#child.pid,
					text: decoder.decode(chunk, { stream: true }),
				});
			}
		} catch {
			// The exit handler reports what was collected.
		}
	}

	#dispatch(event: HostEvent): void {
		if ("ok" in event) {
			const pending = this.#pending.get(event.id);
			if (!pending) return;
			this.#pending.delete(event.id);
			if (event.ok) pending.resolve(event.result);
			else pending.reject(new Error(event.error));
			this.#closeIfIdle();
			return;
		}
		switch (event.ev) {
			case "ready":
				if (event.version !== SANDBOX_HOST_PROTOCOL_VERSION) {
					this.kill(`Sandbox host speaks protocol ${event.version}, expected ${SANDBOX_HOST_PROTOCOL_VERSION}`);
					return;
				}
				this.#ready.resolve();
				return;
			case "shell.chunk":
				this.#pending.get(event.id)?.run?.onChunk?.(event.data);
				return;
			case "shell.trace":
				this.#pending.get(event.id)?.run?.trace?.update(event.snapshot);
				return;
			case "shell.pids":
				this.#pending.get(event.id)?.run?.onPids?.(event.pids);
				return;
			case "fs.request": {
				const filesystem = this.#pending.get(event.id)?.run?.filesystem;
				const reply = (response: ShellFsResponse): void =>
					this.notify({ op: "fs.reply", req: event.req, response });
				if (!filesystem) {
					reply({ error: { code: "ENOTSUP", message: "No filesystem for this run" } });
					return;
				}
				filesystem
					.handler(null, event.request)
					.then(reply, (error: unknown) =>
						reply({ error: { code: "EIO", message: error instanceof Error ? error.message : String(error) } }),
					);
				return;
			}
			case "pty.data":
				this.#ptys.get(event.pty)?.onData(event.data);
				return;
			case "pty.exit": {
				const routes = this.#ptys.get(event.pty);
				this.#ptys.delete(event.pty);
				routes?.onExit(event.result, event.error);
				this.#closeIfIdle();
				return;
			}
			case "log":
				logger.emitForeign({ ...event.record, timestamp: new Date(event.record.timestamp) });
				return;
		}
	}
}

// ── Host pool ────────────────────────────────────────────────────────────────

/** What a contained host is started for. */
export interface SandboxHostScope {
	/** Agent session owning the shells (`undefined`: the shared anonymous pool). */
	agentSessionKey: string | undefined;
	/** Working directory of the host process. */
	cwd: string;
	/** Host-side paths the contained shell must read (the rc snapshot). */
	extraRead?: readonly string[];
	/** Host-side paths the contained shell may write besides the policy's (the session's `local://` root). */
	extraWrite?: readonly string[];
}

const hostPool = new Map<string, Promise<SandboxHostConnection>>();

function poolPrefix(agentSessionKey: string | undefined): string {
	return `${agentSessionKey ?? ""}\n`;
}

/** Starts a host contained by `runtime` and attaches to it. */
export async function startSandboxHost(
	runtime: SandboxRuntime,
	options: {
		cwd: string;
		extraRead?: readonly string[];
		extraWrite?: readonly string[];
		network?: SandboxNetworkMode;
	},
): Promise<SandboxHostConnection> {
	const child = await runtime.spawn({
		argv: sandboxHostArgv(),
		cwd: options.cwd,
		env: sandboxProcessEnv(runtime, workerEnvFromParent(), options.network),
		extraRead: options.extraRead,
		extraWrite: options.extraWrite,
		network: options.network,
	});
	try {
		return await SandboxHostConnection.connect(child);
	} catch (error) {
		child.kill();
		throw error;
	}
}

/**
 * The pooled host for `scope` under `runtime`'s current policy. Hosts of the same agent session
 * under another policy are retired (they exit once their in-flight calls settle).
 */
function acquireHost(runtime: SandboxRuntime, scope: SandboxHostScope): Promise<SandboxHostConnection> {
	const prefix = poolPrefix(scope.agentSessionKey);
	const extra = [...(scope.extraRead ?? []), "\0", ...(scope.extraWrite ?? [])].join("\0");
	const key = `${prefix}${runtime.fingerprint()}\n${extra}`;
	const existing = hostPool.get(key);
	if (existing) return existing;
	for (const [other, host] of hostPool) {
		if (other.startsWith(prefix)) {
			hostPool.delete(other);
			void host.then(
				connection => connection.retire(),
				() => {},
			);
		}
	}
	const started = startSandboxHost(runtime, scope);
	hostPool.set(key, started);
	started.then(
		connection => connection.onExit(() => hostPool.get(key) === started && hostPool.delete(key)),
		() => hostPool.get(key) === started && hostPool.delete(key),
	);
	return started;
}

/**
 * Retires every pooled host of an agent session: each exits once its in-flight calls settle, and
 * its persistent shells and background jobs end with it.
 */
export function releaseSandboxHosts(agentSessionKey: string | undefined): void {
	const prefix = poolPrefix(agentSessionKey);
	for (const [key, host] of hostPool) {
		if (!key.startsWith(prefix)) continue;
		hostPool.delete(key);
		void host.then(
			connection => connection.retire(),
			() => {},
		);
	}
}

/** The pooled hosts of one agent session. */
function sessionHosts(agentSessionKey: string | undefined): Promise<SandboxHostConnection>[] {
	const prefix = poolPrefix(agentSessionKey);
	return [...hostPool].filter(([key]) => key.startsWith(prefix)).map(([, host]) => host);
}

/** Number of live pooled hosts of an agent session (test seam). @internal */
export function sandboxHostPoolSize(agentSessionKey: string | undefined): number {
	return sessionHosts(agentSessionKey).length;
}

/** Pids of an agent session's pooled hosts that started (test seam). @internal */
export async function sandboxHostPids(agentSessionKey: string | undefined): Promise<number[]> {
	const settled = await Promise.allSettled(sessionHosts(agentSessionKey));
	return settled.flatMap(outcome => (outcome.status === "fulfilled" ? [outcome.value.pid] : []));
}

// ── Shell ────────────────────────────────────────────────────────────────────

/** `ShellRunOptions` as `SandboxedShell.run` takes it; `streams` is not supported and ignored. */
export interface SandboxedRunOptions {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: unknown;
	filesystem?: ShellFilesystem;
	/** Pipe taps are not relayed out of the sandbox; ignored. */
	streams?: PipeStreams;
	trace?: SandboxRunTrace;
}

let nextShellId = 0;

/** Drops the host-side shell once its proxy is collected, matching the native kill-on-drop. */
const shellFinalizer = new FinalizationRegistry<{ host: Promise<SandboxHostConnection>; shell: number }>(
	({ host, shell }) => {
		void host.then(
			connection => connection.request({ op: "shell.dispose", shell }).catch(() => {}),
			() => {},
		);
	},
);

/** The `Shell` surface `bash-executor` uses, served by a shell inside a sandbox host. */
export class SandboxedShell {
	readonly #host: Promise<SandboxHostConnection>;
	readonly #id = ++nextShellId;
	readonly #created: Promise<unknown>;
	#pids: number[] = [];
	#running: Promise<unknown> | undefined;
	/** Abort state of the in-flight run; `abort()` may land before the host even started. */
	#runAbort = { requested: false };
	#connection: SandboxHostConnection | undefined;
	#unusable = false;

	constructor(host: Promise<SandboxHostConnection>, init: { options: HostShellOptions } | { from: SandboxedShell }) {
		this.#host = host;
		const shell = this.#id;
		this.#created =
			"from" in init
				? init.from.#created.then(() =>
						host.then(connection => connection.request({ op: "shell.fork", shell, from: init.from.#id })),
					)
				: host.then(connection => connection.request({ op: "shell.create", shell, options: init.options }));
		host.then(
			connection => {
				this.#connection = connection;
			},
			() => {
				this.#unusable = true;
			},
		);
		// Surfaced by the first call that awaits it.
		this.#created.catch(() => {
			this.#unusable = true;
		});
		shellFinalizer.register(this, { host, shell });
	}

	/** True once this shell can never run again: its host failed to start, died, or was retired. */
	get closed(): boolean {
		return this.#unusable || this.#connection?.closed === true;
	}

	fork(): SandboxedShell {
		return new SandboxedShell(this.#host, { from: this });
	}

	run(options: SandboxedRunOptions, onChunk?: (error: Error | null, chunk: string) => void): Promise<ShellRunResult> {
		const abort = { requested: false };
		this.#runAbort = abort;
		const running = this.#run(options, abort, onChunk);
		this.#running = running;
		void running
			.finally(() => {
				if (this.#running === running) this.#running = undefined;
				this.#pids = [];
			})
			.catch(() => {});
		return running;
	}

	async #run(
		options: SandboxedRunOptions,
		abort: { requested: boolean },
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<ShellRunResult> {
		await this.#created;
		const connection = await this.#host;
		const signal = options.signal instanceof AbortSignal ? options.signal : undefined;
		// Cancelled while the host was starting: the command never runs.
		if (abort.requested || signal?.aborted) return { exitCode: undefined, cancelled: true, timedOut: false };
		const onAbort = (): void => void this.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await connection.request(
				{
					op: "shell.run",
					shell: this.#id,
					run: { command: options.command, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs },
					trace: options.trace !== undefined,
					fs: options.filesystem ? { nativeLocalPaths: options.filesystem.nativeLocalPaths } : null,
				},
				{
					onChunk: onChunk ? chunk => onChunk(null, chunk) : undefined,
					trace: options.trace,
					filesystem: options.filesystem,
					onPids: pids => {
						this.#pids = pids;
					},
				},
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/**
	 * Aborts the running command. A host that has not settled the run (or, idle, answered the
	 * abort) within {@link ABORT_SETTLE_GRACE_MS} is wedged and gets killed.
	 */
	async abort(): Promise<void> {
		const running = this.#running;
		if (running) this.#runAbort.requested = true;
		const connection = await this.#host.catch(() => undefined);
		if (!connection) return;
		const aborted = connection.request({ op: "shell.abort", shell: this.#id });
		// The reply only matters as the idle case's liveness signal below.
		aborted.catch(() => {});
		const grace = Promise.withResolvers<false>();
		const timer = setTimeout(() => grace.resolve(false), ABORT_SETTLE_GRACE_MS);
		const settled = await Promise.race([
			(running ?? aborted).then(
				() => true,
				() => true,
			),
			grace.promise,
		]);
		clearTimeout(timer);
		if (!settled) connection.kill("Sandbox host did not stop the aborted command; killed");
	}

	/** Live pids of the in-flight run as last reported by the host; empty when idle. */
	pids(): number[] {
		return this.#pids;
	}

	async liveBackgroundJobCount(): Promise<number> {
		await this.#created;
		const connection = await this.#host;
		return connection.request({ op: "shell.jobs", shell: this.#id });
	}
}

/** Creates the sandboxed shells and traces of one `executeBash` call. */
export interface SandboxShellFactory {
	create(options: HostShellOptions): SandboxedShell;
	trace(): SandboxRunTrace;
}

/** Shells served by the pooled host of `scope` under `runtime`. */
export function sandboxShellFactory(runtime: SandboxRuntime, scope: SandboxHostScope): SandboxShellFactory {
	return {
		create: options => new SandboxedShell(acquireHost(runtime, scope), { options }),
		trace: () => new SandboxRunTrace(),
	};
}

// ── PTY ──────────────────────────────────────────────────────────────────────

let nextPtyId = 0;

/**
 * The `PtySession` surface `tools/bash-interactive.ts` uses, relayed from a PtySession inside a
 * dedicated sandbox host that exits with the command. Input sent before the PTY started is
 * delivered once it has.
 */
export class SandboxedPtySession {
	readonly #runtime: SandboxRuntime;
	readonly #hostCwd: string;
	readonly #id = ++nextPtyId;
	#connection: SandboxHostConnection | undefined;
	#started = false;
	#killed = false;
	#queued: Notification[] = [];

	constructor(runtime: SandboxRuntime, options: { cwd: string }) {
		this.#runtime = runtime;
		this.#hostCwd = options.cwd;
	}

	async start(
		options: PtyStartOptions,
		onChunk?: (error: Error | null, chunk: string) => void,
	): Promise<PtyRunResult> {
		const { signal: rawSignal, ...start } = options;
		const signal = rawSignal instanceof AbortSignal ? rawSignal : undefined;
		const connection = await startSandboxHost(this.#runtime, { cwd: this.#hostCwd });
		this.#connection = connection;
		const exit = Promise.withResolvers<PtyRunResult>();
		// Awaited only once the PTY started; an early return or a failed start must not leave it unhandled.
		exit.promise.catch(() => {});
		connection.attachPty(this.#id, {
			onData: data => onChunk?.(null, data),
			onExit: (result, error) => (error ? exit.reject(new Error(error)) : exit.resolve(result)),
			onFail: exit.reject,
		});
		const onAbort = (): void => this.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (this.#killed || signal?.aborted) {
				return { exitCode: undefined, cancelled: true, timedOut: false };
			}
			await connection.request({ op: "pty.start", pty: this.#id, start: start satisfies HostPtyStart });
			this.#started = true;
			for (const message of this.#queued) connection.notify(message);
			this.#queued = [];
			if (this.#killed) void connection.request({ op: "pty.kill", pty: this.#id }).catch(() => {});
			return await exit.promise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			// The host is this command's alone: ending it also ends anything the command left behind.
			connection.kill("Sandboxed PTY session ended");
		}
	}

	write(data: string): void {
		this.#send({ op: "pty.write", pty: this.#id, data });
	}

	resize(cols: number, rows: number): void {
		this.#send({ op: "pty.resize", pty: this.#id, cols, rows });
	}

	kill(): void {
		this.#killed = true;
		if (this.#started) void this.#connection?.request({ op: "pty.kill", pty: this.#id }).catch(() => {});
	}

	#send(message: Notification): void {
		if (this.#started && this.#connection) this.#connection.notify(message);
		else this.#queued.push(message);
	}
}

// ── Smoke probe ──────────────────────────────────────────────────────────────

/**
 * `omp --smoke-test` probe: where a backend exists, starts the host contained (network denied),
 * runs `echo` through it, and checks that a write outside the workspace is refused. Where none
 * exists it reports why and passes; that is the expected state of hosts without one.
 */
export async function smokeTestSandboxHost(): Promise<void> {
	const support = sandboxSupport();
	if (!support.supported) {
		process.stdout.write(`smoke-test: sandbox unavailable (${support.reason ?? "no backend"}); probe skipped\n`);
		return;
	}
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sandbox-smoke-")));
	const runtime = await SandboxRuntime.for(workspace);
	let connection: SandboxHostConnection | undefined;
	let outsideDir: string | undefined;
	try {
		outsideDir = makeEscapeProbeDir(runtime.effectivePolicy().readwritePaths);
		connection = await startSandboxHost(runtime, { cwd: workspace, network: "deny" });
		const shell = new SandboxedShell(Promise.resolve(connection), { options: {} });
		let output = "";
		const echoed = await shell.run(
			{ command: "echo sandbox-ok", cwd: workspace, timeoutMs: SMOKE_RUN_TIMEOUT_MS },
			(error, chunk) => {
				if (!error) output += chunk;
			},
		);
		if (echoed.exitCode !== 0 || output !== "sandbox-ok\n") {
			throw new Error(`sandbox smoke failed: echo exited ${echoed.exitCode} with ${JSON.stringify(output)}`);
		}
		if (outsideDir === undefined) {
			process.stdout.write("smoke-test: sandbox escape check skipped (no directory outside the writable roots)\n");
		} else {
			const target = path.join(outsideDir, "escaped.txt");
			const escaped = await shell.run({
				command: `echo x > ${quotePosixArgv([target])}`,
				cwd: workspace,
				timeoutMs: SMOKE_RUN_TIMEOUT_MS,
			});
			if (escaped.exitCode === 0 || escaped.timedOut || fs.existsSync(target)) {
				throw new Error(`sandbox smoke failed: a write outside the writable roots succeeded (${target})`);
			}
		}
		process.stdout.write(`smoke-test: sandbox ok (${support.backend ?? "unknown"})\n`);
	} finally {
		connection?.kill("smoke test done");
		await runtime.dispose();
		if (outsideDir !== undefined) fs.rmSync(outsideDir, { recursive: true, force: true });
		fs.rmSync(workspace, { recursive: true, force: true });
	}
}

/** Per-run deadline of the smoke probe's commands. */
const SMOKE_RUN_TIMEOUT_MS = 30_000;

/**
 * A fresh directory the parent can write but the contained host must not: under the first of
 * home and the working directory that lies outside every writable root. `undefined` when neither does
 * (CI may put both under the temp dir).
 */
function makeEscapeProbeDir(writable: readonly string[]): string | undefined {
	for (const base of [os.homedir(), process.cwd()]) {
		let real: string;
		try {
			real = fs.realpathSync(base);
		} catch {
			continue;
		}
		if (writable.some(root => isWithin(real, root, process.platform))) continue;
		try {
			return fs.mkdtempSync(path.join(real, ".omp-sandbox-smoke-"));
		} catch {
			// Not writable by the parent either; try the next base.
		}
	}
	return undefined;
}
