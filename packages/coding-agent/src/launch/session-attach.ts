import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, isEnoent, isPidAlive, isRecord, toError, withTimeout } from "@oh-my-pi/pi-utils";
import { isSessionLeaseHeld } from "../session/session-storage";

export interface SessionAttachTerminal {
	protocolVersion: 1;
	projectDir: string;
	name: string;
	id: string;
}

export type SessionAttachRefusalCode =
	| "owner-unreachable"
	| "terminal-unavailable"
	| "owner-busy"
	| "ownership-unknown";

export type SessionAttachProbe =
	| { status: "live"; sessionId: string; terminal?: SessionAttachTerminal }
	| { status: "unreachable"; sessionId: string; endpoint: string }
	| { status: "unknown"; sessionId: string; reason: string }
	| { status: "absent"; sessionId: string; leaseHeld: boolean | null };

export type SessionAttachDecision =
	| { kind: "attach"; terminal: SessionAttachTerminal }
	| { kind: "cold"; sessionId: string }
	| { kind: "refuse"; code: SessionAttachRefusalCode };

export interface SessionAttachProbeOptions {
	endpointDir?: string;
	timeoutMs?: number;
	sessionPath?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 5_000;

/** Environment variable naming the run directory shared with RPC clients. */
export const SESSION_RUN_DIR_ENV = "OMP_RUN_DIR";

/**
 * The directory that publishes session endpoints. An explicit directory wins;
 * `OMP_RUN_DIR` (trimmed) matches RPC client discovery; otherwise the
 * profile-independent config root is used. Distinct from
 * `OMP_DAEMON_RUNTIME_DIR`, which scopes terminal broker daemons per project.
 */
export function resolveSessionEndpointDir(endpointDir?: string): string {
	if (endpointDir !== undefined) return endpointDir;
	const configured = process.env[SESSION_RUN_DIR_ENV]?.trim();
	return configured || path.join(getBaseConfigRoot(), "run");
}

/**
 * The socket a session owner publishes: one endpoint per session id under the
 * configured session run directory. The owner's terminal generation is not
 * part of the path, so a refreshed owner is reached without rediscovery.
 */
export function sessionAttachEndpoint(sessionId: string, endpointDir?: string): string {
	assertSessionId(sessionId);
	return ipcEndpoint(resolveSessionEndpointDir(endpointDir), sessionId);
}

export interface SessionTerminalRefreshOptions {
	endpointDir?: string;
	timeoutMs?: number;
}

let refreshSequence = 0;

/**
 * Ask the live owner at `sessionId` to repaint the subscriber that is now
 * attached. Both the session id and the terminal generation are verified, so a
 * reply from a replaced owner never counts as a completed refresh.
 */
export async function requestSessionTerminalRefresh(
	sessionId: string,
	generation: string,
	options: SessionTerminalRefreshOptions = {},
): Promise<void> {
	assertSessionId(sessionId);
	if (typeof generation !== "string" || generation.length === 0) {
		throw new TypeError("Session terminal refresh requires an owner generation");
	}
	const endpoint = sessionAttachEndpoint(sessionId, options.endpointDir);
	const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
	const connection = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs });
	const settled = Promise.withResolvers<void>();
	settled.promise.catch(() => {});
	const requestId = `terminal-refresh-${process.pid}-${++refreshSequence}`;

	try {
		connection.start(
			line => {
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					return;
				}
				if (!isRecord(frame)) return;
				if (frame.type === "ready") {
					connection.send(JSON.stringify({ id: requestId, type: "terminal_refresh", sessionId, generation }));
					return;
				}
				if (frame.id !== requestId) return;
				if (frame.type === "terminal_refreshed") {
					if (frame.sessionId !== sessionId) {
						settled.reject(
							new Error(
								`Session terminal refresh answered for "${String(frame.sessionId)}" instead of "${sessionId}"`,
							),
						);
						return;
					}
					if (frame.generation !== generation) {
						settled.reject(
							new Error(
								`Session terminal refresh answered for generation "${String(frame.generation)}" instead of "${generation}"`,
							),
						);
						return;
					}
					settled.resolve();
					return;
				}
				if (frame.type === "terminal_refresh_error") {
					const message =
						typeof frame.message === "string" && frame.message.length > 0
							? frame.message
							: `Session terminal refresh refused for generation "${generation}"`;
					settled.reject(new Error(message));
				}
			},
			reason => {
				settled.reject(new Error(reason ?? `session endpoint ${endpoint} closed during refresh`));
			},
		);
		await withTimeout(
			settled.promise,
			timeoutMs,
			`session endpoint ${endpoint} did not refresh generation "${generation}"`,
		);
	} finally {
		connection.destroy();
	}
}

export function decideSessionAttach(probe: SessionAttachProbe): SessionAttachDecision {
	switch (probe.status) {
		case "live":
			return probe.terminal === undefined
				? { kind: "refuse", code: "terminal-unavailable" }
				: { kind: "attach", terminal: probe.terminal };
		case "unreachable":
			return { kind: "refuse", code: "owner-unreachable" };
		case "unknown":
			return { kind: "refuse", code: "ownership-unknown" };
		case "absent":
			if (probe.leaseHeld === true) return { kind: "refuse", code: "owner-busy" };
			if (probe.leaseHeld === null) return { kind: "refuse", code: "ownership-unknown" };
			return { kind: "cold", sessionId: probe.sessionId };
	}
}

export type RpcSessionAttachDecision =
	| { kind: "attach" }
	| { kind: "cold"; sessionId: string }
	| { kind: "refuse"; code: SessionAttachRefusalCode };

/**
 * RPC bridges need the live session socket, not the terminal generation: a
 * live, probed endpoint is attachable even when its publication carries no
 * terminal coordinates (e.g. an older RPC-only host). Everything else keeps
 * the ownership refusal semantics of {@link decideSessionAttach}.
 */
export function decideRpcSessionAttach(probe: SessionAttachProbe): RpcSessionAttachDecision {
	switch (probe.status) {
		case "live":
			return { kind: "attach" };
		case "unreachable":
			return { kind: "refuse", code: "owner-unreachable" };
		case "unknown":
			return { kind: "refuse", code: "ownership-unknown" };
		case "absent":
			if (probe.leaseHeld === true) return { kind: "refuse", code: "owner-busy" };
			if (probe.leaseHeld === null) return { kind: "refuse", code: "ownership-unknown" };
			return { kind: "cold", sessionId: probe.sessionId };
	}
}

export async function probeSessionAttach(
	sessionId: string,
	options: SessionAttachProbeOptions = {},
): Promise<SessionAttachProbe> {
	assertSessionId(sessionId);
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const endpointDir = resolveSessionEndpointDir(options.endpointDir);
	const endpoint = sessionAttachEndpoint(sessionId, endpointDir);
	const sidecarPath = path.join(endpointDir, `${sessionId}.json`);

	const publication = await readPublication(sidecarPath, sessionId);
	if (publication.kind === "unknown") return { status: "unknown", sessionId, reason: publication.reason };
	if (publication.kind === "invalid") return { status: "unreachable", sessionId, endpoint };
	if (options.sessionPath !== undefined && publication.kind === "absent") {
		return { status: "absent", sessionId, leaseHeld: isSessionLeaseHeld(sessionId) };
	}
	if (
		options.sessionPath !== undefined &&
		(publication.kind !== "published" ||
			publisherProvablyGone(publication) ||
			!(await matchesSessionPath(publication.metadata?.sessionFile, options.sessionPath)))
	) {
		return { status: "unreachable", sessionId, endpoint };
	}

	const observation = await observeLiveSession(endpoint, sessionId, timeoutMs, options.sessionPath);
	if (observation === "live") {
		if (options.sessionPath !== undefined) {
			const current = await readPublication(sidecarPath, sessionId);
			const beforeTerminal = terminalFromMetadata(
				publication.kind === "published" ? publication.metadata : undefined,
			);
			const afterTerminal = terminalFromMetadata(current.kind === "published" ? current.metadata : undefined);
			if (
				current.kind !== "published" ||
				publisherProvablyGone(current) ||
				publication.kind !== "published" ||
				current.metadata?.pid !== publication.metadata?.pid ||
				beforeTerminal?.projectDir !== afterTerminal?.projectDir ||
				beforeTerminal?.name !== afterTerminal?.name ||
				beforeTerminal?.id !== afterTerminal?.id ||
				!(await matchesSessionPath(current.metadata?.sessionFile, options.sessionPath))
			) {
				return { status: "unreachable", sessionId, endpoint };
			}
		}
		const terminal = terminalFromMetadata(publication.kind === "published" ? publication.metadata : undefined);
		return terminal === undefined ? { status: "live", sessionId } : { status: "live", sessionId, terminal };
	}
	if (observation === "unreachable") {
		const current = await readPublication(sidecarPath, sessionId);
		if (publisherProvablyGone(current)) {
			return { status: "absent", sessionId, leaseHeld: isSessionLeaseHeld(sessionId) };
		}
		return { status: "unreachable", sessionId, endpoint };
	}

	const refreshed = await readPublication(sidecarPath, sessionId);
	if (refreshed.kind === "absent" || publisherProvablyGone(refreshed)) {
		return { status: "absent", sessionId, leaseHeld: isSessionLeaseHeld(sessionId) };
	}
	if (refreshed.kind === "unknown") return { status: "unknown", sessionId, reason: refreshed.reason };
	return { status: "unreachable", sessionId, endpoint };
}

type PublicationObservation =
	| { kind: "absent" }
	| { kind: "published"; metadata?: SessionAttachMetadata }
	| { kind: "invalid" }
	| { kind: "unknown"; reason: string };

function publisherProvablyGone(publication: PublicationObservation): boolean {
	return (
		publication.kind === "published" && publication.metadata !== undefined && !isPidAlive(publication.metadata.pid)
	);
}

interface SessionAttachMetadata {
	pid: number;
	sessionId: string;
	sessionFile?: unknown;
	terminal?: unknown;
}

async function readPublication(sidecarPath: string, sessionId: string): Promise<PublicationObservation> {
	let raw: string;
	try {
		raw = await fs.readFile(sidecarPath, "utf8");
	} catch (error) {
		return isEnoent(error) ? { kind: "absent" } : { kind: "unknown", reason: toError(error).message };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "invalid" };
	}
	const metadata = parseMetadata(parsed, sessionId);
	return metadata === undefined ? { kind: "invalid" } : { kind: "published", metadata };
}

function parseMetadata(value: unknown, sessionId: string): SessionAttachMetadata | undefined {
	if (!isRecord(value)) return undefined;
	const { pid, sessionId: observedSessionId } = value;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (observedSessionId !== sessionId) return undefined;
	return { pid, sessionId, sessionFile: value.sessionFile, terminal: value.terminal };
}

function terminalFromMetadata(metadata: SessionAttachMetadata | undefined): SessionAttachTerminal | undefined {
	const terminal = metadata?.terminal;
	if (!isRecord(terminal) || terminal.protocolVersion !== 1) return undefined;
	const { projectDir, name, id } = terminal;
	if (typeof projectDir !== "string" || projectDir.length === 0) return undefined;
	if (typeof name !== "string" || name.length === 0) return undefined;
	if (typeof id !== "string" || id.length === 0) return undefined;
	return { protocolVersion: 1, projectDir, name, id };
}

async function matchesSessionPath(observed: unknown, expected: string): Promise<boolean> {
	if (typeof observed !== "string" || !path.isAbsolute(observed)) return false;
	try {
		return (await fs.realpath(observed)) === expected && (await fs.realpath(expected)) === expected;
	} catch {
		return false;
	}
}

type LiveObservation = "live" | "unreachable" | "vanished";

let probeSequence = 0;

async function observeLiveSession(
	endpoint: string,
	sessionId: string,
	timeoutMs: number,
	sessionPath?: string,
): Promise<LiveObservation> {
	let connection: IpcConnection;
	try {
		connection = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs });
	} catch (error) {
		return isEnoent(error) ? "vanished" : "unreachable";
	}

	const ready = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Record<string, unknown>>();
	ready.promise.catch(() => {});
	response.promise.catch(() => {});
	const requestId = `attach-probe-${process.pid}-${++probeSequence}`;
	let requested = false;

	try {
		connection.start(
			line => {
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					return;
				}
				if (!isRecord(frame)) return;
				if (!requested && frame.type === "ready") {
					requested = true;
					ready.resolve();
					connection.send(JSON.stringify({ id: requestId, type: "get_state" }));
					return;
				}
				if (frame.type === "response" && frame.id === requestId) response.resolve(frame);
			},
			reason => {
				const error = new Error(reason ?? "session endpoint closed");
				ready.reject(error);
				response.reject(error);
			},
		);
		await withTimeout(ready.promise, timeoutMs, `session endpoint ${endpoint} did not complete its handshake`);
		const state = await withTimeout(
			response.promise,
			timeoutMs,
			`session endpoint ${endpoint} did not answer get_state`,
		);
		if (state.success !== true) return "unreachable";
		const data = isRecord(state.data) ? state.data : undefined;
		if (data?.sessionId !== sessionId) return "unreachable";
		if (sessionPath !== undefined && !(await matchesSessionPath(data.sessionFile, sessionPath))) return "unreachable";
		return "live";
	} catch {
		return "unreachable";
	} finally {
		connection.destroy();
	}
}

function assertSessionId(sessionId: string): void {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new TypeError("Session attach probe requires a session id");
	}
	if (sessionId === "." || sessionId === ".." || sessionId.includes("/") || sessionId.includes("\\")) {
		throw new TypeError(`Session id cannot name a path: ${sessionId}`);
	}
}
