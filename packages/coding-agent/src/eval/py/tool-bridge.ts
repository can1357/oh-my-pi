/**
 * HTTP bridge that lets the Python kernel invoke host-side tools and
 * enabled eval-prelude capabilities, mirroring the JavaScript worker bridge.
 *
 * The Python prelude POSTs to `/v1/tool` over a 127.0.0.1 loopback socket, or,
 * for a kernel contained by the OS sandbox (which denies host loopback), over a
 * Unix socket inside the sandbox's private temp dir (its writable root); the host resolves the
 * request against the `ToolSession` registered for the current execution and
 * forwards to the same `callSessionTool` implementation the JavaScript bridge uses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import type { RuntimeCallIdentity } from "../js/shared/runtime";
import { bridgeValueFromToolResult, callSessionTool, type JsStatusEvent } from "../js/tool-bridge";
import type { EvalShadowCellSession } from "../speculation/cell-session";

export interface PyToolBridgeEntry {
	toolSession: ToolSession;
	/**
	 * Turn-cancel handed to the tool implementation. Raw and never deferred, so
	 * delegated work — above all the subagents `agent()` spawns — stops at once.
	 */
	signal?: AbortSignal;
	/** The cell's `timeout` in ms, the budget of a prelude call that sets none (`EvalPreludeContext.cellTimeoutMs`). */
	cellTimeoutMs?: number;
	/**
	 * Kernel-side abort, held back while a critical `agent()` phase (isolation
	 * worktree setup, merge/cherry-pick) is in flight. Decides only when the host
	 * may stop waiting on a call and let the kernel unwind; it is never given to
	 * a tool. Keeping these separate is what stops a cancel from settling the
	 * cell on top of a still-running, abort-insensitive merge.
	 */
	shieldedSignal?: AbortSignal;
	shadowCell?: EvalShadowCellSession;
	emitStatus?: (event: JsStatusEvent) => void;
	/** Shows the user `out://` replies of bridged calls (`ToolBridgeOptions.onReply`). */
	onReply?: (text: string) => void;
	abortRequested?: () => boolean;
}

export interface PyToolBridgeInfo {
	/** `http://127.0.0.1:<port>`, or `unix:<socket path>` for the Unix-socket bridge. */
	url: string;
	token: string;
}

/** `unix` serves a sandbox-contained kernel; POSIX only (Windows keeps TCP). */
export type PyToolBridgeTransport = "tcp" | "unix";

/** Socket file name inside the directory a `unix` bridge is given; short, for the 104-byte `sun_path`. */
const BRIDGE_SOCKET_NAME = "py.sock";

interface BridgeServer {
	info: PyToolBridgeInfo;
	stop: () => Promise<void>;
}

const registrations = new Map<string, PyToolBridgeEntry>();
/** Started servers: `"tcp"`, or `unix:<socket dir>` per directory. */
const serverPromises = new Map<string, Promise<BridgeServer>>();

function markExpectedBridgeShutdownError(error: unknown): error is Error {
	if (!(error instanceof Error)) return false;
	const expected =
		error.name === "AbortError" ||
		("code" in error &&
			(error.code === "ERR_SOCKET_CLOSED" || error.code === "ECONNRESET" || error.code === "EPIPE"));
	if (expected) postmortem.markExpectedCleanupError(error);
	return expected;
}

async function waitForSpeculativeClaim<T>(claim: Promise<T>, name: string, signal?: AbortSignal): Promise<T> {
	if (!signal) return await claim;
	if (signal.aborted) {
		throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
	}
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	let onAbort: () => void = () => {};
	const finish = (settle: () => void): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", onAbort);
		settle();
	};
	onAbort = (): void =>
		finish(() => reject(new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`)));
	signal.addEventListener("abort", onAbort, { once: true });
	void claim.then(
		value => finish(() => resolve(value)),
		error => finish(() => reject(error)),
	);
	return await promise;
}

/**
 * Forward a bridge call to {@link callSessionTool}, failing fast once the cell
 * has been interrupted.
 *
 * Python invokes this bridge with blocking `urllib` requests from worker threads
 * (each `agent()` / `tool.*` call). Two different aborts meet here:
 *
 * - {@link PyToolBridgeEntry.signal} goes to the tool, so a turn cancel tears
 *   down delegated work — subagents included — instead of leaving it running
 *   past the cell.
 * - {@link PyToolBridgeEntry.shieldedSignal} decides when we may stop waiting.
 *   It is deferred across a critical `agent()` phase, so a cancel landing
 *   mid-merge cannot return early and let the cell settle while an
 *   abort-insensitive cherry-pick is still rewriting the repo.
 * Calls arriving after an abort are rejected before starting. A speculative
 * claim is also raced against cancellation, and its late outcome is observed
 * after the bridge has settled. Otherwise the usual path is that the tool
 * observes its own abort and rejects; the race only matters for tools that
 * ignore the signal, keeping the kernel unwinding promptly instead of being
 * hard-killed.
 */
async function callSessionToolPromptOnAbort(
	name: string,
	args: unknown,
	entry: PyToolBridgeEntry,
	identity?: RuntimeCallIdentity,
): Promise<unknown> {
	if (entry.abortRequested?.()) {
		throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
	}
	const claimSignal = entry.signal ?? entry.shieldedSignal;
	if (entry.shadowCell && identity && name === "read") {
		const claimed = await waitForSpeculativeClaim(
			entry.shadowCell.claim(name, args, identity, Number.MAX_SAFE_INTEGER, claimSignal),
			name,
			claimSignal,
		);
		if (claimSignal?.aborted || entry.abortRequested?.()) {
			throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
		}
		if (claimed) return bridgeValueFromToolResult(name, args, claimed, entry.emitStatus);
	}
	const call = callSessionTool(name, args, {
		session: entry.toolSession,
		signal: entry.signal,
		cellTimeoutMs: entry.cellTimeoutMs,
		emitStatus: entry.emitStatus,
		onReply: entry.onReply,
		identity,
	});
	const signal = entry.shieldedSignal ?? entry.signal;
	if (!signal) return await call;
	if (signal.aborted) {
		void call.catch(() => {});
		throw new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`);
	}
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(new Error(`bridge call ${JSON.stringify(name)} aborted: eval cell was interrupted`));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([call, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
		// `call` may still be settling (subagent teardown after its own abort);
		// swallow its outcome so an abort-won race can't surface as unhandled.
		void call.catch(() => {});
	}
}

async function startServer(socketDir: string | undefined): Promise<BridgeServer> {
	const token = crypto.randomUUID();
	const handlers = {
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (req.method !== "POST" || url.pathname !== "/v1/tool") {
				return new Response("Not Found", { status: 404 });
			}
			if (req.headers.get("authorization") !== `Bearer ${token}`) {
				return new Response("Forbidden", { status: 403 });
			}

			let body: { session?: unknown; run?: unknown; name?: unknown; args?: unknown; identity?: unknown };
			try {
				body = (await req.json()) as {
					session?: unknown;
					run?: unknown;
					name?: unknown;
					args?: unknown;
					identity?: unknown;
				};
			} catch {
				return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
			}
			const sessionId = typeof body.session === "string" ? body.session : "";
			const runId = typeof body.run === "string" ? body.run : "";
			const name = typeof body.name === "string" ? body.name : "";
			if (!sessionId || !runId || !name) {
				return Response.json({ ok: false, error: "Missing session/run/name" }, { status: 400 });
			}
			const registrationKey = bridgeRegistrationKey(sessionId, runId);
			const entry = registrations.get(registrationKey) ?? registrations.get(sessionId);
			if (!entry) {
				return Response.json(
					{ ok: false, error: `No active Python tool bridge session: ${registrationKey}` },
					{ status: 200 },
				);
			}

			try {
				const identityRecord =
					body.identity && typeof body.identity === "object" && !Array.isArray(body.identity)
						? body.identity
						: undefined;
				const siteId =
					identityRecord && "siteId" in identityRecord && typeof identityRecord.siteId === "string"
						? identityRecord.siteId
						: undefined;
				const occurrence =
					identityRecord && "occurrence" in identityRecord && typeof identityRecord.occurrence === "number"
						? identityRecord.occurrence
						: undefined;
				const identity = siteId !== undefined && occurrence !== undefined ? { siteId, occurrence } : undefined;
				const value = await callSessionToolPromptOnAbort(name, body.args, entry, identity);
				return Response.json({ ok: true, value });
			} catch (err) {
				return Response.json({
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		error(err: Error): Response {
			if (markExpectedBridgeShutdownError(err)) {
				logger.debug("Python tool bridge connection closed during shutdown", { error: err.message });
			} else {
				logger.error("Python tool bridge request failed", { error: err });
			}
			// Bun requires an error response even when the peer has already gone.
			// An empty body minimizes further writes to a closing socket.
			return new Response(null, { status: 500 });
		},
	};
	// A contained kernel can reach only sockets under its writable roots, so the caller passes its
	// sandbox's private temp dir; the socket is removed when the server stops or the process exits.
	const socketPath = socketDir ? path.join(socketDir, BRIDGE_SOCKET_NAME) : undefined;
	const removeSocket = (): void => {
		if (socketPath) fs.rmSync(socketPath, { force: true });
	};
	const server = (() => {
		try {
			if (!socketPath) return Bun.serve({ ...handlers, hostname: "127.0.0.1", port: 0 });
			// The directory is writable from inside the sandbox: clear anything left at the socket path.
			removeSocket();
			return Bun.serve({ ...handlers, unix: socketPath });
		} catch (error) {
			removeSocket();
			throw error;
		}
	})();
	const cancelCleanup = socketPath ? postmortem.register("python-tool-bridge-socket", removeSocket) : undefined;

	const info: PyToolBridgeInfo = {
		url: socketPath ? `unix:${socketPath}` : `http://${server.hostname}:${server.port}`,
		token,
	};
	logger.debug("Python tool bridge listening", { url: info.url });
	let stopPromise: Promise<void> | null = null;

	return {
		info,
		stop: () => {
			stopPromise ??= Promise.try(() => server.stop(true))
				.catch(error => {
					if (!markExpectedBridgeShutdownError(error)) throw error;
					logger.debug("Python tool bridge stopped after its socket closed", {
						error: error.message,
					});
				})
				.finally(() => {
					cancelCleanup?.();
					removeSocket();
				});
			return stopPromise;
		},
	};
}

/**
 * Starts the bridge server lazily and returns its connection info: TCP on loopback, or (`unix`) a
 * Unix socket inside `socketDir`, one server per directory.
 */
export async function ensurePyToolBridge(
	transport: PyToolBridgeTransport = "tcp",
	socketDir?: string,
): Promise<PyToolBridgeInfo> {
	if (transport === "unix" && socketDir === undefined) throw new Error("A unix Python tool bridge needs a socket dir");
	const key = transport === "unix" ? `unix:${socketDir}` : "tcp";
	let pending = serverPromises.get(key);
	if (!pending) {
		pending = startServer(transport === "unix" ? socketDir : undefined);
		serverPromises.set(key, pending);
	}
	try {
		const server = await pending;
		return server.info;
	} catch (err) {
		if (serverPromises.get(key) === pending) serverPromises.delete(key);
		throw err;
	}
}

/**
 * Register a tool session for the duration of one execution. The returned
 * function MUST be called to remove the entry once execution finishes.
 */
function bridgeRegistrationKey(sessionId: string, runId: string): string {
	return `${sessionId}:${runId}`;
}

export function registerPyToolBridge(sessionId: string, runId: string, entry: PyToolBridgeEntry): () => void {
	const key = bridgeRegistrationKey(sessionId, runId);
	registrations.set(key, entry);
	return () => {
		if (registrations.get(key) === entry) {
			registrations.delete(key);
		}
	};
}

/** Stop the bridges and clear registrations. Test-only / shutdown helper. */
export async function disposePyToolBridge(): Promise<void> {
	registrations.clear();
	const pending = [...serverPromises.values()];
	serverPromises.clear();
	for (const started of pending) {
		try {
			const server = await started;
			await server.stop();
		} catch (err) {
			logger.debug("Failed to stop Python tool bridge", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
