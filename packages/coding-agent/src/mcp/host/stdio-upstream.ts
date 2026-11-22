/**
 * Subprocess upstream of the MCP host: JSON-RPC 2.0 as newline-delimited JSON
 * on a {@link ManagedChild}'s stdin/stdout.
 *
 * The child is spawned through the host's `spawn`, so in the daemon its pipes
 * are raw fds that survive a re-exec; {@link StdioUpstream.adopt} continues
 * such a child from a {@link StdioUpstreamState}. Nothing is read from the
 * host's own environment or working directory: the command is resolved
 * against the spec's.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { ChildExit, ChildSpawn, ManagedChild, ManagedChildState } from "../../daemon/module";
import { createMCPJsonRpcError, MCPTransportError, normalizeMCPTransportError } from "../errors";
import { routeProgressNotification, withProgressToken } from "../progress";
import type { JsonRpcError, MCPRequestOptions, MCPTransport } from "../types";
import { toJsonRpcError } from "../types";
import {
	encodeJsonLine,
	JsonLineDecoder,
	MCP_STDERR_TAIL_BYTES,
	type McpStdioSpec,
	type McpUpstreamExit,
} from "./contract";

/** Inputs that decide how a stdio server's command is launched. */
export interface ResolveStdioSpawnOptions {
	/** Directory relative commands and the Windows lookup resolve against. */
	cwd: string;
	/** Environment the lookup reads `PATH`, `PATHEXT` and `COMSPEC` from. */
	env: Record<string, string | undefined>;
	/** Defaults to the host's platform. */
	platform?: NodeJS.Platform;
	signal?: AbortSignal;
}

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_BATCH_EXTENSIONS: Record<string, true> = { ".bat": true, ".cmd": true };

function getCaseInsensitiveEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) return direct;
	const normalized = name.toLowerCase();
	for (const key in env) {
		if (key.toLowerCase() === normalized) return env[key];
	}
	return undefined;
}

function getWindowsPathExt(env: Record<string, string | undefined>): string[] {
	const raw = getCaseInsensitiveEnv(env, "PATHEXT");
	if (!raw) return DEFAULT_WINDOWS_PATHEXT;
	const extensions: string[] = [];
	for (const part of raw.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		extensions.push(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
	}
	return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATHEXT;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function hasPathSegment(command: string): boolean {
	return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function hasExecutableExtension(command: string, extensions: string[]): boolean {
	const ext = path.extname(command).toLowerCase();
	if (!ext) return false;
	return extensions.some(candidate => candidate.toLowerCase() === ext);
}

async function resolveWindowsCommandPath(
	command: string,
	cwd: string,
	env: Record<string, string | undefined>,
	signal?: AbortSignal,
): Promise<string | null> {
	const extensions = getWindowsPathExt(env);
	const hasExt = hasExecutableExtension(command, extensions);
	const candidates = hasExt ? [command] : extensions.map(ext => `${command}${ext}`);

	if (hasPathSegment(command)) {
		for (const candidate of candidates) {
			signal?.throwIfAborted();
			const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
			if (await fileExists(resolved)) return resolved;
		}
		return hasExt ? command : null;
	}

	// Match cmd.exe's lookup order for an unqualified name: current directory
	// first, then PATH. Skipping cwd would launch a global shim instead of a
	// project-local one with the same name.
	const searchDirs = [cwd];
	const pathValue = getCaseInsensitiveEnv(env, "PATH");
	if (pathValue) {
		for (const dir of pathValue.split(";")) {
			if (dir) searchDirs.push(dir);
		}
	}
	for (const dir of searchDirs) {
		for (const candidate of candidates) {
			signal?.throwIfAborted();
			const resolved = path.join(dir, candidate);
			if (await fileExists(resolved)) return resolved;
		}
	}
	return hasExt ? command : null;
}

function resolveWindowsShimPath(value: string, shimDir: string): string | null {
	const match = /^%dp0%[\\/]*(.*)$/i.exec(value);
	if (!match) return null;
	const suffix = match[1];
	if (!suffix) return shimDir;
	return path.join(shimDir, ...suffix.split(/[\\/]+/).filter(Boolean));
}

async function resolveWindowsNpmShimCommand(
	command: string,
	args: readonly string[],
	cwd: string,
): Promise<string[] | null> {
	if (!isWindowsBatchCommand(command)) return null;
	if (!hasPathSegment(command)) return null;
	const commandPath = path.resolve(cwd, command);
	const commandName = path
		.basename(commandPath)
		.replace(/\.cmd$/i, "")
		.toLowerCase();
	if (commandName === "npx") return null;

	let content: string;
	try {
		content = await Bun.file(commandPath).text();
	} catch {
		return null;
	}

	// cmd-shim emits the same invocation line for every interpreter; only
	// bypass cmd.exe when the shim's fallback interpreter is actually node.
	// The IF EXIST branch assigns a %dp0%-prefixed value, so requiring a
	// non-%-leading SET value picks the bare PATH-fallback program name.
	const prog = /SET\s+"_prog=([^%"][^"]*)"/i.exec(content)?.[1];
	if (
		!prog ||
		path
			.basename(prog)
			.replace(/\.exe$/i, "")
			.toLowerCase() !== "node"
	)
		return null;

	const rawTarget = /"%_prog%"\s+"([^"]+)"\s+%\*/i.exec(content)?.[1];
	if (!rawTarget) return null;

	const target = resolveWindowsShimPath(rawTarget, path.dirname(commandPath));
	if (!target) return null;

	const siblingNode = path.join(path.dirname(commandPath), "node.exe");
	const nodeCommand = (await fileExists(siblingNode)) ? siblingNode : "node";
	return [nodeCommand, target, ...args];
}

function isWindowsBatchCommand(command: string): boolean {
	return Object.hasOwn(WINDOWS_BATCH_EXTENSIONS, path.extname(command).toLowerCase());
}

/**
 * Resolve the argv that launches a stdio server's `command`.
 *
 * Elsewhere than Windows this is the command and its arguments as given. On
 * Windows `CreateProcess` only ever appends `.exe`, so the command is looked
 * up the way `cmd.exe` would (cwd, then `PATH`, trying `PATHEXT`) and replaced
 * by the full path found; an npm shim whose interpreter is node is replaced by
 * the node invocation it wraps. A `.cmd`/`.bat` path is passed on as such: the
 * spawner applies the cmd.exe-safe argument escaping for batch files. A name
 * the lookup cannot pin down is passed as given and fails at spawn.
 *
 * @throws when a batch command or one of its arguments contains NUL, CR or LF (they truncate a `cmd.exe` command line), or `options.signal` aborts during the lookup.
 */
export async function resolveStdioSpawnCommand(
	command: string,
	args: readonly string[],
	options: ResolveStdioSpawnOptions,
): Promise<string[]> {
	if ((options.platform ?? process.platform) !== "win32") return [command, ...args];

	const resolved = (await resolveWindowsCommandPath(command, options.cwd, options.env, options.signal)) ?? command;
	const npmShimCommand = await resolveWindowsNpmShimCommand(resolved, args, options.cwd);
	if (npmShimCommand) return npmShimCommand;
	if (isWindowsBatchCommand(resolved)) {
		for (const token of [resolved, ...args]) {
			if (/[\0\r\n]/.test(token)) {
				throw new Error("Windows batch MCP command and arguments cannot contain NUL, CR, or LF characters");
			}
		}
	}
	return [resolved, ...args];
}

/** The `error` member of a JSON-RPC response; undefined unless it has a numeric code and a string message. */
export function jsonRpcErrorOf(value: unknown): JsonRpcError | undefined {
	if (!isRecord(value) || typeof value.code !== "number" || typeof value.message !== "string") return undefined;
	return { code: value.code, message: value.message, data: value.data };
}

/** What {@link StdioUpstream.adopt} needs besides the child to continue a stream across a daemon re-exec. */
export interface StdioUpstreamState {
	/** Stdout text received after the last complete line. */
	remainder: string;
	/**
	 * Last integer request id handed out. A request's progress token is its
	 * id, so this is also the high-water mark that keeps tokens unique after
	 * {@link StdioUpstream.adopt}.
	 */
	lastId: number;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	onProgress?: MCPRequestOptions["onProgress"];
}

/** How long each shutdown step (stdin closed, then SIGTERM) gets before the next one. */
const SHUTDOWN_STEP_MS = 1_000;

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted");
}

function notConnected(): MCPTransportError {
	return new MCPTransportError({
		transport: "stdio",
		stage: "connect",
		failure: "closed",
		message: "Transport not connected",
		retryable: true,
	});
}

/**
 * One MCP server subprocess, either era. Install the event handlers, then
 * {@link connect} (spawn) or {@link adopt} (continue a surviving child); the
 * child's output is dispatched from that point on.
 *
 * Requests have no deadline here: a caller bounds one with its `signal`, and
 * aborting a written request tells the server with `notifications/cancelled`.
 */
export class StdioUpstream implements MCPTransport {
	readonly #spec: McpStdioSpec;
	readonly #pending = new Map<string | number, PendingRequest>();
	readonly #exit = Promise.withResolvers<McpUpstreamExit>();
	#child: ManagedChild | undefined;
	#decoder = new JsonLineDecoder();
	#lastId = 0;
	#stderr: Buffer = Buffer.alloc(0);
	#connected = false;
	#closing: Promise<void> | undefined;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(spec: McpStdioSpec) {
		this.#spec = spec;
	}

	get connected(): boolean {
		return this.#connected;
	}

	/** Pid of the child's main process; undefined before {@link connect} or {@link adopt}. */
	get pid(): number | undefined {
		return this.#child?.pid;
	}

	/** Settles once a started child is gone, with its exit status and stderr tail. Never rejects. */
	get exited(): Promise<McpUpstreamExit> {
		return this.#exit.promise;
	}

	/** The last {@link MCP_STDERR_TAIL_BYTES} bytes the child wrote to stderr. */
	stderrTail(): string {
		return this.#stderr.toString("utf8");
	}

	/**
	 * Spawn the server with `spawn` and start dispatching its output.
	 *
	 * @throws MCPTransportError when the command cannot be resolved or spawned; the abort reason when `signal` aborts first.
	 */
	async connect(spawn: (spec: ChildSpawn) => ManagedChild, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (this.#child) return;
		const spec = this.#spec;
		let child: ManagedChild;
		try {
			const argv = await resolveStdioSpawnCommand(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.spawnEnv,
				signal,
			});
			// The lookup may outlast the caller's patience, especially on Windows PATHs.
			signal?.throwIfAborted();
			child = spawn({ application: argv[0], args: argv.slice(1), env: spec.spawnEnv, cwd: spec.cwd });
		} catch (error) {
			if (signal?.aborted) throw abortReason(signal);
			throw normalizeMCPTransportError(error, { transport: "stdio", stage: "connect" });
		}
		this.#attach(child);
	}

	/** Continue a child that survived a daemon re-exec, from the state {@link snapshot} captured. */
	adopt(child: ManagedChild, state: StdioUpstreamState): void {
		this.#decoder = new JsonLineDecoder(state.remainder);
		this.#lastId = state.lastId;
		this.#attach(child);
	}

	/**
	 * The child handle and stream position for {@link adopt}; undefined when no
	 * child is running. Only consistent while the child's output is paused, as
	 * it is when the daemon snapshots its units.
	 */
	snapshot(): { child: ManagedChildState; state: StdioUpstreamState } | undefined {
		if (!this.#child || !this.#connected) return undefined;
		return {
			child: this.#child.state(),
			state: { remainder: this.#decoder.remainder(), lastId: this.#lastId },
		};
	}

	#attach(child: ManagedChild): void {
		this.#child = child;
		this.#connected = true;
		void child.exited.then(exit => this.#onExit(exit));
		child.onStderr(chunk => {
			const joined = Buffer.concat([this.#stderr, chunk]);
			this.#stderr = joined.subarray(Math.max(0, joined.length - MCP_STDERR_TAIL_BYTES));
		});
		child.onStdout(chunk => {
			for (const line of this.#decoder.push(chunk)) this.#onLine(line);
		});
	}

	#onLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			// Servers do print banners on stdout; a line that is not JSON is not a message.
			logger.debug("MCP stdio upstream wrote a non-JSON line", { command: this.#spec.command });
			return;
		}
		if (Array.isArray(message)) {
			for (const entry of message) this.#onMessage(entry);
		} else {
			this.#onMessage(message);
		}
	}

	#onMessage(message: unknown): void {
		if (!isRecord(message)) return;
		const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
		if (typeof message.method === "string") {
			if (id !== undefined) {
				void this.#answer(id, message.method, message.params);
				return;
			}
			routeProgressNotification(message.method, message.params, token => this.#pending.get(token)?.onProgress);
			try {
				this.onNotification?.(message.method, message.params);
			} catch (error) {
				logger.debug("MCP stdio notification handler failed", { method: message.method, error });
			}
			return;
		}
		if (id === undefined) return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		if (message.error === undefined) {
			pending.resolve(message.result);
			return;
		}
		const error = jsonRpcErrorOf(message.error);
		pending.reject(
			error
				? createMCPJsonRpcError("stdio", error)
				: new MCPTransportError({
						transport: "stdio",
						stage: "decode",
						failure: "malformed_response",
						message: "Malformed JSON-RPC error response",
						retryable: false,
					}),
		);
	}

	/**
	 * Answer a server-to-client request through `onRequest`. Only a
	 * handshake-era session installs that handler: a 2026-07-28 client must
	 * never write a JSON-RPC response, so without one the request is dropped.
	 */
	async #answer(id: string | number, method: string, params: unknown): Promise<void> {
		const onRequest = this.onRequest;
		if (!onRequest) {
			logger.debug("Ignored a server request on a modern MCP upstream", { method, command: this.#spec.command });
			return;
		}
		let response: Record<string, unknown>;
		try {
			response = { jsonrpc: "2.0", id, result: (await onRequest(method, params)) ?? {} };
		} catch (error) {
			response = { jsonrpc: "2.0", id, error: toJsonRpcError(error) };
		}
		// A dead child has no use for the response.
		if (this.#connected) this.#child?.write(encodeJsonLine(response));
	}

	#onExit(exit: ChildExit): void {
		this.#connected = false;
		const error = this.#closing
			? new MCPTransportError({
					transport: "stdio",
					stage: "receive",
					failure: "closed",
					message: "Transport closed",
					retryable: false,
				})
			: new MCPTransportError({
					transport: "stdio",
					stage: "receive",
					failure: "eof",
					message:
						exit.exitCode !== undefined
							? `MCP subprocess exited with code ${exit.exitCode} before responding`
							: exit.signal !== undefined
								? `MCP subprocess was killed by signal ${exit.signal} before responding`
								: "MCP subprocess closed stdout before responding",
					retryable: false,
					code: exit.exitCode ?? exit.signal,
				});
		// Every pending request was written to the child, so none may be replayed.
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#exit.resolve({ code: exit.exitCode, signal: exit.signal, stderr: this.stderrTail() });
		const onClose = this.onClose;
		this.onClose = undefined;
		try {
			onClose?.();
		} catch (closeError) {
			logger.debug("MCP stdio onClose callback failed", { error: closeError });
		}
	}

	#nextId(): string | number {
		return this.#spec.requestIdFormat === "string" ? Snowflake.next() : ++this.#lastId;
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		const child = this.#child;
		if (!this.#connected || !child || this.#closing) return Promise.reject(notConnected());
		const signal = options?.signal;
		if (signal?.aborted) return Promise.reject(abortReason(signal));

		const id = this.#nextId();
		options?.onRequestId?.(id);
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const settle = (): void => {
			this.#pending.delete(id);
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = (): void => {
			settle();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
			// `initialize` is the one request the handshake era forbids cancelling.
			if (method === "initialize" || !this.#connected) return;
			child.write(
				encodeJsonLine({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, reason: "Request cancelled by the client" },
				}),
			);
		};
		this.#pending.set(id, {
			onProgress: options?.onProgress,
			resolve: value => {
				settle();
				resolve(value as T);
			},
			reject: error => {
				settle();
				reject(error);
			},
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		// The child queues what the pipe cannot take yet; a child that died in
		// the meantime fails this request through its exit.
		child.write(
			encodeJsonLine({
				jsonrpc: "2.0",
				id,
				method,
				params: options?.onProgress ? withProgressToken(params, id) : (params ?? {}),
			}),
		);
		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#child || this.#closing) throw notConnected();
		this.#child.write(encodeJsonLine({ jsonrpc: "2.0", method, params: params ?? {} }));
	}

	/**
	 * Shut the child down in the specification's order: close its stdin, wait
	 * for it to exit, SIGTERM its process group, then SIGKILL. Resolved once
	 * the child is reaped; descendants a cleanly exited leader left behind are
	 * swept with one group SIGKILL. In-flight requests fail at once with a
	 * non-retryable `closed` error. Idempotent.
	 */
	close(): Promise<void> {
		this.#closing ??= this.#terminate();
		return this.#closing;
	}

	async #terminate(): Promise<void> {
		const child = this.#child;
		if (!child) return;
		const wasRunning = this.#connected;
		if (wasRunning) {
			const error = new MCPTransportError({
				transport: "stdio",
				stage: "receive",
				failure: "closed",
				message: "Transport closed",
				retryable: false,
			});
			for (const pending of this.#pending.values()) pending.reject(error);
			child.closeInput();
		}
		const terminate = setTimeout(() => child.kill(), SHUTDOWN_STEP_MS);
		const escalate = setTimeout(() => child.kill("SIGKILL"), 2 * SHUTDOWN_STEP_MS);
		try {
			await this.#exit.promise;
		} finally {
			clearTimeout(terminate);
			clearTimeout(escalate);
		}
		// A child that was gone before this call may have had its group id reused since.
		if (!wasRunning || process.platform === "win32") return;
		try {
			// The reaped child no longer takes signals through its handle; its group may still hold descendants.
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// Group already empty.
		}
	}
}
