/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, readJsonl, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { type Subprocess, spawn } from "bun";
import { hostHasInheritableConsole } from "../../eval/py/spawn-options";
import {
	buildModernRequestParams,
	getMCPNotificationSubscriptionId,
	hasMCPSubscriptionNotifications,
	isMCPSubscriptionNotificationAcknowledged,
	type JsonRpcError,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type MCPListenHandle,
	type MCPListenOptions,
	MCPNotificationMethods,
	type MCPRequestId,
	type MCPRequestOptions,
	type MCPStdioServerConfig,
	type MCPSubscriptionNotificationFilter,
	MCPSubscriptionProtocolError,
	type MCPTransport,
	type MCPTransportProtocolConfiguration,
	toJsonRpcError,
	validateMCPSubscriptionAcknowledgement,
} from "../../mcp/types";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

/** Subprocess argv and platform-derived spawn flags for an MCP stdio server. */
export interface StdioSpawnCommand {
	cmd: string[];
	/**
	 * Hide the Windows console window for the direct child.
	 *
	 * Windows uses this only when the OMP host has no console to share. When
	 * the host is running inside a terminal, `windowsHide: true` maps to
	 * `CREATE_NO_WINDOW`, which strips that inheritable console from hidden
	 * `cmd.exe` / PowerShell wrapper chains. Their console grandchildren then
	 * allocate fresh visible conhost windows during startup or reconnects
	 * (#3567).
	 */
	windowsHide?: boolean;
	/**
	 * Run the subprocess in its own session.
	 *
	 * POSIX: `true`. Detach → `setsid`, so the MCP process tree has no
	 * controlling terminal and terminal job-control signals (Ctrl+Z SIGTSTP,
	 * background-read SIGTTIN) cannot stop stdio servers such as
	 * `chrome-devtools-mcp` and leave our read loop blocked on silent pipes.
	 *
	 * Windows: `false`. There is no SIGTSTP/SIGTTIN to escape, and Windows
	 * wrapper chains must stay in the OMP console session so nested console
	 * grandchildren keep stdout routed through our pipe (#3544).
	 */
	detached: boolean;
}

/** Inputs used to resolve platform-specific stdio spawn behavior. */
export interface ResolveStdioSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	hostHasInheritableConsole?: boolean;
	platform?: NodeJS.Platform;
}

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

function getCaseInsensitiveEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) return direct;
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalized) return value;
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
): Promise<string | null> {
	const extensions = getWindowsPathExt(env);
	const hasExt = hasExecutableExtension(command, extensions);
	const candidates = hasExt ? [command] : extensions.map(ext => `${command}${ext}`);

	if (hasPathSegment(command)) {
		for (const candidate of candidates) {
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

function extractWindowsNpmShimTarget(content: string): string | null {
	const match = /"%_prog%"\s+"([^"]+)"\s+%\*/i.exec(content);
	return match?.[1] ?? null;
}

/**
 * Extract the shim's PATH-fallback interpreter (`SET "_prog=node"`). The
 * `IF EXIST` branch assigns a `%dp0%`-prefixed value, so requiring a
 * non-`%`-leading value picks the bare program name.
 */
function extractWindowsNpmShimProg(content: string): string | null {
	const match = /SET\s+"_prog=([^%"][^"]*)"/i.exec(content);
	return match?.[1] ?? null;
}

async function resolveWindowsNpmShimCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	windowsHide: boolean,
): Promise<StdioSpawnCommand | null> {
	if (!isWindowsBatchCommand(command)) return null;
	if (!hasPathSegment(command)) return null;
	const commandPath = path.resolve(cwd, command);

	let content: string;
	try {
		content = await Bun.file(commandPath).text();
	} catch {
		return null;
	}

	// cmd-shim emits the same invocation line for every interpreter; only
	// bypass cmd.exe when the shim's fallback interpreter is actually node.
	const prog = extractWindowsNpmShimProg(content);
	if (
		!prog ||
		path
			.basename(prog)
			.replace(/\.exe$/i, "")
			.toLowerCase() !== "node"
	)
		return null;

	const rawTarget = extractWindowsNpmShimTarget(content);
	if (!rawTarget) return null;

	const target = resolveWindowsShimPath(rawTarget, path.dirname(commandPath));
	if (!target) return null;

	const siblingNode = path.join(path.dirname(commandPath), "node.exe");
	const nodeCommand = (await fileExists(siblingNode)) ? siblingNode : "node";
	return {
		cmd: [nodeCommand, target, ...args],
		windowsHide,
		detached: false,
	};
}

function quoteCmdArg(value: string): string {
	if (value.length === 0) return '""';
	let result = '"';
	for (const char of value) {
		if (char === '"') {
			result += '^"';
		} else if (char === "^") {
			result += "^^";
		} else if (char === "%") {
			result += "^%";
		} else {
			result += char;
		}
	}
	return `${result}"`;
}

function isWindowsBatchCommand(command: string): boolean {
	return WINDOWS_BATCH_EXTENSIONS.has(path.extname(command).toLowerCase());
}

function resolveComSpec(env: Record<string, string | undefined>): string {
	const comspec = getCaseInsensitiveEnv(env, "COMSPEC");
	return comspec && comspec.length > 0 ? comspec : "cmd.exe";
}

/** `cmd /s /c` strips one outer quote pair; keep inner argv quotes intact. */
function buildCmdExeCommand(command: string, args: readonly string[]): string {
	const quotedCommand = [command, ...args].map(quoteCmdArg).join(" ");
	return `"${quotedCommand}"`;
}

/**
 * Resolve the subprocess argv used to launch an MCP stdio server.
 *
 * On Windows, our PATH/PATHEXT walk may return `null` for a bare command
 * (e.g. `npx`) — `Bun.env.PATH` empty under a restricted parent process,
 * UNC/network mounts that reject `fs.access`, locked-down shells. The
 * legacy fallback handed `Bun.spawn` the bare name, but `CreateProcess`
 * only appends `.exe` for extensionless names — `.cmd`/`.bat` are never
 * tried, so `npx` (which exists only as `npx.cmd` on Windows) crashes the
 * subprocess immediately. When the resolver can't pin the command down,
 * route through `cmd.exe /d /s /c` so Windows's own PATHEXT lookup runs.
 */
export async function resolveStdioSpawnCommand(
	config: MCPStdioServerConfig,
	options: ResolveStdioSpawnOptions,
): Promise<StdioSpawnCommand> {
	const args = config.args ?? [];
	if (options.platform !== "win32") return { cmd: [config.command, ...args], detached: true };

	const windowsHide = options.hostHasInheritableConsole === undefined ? true : !options.hostHasInheritableConsole;
	const resolved = await resolveWindowsCommandPath(config.command, options.cwd, options.env);
	const resolvedCommand = resolved ?? config.command;
	const npmShimCommand = await resolveWindowsNpmShimCommand(resolvedCommand, args, options.cwd, windowsHide);
	if (npmShimCommand) return npmShimCommand;

	// Direct-spawn only when we resolved to a concrete file AND its extension
	// is not a batch script. Everything else (resolved .cmd/.bat, or an
	// unresolved extensionless command) goes through cmd.exe so PATHEXT runs.
	// Windows stdio servers stay attached so wrapper grandchildren inherit the
	// same console session. Only hide the child when OMP itself has no console
	// to share; CREATE_NO_WINDOW breaks console inheritance for nested wrappers.
	const detached = false;
	const needsCmdExe = resolved === null || isWindowsBatchCommand(resolvedCommand);
	if (!needsCmdExe) return { cmd: [resolvedCommand, ...args], windowsHide, detached };

	return {
		cmd: [resolveComSpec(options.env), "/d", "/s", "/c", buildCmdExeCommand(resolvedCommand, args)],
		windowsHide,
		detached,
	};
}

/** Minimal write surface of `Subprocess.stdin` we need for framed sends. */
interface FrameSink {
	write(chunk: string): unknown;
	flush(): unknown;
}

/** Narrow a value to a thenable so a rejection handler can be attached. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value != null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/**
 * Write a newline-delimited JSON-RPC frame to the subprocess's stdin sink,
 * swallowing both synchronous throws and asynchronous rejections so the caller
 * can decide how to react.
 *
 * Bun's `FileSink.write()`/`flush()` can fail two ways once the read end of the
 * pipe has been closed by a subprocess that exited between read-loop ticks:
 *   - a synchronous throw (most reliably observed on Windows), and
 *   - a *rejected Promise* returned from `write()`/`flush()`, i.e. the EPIPE is
 *     surfaced asynchronously (note the `processTicksAndRejections` frame in the
 *     stack traces on #1710 and the follow-up report).
 *
 * A sibling `async` method's `try/catch` only catches the synchronous case; an
 * un-awaited rejected Promise escapes as a fatal unhandled rejection. So we both
 * catch the throw and neutralize any returned promise's rejection.
 *
 * Returns `true` when the frame was accepted synchronously, `false` when the
 * sink threw — callers signal transport closure on `false`. An asynchronous
 * failure cannot be reflected in the return value; it is neutralized here and
 * the dead transport is detected by the read loop / request timeout instead.
 */
export function writeFrame(stdin: FrameSink, frame: string): boolean {
	try {
		const wrote = stdin.write(frame);
		const flushed = stdin.flush();
		if (isThenable(wrote)) wrote.then(undefined, () => {});
		if (isThenable(flushed)) flushed.then(undefined, () => {});
		return true;
	} catch {
		return false;
	}
}
interface MCPStdioListenerState {
	handle: MCPListenHandle;
	requestedNotifications: MCPSubscriptionNotificationFilter;
	acknowledgment: ReturnType<typeof Promise.withResolvers<MCPSubscriptionNotificationFilter>>;
	completion: ReturnType<typeof Promise.withResolvers<void>>;
	stdin: FrameSink;
	onNotification?: (method: string, params: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	writePromise: Promise<void>;
	requestSent: boolean;
	cancellationSent: boolean;
	cancelled: boolean;
	acknowledged: boolean;
	settled: boolean;
}

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;
	#protocolConfiguration: MCPTransportProtocolConfiguration | undefined;
	#listeners = new Map<MCPRequestId, MCPStdioListenerState>();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	configureProtocol(configuration: MCPTransportProtocolConfiguration): void {
		this.#protocolConfiguration = configuration;
	}

	getProtocolConfiguration(): MCPTransportProtocolConfiguration | undefined {
		return this.#protocolConfiguration;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;

		const env = {
			...Bun.env,
			...this.config.env,
		};
		const cwd = this.config.cwd ?? getProjectDir();
		const spawnCommand = await resolveStdioSpawnCommand(this.config, {
			cwd,
			env,
			platform: process.platform,
			hostHasInheritableConsole: hostHasInheritableConsole(),
		});

		// Platform-derived session and console-window handling come from
		// `resolveStdioSpawnCommand`: POSIX detaches into its own session to
		// escape terminal job-control signals (SIGTSTP, SIGTTIN); Windows stays
		// attached, and only hides the child when the host has no console to
		// share. See `StdioSpawnCommand`.
		this.#process = spawn({
			cmd: spawnCommand.cmd,
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: spawnCommand.windowsHide,
			detached: spawnCommand.detached,
		});

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		// Initialization-based revisions permit server-to-client requests. The
		// modern protocol represents interaction through request results instead,
		// so answering a server-originated request would itself violate the wire
		// protocol. An unconfigured transport remains legacy-compatible for
		// callers that construct StdioTransport directly.
		if ("method" in message && "id" in message && message.id != null) {
			const request = message as JsonRpcRequest;
			if (this.#protocolConfiguration?.era === "modern") {
				const error = new Error(`MCP protocol violation: modern server sent client request "${request.method}"`);
				try {
					this.onError?.(error);
				} catch {
					// A diagnostic callback must not break the stdout read loop.
				}
				return;
			}
			void this.#handleServerRequest(request);
			return;
		}

		// Responses complete ordinary requests or gracefully close listeners.
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const listener = this.#listeners.get(response.id);
			if (listener) {
				this.#handleListenerResponse(listener, response);
				return;
			}
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Subscription notifications are demultiplexed by their listen request ID.
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			if (notification.method === MCPNotificationMethods.CANCELLED) {
				const requestId =
					typeof notification.params === "object" &&
					notification.params !== null &&
					!Array.isArray(notification.params)
						? (notification.params as Record<string, unknown>).requestId
						: undefined;
				const listener =
					typeof requestId === "string" || typeof requestId === "number"
						? this.#listeners.get(requestId)
						: undefined;
				if (listener) {
					this.#settleListenerSuccess(listener);
					return;
				}
				return;
			}

			const subscriptionId = getMCPNotificationSubscriptionId(notification.params);
			if (subscriptionId !== undefined) {
				const listener = this.#listeners.get(subscriptionId);
				if (listener) this.#handleListenerNotification(listener, notification.method, notification.params);
				return;
			}
			if (notification.method === MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
				this.onError?.(
					new MCPSubscriptionProtocolError(
						"subscriptions/listen acknowledgment omitted io.modelcontextprotocol/subscriptionId",
					),
				);
				return;
			}
			this.onNotification?.(notification.method, notification.params);
		}
	}

	#cleanupListener(listener: MCPStdioListenerState): void {
		this.#listeners.delete(listener.handle.requestId);
		if (listener.signal && listener.onAbort) {
			listener.signal.removeEventListener("abort", listener.onAbort);
		}
	}

	async #sendListenerCancellation(listener: MCPStdioListenerState): Promise<void> {
		if (listener.cancellationSent || !listener.requestSent) return;
		if (!this.#connected || this.#process?.stdin !== listener.stdin) return;
		listener.cancellationSent = true;
		const notification = {
			jsonrpc: "2.0" as const,
			method: MCPNotificationMethods.CANCELLED,
			params: { requestId: listener.handle.requestId },
		};
		try {
			await listener.stdin.write(`${JSON.stringify(notification)}\n`);
			await listener.stdin.flush();
		} catch {
			// Advisory cancellation must not replace local listener failure.
		}
	}

	#settleListenerFailure(listener: MCPStdioListenerState, error: unknown): void {
		if (listener.settled) return;
		listener.settled = true;
		if ((listener.acknowledged || listener.requestSent) && !listener.cancellationSent) {
			listener.cancelled = true;
			void this.#sendListenerCancellation(listener);
		}
		this.#cleanupListener(listener);
		const failure = error instanceof Error ? error : new Error(String(error));
		if (!listener.acknowledged) listener.acknowledgment.reject(failure);
		listener.completion.reject(failure);
		try {
			this.onError?.(failure);
		} catch {
			// Diagnostic callbacks do not own the transport read loop.
		}
	}

	#settleListenerSuccess(listener: MCPStdioListenerState): void {
		if (listener.settled) return;
		listener.settled = true;
		this.#cleanupListener(listener);
		if (!listener.acknowledged) {
			listener.acknowledgment.reject(
				new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} ended before acknowledgment`,
				),
			);
		}
		listener.completion.resolve();
	}

	#handleListenerResponse(listener: MCPStdioListenerState, response: JsonRpcResponse): void {
		try {
			if (response.error) {
				throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
			}
			if (!listener.acknowledged) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} closed before acknowledgment`,
				);
			}
			const result = response.result;
			if (typeof result !== "object" || result === null || Array.isArray(result)) {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen closure result");
			}
			const closure = result as Record<string, unknown>;
			const metadata =
				typeof closure._meta === "object" && closure._meta !== null && !Array.isArray(closure._meta)
					? (closure._meta as Record<string, unknown>)
					: undefined;
			if (
				closure.resultType !== "complete" ||
				metadata?.["io.modelcontextprotocol/subscriptionId"] !== listener.handle.requestId
			) {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen graceful closure");
			}
			this.#settleListenerSuccess(listener);
		} catch (error) {
			this.#settleListenerFailure(listener, error);
		}
	}

	#handleListenerNotification(listener: MCPStdioListenerState, method: string, params: unknown): void {
		try {
			if (!listener.acknowledged) {
				if (method !== MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
					throw new MCPSubscriptionProtocolError(
						`subscriptions/listen ${listener.handle.requestId} received ${method} before acknowledgment`,
					);
				}
				const accepted = validateMCPSubscriptionAcknowledgement(listener.requestedNotifications, params);
				listener.acknowledged = true;
				listener.handle.acknowledgedNotifications = accepted;
				listener.acknowledgment.resolve(accepted);
				return;
			}
			if (method === MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} was acknowledged more than once`,
				);
			}
			if (
				!isMCPSubscriptionNotificationAcknowledged(listener.handle.acknowledgedNotifications ?? {}, method, params)
			) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} received unacknowledged notification ${method}`,
				);
			}
			try {
				listener.onNotification?.(method, params);
			} catch (error) {
				// Delivery has failed after the server accepted this listener, so
				// tell it to release only this request-scoped subscription. Mark
				// cancellation requested before settling: the server can respond
				// between stdin.write() and stdin.flush(), before requestSent is
				// recorded, and the write continuation will send it once framed.
				listener.cancelled = true;
				void this.#sendListenerCancellation(listener);
				this.#settleListenerFailure(listener, error);
			}
		} catch (error) {
			this.#settleListenerFailure(listener, error);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			this.#sendResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (this.#protocolConfiguration?.era === "modern") return;
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		// Silent on failure — a dead subprocess has no use for the response,
		// and the read loop will close the transport on EOF.
		writeFrame(this.#process.stdin, `${JSON.stringify(response)}\n`);
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		// Reject all pending requests
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();
		for (const listener of this.#listeners.values()) {
			this.#settleListenerFailure(listener, new Error("Transport closed"));
		}
		this.#listeners.clear();

		this.onClose?.();
	}

	async listen(
		params: { notifications: MCPSubscriptionNotificationFilter },
		options?: MCPListenOptions,
	): Promise<MCPListenHandle> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}
		const protocol = this.#protocolConfiguration;
		if (protocol?.era !== "modern" || protocol.phase !== "connected") {
			throw new Error("subscriptions/listen requires a connected modern MCP transport");
		}
		if (!hasMCPSubscriptionNotifications(params.notifications)) {
			throw new Error("subscriptions/listen requires at least one notification filter");
		}
		if (params.notifications.resourceSubscriptions?.some(uri => typeof uri !== "string" || uri.length === 0)) {
			throw new Error("subscriptions/listen resourceSubscriptions must contain non-empty strings");
		}
		if (options?.signal?.aborted) {
			throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
		}

		const requestedNotifications: MCPSubscriptionNotificationFilter = {
			...(params.notifications.toolsListChanged === true ? { toolsListChanged: true } : {}),
			...(params.notifications.promptsListChanged === true ? { promptsListChanged: true } : {}),
			...(params.notifications.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
			...(params.notifications.resourceSubscriptions
				? { resourceSubscriptions: [...new Set(params.notifications.resourceSubscriptions)] }
				: {}),
		};
		const requestId = Snowflake.next();
		const acknowledgment = Promise.withResolvers<MCPSubscriptionNotificationFilter>();
		const completion = Promise.withResolvers<void>();
		// A subprocess can answer during the same turn as the request write.
		// Mark lifecycle promises handled until the returned handle can be observed.
		void acknowledgment.promise.catch(() => {});
		void completion.promise.catch(() => {});
		const stdin = this.#process.stdin;
		let listener!: MCPStdioListenerState;

		const sendCancellation = (): Promise<void> => this.#sendListenerCancellation(listener);
		const cancel = async (): Promise<void> => {
			if (listener.settled) return;
			listener.cancelled = true;
			await listener.writePromise.catch(() => {});
			await sendCancellation();
			this.#settleListenerSuccess(listener);
		};
		const handle: MCPListenHandle = {
			requestId,
			requestedNotifications,
			acknowledged: acknowledgment.promise,
			completion: completion.promise,
			cancel,
		};
		listener = {
			handle,
			requestedNotifications,
			acknowledgment,
			completion,
			stdin,
			onNotification: options?.onNotification,
			signal: options?.signal,
			requestSent: false,
			cancellationSent: false,
			cancelled: false,
			acknowledged: false,
			settled: false,
			writePromise: Promise.resolve(),
		};
		if (options?.signal) {
			listener.onAbort = () => {
				void cancel();
			};
			options.signal.addEventListener("abort", listener.onAbort, { once: true });
			if (options.signal.aborted) {
				listener.onAbort();
			}
		}
		this.#listeners.set(requestId, listener);

		const request = {
			jsonrpc: "2.0" as const,
			id: requestId,
			method: "subscriptions/listen",
			params: buildModernRequestParams(
				{ notifications: requestedNotifications },
				{ version: protocol.version, clientCapabilities: protocol.clientCapabilities },
				options?.metadata,
				protocol.clientInfo,
			),
		};
		listener.writePromise = (async () => {
			try {
				await stdin.write(`${JSON.stringify(request)}\n`);
				await stdin.flush();
				listener.requestSent = true;
				if (listener.cancelled) await sendCancellation();
			} catch (error) {
				this.#settleListenerFailure(listener, error);
			}
		})();
		return handle;
	}
	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal;
		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};
		const stdin = this.#process.stdin;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		let requestSent = false;
		let cancellationRequested = false;
		let cancellationSent = false;

		const sendCancellationIfNeeded = () => {
			if (!cancellationRequested || cancellationSent || !requestSent) return;
			if (!this.#connected || this.#process?.stdin !== stdin) return;

			cancellationSent = true;
			const notification = {
				jsonrpc: "2.0" as const,
				method: "notifications/cancelled",
				params: { requestId: id },
			};
			// Cancellation is advisory and best-effort. A pipe that closes between
			// the liveness check and this write must not replace the local abort or
			// timeout result, nor may an asynchronous EPIPE escape unhandled.
			writeFrame(stdin, `${JSON.stringify(notification)}\n`);
		};

		const settle = (complete: () => void): boolean => {
			if (settled) return false;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
			complete();
			return true;
		};

		const onAbort = () => {
			if (settled) return;
			cancellationRequested = true;
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			settle(() => reject(reason));
			sendCancellationIfNeeded();
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
			}
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				settle(() => resolve(value as T));
			},
			reject: (error: Error) => {
				settle(() => reject(error));
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				if (settled) return;
				cancellationRequested = true;
				settle(() => reject(new Error(`Request timeout after ${timeout}ms`)));
				sendCancellationIfNeeded();
			}, timeout);
		}

		const message = `${JSON.stringify(request)}\n`;
		void (async () => {
			try {
				// Await both: Bun's FileSink can surface a broken pipe either as a
				// synchronous throw or as a rejected Promise.
				await stdin.write(message);
				await stdin.flush();
				requestSent = true;
				sendCancellationIfNeeded();
			} catch (error: unknown) {
				settle(() => reject(error instanceof Error ? error : new Error(String(error))));
			}
		})();

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		// Bun's FileSink can throw EPIPE synchronously on Windows when the
		// subprocess has exited between the last read-loop tick and this
		// write (e.g. an MCP server that dies after returning `initialize`
		// but before `notifications/initialized` is delivered). Tear the
		// transport down so any wired `onClose` (and reconnect machinery)
		// engages, then surface the failure to the caller so a write that
		// dropped on the floor is never silently treated as delivered —
		// `initializeConnection()` runs before the manager installs its
		// `onClose` handler, so a swallowed failure there would yield a
		// "connected" handle wrapping a dead transport. See #1710.
		if (!writeFrame(this.#process.stdin, `${JSON.stringify(notification)}\n`)) {
			this.#handleClose();
			throw new Error(`Transport closed while sending notification "${method}"`);
		}
	}

	async close(): Promise<void> {
		const listeners = [...this.#listeners.values()];
		for (const listener of listeners) {
			listener.cancelled = true;
			void this.#sendListenerCancellation(listener);
		}
		if (this.#connected) {
			this.#handleClose();
		}

		if (this.#process) {
			const proc = this.#process;
			this.#process = null;
			try {
				proc.stdin?.end?.();
			} catch {
				// Ignore stdin close errors
			}
			const exited = proc.exited;
			let timeoutId: NodeJS.Timeout | undefined;
			const timeoutPromise = new Promise<void>(resolve => {
				timeoutId = setTimeout(resolve, 2000);
			});
			try {
				await Promise.race([exited, timeoutPromise]);
			} catch {
				// Ignore exited rejection
			} finally {
				if (timeoutId) clearTimeout(timeoutId);
			}
			try {
				proc.kill();
			} catch {
				// Ignore kill errors
			}
		}

		if (this.#readLoop) {
			// Do not block/await the read loop as it can hang indefinitely in some environments
			this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
