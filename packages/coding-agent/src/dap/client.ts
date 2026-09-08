import * as fs from "node:fs/promises";
import { isEnoent, logger, ptree } from "@oh-my-pi/pi-utils";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import { MessageFramer } from "../jsonrpc/message-framing";
import { ToolAbortError } from "../tools/tool-errors";
import type {
	DapCapabilities,
	DapClientState,
	DapEventMessage,
	DapInitializeArguments,
	DapPendingRequest,
	DapRequestMessage,
	DapResolvedAdapter,
	DapResponseMessage,
} from "./types";

interface DapSpawnOptions {
	adapter: DapResolvedAdapter;
	cwd: string;
	/**
	 * Cap on how long the socket-mode helpers wait for the adapter to open its
	 * socket (unix) or dial back into our listener (TCP). Exposed for tests;
	 * production callers rely on the default.
	 *
	 * @internal
	 */
	socketReadyTimeoutMs?: number;
}

/** Minimal write interface shared by Bun.FileSink and Bun TCP sockets. */
interface DapWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | Promise<number> | undefined;
}

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Hard cap on a single message write. A wedged adapter stdin used to hang the
 * whole client forever; on hitting this cap the client disposes itself so the
 * next request fails fast instead of piling more work onto a broken adapter.
 */
const WRITE_MESSAGE_TIMEOUT_MS = 30_000;
/** Default wait for socket-mode adapters to become reachable. */
const SOCKET_READY_TIMEOUT_MS = 10_000;

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

export class DapClient {
	readonly adapter: DapResolvedAdapter;
	readonly cwd: string;
	readonly proc: DapClientState["proc"];
	/** TCP server port reused by child DAP sessions. */
	readonly port?: number;
	/** ReadableStream of DAP bytes — from proc.stdout (stdio) or a socket (socket mode). */
	readonly #readable: ReadableStream<Uint8Array>;
	/** Write sink — proc.stdin (stdio) or a socket (socket mode). */
	readonly #writeSink: DapWriteSink;
	/** Optional socket to close on dispose (socket mode only). */
	readonly #socket?: { end(): void };
	#requestSeq = 0;
	#pendingRequests = new Map<number, DapPendingRequest>();
	#messageBuffer: Buffer = Buffer.alloc(0);
	#isReading = false;
	#disposed = false;
	#lastActivity = Date.now();
	#capabilities?: DapCapabilities;
	#eventHandlers = new Map<string, Set<DapEventHandler>>();
	#anyEventHandlers = new Set<DapEventHandler>();
	#reverseRequestHandlers = new Map<string, DapReverseRequestHandler>();
	#adapterExited = false;
	#pendingWriteExitRejectors = new Set<() => void>();
	/** Rejectors for in-flight {@link waitForEvent} calls, woken when the
	 *  transport closes so an event that can never arrive fails fast instead of
	 *  waiting out its own timeout. */
	#eventWaiterRejectors = new Set<(error: Error) => void>();

	constructor(
		adapter: DapResolvedAdapter,
		cwd: string,
		proc: DapClientState["proc"],
		options?: {
			readable?: ReadableStream<Uint8Array>;
			writeSink?: DapWriteSink;
			socket?: { end(): void };
			port?: number;
		},
	) {
		this.adapter = adapter;
		this.cwd = cwd;
		this.proc = proc;
		this.#readable = options?.readable ?? (proc.stdout as ReadableStream<Uint8Array>);
		this.#writeSink = options?.writeSink ?? proc.stdin;
		this.#socket = options?.socket;
		this.port = options?.port;
		this.proc.exited.then(
			() => this.#rejectPendingWritesForExit(),
			() => this.#rejectPendingWritesForExit(),
		);
	}

	static async spawn({ adapter, cwd, socketReadyTimeoutMs }: DapSpawnOptions): Promise<DapClient> {
		if (adapter.connectMode === "socket") {
			return DapClient.#spawnSocket({ adapter, cwd, socketReadyTimeoutMs });
		}
		if (adapter.connectMode === "tcp") {
			return DapClient.#spawnTcp({ adapter, cwd, socketReadyTimeoutMs });
		}
		// Merge non-interactive env and start in a new session (detached → setsid)
		// so the adapter process tree has no controlling terminal. Without this,
		// debuggee children can reach /dev/tty and trigger SIGTTIN, suspending
		// the parent harness under shell job control.
		const env = {
			...Bun.env,
			...NON_INTERACTIVE_ENV,
		};
		const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args], {
			cwd,
			stdin: "pipe",
			env,
			detached: true,
		});
		const client = new DapClient(adapter, cwd, proc);
		proc.exited.then(() => {
			client.#handleProcessExit();
		});
		void client.#startMessageReader();
		return client;
	}

	/** Connect to another session on an existing TCP DAP server. */
	static async connect({
		adapter,
		cwd,
		host,
		port,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		host: string;
		port: number;
	}): Promise<DapClient> {
		const exited = Promise.withResolvers<void>();
		const { readable, writeSink, socket } = await connectTcpSocket(host, port, () => exited.resolve());
		const proc = {
			exited: exited.promise,
			exitCode: null,
			stdin: { write: () => 0, flush: () => undefined },
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>(),
			peekStderr: () => "",
			kill: () => {
				exited.resolve();
				return true;
			},
		} as unknown as DapClientState["proc"];
		const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket, port });
		exited.promise.then(() => client.#handleProcessExit());
		void client.#startMessageReader();
		return client;
	}

	/** Spawn an adapter that listens on a caller-selected TCP port. */
	static async #spawnTcp({ adapter, cwd, socketReadyTimeoutMs }: DapSpawnOptions): Promise<DapClient> {
		const host = "127.0.0.1";
		const reservation = Bun.listen({
			hostname: host,
			port: 0,
			socket: {
				open() {},
				data() {},
				close() {},
				error() {},
			},
		});
		const port = reservation.port;
		reservation.stop(true);
		const args = adapter.args.map(arg => arg.replaceAll("$" + "{port}", String(port)));
		const proc = ptree.spawn([adapter.resolvedCommand, ...args], {
			cwd,
			stdin: "pipe",
			env: {
				...Bun.env,
				...NON_INTERACTIVE_ENV,
			},
			detached: true,
		});

		try {
			// Wait for the adapter to announce it is listening on `port` before
			// connecting. Without this gate the first connect can land in the
			// window where a just-released reservation port still accepts
			// connections (WSL2 mirrored networking, issue #6055): the transport
			// then binds to a ghost of the reservation listener instead of the
			// adapter. Draining stdout here also avoids a pipe-buffer deadlock —
			// in tcp mode the DAP protocol flows over the socket, so nothing else
			// consumes the adapter's stdout.
			const readyTimeoutMs = socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
			await waitForTcpServerListening(proc, port, readyTimeoutMs);
			const { readable, writeSink, socket } = await waitForTcpTransport(host, port, readyTimeoutMs, proc);
			const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket, port });
			proc.exited.then(() => client.#handleProcessExit());
			void client.#startMessageReader();
			return client;
		} catch (error) {
			try {
				proc.kill();
			} catch {
				/* proc may already be dead */
			}
			throw error;
		}
	}

	/**
	 * Spawn a socket-mode adapter (e.g. dlv).
	 * Linux: connect to a unix domain socket via --listen=unix:<path>
	 * macOS/other: the adapter dials into our TCP listener via --client-addr
	 */
	static async #spawnSocket({ adapter, cwd, socketReadyTimeoutMs }: DapSpawnOptions): Promise<DapClient> {
		const env = {
			...Bun.env,
			...NON_INTERACTIVE_ENV,
		};
		const timeoutMs = socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
		const isLinux = process.platform === "linux";

		if (isLinux) {
			return DapClient.#spawnSocketUnix({ adapter, cwd, env, timeoutMs });
		}
		return DapClient.#spawnSocketClientAddr({ adapter, cwd, env, timeoutMs });
	}

	/** Linux: spawn adapter with --listen=unix:<path>, then connect to the socket. */
	static async #spawnSocketUnix({
		adapter,
		cwd,
		env,
		timeoutMs,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		env: Record<string, string | undefined>;
		timeoutMs: number;
	}): Promise<DapClient> {
		const socketPath = `/tmp/dap-${adapter.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
		const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--listen=unix:${socketPath}`], {
			cwd,
			stdin: "pipe",
			env,
			detached: true,
		});

		// If waitForCondition throws (timeout, or adapter exited early) or the
		// socket connect fails, we must not leak the detached adapter process.
		try {
			await waitForCondition(() => isUnixSocketReady(socketPath), timeoutMs, proc);
			const { readable, writeSink, socket } = await connectSocket({ unix: socketPath }, timeoutMs);
			const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket });
			proc.exited.then(() => client.#handleProcessExit());
			void client.#startMessageReader();
			return client;
		} catch (error) {
			try {
				proc.kill();
			} catch {
				/* proc may already be dead */
			}
			throw error;
		}
	}

	/** macOS/other: listen on a random TCP port, spawn adapter with --client-addr, accept connection. */
	static async #spawnSocketClientAddr({
		adapter,
		cwd,
		env,
		timeoutMs,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		env: Record<string, string | undefined>;
		timeoutMs: number;
	}): Promise<DapClient> {
		const { promise: connPromise, resolve: resolveConn } = Promise.withResolvers<Bun.Socket<undefined>>();

		// Listen on port 0 (OS picks a free port)
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open(socket) {
					resolveConn(socket);
				},
				data() {},
				close() {},
				error() {},
			},
		});

		const port = server.port;
		const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--client-addr=127.0.0.1:${port}`], {
			cwd,
			stdin: "pipe",
			env,
			detached: true,
		});

		// Wait for the adapter to dial back. On timeout (or any other failure
		// before we've wired up the client) kill `proc` — otherwise the detached
		// adapter process is orphaned.
		const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>();
		const connectTimeout = setTimeout(
			() => rejectTimeout(new Error(`${adapter.name} did not connect within ${timeoutMs}ms`)),
			timeoutMs,
		);
		try {
			const rawSocket = await Promise.race([connPromise, timeoutPromise]);
			const { readable, writeSink, socket } = wrapBunSocket(rawSocket);
			const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket });
			proc.exited.then(() => client.#handleProcessExit());
			void client.#startMessageReader();
			return client;
		} catch (error) {
			try {
				proc.kill();
			} catch {
				/* proc may already be dead */
			}
			throw error;
		} finally {
			clearTimeout(connectTimeout);
			server.stop();
		}
	}

	get capabilities(): DapCapabilities | undefined {
		return this.#capabilities;
	}

	get lastActivity(): number {
		return this.#lastActivity;
	}

	isAlive(): boolean {
		return !this.#disposed && this.proc.exitCode === null;
	}

	async initialize(args: DapInitializeArguments, signal?: AbortSignal, timeoutMs?: number): Promise<DapCapabilities> {
		const body = (await this.sendRequest("initialize", args, signal, timeoutMs)) as DapCapabilities | undefined;
		this.#capabilities = body ?? {};
		return this.#capabilities;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		const handlers = this.#eventHandlers.get(event) ?? new Set<DapEventHandler>();
		handlers.add(handler);
		this.#eventHandlers.set(event, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.#eventHandlers.delete(event);
			}
		};
	}

	onAnyEvent(handler: DapEventHandler): () => void {
		this.#anyEventHandlers.add(handler);
		return () => {
			this.#anyEventHandlers.delete(handler);
		};
	}

	onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
		this.#reverseRequestHandlers.set(command, handler);
		return () => {
			if (this.#reverseRequestHandlers.get(command) === handler) {
				this.#reverseRequestHandlers.delete(command);
			}
		};
	}

	async waitForEvent<TBody>(
		event: string,
		predicate?: (body: TBody) => boolean,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<TBody> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		}
		const { promise, resolve, reject } = Promise.withResolvers<TBody>();
		const cleanup = () => {
			unsubscribe();
			this.#eventWaiterRejectors.delete(closeHandler);
			if (timeout) clearTimeout(timeout);
			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		};
		const abortHandler = () => {
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new ToolAbortError());
		};
		const closeHandler = (error: Error) => {
			cleanup();
			reject(error);
		};
		const unsubscribe = this.onEvent(event, body => {
			const typedBody = body as TBody;
			if (predicate && !predicate(typedBody)) {
				return;
			}
			cleanup();
			resolve(typedBody);
		});
		this.#eventWaiterRejectors.add(closeHandler);
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error(`DAP event ${event} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		return promise;
	}

	async sendRequest<TBody = unknown>(
		command: string,
		args?: unknown,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<TBody> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		}
		if (this.#disposed) {
			throw new Error(`DAP adapter ${this.adapter.name} is not running`);
		}
		const requestSeq = ++this.#requestSeq;
		const request: DapRequestMessage = {
			seq: requestSeq,
			type: "request",
			command,
			arguments: args,
		};
		const { promise, resolve, reject } = Promise.withResolvers<TBody>();
		// Suppress "unhandled rejection" if the request timer or abort fires
		// before the caller's `await` subscribes — e.g. while #writeMessage is
		// still racing a wedged stdin flush. The caller's own `await` still
		// receives the rejection normally; this handler is a passive guard.
		promise.catch(() => {});

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		};
		const abortHandler = () => {
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new ToolAbortError());
		};
		const timeout = setTimeout(() => {
			if (!this.#pendingRequests.has(requestSeq)) return;
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			reject(new Error(`DAP request ${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		this.#pendingRequests.set(requestSeq, {
			command,
			resolve: body => {
				cleanup();
				resolve(body as TBody);
			},
			reject: error => {
				cleanup();
				reject(error);
			},
		});
		this.#lastActivity = Date.now();
		// Fire the write in the background. Awaiting it here would let a wedged
		// stdin flush block the caller's `timeoutMs`; if it fails, propagate the
		// failure into `promise` — the timer or abort may still win the race.
		void this.#writeMessage(request).catch(error => {
			if (!this.#pendingRequests.has(requestSeq)) return;
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			reject(error);
		});
		return promise;
	}

	async sendResponse(request: DapRequestMessage, success: boolean, body?: unknown, message?: string): Promise<void> {
		const response: DapResponseMessage = {
			seq: ++this.#requestSeq,
			type: "response",
			request_seq: request.seq,
			success,
			command: request.command,
			...(message ? { message } : {}),
			...(body !== undefined ? { body } : {}),
		};
		await this.#writeMessage(response);
	}

	/**
	 * Framed write to the adapter, bounded by {@link WRITE_MESSAGE_TIMEOUT_MS}
	 * and by adapter exit. Without this bound a wedged adapter stdin used to
	 * hang the whole client forever. On timeout or exit-before-flush the client
	 * disposes itself and rethrows.
	 */
	async #writeMessage(message: DapRequestMessage | DapResponseMessage): Promise<void> {
		const content = JSON.stringify(message);
		this.#writeSink.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`);
		this.#writeSink.write(content);
		const flushResult = this.#writeSink.flush();
		if (!(flushResult instanceof Promise)) return;

		if (this.#adapterExited) {
			throw new Error(`DAP adapter ${this.adapter.name} exited before write completed`);
		}

		const { promise: guardPromise, reject: guardReject, resolve: guardResolve } = Promise.withResolvers<void>();
		const timer = setTimeout(
			() =>
				guardReject(
					new Error(`DAP adapter ${this.adapter.name} write timed out after ${WRITE_MESSAGE_TIMEOUT_MS}ms`),
				),
			WRITE_MESSAGE_TIMEOUT_MS,
		);
		const rejectOnExit = () => {
			guardReject(new Error(`DAP adapter ${this.adapter.name} exited before write completed`));
		};
		this.#pendingWriteExitRejectors.add(rejectOnExit);

		try {
			await Promise.race([flushResult, guardPromise]);
		} catch (error) {
			// The client is now known-broken. Kick off dispose in the background;
			// callers will see subsequent sendRequest calls fail fast.
			void this.dispose();
			throw error;
		} finally {
			clearTimeout(timer);
			this.#pendingWriteExitRejectors.delete(rejectOnExit);
			// Release the guard so any late timeout callback becomes a no-op.
			guardResolve();
		}
	}

	#rejectPendingWritesForExit(): void {
		this.#adapterExited = true;
		for (const reject of this.#pendingWriteExitRejectors) {
			reject();
		}
		this.#pendingWriteExitRejectors.clear();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#rejectPendingRequests(new Error(`DAP adapter ${this.adapter.name} disposed`));
		try {
			this.#socket?.end();
		} catch {
			/* socket may already be closed */
		}
		try {
			this.proc.kill();
		} catch (error) {
			logger.debug("Failed to kill DAP adapter", {
				adapter: this.adapter.name,
				error: toErrorMessage(error),
			});
		}
		await this.proc.exited.catch(() => {});
	}

	async #startMessageReader(): Promise<void> {
		if (this.#isReading) return;
		this.#isReading = true;
		const reader = this.#readable.getReader();

		const framer = new MessageFramer(this.#messageBuffer);

		let closeError: Error | undefined;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				framer.push(Buffer.from(value));

				// Drain every complete message currently buffered.
				for (const messageText of framer.drain(headerText => {
					// Non-protocol bytes (e.g. an adapter printing to stdout).
					// Drop past the bogus terminator and resync instead of
					// stalling on the same junk header forever.
					logger.warn("DAP framing resync: header block without Content-Length", {
						adapter: this.adapter.name,
						header: headerText.slice(0, 200),
					});
				})) {
					this.#lastActivity = Date.now();

					// A malformed message must not kill the reader — later
					// messages are still well-framed.
					try {
						const message = JSON.parse(messageText) as DapResponseMessage | DapEventMessage | DapRequestMessage;
						if (message.type === "response") {
							this.#handleResponse(message);
						} else if (message.type === "event") {
							await this.#dispatchEvent(message);
						} else {
							await this.#handleAdapterRequest(message);
						}
					} catch (error) {
						logger.warn("DAP message handling failed", {
							adapter: this.adapter.name,
							error: toErrorMessage(error),
						});
					}
				}
			}
		} catch (error) {
			closeError = new Error(`DAP connection closed: ${toErrorMessage(error)}`);
		} finally {
			// Persist any unparsed remainder so a restarted reader resumes mid-message.
			this.#messageBuffer = framer.remainder();
			reader.releaseLock();
			this.#isReading = false;
		}
		// The transport is gone once the reader loop exits — on a thrown error
		// or a clean stream end (a socket the peer dropped after we wrote, e.g.
		// the WSL2-mirrored ghost-accept race in issue #6055). Fail every
		// in-flight request and event waiter so callers see an immediate error
		// instead of waiting out their own timeout.
		this.#failConnection(closeError ?? new Error(`DAP connection closed: ${this.adapter.name} transport ended`));
	}

	#handleResponse(message: DapResponseMessage): void {
		const pending = this.#pendingRequests.get(message.request_seq);
		if (!pending) {
			return;
		}
		this.#pendingRequests.delete(message.request_seq);
		if (message.success) {
			pending.resolve(message.body);
			return;
		}
		const errorMessage = message.message ?? `DAP request ${pending.command} failed`;
		pending.reject(new Error(errorMessage));
	}

	async #dispatchEvent(message: DapEventMessage): Promise<void> {
		const handlers = Array.from(this.#eventHandlers.get(message.event) ?? []);
		const anyHandlers = Array.from(this.#anyEventHandlers);
		for (const handler of [...handlers, ...anyHandlers]) {
			try {
				await handler(message.body, message);
			} catch (error) {
				logger.warn("DAP event handler failed", {
					adapter: this.adapter.name,
					event: message.event,
					error: toErrorMessage(error),
				});
			}
		}
	}

	async #handleAdapterRequest(message: DapRequestMessage): Promise<void> {
		try {
			const handler = this.#reverseRequestHandlers.get(message.command);
			if (handler) {
				try {
					const body = await handler(message.arguments);
					await this.sendResponse(message, true, body);
				} catch (error) {
					const errorMessage = toErrorMessage(error);
					await this.sendResponse(
						message,
						false,
						{
							error: {
								id: 1,
								format: errorMessage,
							},
						},
						errorMessage,
					);
				}
				return;
			}
			const errorMessage = `Unsupported DAP request: ${message.command}`;
			await this.sendResponse(
				message,
				false,
				{
					error: {
						id: 1,
						format: errorMessage,
					},
				},
				errorMessage,
			);
		} catch (error) {
			logger.warn("Failed to answer DAP adapter request", {
				adapter: this.adapter.name,
				command: message.command,
				error: toErrorMessage(error),
			});
		}
	}

	#handleProcessExit(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const stderr = this.proc.peekStderr().trim();
		const exitCode = this.proc.exitCode;
		const error = new Error(
			stderr
				? `DAP adapter exited (code ${exitCode}): ${stderr}`
				: `DAP adapter exited unexpectedly (code ${exitCode})`,
		);
		this.#failConnection(error);
	}

	/** Reject every in-flight request and wake every event waiter with `error`.
	 *  Called when the transport dies (reader end, socket close, adapter exit)
	 *  so nothing sits pending until its own timeout. */
	#failConnection(error: Error): void {
		this.#rejectPendingRequests(error);
		const waiters = Array.from(this.#eventWaiterRejectors);
		this.#eventWaiterRejectors.clear();
		for (const reject of waiters) {
			reject(error);
		}
	}

	#rejectPendingRequests(error: Error): void {
		for (const pending of this.#pendingRequests.values()) {
			pending.reject(error);
		}
		this.#pendingRequests.clear();
	}
}

async function isUnixSocketReady(socketPath: string): Promise<boolean> {
	try {
		return (await fs.stat(socketPath)).isSocket();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Poll a condition until it returns true, or timeout/process exit. */
async function waitForCondition(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	proc: { exitCode: number | null },
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		if (proc.exitCode !== null) {
			throw new Error("Adapter process exited before socket was ready");
		}
		await Bun.sleep(50);
	}
	throw new Error(`Socket not ready after ${timeoutMs}ms`);
}

/** Connect once to a TCP DAP server. */
async function connectTcpSocket(host: string, port: number, onClose?: () => void): Promise<SocketTransport> {
	const { promise, resolve, reject } = Promise.withResolvers<SocketTransport>();
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	let opened = false;
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	void Bun.connect({
		hostname: host,
		port,
		socket: {
			open(socket) {
				opened = true;
				resolve({
					readable,
					writeSink: socketToSink(socket),
					socket,
				});
			},
			data(_socket, data) {
				streamController.enqueue(new Uint8Array(data));
			},
			close() {
				onClose?.();
				if (!opened) {
					reject(new Error(`Connection to TCP port ${host}:${port} closed before opening`));
				}
				try {
					streamController.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, error) {
				onClose?.();
				if (!opened) {
					reject(error);
				}
				try {
					streamController.error(error);
				} catch {
					/* already closed */
				}
			},
		},
	}).catch(error => {
		onClose?.();
		reject(error);
	});
	return promise;
}

/** Wait for a TCP DAP server and retain the first successful connection. */
async function waitForTcpTransport(
	host: string,
	port: number,
	timeoutMs: number,
	proc: { exitCode: number | null },
): Promise<SocketTransport> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`Adapter process exited before TCP port ${host}:${port} was ready`);
		}
		try {
			return await connectTcpSocket(host, port);
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error(`TCP port ${host}:${port} was not ready after ${timeoutMs}ms`);
}

/**
 * Give the adapter a chance to announce it is listening on `port` before the
 * first connect. vscode-js-debug prints `Debug server listening at HOST:PORT`
 * to stdout from inside its `listen()` callback; waiting for the port to appear
 * there means we only connect once the child genuinely owns the reserved port,
 * which closes the WSL2-mirrored ghost-accept window (issue #6055) at its root.
 *
 * Best-effort: resolves on the banner, on process exit, or on timeout — the
 * subsequent connect loop and `proc.exitCode` checks surface real failures, so
 * an adapter that never prints a banner still proceeds (just without the gate).
 * Also drains stdout for the wait's duration: in tcp mode the DAP protocol
 * flows over the socket, so nothing else consumes the adapter's stdout.
 *
 * Exported so tests can drive the gate deterministically with a synthetic stdout.
 */
export async function waitForTcpServerListening(
	proc: { stdout: ReadableStream<Uint8Array>; exitCode: number | null },
	port: number,
	timeoutMs: number,
): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const portText = String(port);
	void (async () => {
		try {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of proc.stdout) {
				buffered += decoder.decode(chunk, { stream: true });
				if (buffered.includes(portText)) {
					ready.resolve();
				}
				// Keep only the tail relevant for banner matching so a chatty
				// adapter cannot grow this buffer without bound.
				if (buffered.length > 4096) {
					buffered = buffered.slice(-1024);
				}
			}
		} catch {
			/* stdout errored — the connect loop surfaces the real failure */
		}
		ready.resolve();
	})();
	await Promise.race([ready.promise, Bun.sleep(timeoutMs)]);
}

interface SocketTransport {
	readable: ReadableStream<Uint8Array>;
	writeSink: DapWriteSink;
	socket: { end(): void };
}

/** Adapt a Bun.Socket to DapWriteSink. */
function socketToSink(socket: Bun.Socket<undefined>): DapWriteSink {
	return {
		write(data: string | Uint8Array) {
			return socket.write(data);
		},
		flush() {
			socket.flush();
			return undefined;
		},
	};
}

/**
 * Connect to a unix domain socket and return DAP transport streams.
 *
 * Rejects (rather than hanging) when the connect fails — a stat-ready but dead
 * socket returns ECONNREFUSED, a socket removed between the readiness stat and
 * the connect returns ENOENT, a permission mismatch returns EACCES — and when
 * neither `open` nor an error arrives within `timeoutMs` (e.g. a TOCTOU stall).
 * `#spawnSocketUnix`'s catch then kills the detached adapter instead of leaking
 * it. Exported so tests can drive the reject path deterministically.
 */
export async function connectSocket(options: { unix: string }, timeoutMs: number): Promise<SocketTransport> {
	const { promise, resolve, reject } = Promise.withResolvers<SocketTransport>();
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	let opened = false;

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	const timer = setTimeout(() => {
		reject(new Error(`Timed out connecting to unix socket ${options.unix} after ${timeoutMs}ms`));
	}, timeoutMs);
	// A late socket callback after settle is a no-op; clearing the timer just
	// stops it from keeping the event loop alive past the connect.
	void promise.then(
		() => clearTimeout(timer),
		() => clearTimeout(timer),
	);

	Bun.connect({
		unix: options.unix,
		socket: {
			open(socket) {
				opened = true;
				resolve({
					readable,
					writeSink: socketToSink(socket),
					socket,
				});
			},
			data(_socket, data) {
				streamController.enqueue(new Uint8Array(data));
			},
			close() {
				if (!opened) {
					reject(new Error(`Unix socket ${options.unix} closed before opening`));
				}
				try {
					streamController.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, err) {
				if (!opened) {
					reject(err);
				}
				try {
					streamController.error(err);
				} catch {
					/* already closed */
				}
			},
		},
	}).catch(err => {
		// Bun.connect rejects the returned promise on synchronous connect
		// failures (e.g. ENOENT) without always firing the `error` handler.
		if (!opened) {
			reject(err);
		}
	});

	return promise;
}

/** Wrap an already-connected Bun.Socket into DAP transport streams. */
function wrapBunSocket(rawSocket: Bun.Socket<undefined>): SocketTransport {
	let streamController: ReadableStreamDefaultController<Uint8Array>;

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	// Attach data/close/error handlers to the already-open socket
	rawSocket.reload({
		socket: {
			open() {},
			data(_socket, data) {
				streamController.enqueue(new Uint8Array(data));
			},
			close() {
				try {
					streamController.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, err) {
				try {
					streamController.error(err);
				} catch {
					/* already closed */
				}
			},
		},
	});

	return {
		readable,
		writeSink: socketToSink(rawSocket),
		socket: rawSocket,
	};
}
