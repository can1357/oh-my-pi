import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ServiceTier,
	TextContent,
	Usage,
} from "@pk-nerdsaver-ai/pi-ai";
import {
	directoryExists,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEnoent,
	logger,
	toError,
} from "@pk-nerdsaver-ai/pi-utils";
import { ArtifactManager } from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore } from "./blob-store";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import { type BuildSessionContextOptions, buildSessionContext, type SessionContext } from "./session-context";
import {
	type BackgroundInstanceEntry,
	type BranchSummaryEntry,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type MCPToolSelectionEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	type ServiceTierChangeEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionMessageEntry,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { findMostRecentSession, listAllSessions, listSessions, type SessionInfo } from "./session-listing";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	writeTerminalBreadcrumb,
} from "./session-paths";
import { prepareEntryForPersistence } from "./session-persistence";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
} from "./session-storage";
import { SessionWriterGuard, type SessionWriterGuardHandle } from "./session-writer-guard";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;

function freezeExecutionProfile(profile: SessionInitEntry["executionProfile"]): SessionInitEntry["executionProfile"] {
	if (!profile) return undefined;
	return Object.freeze({
		...profile,
		modelPool: Object.freeze([...profile.modelPool]),
	});
}

function freezeCollaborationPolicy(
	policy: SessionInitEntry["collaborationPolicy"],
): SessionInitEntry["collaborationPolicy"] {
	if (!policy) return undefined;
	return Object.freeze({
		...policy,
		allowedPeers: Object.freeze([...policy.allowedPeers]),
		familyIds: Object.freeze([...policy.familyIds]),
	});
}

function freezeToolCeiling(ceiling: SessionInitEntry["toolCeiling"]): SessionInitEntry["toolCeiling"] {
	if (!ceiling) return undefined;
	return Object.freeze(ceiling.map(capability => Object.freeze({ source: capability.source, name: capability.name })));
}

function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	return sessionFile ? sessionFile.slice(0, -JSONL_SUFFIX_LENGTH) : null;
}
function replicationBranch(entries: ReadonlyArray<SessionEntry>, leafId: string | null): SessionEntry[] {
	if (leafId === null) return [];
	const byId = new Map(entries.map(entry => [entry.id, entry]));
	if (byId.size !== entries.length) throw new Error("replication snapshot contains duplicate entry ids");
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let cursor = byId.get(leafId);
	while (cursor) {
		if (seen.has(cursor.id)) throw new Error("replication snapshot branch contains a cycle");
		seen.add(cursor.id);
		branch.unshift(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	if (branch.at(-1)?.id !== leafId) throw new Error("replication snapshot active leaf is missing");
	if (branch[0]?.parentId !== null) throw new Error("replication snapshot branch has a missing parent");
	return branch;
}

/**
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. A breadcrumb that points at such a child — a
 * pre-fix poisoned crumb left by a subagent that opened in the parent's TTY, or
 * any nested artifact — must resolve back up to the top-level session so
 * `--continue` resumes the real conversation instead of a subagent transcript.
 */
function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);
	// Walk up while the containing dir is itself a session's artifacts dir
	// (`<dir>.jsonl` exists). Capped to defend against pathological layouts.
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = `${path.dirname(current)}.jsonl`;
		if (!fs.existsSync(parentSessionFile)) return current;
		current = parentSessionFile;
	}
	return current;
}

function emptyUsageStatistics(): UsageStatistics {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * parent→children adjacency, the resolved label map, the active leaf, and the
 * running usage totals. Kept in lockstep with the manager's `#entries` so reads
 * stay O(1)/O(children) instead of rescanning the whole journal.
 */
class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#children = new Map<string | null, SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
	}

	insert(entry: SessionEntry): void {
		this.#entriesById.set(entry.id, entry);
		this.#leaf = entry.id;

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		addUsage(this.#usage, entryUsage(entry));
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		this.#leaf = id;
	}

	childrenOf(parentId: string): SessionEntry[] {
		return [...(this.#children.get(parentId) ?? [])];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		const branch: SessionEntry[] = [];
		const seen = new Set<string>();
		let cursor = id ? this.#entriesById.get(id) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.unshift(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}

		return branch;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getUsageStatistics"
	| "putBlob"
	| "putBlobSync"
>;

export interface SessionReplicationSnapshot {
	header: SessionHeader;
	entries: SessionEntry[];
	leafId: string | null;
}

interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: "auto" | "user" | undefined;
	sessionFile: string | undefined;
	onDisk: boolean;
	needsRewrite: boolean;
	header: SessionHeader;
	entries: SessionEntry[];
}

export interface BackgroundInstanceState {
	name: string;
	status: "active" | "archived";
	model?: string;
	role?: string;
	pinned?: boolean;
	expiresAt?: string;
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: appends are handed
 * to the OS synchronously in-body (so an entry survives an OOM/SIGKILL the
 * instant `appendMessage` returns) but never `fsync`'d. Full-file rewrites go
 * through the storage layer's atomic temp-write+rename so a crash mid-rewrite
 * cannot truncate the prior good file.
 */
export class SessionManager {
	#cwd: string;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;

	#sessionId = "";
	#sessionName: string | undefined;
	#titleSource: "auto" | "user" | undefined;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#entries: SessionEntry[] = [];
	#index = new SessionEntryIndex();

	/** File reflects all current entries; appends can go incrementally. */
	#fileIsCurrent = false;
	/** In-memory entries diverged from disk (load-migration/sanitize) → next persist must full-rewrite. */
	#rewriteRequired = false;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;

	/**
	 * Collab replication tap: invoked for every appended entry with the
	 * in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	/** The single open append writer; the manager only ever writes one file at a time. */
	#writer: SessionStorageWriter | undefined;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/** OS-backed ownership proof spanning the entire writable file-session lifetime. */
	#writerGuard: SessionWriterGuardHandle | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	#sessionNameChangedCallbacks = new Set<() => void>();

	private constructor(cwd: string, sessionDir: string, persist: boolean, storage: SessionStorage) {
		this.#cwd = cwd;
		this.#sessionDir = sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		this.#blobs = new BlobStore(getBlobsDir());

		if (persist && sessionDir) this.#storage.ensureDirSync(sessionDir);
	}

	#requiresWriterGuard(): boolean {
		return this.#persist && this.#storage instanceof FileSessionStorage;
	}

	#acquireWriterGuard(): void {
		if (!this.#requiresWriterGuard() || !this.#sessionFile || !this.#sessionId) return;
		if (this.#writerGuard && !this.#writerGuard.released && this.#writerGuard.sessionId === this.#sessionId) return;
		if (this.#writerGuard && !this.#writerGuard.released) {
			throw new Error("Cannot change writable sessions before releasing the prior writer guard");
		}
		// Share ownership the process already holds: reopening a live session in
		// the same process (reload-style tests, hub rename/archive maintenance,
		// collab replication loading a peer's file) is legitimate — the guard
		// exists to fence *other* processes, and the underlying lock stays held
		// until every in-process handle releases.
		this.#writerGuard = SessionWriterGuard.acquire({
			sessionId: this.#sessionId,
			transcriptPath: this.#sessionFile,
			sameProcessOwner: "share",
		});
	}

	#releaseWriterGuardSync(): void {
		this.#writerGuard?.releaseSync();
		this.#writerGuard = undefined;
	}

	async #releaseWriterGuard(): Promise<void> {
		const guard = this.#writerGuard;
		this.#writerGuard = undefined;
		await guard?.release();
	}
	#rememberBreadcrumb(cwd: string, sessionFile: string): void {
		if (!this.#suppressBreadcrumb) writeTerminalBreadcrumb(cwd, sessionFile);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		if (!this.#diskFailure) this.#diskFailure = error;

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
		}

		return this.#diskFailure;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return;
				if (this.#diskFailure && !options.ignorePriorError) throw this.#diskFailure;
				await work();
			});

		const reported = scheduled.catch(err => {
			throw this.#noteDiskFailure(err);
		});
		this.#diskTail = reported.catch(() => undefined);
		return reported;
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignorePriorError: true, ignoreEpoch: true },
			);
		} finally {
			this.#writer = undefined;
			this.#diskTail = Promise.resolve();
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		if (writer) void writer.close().catch(() => undefined);
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		await writer.close();
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		if (this.#writer?.isOpen()) return this.#writer;

		this.#writer = this.#storage.openWriter(this.#sessionFile, {
			flags: "a",
			onError: err => this.#noteDiskFailure(err),
		});
		return this.#writer;
	}

	#lineFor(entry: FileEntry): string {
		return `${JSON.stringify(prepareEntryForPersistence(entry, this.#blobs))}\n`;
	}

	#fileBody(): string {
		let body = this.#lineFor(this.#header);
		for (const entry of this.#entries) body += this.#lineFor(entry);
		return body;
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 */
	#rewriteSynchronously(): void {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;

		try {
			const body = this.#fileBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			this.#storage.writeTextSync(this.#sessionFile, body);
			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized inside the task — after the writer is
	 * closed — so entries appended before the task runs are included.
	 */
	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;

		const epoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				await this.#closeWriterHandle();
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				await this.#storage.writeTextAtomic(sessionFile, this.#fileBody());
				this.#fileIsCurrent = true;
				this.#rewriteRequired = false;
			},
			{ epoch },
		);
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) throw this.#diskFailure;

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Cold/divergent: not on disk yet, or in-memory entries diverged from the
		// file → rewrite the whole file synchronously and keep going.
		if (!this.#fileIsCurrent || this.#rewriteRequired) {
			this.#rewriteSynchronously();
			return;
		}

		// Hot path: append synchronously so the entry is durable the instant this
		// returns (file/memory writers perform the write in-body). Never routed
		// through the async disk chain — durability must hold without a flush().
		// A mid-close writer leaves `#writer` undefined, so `#appendWriter` simply
		// opens a fresh append handle and the entry still lands.
		try {
			void this.#appendWriter()
				.append(this.#lineFor(entry))
				.catch(err => this.#noteDiskFailure(err));
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#sessionId = mintSessionId();
		this.#sessionName = undefined;
		this.#titleSource = undefined;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
		};

		this.#entries = [];
		this.#index.clear();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
			this.#acquireWriterGuard();
		} else {
			this.#sessionFile = undefined;
		}

		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[]): void {
		this.#header = header;
		this.#entries = entries;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#index.rebuild(entries);
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string } {
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
		};
	}

	#recordEntry(entry: SessionEntry): void {
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#appendToSessionFile(entry);

		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("collab entry hook failed", { error: String(err) });
			}
		}
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#artifactManagerForSession(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		this.#artifactManager = new ArtifactManager(sessionFile.slice(0, -JSONL_SUFFIX_LENGTH));
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of [...this.#sessionNameChangedCallbacks]) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	/** Puts a binary blob into the blob store and returns the blob reference. */
	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	/** Synchronous variant of {@link putBlob} for rebuild-only render paths. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	captureState(): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			sessionFile: this.#sessionFile,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			// Snapshot header + entries by reference: switch/reload replaces the
			// active header/array wholesale, so rollback needs no deep clone.
			header: this.#header,
			entries: [...this.#entries],
		};
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		this.#closeWriterEventually();
		this.#releaseWriterGuardSync();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#applyEntries(snapshot.header, [...snapshot.entries]);
		this.#acquireWriterGuard();
		this.#sessionName = snapshot.sessionName;
		this.#titleSource = snapshot.titleSource;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/** Switch to a different session file (resume / branch). */
	async setSessionFile(sessionFile: string): Promise<void> {
		await this.#drainAndCloseWriter();
		await this.#releaseWriterGuard();
		this.#clearDiskError();

		const resolvedSessionFile = path.resolve(sessionFile);
		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const fileEntries = await loadEntriesFromFile(resolvedSessionFile, this.#storage);
		if (fileEntries.length === 0) {
			// Explicit but empty/missing path (e.g. --session flag): start fresh but
			// keep the requested path and materialize the header immediately.
			this.#resetToNewSession(undefined, resolvedSessionFile);
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = true;
			return;
		}

		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);
		// loadEntriesFromFile guarantees entries[0] is a valid session header.
		const header = fileEntries[0] as SessionHeader;

		// Adopt the loaded session's working directory. Sessions live in a dir
		// keyed by their cwd, so resuming a session from another project must
		// re-point cwd/sessionDir at that project — unless that project directory
		// no longer exists on disk, in which case adopting it (and the process
		// chdir interactive mode then performs) would fail with ENOENT. Keep the
		// current cwd so the resumed session stays where the user already is.
		const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryExists(headerCwd))) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		}

		this.#applyEntries(header, fileEntries.slice(1) as SessionEntry[]);
		this.#acquireWriterGuard();
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;

		if (this.sanitizeLoadedOpenAIResponsesReplayMetadata()) this.#rewriteRequired = true;
	}

	/** Start a new session. Drains and closes any existing writer first. */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#drainAndCloseWriter();
		await this.#releaseWriterGuard();
		return this.#resetToNewSession(options);
	}

	/** Delete a session file and its artifact directory. ENOENT is treated as success. */
	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		try {
			await this.#storage.deleteSessionWithArtifacts(sessionPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	/**
	 * Fork the current session into a new file with the same entries.
	 * @returns the old and new session file paths, or undefined when not persisting.
	 */
	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		const oldSessionFile = this.#sessionFile;
		const parentSessionId = this.#sessionId;
		await this.#drainAndCloseWriter();
		await this.#releaseWriterGuard();
		this.#clearDiskError();

		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#sessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		this.#acquireWriterGuard();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			parentSession: parentSessionId,
		};
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		await this.#rewriteAtomically();
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	/**
	 * Move the session to a new working directory: relocate the session file and
	 * artifacts on disk, update internal references, and rewrite the header cwd.
	 */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir))
		) {
			return;
		}

		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));

		let sessionFileExisted = false;

		if (this.#persist && this.#sessionFile) {
			this.#storage.ensureDirSync(nextSessionDir);
			await this.#drainAndCloseWriter();
			this.#clearDiskError();

			const oldSessionFile = this.#sessionFile;
			const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
			const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile)!;
			const newArtifactsDir = artifactsDirectoryFor(newSessionFile)!;
			const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
			const artifactPathChanged = path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
			sessionFileExisted = this.#storage.existsSync(oldSessionFile);

			let sessionMoved = false;
			let artifactsMoved = false;

			try {
				if (sessionFileExisted && sessionPathChanged) {
					await fs.promises.rename(oldSessionFile, newSessionFile);
					sessionMoved = true;
				}

				if (artifactPathChanged) {
					try {
						const artifactStat = await fs.promises.stat(oldArtifactsDir);
						if (artifactStat.isDirectory()) {
							await fs.promises.rename(oldArtifactsDir, newArtifactsDir);
							artifactsMoved = true;
						}
					} catch (err) {
						if (!isEnoent(err)) throw err;
					}
				}
			} catch (err) {
				if (artifactsMoved) {
					try {
						await fs.promises.rename(newArtifactsDir, oldArtifactsDir);
					} catch (rollbackErr) {
						throw new Error(
							`Failed to move artifacts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
						);
					}
				}

				if (sessionMoved) {
					try {
						await fs.promises.rename(newSessionFile, oldSessionFile);
					} catch (rollbackErr) {
						throw new Error(
							`Failed to move session file and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
						);
					}
				}

				throw err;
			}

			this.#sessionFile = newSessionFile;
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
		}

		this.#cwd = resolvedCwd;
		this.#sessionDir = nextSessionDir;
		this.#header.cwd = resolvedCwd;

		// Rewrite at the new location when the file already existed (update cwd) or
		// there is in-memory output worth materializing; otherwise stay lazy.
		const hasAssistant = this.#historyContainsAssistantMessage();
		if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
		}

		if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
	}

	/**
	 * Force the session onto disk even with no assistant message yet (ACP
	 * session/new must create a discoverable file immediately).
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically();
	}

	/** Flush pending writes. Call before switching sessions or on shutdown. */
	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Synchronously flush all in-memory entries to disk. Use when the process may
	 * exit before an async flush settles (Ctrl+C in the TUI). Software-crash
	 * durable; not atomic and not power-loss safe — a same-process crash never
	 * lands mid-`writeFileSync`.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) throw this.#diskFailure;
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/** Flush, then close the append writer. */
	async close(): Promise<void> {
		if (!this.#persist) return;
		await this.#scheduleDiskWork(async () => {
			const hadWriter = this.#writer !== undefined;
			await this.#closeWriterHandle();
			await this.#releaseWriterGuard();
			if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
				this.#fileIsCurrent = true;
		});
		if (this.#diskFailure) throw this.#diskFailure;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	/**
	 * Open a new per-turn budget window: snapshot the cumulative output baseline,
	 * reset the eval-subagent counter, and set the (optional) ceiling.
	 */
	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		// Non-persistent session: keep an in-memory copy so spill truncation works.
		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): "auto" | "user" | undefined {
		return this.#titleSource;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: "auto" | "user" = "auto"): Promise<boolean> {
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		this.#sessionName = title;
		this.#titleSource = source;
		this.#header.title = title;
		this.#header.titleSource = source;

		if (this.#persist && this.#sessionFile && this.#storage.existsSync(this.#sessionFile)) {
			await this.#rewriteAtomically();
		}

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * Snapshot the session for collab replication: the live header plus a deep
	 * copy of every entry (the host mutates entries in place on rewrite paths, so
	 * guests must not share references).
	 */
	snapshotForReplication(): SessionReplicationSnapshot {
		return {
			header: structuredClone(this.#header),
			entries: structuredClone(this.#entries) as SessionEntry[],
			leafId: this.#index.leafId(),
		};
	}

	/**
	 * Append a message as a child of the current leaf, then advance the leaf.
	 * CompactionSummaryMessage / BranchSummaryMessage are rejected here — they are
	 * top-level entries via appendCompaction()/branchWithSummary().
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			...(configured !== undefined ? { configured } : {}),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTier | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Latest active background-instance marker for this session, if it is currently a background agent. */
	getBackgroundInstance(): BackgroundInstanceState | undefined {
		for (let i = this.#entries.length - 1; i >= 0; i--) {
			const entry = this.#entries[i];
			if (entry?.type !== "background_instance") continue;
			if (entry.status === "archived") return undefined;
			return {
				name: entry.name,
				status: entry.status,
				model: entry.model,
				role: entry.role,
				pinned: entry.pinned,
				expiresAt: entry.expiresAt,
			};
		}
		const headerVal = this.#header.backgroundInstance;
		if (headerVal && headerVal.status === "active") {
			return {
				name: headerVal.name,
				status: headerVal.status,
				model: headerVal.model,
				role: headerVal.role,
				pinned: headerVal.pinned,
				expiresAt: headerVal.expiresAt,
			};
		}
		return undefined;
	}

	/** Append a background-instance marker and mirror it into the header cache so listing sees it without a full scan. */
	appendBackgroundInstance(input: BackgroundInstanceState): string {
		const entry: BackgroundInstanceEntry = { type: "background_instance", ...this.#freshEntryFields(), ...input };
		this.#header.backgroundInstance = { ...input };
		this.#recordEntry(entry);
		this.#rewriteSynchronously();
		return entry.id;
	}

	/** Promote the current session into a persistent named background agent. Returns false if the name sanitizes to empty. */
	async backgroundCurrentSession(input: { name: string; model?: string; role?: string }): Promise<boolean> {
		if (!(await this.setSessionName(input.name, "user"))) return false;
		this.#forceFileCreation = true;
		this.appendBackgroundInstance({
			name: this.getSessionName()!,
			status: "active",
			model: input.model,
			role: input.role,
			pinned: true,
		});
		return true;
	}

	/** Archive the active background-instance marker (the session stays on disk; it just drops out of the background roster). */
	archiveBackgroundInstance(): string | undefined {
		const current = this.getBackgroundInstance();
		if (!current) return undefined;
		return this.appendBackgroundInstance({ ...current, status: "archived" });
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 */
	appendModelChange(model: string, role?: string): string {
		const entry: ModelChangeEntry = { type: "model_change", ...this.#freshEntryFields(), model, role };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		outputSchema?: unknown;
		spawns?: string;
		readSummarize?: boolean;
		fusionSidekick?: boolean;
		maxModelRequestsPerRun?: number;
		executionProfile?: SessionInitEntry["executionProfile"];
		collaborationPolicy?: SessionInitEntry["collaborationPolicy"];
		toolCeiling?: SessionInitEntry["toolCeiling"];
	}): string {
		const entry: SessionInitEntry = {
			type: "session_init",
			...this.#freshEntryFields(),
			...init,
			tools: [...init.tools],
			executionProfile: freezeExecutionProfile(init.executionProfile),
			collaborationPolicy: freezeCollaborationPolicy(init.collaborationPolicy),
			toolCeiling: freezeToolCeiling(init.toolCeiling),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromExtension?: boolean,
		preserveData?: Record<string, unknown>,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromExtension,
			preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Rewrite the session file after in-place entry updates (e.g. pruning old tool
	 * outputs). Use sparingly.
	 */
	async rewriteEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically();
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		attribution: MessageAttribution = "agent",
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(details),
			attribution,
			...this.#freshEntryFields(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append an MCP tool selection entry recording the discovery-selected MCP tools.
	 */
	appendMCPToolSelection(selectedToolNames: string[]): string {
		const entry: MCPToolSelectionEntry = {
			type: "mcp_tool_selection",
			...this.#freshEntryFields(),
			selectedToolNames: [...selectedToolNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Append a TTSR injection entry recording which rules were injected. */
	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** All unique TTSR rule names injected on the current branch (root → leaf). */
	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded.
	 */
	getLastModelChangeRole(): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "model_change") return entry.role ?? "default";
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.#index.get(id);
	}

	/** All direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	/**
	 * Set or clear a label on an entry. Pass undefined/empty to clear.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from an entry to root, returning entries in path order. Includes all
	 * entry types; use buildSessionContext() for the resolved LLM messages.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), options);
	}

	/** Strip stale OpenAI Responses assistant replay metadata from loaded entries. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;

			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}

		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	/** All session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return [...this.#entries];
	}

	/**
	 * The session as a tree. A well-formed session has exactly one root; orphaned
	 * entries (broken parent chain) are returned as roots too.
	 */
	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	/**
	 * Move the leaf to an earlier entry so the next append forms a new branch.
	 * Existing entries are never modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#index.setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#index.setLeaf(null);
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#index.setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to `leafId`.
	 * Returns the new file path, or undefined when not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);

		// Drop label entries from the path; recreate them fresh from the resolved map.
		const entriesToKeep = branchPath.filter(entry => entry.type !== "label");
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: this.#persist ? sourceSessionFile : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#closeWriterEventually();
		this.#releaseWriterGuardSync();
		this.#header = header;
		this.#entries = [...entriesToKeep, ...labels];
		this.#sessionId = newSessionId;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#index.rebuild(this.#entries);
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#forceFileCreation = this.#persist;

		if (!this.#persist) {
			this.#sessionFile = undefined;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			return undefined;
		}

		this.#sessionFile = newSessionFile;
		this.#acquireWriterGuard();
		this.#rewriteSynchronously();
		this.#rememberBreadcrumb(this.#cwd, newSessionFile);
		return newSessionFile;
	}

	/** Resolve the canonical default session directory for a cwd. */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/**
	 * Create a fresh, header-only session file in `cwd`'s default session
	 * directory and return its path. Used by /move to mint the target session
	 * before switching into it; the file is a valid session (one header entry,
	 * no messages) that `setSessionFile` can adopt directly.
	 */
	static createEmptySessionFile(cwd: string): string {
		const resolvedCwd = path.resolve(cwd);
		const sessionDir = SessionManager.getDefaultSessionDir(resolvedCwd);
		fs.mkdirSync(sessionDir, { recursive: true });
		const timestamp = nowIso();
		const sessionId = mintSessionId();
		const sessionFile = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${sessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: resolvedCwd,
		};
		fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
		return sessionFile;
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in the session header)
	 * @param sessionDir Optional session directory; defaults to the cwd-derived dir.
	 */
	static create(cwd: string, sessionDir?: string, storage: SessionStorage = new FileSessionStorage()): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Callers that register
	 * the fork as a named agent (e.g. `/tan`) pass `<agentId>.jsonl` so the
	 * persisted-subagent scan keys the agent by the same id the live ref uses.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { suppressBreadcrumb?: boolean; sessionFile?: string },
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		const sourceEntries = structuredClone(await loadEntriesFromFile(sourcePath, storage)) as FileEntry[];
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const history = sourceEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		manager.#resetToNewSession({ parentSession: sourceHeader?.id }, options?.sessionFile);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#entries = history;
		manager.#index.rebuild(history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		return manager;
	}

	/** Fork an already-decoded replication snapshot without writing plaintext to a temporary file. */
	static async forkFromSnapshot(
		snapshot: SessionReplicationSnapshot,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { suppressBreadcrumb?: boolean; sessionFile?: string },
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		const sourceEntries = structuredClone([snapshot.header, ...snapshot.entries]) as FileEntry[];
		migrateToCurrentVersion(sourceEntries);
		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const allHistory = sourceEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		const history = replicationBranch(allHistory, snapshot.leafId);

		manager.#resetToNewSession({ parentSession: sourceHeader?.id }, options?.sessionFile);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#entries = history;
		manager.#index.rebuild(history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		return manager;
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { initialCwd?: string; suppressBreadcrumb?: boolean },
	): Promise<SessionManager> {
		const loaded = await loadEntriesFromFile(filePath, storage);
		const header = loaded.find(entry => entry.type === "session") as SessionHeader | undefined;
		// Resume into the session's recorded cwd only when that directory still
		// exists. A deleted project dir would make the constructor's #cwd — and the
		// `setProjectDir` chdir interactive mode runs next — point at (and fail on)
		// a missing path, so fall back to the launch cwd and anchor /new and /branch
		// there too, keeping the resumed session where the user already is.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryExists(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		await manager.setSessionFile(filePath);
		return manager;
	}

	/**
	 * Lock-free peek for cold subagent revival: returns the recorded working
	 * directory (session header) and the latest `session_init` contract (system
	 * prompt / tools / output schema) WITHOUT taking the single-writer lock that
	 * {@link open} acquires — the caller re-opens for the actual revive. Returns
	 * null when the file can't be read; `init` is null for files written before
	 * `session_init` was recorded (no faithful contract to rebuild from).
	 */
	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<{
		cwd: string;
		init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			spawns?: string;
			readSummarize?: boolean;
			fusionSidekick?: boolean;
			maxModelRequestsPerRun?: number;
			executionProfile?: SessionInitEntry["executionProfile"];
			collaborationPolicy?: SessionInitEntry["collaborationPolicy"];
			toolCeiling?: SessionInitEntry["toolCeiling"];
		} | null;
	} | null> {
		let loaded: FileEntry[];
		try {
			loaded = await loadEntriesFromFile(filePath, storage);
		} catch {
			return null;
		}
		// A missing/empty file has no usable session — nothing to revive from.
		if (loaded.length === 0) return null;
		const header = loaded.find(entry => entry.type === "session") as SessionHeader | undefined;
		let init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			spawns?: string;
			readSummarize?: boolean;
			fusionSidekick?: boolean;
			maxModelRequestsPerRun?: number;
			executionProfile?: SessionInitEntry["executionProfile"];
			collaborationPolicy?: SessionInitEntry["collaborationPolicy"];
			toolCeiling?: SessionInitEntry["toolCeiling"];
		} | null = null;
		for (let index = loaded.length - 1; index >= 0; index--) {
			const entry = loaded[index];
			if (entry.type === "session_init") {
				init = {
					systemPrompt: entry.systemPrompt,
					task: entry.task,
					tools: [...entry.tools],
					outputSchema: entry.outputSchema,
					readSummarize: entry.readSummarize,
					spawns: entry.spawns,
					fusionSidekick: entry.fusionSidekick,
					maxModelRequestsPerRun: entry.maxModelRequestsPerRun,
					executionProfile: freezeExecutionProfile(entry.executionProfile),
					collaborationPolicy: freezeCollaborationPolicy(entry.collaborationPolicy),
					toolCeiling: freezeToolCeiling(entry.toolCeiling),
				};
				break;
			}
		}
		return { cwd: header?.cwd ?? getProjectDir(), init };
	}

	/** Continue the most recent session, or create a new one if none exists. */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				chosenSession = breadcrumb.sessionFile;
			} else {
				// The terminal's last session started in a different cwd. If that cwd is
				// gone (worktree move/rename) and this location has no sessions of its
				// own, re-root the moved session here instead of starting fresh. When an
				// explicit sessionDir is reused across the move, the stale breadcrumb file
				// may be the newest entry there; prefer a genuine current-cwd session.
				let newestInTargetDir = await findMostRecentSession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !fs.existsSync(breadcrumbCwd);
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd,
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const looksLikeMovedProject =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				if (looksLikeMovedProject) {
					logger.info("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					const manager = await SessionManager.open(breadcrumb.sessionFile, undefined, storage, {
						initialCwd: breadcrumbCwd,
					});
					await manager.moveTo(cwd, sessionDir);
					return manager;
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentSession(dir, storage);

		const manager = new SessionManager(cwd, dir, true, storage);
		if (chosenSession) await manager.setSessionFile(chosenSession);
		else manager.#resetToNewSession();
		return manager;
	}

	/** Create an in-memory session (no file persistence). */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * List sessions for a project directory.
	 * @param sessionDir Optional dir; defaults to the cwd-derived dir.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		return listSessions(dir, storage);
	}

	/** List all sessions across all project directories. */
	static listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return listAllSessions(storage);
	}
}

/**
 * Drop a /move target session that never gained real content. `/move` mints an
 * empty session file (see {@link SessionManager.createEmptySessionFile}) and
 * records it as the owning move marker; if the session is abandoned before any
 * user or assistant message lands, this deletes the file so moves don't litter
 * the session directory. A session that received real messages — or a session
 * whose file is not the marked one — is left untouched.
 */
export async function cleanupEmptyMoveSession(
	manager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	if (!movedFromEmptySessionFile) return;
	const currentFile = manager.getSessionFile();
	if (!currentFile || path.resolve(currentFile) !== path.resolve(movedFromEmptySessionFile)) return;
	const hasRealMessages = manager
		.getEntries()
		.some(entry => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
	if (hasRealMessages) return;
	await manager.dropSession(movedFromEmptySessionFile);
}
