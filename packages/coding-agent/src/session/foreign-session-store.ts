import type { SessionManager } from "./session-manager";

/** External coding-agent session source supported by OMP imports. */
export type ForeignSessionSource = "claude" | "codex";

/** Lightweight source metadata used to choose a foreign session before loading its transcript. */
export interface ForeignSessionInfo {
	readonly source: ForeignSessionSource;
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly title?: string;
	readonly created: Date;
	readonly modified: Date;
	readonly messageCount?: number;
	readonly firstMessage?: string;
}

/** Options for one listing pass over a foreign session store. */
export interface ForeignSessionListOptions {
	/**
	 * Reports a directory that exists but could not be read. The listing still
	 * returns everything readable, because one unreadable directory out of many
	 * must not cost the user the rest.
	 */
	warn?: (message: string) => void;
}

/** Lists and converts sessions owned by another coding agent. */
export interface ForeignSessionStore {
	/** Lists source sessions without parsing complete transcripts. */
	list(options?: ForeignSessionListOptions): Promise<ForeignSessionInfo[]>;
	/** Converts one source session into a non-persistent OMP session. */
	load(session: ForeignSessionInfo): Promise<SessionManager>;
}
