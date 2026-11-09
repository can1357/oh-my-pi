import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { SESSION_OWNER_WORKER_ARG } from "../cli/worker-selectors";
import {
	FileSessionStorage,
	type SessionReservation,
	type SessionStorage,
	SessionReservationBusyError,
	SessionReservationUnavailableError,
} from "../session/session-storage";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import {
	decideSessionAttach,
	probeSessionAttach,
	type SessionAttachProbe,
	type SessionAttachRefusalCode,
	type SessionAttachTerminal,
} from "./session-attach";

/** Private launch metadata the broker injects into a session-owner child. */
export const SESSION_OWNER_CONTEXT_ENV = "OMP_SESSION_OWNER_CONTEXT";

/** Broker coordinates of the PTY that hosts this session owner. */
export interface SessionOwnerContext {
	projectDir: string;
	name: string;
	id: string;
}

export interface SessionOwnerLaunchOptions {
	name: string;
	projectDir: string;
	argv: readonly string[];
	env?: Record<string, string>;
}

let activeContext: SessionOwnerContext | undefined;

function parseSessionOwnerContext(raw: string): SessionOwnerContext {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new TypeError("Session owner launch context is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new TypeError("Session owner launch context is not an object");
	}
	const { projectDir, name, id } = parsed as Partial<SessionOwnerContext>;
	if (typeof projectDir !== "string" || projectDir.length === 0) {
		throw new TypeError("Session owner launch context has no project directory");
	}
	if (typeof name !== "string" || name.length === 0) {
		throw new TypeError("Session owner launch context has no daemon name");
	}
	if (typeof id !== "string" || id.length === 0) {
		throw new TypeError("Session owner launch context has no broker generation");
	}
	return { projectDir, name, id };
}

/**
 * Read and erase the broker-injected launch context. Erasing before normal
 * startup keeps the role out of every descendant environment.
 */
export function consumeSessionOwnerContext(env: Record<string, string | undefined>): SessionOwnerContext | undefined {
	const raw = env[SESSION_OWNER_CONTEXT_ENV];
	delete env[SESSION_OWNER_CONTEXT_ENV];
	if (raw === undefined) return undefined;
	const context = parseSessionOwnerContext(raw);
	activeContext = context;
	return context;
}

/** The broker coordinates of the process-local owner role, if this process has it. */
export function sessionOwnerContext(): SessionOwnerContext | undefined {
	return activeContext;
}

/** True only inside the hidden worker that consumed a broker launch context. */
export function isSessionOwnerProcess(): boolean {
	return activeContext !== undefined;
}

/** Drop the process-local owner role between in-process tests. */
export function resetSessionOwnerContextForTest(): void {
	activeContext = undefined;
}

/** What a cold-resume owner does before it may construct a session manager. */
export type SessionOwnerReservation =
	| { kind: "reserved"; reservation: SessionReservation }
	| { kind: "attach"; terminal: SessionAttachTerminal }
	| { kind: "refuse"; code: SessionAttachRefusalCode };

export interface SessionOwnerReserveOptions {
	/** Reads the live publication and lease observation for the target; defaults to {@link probeSessionAttach}. */
	probe?: (sessionId: string) => Promise<SessionAttachProbe>;
	storage?: SessionStorage;
}

/**
 * Decide a cold resume before any session mutation: attach to a live owner,
 * refuse when ownership is not demonstrably free, or take a strict reservation
 * of the target. The reservation is rechecked against a publication that
 * appeared in the window, so a race winner that published after the probe is
 * attached instead of shadowed. A caller that keeps the reservation must hand
 * it to the manager's first claim and release it on startup failure.
 */
export async function reserveSessionOwnerTarget(
	sessionId: string,
	sessionPath: string,
	options: SessionOwnerReserveOptions = {},
): Promise<SessionOwnerReservation> {
	const probe = options.probe ?? ((id: string) => probeSessionAttach(id));
	const decision = decideSessionAttach(await probe(sessionId));
	if (decision.kind !== "cold") return decision;

	const storage = options.storage ?? new FileSessionStorage();
	if (!storage.reserveSession) return { kind: "refuse", code: "ownership-unknown" };
	let reservation: SessionReservation;
	try {
		reservation = storage.reserveSession(sessionId, sessionPath);
	} catch (error) {
		if (error instanceof SessionReservationBusyError) {
			const raced = decideSessionAttach(await probe(sessionId));
			if (raced.kind === "attach") return raced;
			return { kind: "refuse", code: raced.kind === "refuse" ? raced.code : "owner-busy" };
		}
		if (error instanceof SessionReservationUnavailableError) return { kind: "refuse", code: "ownership-unknown" };
		throw error;
	}

	// The reservation itself now answers `owner-busy`, so only a publication
	// that appeared in the window may divert: a reachable owner is attached to
	// and an unreachable or ambiguous one is refused rather than shadowed.
	// Anything else is this reservation, which the caller keeps.
	const after = decideSessionAttach(await probe(sessionId));
	if (after.kind === "attach" || (after.kind === "refuse" && after.code !== "owner-busy")) {
		reservation.release();
		return after;
	}
	return { kind: "reserved", reservation };
}

/** Build the persistent PTY specification that re-enters the CLI as a session owner. */
export function sessionOwnerSpec(options: SessionOwnerLaunchOptions): DaemonSpec {
	const [application, ...entryArgs] = resolveCliEntryCmd();
	if (application === undefined) throw new Error("CLI entry command is empty");
	const env = { ...options.env };
	delete env[SESSION_OWNER_CONTEXT_ENV];
	return {
		name: options.name,
		application,
		args: [...entryArgs, SESSION_OWNER_WORKER_ARG, ...options.argv],
		env,
		cwd: options.projectDir,
		pty: true,
		persist: true,
		detached: false,
		restart: "no",
	};
}

/**
 * Enter the hidden owner route: consume the broker launch context, then run the
 * ordinary root CLI once. The broker is this process's actual supervisor, so no
 * IPC parent watch is installed here.
 */
export async function runSessionOwner(argv: readonly string[]): Promise<void> {
	if (!consumeSessionOwnerContext(process.env)) {
		throw new Error("Session owner worker requires the broker launch context");
	}
	// Static import would drag the CLI graph into every module that reads owner
	// metadata; the reentry is a deliberate load-time cycle boundary.
	const { runCli } = await import("../cli");
	await runCli([...argv]);
}
