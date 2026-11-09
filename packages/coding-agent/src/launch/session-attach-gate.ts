import {
	findSessionContinuation,
	readSessionInfo,
	resolveResumeTarget,
	type SessionContinuation,
	type SessionInfo,
} from "../session/session-listing";
import { SessionManager, type ContinueRecentTarget } from "../session/session-manager";
import { FileSessionStorage, type SessionReservation, type SessionStorage } from "../session/session-storage";
import {
	probeSessionAttach,
	type SessionAttachProbe,
	type SessionAttachRefusalCode,
	type SessionAttachTerminal,
} from "./session-attach";
import { reserveSessionOwnerTarget } from "./session-owner";

/** The startup target a session-attach decision was made for. */
export interface ResolvedSessionTarget {
	readonly session: SessionInfo;
	readonly continuation?: SessionContinuation;
	/** Present when the target came from `--continue` or auto-resume selection. */
	readonly recent?: ContinueRecentTarget;
}

export interface SessionAttachGateOptions {
	readonly cwd: string;
	readonly sessionDir?: string;
	readonly resume?: string | true;
	readonly continue?: boolean;
	readonly fork?: string;
	readonly noSession?: boolean;
	readonly goal?: string;
	readonly fromClaude?: boolean;
	readonly fromCodex?: boolean;
	/** The effective `autoResume` setting; only consulted when no other target flag is set. */
	readonly autoResume?: boolean;
	/** Reads the live publication and lease observation; defaults to {@link probeSessionAttach}. */
	readonly probe?: (sessionId: string) => Promise<SessionAttachProbe>;
	readonly storage?: SessionStorage;
	readonly endpointDir?: string;
}

/** What a launch may do with the session it was asked to open. */
export type SessionAttachGate =
	| { readonly kind: "none" }
	| { readonly kind: "attach"; readonly target: ResolvedSessionTarget; readonly terminal: SessionAttachTerminal }
	| {
			readonly kind: "cold";
			readonly target: ResolvedSessionTarget;
			readonly reservation: SessionReservation;
	  }
	| { readonly kind: "refuse"; readonly sessionId: string; readonly code: SessionAttachRefusalCode };

/**
 * Resolve the session this launch targets, then decide whether it can be
 * attached, must be refused, or may be opened cold under a strict
 * reservation. Returns `none` when the launch starts a fresh session or
 * explicitly forks/imports one; resolution failures stay for the caller's
 * existing error paths.
 */
export async function resolveStartupSessionGate(options: SessionAttachGateOptions): Promise<SessionAttachGate> {
	const target = await resolveStartupTarget(options);
	if (!target) return { kind: "none" };
	return gateSessionTarget(target, options);
}

/**
 * Decide ownership for a target selected interactively, e.g. from the resume
 * picker, before any session manager is constructed for it.
 */
export async function gateSessionTarget(
	target: ResolvedSessionTarget,
	options: SessionAttachGateOptions,
): Promise<SessionAttachGate> {
	const endpointDir = options.endpointDir;
	const outcome = await reserveSessionOwnerTarget(target.session.id, target.session.path, {
		probe: options.probe ?? (endpointDir ? id => probeSessionAttach(id, { endpointDir }) : undefined),
		storage: options.storage,
	});
	if (outcome.kind === "reserved") return { kind: "cold", target, reservation: outcome.reservation };
	if (outcome.kind === "attach") return { kind: "attach", target, terminal: outcome.terminal };
	return { kind: "refuse", sessionId: target.session.id, code: outcome.code };
}

/** The user-facing refusal for a target this process must not open. */
export function describeSessionAttachRefusal(sessionId: string, code: SessionAttachRefusalCode): string {
	switch (code) {
		case "owner-unreachable":
			return `Session "${sessionId}" is owned by a live omp process whose attach endpoint is unreachable; refusing to open a second transcript. Stop that process or restore its endpoint, then retry.`;
		case "terminal-unavailable":
			return `Session "${sessionId}" is live but hosted outside a terminal; refusing to open a second transcript. Attach to its RPC/Web endpoint instead.`;
		case "owner-busy":
			return `Session "${sessionId}" is owned by another omp process; refusing to open a second transcript. Close it there, then retry.`;
		case "ownership-unknown":
			return `Cannot determine whether session "${sessionId}" is owned; refusing to open a second transcript. Retry once its ownership lease is readable.`;
	}
}

async function resolveStartupTarget(options: SessionAttachGateOptions): Promise<ResolvedSessionTarget | undefined> {
	if (options.noSession || options.fork !== undefined || options.fromClaude || options.fromCodex) return undefined;
	if (options.resume === true) return undefined;

	if (typeof options.resume === "string") {
		const sessionArg = options.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
			const continuation = await findSessionContinuation(sessionArg);
			const session = await readSessionInfo(continuation?.session.path ?? sessionArg);
			return session ? { session, continuation } : undefined;
		}
		const match = await resolveResumeTarget(sessionArg, options.cwd, options.sessionDir);
		return match ? { session: match.session, continuation: match.continuation } : undefined;
	}

	if (options.continue) return resolveRecentTarget(options);
	if (options.autoResume && options.goal === undefined && options.sessionDir === undefined) {
		return resolveRecentTarget(options);
	}
	return undefined;
}

async function resolveRecentTarget(options: SessionAttachGateOptions): Promise<ResolvedSessionTarget | undefined> {
	const storage = options.storage ?? new FileSessionStorage();
	const recent = await SessionManager.resolveContinueTarget(options.cwd, options.sessionDir, storage);
	if (!recent.sessionPath) return undefined;
	const session = await readSessionInfo(recent.sessionPath);
	return session ? { session, continuation: recent.continuation, recent } : undefined;
}
