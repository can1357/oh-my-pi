/** Options shared by every archive view. */
interface ArchiveOptions {
	/** Maximum rows (1–500). Default 20. */
	limit?: number;
	/** Return the records without printing the formatted listing. */
	silent?: boolean;
}

/** Options for views scoped to one project or every project. */
interface ArchiveScopedOptions extends ArchiveOptions {
	/** Project directory (`~` and relative paths allowed) or `"*"` for every project. Default: current project. */
	project?: string;
}

/** A listed session. Times are ISO-8601 strings. */
interface ArchiveSession {
	id: string;
	/** Session JSONL file. */
	file: string;
	/** Working directory the session ran in. */
	project: string;
	title: string;
	created: string;
	modified: string;
	messages: number;
	status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	/** Newest journaled idle recap. */
	recap?: string;
}

/** A project with its newest session. */
interface ArchiveProject {
	path: string;
	/** Session files in the project, empty ones included. */
	sessions: number;
	lastActive: string;
	latest: ArchiveSession;
}

/** A unique prompt from prompt history with its latest submission's provenance. */
interface ArchivePrompt {
	text: string;
	at: string;
	project?: string;
	session?: string;
	uses: number;
}

/** A journaled idle recap. */
interface ArchiveRecap {
	text: string;
	at: string;
	session: string;
	project: string;
}

/** One session with every recap (oldest first) and its newest `limit` prompts (oldest first). */
interface ArchiveSessionDetail extends ArchiveSession {
	parent?: string;
	recaps: ArchiveRecap[];
	prompts: ArchivePrompt[];
}

/** Read-only view of local history in JavaScript Eval. Each call prints a formatted listing and returns its records. */
declare const archive: {
	/** Recent projects by last activity, each with its newest session and recap. */
	projects(options?: ArchiveOptions): Promise<ArchiveProject[]>;
	/** Newest non-empty sessions with their latest recap. */
	sessions(options?: ArchiveScopedOptions): Promise<ArchiveSession[]>;
	/** One session by id prefix or `.jsonl` path; `limit` caps its prompts. */
	session(id: string, options?: ArchiveOptions): Promise<ArchiveSessionDetail>;
	/** Prompt history, newest first. */
	prompts(options?: ArchiveScopedOptions): Promise<ArchivePrompt[]>;
	/** Prompts containing every query token (prefix or substring match), newest first. */
	search(query: string, options?: ArchiveScopedOptions): Promise<ArchivePrompt[]>;
	/** Journaled idle recaps, newest first. */
	recaps(options?: ArchiveScopedOptions): Promise<ArchiveRecap[]>;
};
