import * as fs from "node:fs/promises";
import { isEnoent, logger, ptree } from "@pk-nerdsaver-ai/pi-utils";
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
}

/** Minimal write interface shared by Bun.FileSink and Bun TCP sockets. */
interface DapWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | Promise<number> | undefined;
}

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

async function writeMessage(sink: DapWriteSink, message: DapRequestMessage | DapResponseMessage): Promise<void> {
	const content = JSON.stringify(message);
	sink.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`);
	sink.write(content);
	await sink.flush();
}

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

export class DapClient {
	readonly adapter: DapResolvedAdapter;
	readonly cwd: string;
	readonly proc: DapClientState["proc"];
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

	constructor(
		adapter: DapResolvedAdapter,
		cwd: string,
		proc: DapClientState["proc"],
		options?: { readable?: ReadableStream<Uint8Array>; writeSink?: DapWriteSink; socket?: { end(): void } },
	) {
		this.adapter = adapter;
		this.cwd = cwd;
		this.proc = proc;
		this.#readable = options?.readable ?? (proc.stdout as ReadableStream<Uint8Array>);
		this.#writeSink = options?.writeSink ?? proc.stdin;
		this.#socket = options?.socket;
	}

	static async spawn({ adapter, cwd }: DapSpawnOptions): Promise<DapClient> {
		if (adapter.connectMode === "socket") {
			return DapClient.#spawnSocket({ adapter, cwd });
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

	/**
	 * Spawn a socket-mode adapter (e.g. dlv).
	 * Linux: connect to a unix domain socket via --listen=unix:<path>
	 * macOS/other: the adapter dials into our TCP listener via --client-addr
	 */
	static async #spawnSocket({ adapter, cwd }: DapSpawnOptions): Promise<DapClient> {
		const env = {
			...Bun.env,
			...NON_INTERACTIVE_ENV,
		};
		const isLinux = process.platform === "linux";

		if (isLinux) {
			return DapClient.#spawnSocketUnix({ adapter, cwd, env });
		}
		return DapClient.#spawnSocketClientAddr({ adapter, cwd, env });
	}

	/** Linux: spawn adapter with --listen=unix:<path>, then connect to the socket. */
	static async #spawnSocketUnix({
		adapter,
		cwd,
		env,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		env: Record<string, string | undefined>;
	}): Promise<DapClient> {
		const socketPath = `/tmp/dap-${adapter.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
		const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--listen=unix:${socketPath}`], {
			cwd,
			stdin: "pipe",
			env,
			detached: true,
		});

		await waitForCondition(() => isUnixSocketReady(socketPath), 10_000, proc);

		const { readable, writeSink, socket } = await connectSocket({ unix: socketPath });
		const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket });
		proc.exited.then(() => client.#handleProcessExit());
		void client.#startMessageReader();
		return client;
	}

	/** macOS/other: listen on a random TCP port, spawn adapter with --client-addr, accept connection. */
	static async #spawnSocketClientAddr({
		adapter,
		cwd,
		env,
	}: {
		adapter: DapResolvedAdapter;
		cwd: string;
		env: Record<string, string | undefined>;
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

		// Wait for dlv to connect (with timeout)
		let rawSocket: Bun.Socket<undefined>;
		const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>();
		const connectTimeout = setTimeout(
			() => rejectTimeout(new Error(`${adapter.name} did not connect within 10s`)),
			10_000,
		);
		try {
			rawSocket = await Promise.race([connPromise, timeoutPromise]);
		} finally {
			clearTimeout(connectTimeout);
			server.stop();
		}

		const { readable, writeSink, socket } = wrapBunSocket(rawSocket);
		const client = new DapClient(adapter, cwd, proc, { readable, writeSink, socket });
		proc.exited.then(() => client.#handleProcessExit());
		void client.#startMessageReader();
		return client;
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
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = () => {
			unsubscribe();
			if (timeout) clearTimeout(timeout);
			if (signal) {
				signal.removeEventListener("abort", abortHandler);
			}
		};
		const abortHandler = () => {
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new ToolAbortError());
		};
		const unsubscribe = this.onEvent(event, body => {
			const typedBody = body as TBody;
			if (predicate && !predicate(typedBody)) {
				return;
			}
			cleanup();
			resolve(typedBody);
		});
		if (signal) {
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		timeout = setTimeout(() => {
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
		let timeout: NodeJS.Timeout | undefined;
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
		timeout = setTimeout(() => {
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
		try {
			await writeMessage(this.#writeSink, request);
		} catch (error) {
			this.#pendingRequests.delete(requestSeq);
			cleanup();
			throw error;
		}
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
		await writeMessage(this.#writeSink, response);
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
			this.#rejectPendingRequests(new Error(`DAP connection closed: ${toErrorMessage(error)}`));
		} finally {
			// Persist any unparsed remainder so a restarted reader resumes mid-message.
			this.#messageBuffer = framer.remainder();
			reader.releaseLock();
			this.#isReading = false;
		}
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
		this.#rejectPendingRequests(error);
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

/** Connect to a unix domain socket and return DAP transport streams. */
async function connectSocket(options: { unix: string }): Promise<SocketTransport> {
	const { promise, resolve } = Promise.withResolvers<SocketTransport>();
	let streamController: ReadableStreamDefaultController<Uint8Array>;

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	Bun.connect({
		unix: options.unix,
		socket: {
			open(socket) {
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
