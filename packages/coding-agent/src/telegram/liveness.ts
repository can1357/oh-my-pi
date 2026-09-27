/**
 * Second-writer protection. Before this process opens a session file it asks
 * whether any *other* omp process already holds it: two writers on one JSONL
 * corrupt it. A session this host already holds (the attached relay or an
 * owned topic runtime) is checked first, before the presence registry, so the
 * bridge never refuses itself.
 */
import type { SessionPresence } from "../session/session-presence";
import type { TopicEntry } from "./types";

export const UNKNOWN_LIVENESS_TEXT: string =
	"⚠️ Could not determine whether this session is live in another process, and raising it blindly risks a second writer: check `/sessions` and retry.";

export const LOCAL_HOLDER_TEXT: string =
	"⚠️ This session is already open in this omp process — write in its topic instead of raising a second copy.";

export const secondWriterText = (pid: number): string =>
	`⚠️ This session is currently running in another omp process (pid ${pid}) — writing here is refused because a second writer would corrupt its file. Close it there and the next message will continue it here.`;

export interface LivenessDeps {
	/** Live sessions of other processes; rejects when the presence directory cannot be read. */
	livePresence(): Promise<SessionPresence[]>;
	/** Presence of one specific file in another process; rejects when presence is unreadable. */
	findHolder(sessionFile: string): Promise<SessionPresence | null>;
	/**
	 * True when this process holds the file: the attached relay, an owned topic
	 * runtime, or the hosting process's own interactive session (which keeps
	 * holding it between detach and the next attach).
	 */
	isHeldLocally(sessionFile: string): Promise<boolean>;
	notify(threadId: number | null, markdown: string): Promise<boolean>;
}

/** Process-presence reader; the production default is the session-presence registry. */
export interface PresenceSource {
	list(): Promise<SessionPresence[]>;
	findHolder(sessionFile: string): Promise<SessionPresence | null>;
}

export type HolderLookup =
	| { lookup: "free" }
	| { lookup: "held"; pid: number; local: boolean }
	| { lookup: "unknown"; reason: string | null };

/** Names the process holding `sessionFile`, if any. */
export async function sessionHolder(
	deps: LivenessDeps,
	input: { file?: string | null; id?: string | null },
): Promise<HolderLookup> {
	const file = input.file ?? null;
	if (file !== null && file !== "") {
		const local = await deps.isHeldLocally(file).catch(() => false);
		if (local) return { lookup: "held", pid: process.pid, local: true };
	}
	if (file === null || file === "") {
		// No file to guard: a new session cannot collide.
		if (input.id === null || input.id === undefined) return { lookup: "free" };
		try {
			const sessions = await deps.livePresence();
			const found = sessions.find(session => matchesId(session, input.id as string));
			return found === undefined ? { lookup: "free" } : { lookup: "held", pid: found.pid, local: false };
		} catch (error) {
			return { lookup: "unknown", reason: error instanceof Error ? error.message : String(error) };
		}
	}
	try {
		const holder = await deps.findHolder(file);
		return holder === null ? { lookup: "free" } : { lookup: "held", pid: holder.pid, local: false };
	} catch (error) {
		return { lookup: "unknown", reason: error instanceof Error ? error.message : String(error) };
	}
}

function matchesId(session: SessionPresence, id: string): boolean {
	const held = typeof session.sessionId === "string" ? session.sessionId : "";
	if (held === "") return false;
	return held === id || held.startsWith(id) || id.startsWith(held);
}

export type RaiseRefusal = { ok: false; reason: "busy_session" | "unknown_liveness" } | { ok: true };

/** Gate in front of every lazy raise: refuses when the file is taken elsewhere. */
export async function raiseAllowed(deps: LivenessDeps, entry: TopicEntry): Promise<RaiseRefusal> {
	const file = entry.sessionFile;
	if (typeof file !== "string" || file === "") return { ok: true };
	const holder = await sessionHolder(deps, { file });
	if (holder.lookup === "free") return { ok: true };
	if (holder.lookup === "unknown") {
		await deps.notify(entry.threadId, UNKNOWN_LIVENESS_TEXT);
		return { ok: false, reason: "unknown_liveness" };
	}
	await deps.notify(entry.threadId, holder.local ? LOCAL_HOLDER_TEXT : secondWriterText(holder.pid));
	return { ok: false, reason: "busy_session" };
}

/** Live sessions of other processes, tolerating an unreadable presence directory. */
export async function livePresenceOrEmpty(deps: { livePresence(): Promise<SessionPresence[]> }): Promise<{
	ok: boolean;
	sessions: SessionPresence[];
	reason: string | null;
}> {
	try {
		return { ok: true, sessions: await deps.livePresence(), reason: null };
	} catch (error) {
		return { ok: false, sessions: [], reason: error instanceof Error ? error.message : String(error) };
	}
}
