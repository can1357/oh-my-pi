/**
 * Client half of the broker-shared LSP mux.
 *
 * `connectSharedLspTransport` ensures the per-project mux daemon is running
 * under the daemon broker (same lifecycle as the shared Chromium: started on
 * first use, stopped when the last omp process in the project exits), dials
 * its socket, performs the `omp/muxConnect` handshake, and returns an
 * {@link LspTransport} the ordinary LSP client machinery drives exactly like
 * a locally spawned server. Every failure degrades to `null` so callers fall
 * back to a process-local spawn.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import { MessageFramer } from "../../jsonrpc/message-framing";
import { daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import { daemonRuntimeDir } from "../../launch/paths";
import { resolveWorkerSpawnCmd, SMOKE_TEST_TIMEOUT_MS, workerEnvFromParent } from "../../subprocess/worker-client";
import type { LspJsonRpcRequest, LspJsonRpcResponse, LspTransport, LspWriteSink } from "../types";
import {
	LSP_MUX_DAEMON_NAME,
	LSP_MUX_PROJECT_DIR_ENV,
	LSP_MUX_READY_PATTERN,
	LSP_MUX_SOCKET_ENV,
	LSP_MUX_WORKER_ARG,
	lspMuxEndpoint,
	MUX_CONNECT_METHOD,
	MUX_PING_METHOD,
	MUX_PING_RESULT,
	type MuxConnectParams,
	type MuxConnectResult,
} from "./protocol";

const CONNECT_TIMEOUT_MS = 3_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_500;
const READY_TIMEOUT_MS = 15_000;
/** probe→describe→start rounds; bounds cross-process start races and wedged-mux replacement. */
const ENSURE_ATTEMPTS = 3;

/** Dial a mux endpoint (Unix socket or Windows named pipe) with a bounded connect. */
function connectEndpoint(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.connect(endpoint);
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Timed out connecting to LSP mux at ${endpoint}`));
	}, timeoutMs);
	socket.once("connect", () => {
		clearTimeout(timer);
		socket.removeListener("error", onError);
		resolve(socket);
	});
	const onError = (error: Error) => {
		clearTimeout(timer);
		reject(error);
	};
	socket.once("error", onError);
	return promise;
}

/**
 * Send one request on a fresh socket and await its response. Used only
 * before the transport takes over the socket; leftover bytes after the
 * response are returned so the transport's stream can replay them.
 */
function requestOnSocket(
	socket: net.Socket,
	request: LspJsonRpcRequest,
	timeoutMs: number,
): Promise<{ response: LspJsonRpcResponse; leftover: Buffer }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ response: LspJsonRpcResponse; leftover: Buffer }>();
	const framer = new MessageFramer(Buffer.alloc(0));
	const timer = setTimeout(() => {
		cleanup();
		reject(new Error(`LSP mux ${request.method} timed out`));
	}, timeoutMs);
	const onData = (chunk: Buffer) => {
		framer.push(chunk);
		for (const text of framer.drain(() => {})) {
			let message: LspJsonRpcResponse;
			try {
				message = JSON.parse(text);
			} catch (error) {
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (message.id !== request.id) continue;
			cleanup();
			if (message.error) reject(new Error(`LSP mux ${request.method} failed: ${message.error.message}`));
			else resolve({ response: message, leftover: framer.remainder() });
			return;
		}
	};
	const onClose = () => {
		cleanup();
		reject(new Error("LSP mux connection closed during handshake"));
	};
	const cleanup = () => {
		clearTimeout(timer);
		socket.removeListener("data", onData);
		socket.removeListener("close", onClose);
		socket.removeListener("error", onClose);
	};
	socket.on("data", onData);
	socket.once("close", onClose);
	socket.once("error", onClose);
	const content = JSON.stringify(request);
	socket.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	return promise;
}

/**
 * Wrap a connected, handshaken mux socket as an {@link LspTransport}.
 * Socket close maps to a clean "process exit" (code 0) so the LSP client's
 * crash-recovery path treats a dead mux exactly like a dead server.
 */
function socketTransport(socket: net.Socket, leftover: Buffer, pid: number | undefined): LspTransport {
	const exited = Promise.withResolvers<number>();
	let exitCode: number | null = null;
	let needDrain = false;
	socket.on("error", () => {
		// "close" always follows; swallowing here prevents an unhandled error event.
	});
	socket.once("close", () => {
		exitCode = 0;
		exited.resolve(0);
	});
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			if (leftover.byteLength > 0) controller.enqueue(new Uint8Array(leftover));
			socket.on("data", (chunk: Buffer) =>
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
			);
			socket.once("close", () => {
				try {
					controller.close();
				} catch {
					// already errored/closed
				}
			});
		},
	});
	const stdin: LspWriteSink = {
		write(data) {
			needDrain = !socket.write(data);
			return typeof data === "string" ? Buffer.byteLength(data, "utf-8") : data.byteLength;
		},
		flush() {
			if (!needDrain || socket.destroyed) return;
			return new Promise<void>(resolveDrain => {
				const onDrain = () => {
					needDrain = false;
					socket.removeListener("close", onDrain);
					resolveDrain();
				};
				socket.once("drain", onDrain);
				socket.once("close", onDrain);
			});
		},
	};
	return {
		stdin,
		stdout,
		exited: exited.promise,
		get exitCode() {
			return exitCode;
		},
		pid,
		sharedMux: true,
		kill() {
			socket.destroy();
		},
		peekStderr() {
			return "";
		},
	};
}

let nextHandshakeId = 1;

/** Dial and handshake one server link; throws on any failure. */
async function dialMuxServer(endpoint: string, params: MuxConnectParams): Promise<LspTransport> {
	const socket = await connectEndpoint(endpoint, CONNECT_TIMEOUT_MS);
	socket.setNoDelay(true);
	try {
		const { response, leftover } = await requestOnSocket(
			socket,
			{ jsonrpc: "2.0", id: `connect:${nextHandshakeId++}`, method: MUX_CONNECT_METHOD, params },
			HANDSHAKE_TIMEOUT_MS,
		);
		const result = response.result as MuxConnectResult;
		return socketTransport(socket, leftover, result.pid);
	} catch (error) {
		socket.destroy();
		throw error;
	}
}

/** True when a mux answers the ping handshake at `endpoint`. */
async function probeMux(endpoint: string): Promise<boolean> {
	try {
		const socket = await connectEndpoint(endpoint, PROBE_TIMEOUT_MS);
		try {
			const { response } = await requestOnSocket(
				socket,
				{ jsonrpc: "2.0", id: "probe", method: MUX_PING_METHOD, params: null },
				PROBE_TIMEOUT_MS,
			);
			return response.result === MUX_PING_RESULT;
		} finally {
			socket.destroy();
		}
	} catch {
		return false;
	}
}

/**
 * Ensure the project's mux daemon is running under the broker and reachable.
 * Returns its endpoint, or null when the shared path is unavailable.
 */
async function ensureLspMuxDaemon(projectDir: string, signal?: AbortSignal): Promise<string | null> {
	const client = await daemonClientForProject(projectDir);
	const endpoint = lspMuxEndpoint(client.projectDir, daemonRuntimeDir(client.projectDir));
	// The broker connection doubles as the presence lease keeping the daemon alive.
	await client.request({ op: "ping" }, signal);
	if (await probeMux(endpoint)) return endpoint;
	const spawn = resolveWorkerSpawnCmd(LSP_MUX_WORKER_ARG);
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		signal?.throwIfAborted();
		// A concurrent start may have won since the last round; adopt it.
		if (await probeMux(endpoint)) return endpoint;
		const existing = await describeQuietly(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			if (existing.readyAt === undefined) {
				await waitReady(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal, READY_TIMEOUT_MS);
			}
			if (await probeMux(endpoint)) return endpoint;
			// Live record but nothing listening: replace the wedged daemon.
			await stopQuietly(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name: LSP_MUX_DAEMON_NAME,
						application: spawn.cmd[0]!,
						args: spawn.cmd.slice(1),
						env: {
							[LSP_MUX_SOCKET_ENV]: endpoint,
							[LSP_MUX_PROJECT_DIR_ENV]: client.projectDir,
						},
						cwd: spawn.cwd ?? client.projectDir,
						pty: false,
						ready: { log: LSP_MUX_READY_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				signal,
			);
			if (started.op !== "start") continue;
			if (await probeMux(endpoint)) return endpoint;
			await stopQuietly(client, LSP_MUX_DAEMON_NAME, "LSP mux", signal);
		} catch (error) {
			signal?.throwIfAborted();
			// Lost a cross-process start race; the next round adopts the winner.
			logger.debug("LSP mux start contention", {
				name: LSP_MUX_DAEMON_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}

/**
 * Open a broker-shared transport for one language server, ensuring the mux
 * daemon first. Returns null (after a debug log) when the shared path is
 * unavailable so the caller falls back to a process-local spawn.
 */
export async function connectSharedLspTransport(opts: {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
}): Promise<LspTransport | null> {
	try {
		const endpoint = await ensureLspMuxDaemon(opts.cwd, opts.signal);
		if (!endpoint) return null;
		return await dialMuxServer(endpoint, {
			command: opts.command,
			args: opts.args,
			cwd: opts.cwd,
			env: opts.env,
		});
	} catch (error) {
		if (opts.signal?.aborted) throw error;
		logger.debug("Shared LSP transport unavailable; falling back to local spawn", {
			command: opts.command,
			cwd: opts.cwd,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** Exercise worker-host mux startup and the ping handshake for distribution smoke tests. */
export async function smokeTestLspMux(): Promise<void> {
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-lsp-mux-smoke-${process.pid.toString(16)}`
			: path.join(os.tmpdir(), `omp-lsp-mux-smoke-${process.pid.toString(36)}.sock`);
	const spawn = resolveWorkerSpawnCmd(LSP_MUX_WORKER_ARG);
	const proc = ptree.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent({
			[LSP_MUX_SOCKET_ENV]: endpoint,
			[LSP_MUX_PROJECT_DIR_ENV]: process.cwd(),
		}),
	});
	try {
		const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
		let alive = false;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) break;
			if (await probeMux(endpoint)) {
				alive = true;
				break;
			}
			await Bun.sleep(200);
		}
		if (!alive) {
			throw new Error(`lsp mux smoke failed: no ping response (${proc.peekStderr().slice(-500) || "no stderr"})`);
		}
	} finally {
		proc.kill();
		await proc.exited.catch(() => {});
	}
}
