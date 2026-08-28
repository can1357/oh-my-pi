/**
 * HTTP loopback bridge that lets the Python kernel synchronously invoke
 * host-side tools by name, mirroring the JS worker's `tool.<name>(args)` proxy.
 *
 * The Python prelude builds a `tool` proxy that POSTs to `/v1/tool` over a
 * 127.0.0.1 loopback socket; the host resolves the request against the
 * `ToolSession` registered for the current execution and forwards to the same
 * `callSessionTool` implementation the JS bridge uses.
 */
import { logger } from "@oh-my-pi/pi-utils";
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
	abortRequested?: () => boolean;
}

export interface PyToolBridgeInfo {
	url: string;
	token: string;
}

interface BridgeServer {
	info: PyToolBridgeInfo;
	stop: () => Promise<void>;
}

const registrations = new Map<string, PyToolBridgeEntry>();
let serverPromise: Promise<BridgeServer> | null = null;

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
 *
 * Calls arriving after an abort are rejected before starting. Otherwise the
 * usual path is that the tool observes its own abort and rejects; the race only
 * matters for tools that ignore the signal, keeping the kernel unwinding
 * promptly instead of being hard-killed.
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
	if (entry.shadowCell && identity && name === "read") {
		const claimed = await entry.shadowCell.claim(name, args, identity, Number.MAX_SAFE_INTEGER);
		if (claimed) return bridgeValueFromToolResult(name, args, claimed, entry.emitStatus);
	}
	const call = callSessionTool(name, args, {
		session: entry.toolSession,
		signal: entry.signal,
		emitStatus: entry.emitStatus,
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

async function startServer(): Promise<BridgeServer> {
	const token = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
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
	});

	const info: PyToolBridgeInfo = {
		url: `http://${server.hostname}:${server.port}`,
		token,
	};
	logger.debug("Python tool bridge listening", { url: info.url });

	return {
		info,
		stop: async () => {
			await server.stop(true);
		},
	};
}

/** Starts the bridge server lazily and returns its connection info. */
export async function ensurePyToolBridge(): Promise<PyToolBridgeInfo> {
	if (!serverPromise) {
		serverPromise = startServer();
	}
	try {
		const server = await serverPromise;
		return server.info;
	} catch (err) {
		serverPromise = null;
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

/** Stop the bridge and clear registrations. Test-only / shutdown helper. */
export async function disposePyToolBridge(): Promise<void> {
	registrations.clear();
	const pending = serverPromise;
	serverPromise = null;
	if (!pending) return;
	try {
		const server = await pending;
		await server.stop();
	} catch (err) {
		logger.debug("Failed to stop Python tool bridge", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
