/**
 * Bun JavaScriptCore remote inspector control.
 *
 * Wraps `bun:jsc`'s `startRemoteDebugger`, which exposes JavaScriptCore's
 * built-in WebKit RemoteInspectorServer over a raw socket. The API is one-shot
 * and rough around the edges (Bun documents it as untested, "may not be
 * supported yet on macOS"):
 *   - it returns `void` and has no stop handle, so we track the live endpoint
 *     at module scope and make starting idempotent;
 *   - it rejects port `0`, so "let the OS pick" is implemented by reserving a
 *     free port via `node:net` and handing the concrete number to Bun;
 *   - on macOS (Bun 1.3.x) it throws a spurious "port already in use" error
 *     even when the server binds fine, so success is decided by a loopback
 *     probe rather than by whether the call threw.
 */

import { startRemoteDebugger } from "bun:jsc";
import * as net from "node:net";

const DEFAULT_HOST = "127.0.0.1";
/** How long to keep probing for the inspector socket before giving up. */
const PROBE_DEADLINE_MS = 1000;
const PROBE_INTERVAL_MS = 50;

export interface RemoteDebuggerInfo {
	host: string;
	port: number;
}

let active: RemoteDebuggerInfo | null = null;
/** In-flight start, shared so concurrent callers coalesce onto one launch. */
let starting: Promise<RemoteDebuggerInfo> | null = null;

/** Underlying starter signature; tests inject a disposable listener in its place. */
export type RemoteDebuggerStarter = (host: string, port: number) => void;

export interface StartRemoteDebuggerOptions {
	/** Explicit port; when omitted a free port is reserved automatically. */
	port?: number;
	/** Override the JSC starter. Defaults to `bun:jsc`'s `startRemoteDebugger`. */
	start?: RemoteDebuggerStarter;
}

/** The live inspector endpoint for this process, or `null` if not started. */
export function getRemoteDebugger(): RemoteDebuggerInfo | null {
	return active;
}

/** Reserve a free TCP port on `host` by binding to `0`, then releasing it. */
async function reserveFreePort(host: string): Promise<number> {
	const server = net.createServer();
	const listening = Promise.withResolvers<number>();
	server.once("error", listening.reject);
	server.listen(0, host, () => {
		const addr = server.address();
		if (addr && typeof addr === "object") listening.resolve(addr.port);
		else listening.reject(new Error("Failed to reserve a debugger port"));
	});
	try {
		return await listening.promise;
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
}

/** Resolve once `host:port` accepts a TCP connection (within one attempt). */
function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host, port });
	let settled = false;
	const finish = (ok: boolean) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(ok);
	};
	socket.setTimeout(timeoutMs);
	socket.once("connect", () => finish(true));
	socket.once("timeout", () => finish(false));
	socket.once("error", () => finish(false));
	return promise;
}

/** Poll the inspector socket until it accepts a connection or the deadline passes. */
async function waitForListening(host: string, port: number): Promise<boolean> {
	const deadline = Date.now() + PROBE_DEADLINE_MS;
	do {
		if (await tryConnect(host, port, PROBE_INTERVAL_MS)) return true;
		await Bun.sleep(PROBE_INTERVAL_MS);
	} while (Date.now() < deadline);
	return false;
}

/**
 * Start the JavaScriptCore remote inspector for this process and return its
 * endpoint. Idempotent: the underlying API cannot be stopped or rebound, so a
 * second call returns the existing endpoint instead of starting again. When
 * `port` is omitted a free port is reserved automatically.
 *
 * Throws only when the socket never comes up; Bun's spurious bind error is
 * swallowed and overridden by the loopback probe.
 */
export async function startRemoteDebuggerServer(options: StartRemoteDebuggerOptions = {}): Promise<RemoteDebuggerInfo> {
	if (active) return active;
	starting ??= launch(options);
	try {
		return await starting;
	} finally {
		starting = null;
	}
}

async function launch({ port, start = startRemoteDebugger }: StartRemoteDebuggerOptions): Promise<RemoteDebuggerInfo> {
	const host = DEFAULT_HOST;
	const chosen = port ?? (await reserveFreePort(host));

	// Something already on this port? Refuse up front: otherwise Bun throws a
	// real bind error and our success probe would connect to that unrelated
	// service, marking a bogus endpoint as the debugger.
	if (await tryConnect(host, chosen, PROBE_INTERVAL_MS)) {
		throw new Error(`Port ${host}:${chosen} is already in use; cannot start remote debugger there.`);
	}

	let thrown: unknown;
	try {
		start(host, chosen);
	} catch (err) {
		// Bun's startRemoteDebugger throws a spurious bind error even on success,
		// so defer the verdict to the loopback probe below.
		thrown = err;
	}

	if (await waitForListening(host, chosen)) {
		active = { host, port: chosen };
		return active;
	}

	throw thrown instanceof Error ? thrown : new Error(`Remote debugger socket never came up on ${host}:${chosen}`);
}

/**
 * Test-only: forget the tracked endpoint so a fresh start can be exercised.
 * Does not (and cannot) stop a real JSC inspector — callers in tests own the
 * disposable listener they injected.
 */
export function __resetRemoteDebuggerForTests(): void {
	active = null;
	starting = null;
}
