import * as fs from "node:fs";
import * as util from "node:util";
import * as path from "node:path";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ServiceTierByFamily,
	TextContent,
	Usage,
} from "@oh-my-pi/pi-ai";
import { messageEstimateVersion } from "@oh-my-pi/pi-agent-core/compaction";
import {
	directoryIsEnterable,
	directoryIsMissing,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEexist,
	isEnoent,
	isEnotdir,
	isEnotempty,
	isFsError,
	logger,
	pathIsWithin,
	stringifyJson,
	toError,
} from "@oh-my-pi/pi-utils";
import { isTaskToolDetails, type StructuredSubagentSchemaMode } from "@oh-my-pi/pi-tui/tools/task";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { moveFileAcrossDevices } from "../utils/atomic-file";
import { hasAnnotationDraftsSync } from "../extensibility/custom-commands/bundled/annotate/draft-store";
import { ArtifactManager } from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore, lazyImageDataSync } from "./blob-store";
import type { CompactionMethod } from "./compaction-methods";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import { createInterruptedToolResults, sessionExitFollowsLastMessage } from "./exit-diagnostics";
import type { RetryFallbackRole } from "./retry-fallback-chains";
import {
	type BuildSessionContextOptions,
	buildSessionContext,
	type SessionContext,
	snapcompactHistoryBlockOptions,
} from "./session-context";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CredentialPinEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	EPHEMERAL_MODEL_CHANGE_ROLE,
	PREWALK_MODEL_CHANGE_ROLE,
	type FileEntry,
	type LabelEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type ModelUsageEntry,
	lastSelfSelectedLeafId,
	type NewSessionOptions,
	type ResetBoundaryEntry,
	type ServiceTierChangeEntry,
	sessionEntryLeafId,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { currentRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity";
import {
	filterSessionsForPicker,
	findMostRecentNonEmptySession,
	findRecentSessionContinuation,
	findSessionContinuation,
	isEmptySession,
	listAllSessions,
	listSessions,
	type SessionContinuation,
	type SessionInfo,
} from "./session-listing";
import {
	loadEntriesFromFile,
	loadSessionFile,
	normalizeAssistantUsage,
	parseSessionContent,
	readSessionHeaderId,
	resolveBlobRefsInEntries,
	resolveBlobRefsInEntriesSync,
	type SessionLoadResult,
	visitEntriesFromFile,
} from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	hasPositiveMovedProjectEvidence,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	worktreeSessionDirs,
	writeTerminalBreadcrumb,
} from "./session-paths";
import {
	ANTHROPIC_SERVER_TOOL_BLOCK_FIELDS,
	atomicPersistenceCarrierKeys,
	forgetExternalizedImages,
	isAtomicPersistenceNodeOwnFields,
	isSnapcompactArchiveSlot,
	MAX_PROTOTYPE_CHAIN_DEPTH,
	prepareEntryForPersistence,
	projectorImageField,
	snapcompactArchiveStampable,
	TRANSIENT_PERSISTENCE_KEYS,
} from "./session-persistence";
import { loadPinnedSessionIds, sortPinnedFirst } from "./session-pins";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
	SessionWriteConflictError,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	normalizeWorkspaceDirectory,
} from "./session-workspace";
import { recordSessionRecap, recordSessionTitle } from "./session-index";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;
const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";
const DISCARDED_ENTRY_BRANCH_MARKER = "discarded-entry-branch";
/**
 * Read-back-and-retry passes one full rewrite makes after meeting another
 * writer's entries. Each pass re-reads the file, so only a writer that appends
 * inside every read-to-publish window exhausts them.
 */
const MAX_WRITE_CONFLICT_RECOVERIES = 3;

/** A fresh session id. */
export function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

/**
 * `moveTo` refused before anything moved: another live omp process writes the
 * session, or the session file at the destination.
 */
export class SessionMoveRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionMoveRefusedError";
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH);
}

/**
 * Copy a session's artifact directory to another session, matching interactive
 * `/fork`. Never overwrites: a destination file written while the copy runs
 * (a session that already moved and kept working) wins over the source's copy.
 * Failures are logged, never thrown.
 */
export async function copySessionArtifacts(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
	// Artifacts sit beside the journal's real name: a session reached through a
	// symlink keeps them next to the link's target, not next to the link.
	let realSource = sourceSessionFile;
	try {
		realSource = await fs.promises.realpath(sourceSessionFile);
	} catch {}
	const sourceArtifactsDir = artifactsDirectoryFor(realSource);
	const destinationArtifactsDir = artifactsDirectoryFor(destinationSessionFile);
	if (!sourceArtifactsDir || !destinationArtifactsDir) return;
	if (path.resolve(sourceArtifactsDir) === path.resolve(destinationArtifactsDir)) return;
	try {
		if ((await fs.promises.stat(sourceArtifactsDir)).isDirectory()) {
			// Create the destination first and merge into it: Bun's `cp` fails with
			// EEXIST when another writer (the moved session's artifact manager,
			// `local://`) creates the directory while the copy is starting.
			await fs.promises.mkdir(destinationArtifactsDir, { recursive: true });
			await fs.promises.cp(sourceArtifactsDir, destinationArtifactsDir, {
				recursive: true,
				force: false,
				errorOnExist: false,
			});
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to copy session artifacts", {
				sourceArtifactsDir,
				destinationArtifactsDir,
				error: toError(error).message,
			});
		}
	}
}

/** The numeric id an artifact file name (`<id>.<tool>.log`) carries, if any. */
function artifactIdOf(name: string): string | undefined {
	return /^(\d+)\./.exec(name)?.[1];
}

/**
 * Move one directory entry without replacing anything that has appeared at
 * `to` since the caller listed the destination. `link(2)` refuses an existing
 * target where `rename(2)` would silently overwrite it; where hard links are
 * unavailable an exclusive copy keeps the same guarantee. A directory rename
 * only ever replaces an empty directory, which is harmless.
 */
async function moveEntryWithoutReplacing(from: string, to: string, isDirectory: boolean): Promise<void> {
	if (isDirectory) {
		await fs.promises.rename(from, to);
		return;
	}
	try {
		await fs.promises.link(from, to);
	} catch (err) {
		if (isEexist(err)) throw err;
		await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
	}
	try {
		await fs.promises.unlink(from);
	} catch (err) {
		// The entry has landed; a second copy left behind is not a failed move.
		if (!isEnoent(err)) logger.debug("Artifact placed but its source copy could not be removed", { from, to });
	}
}

/** What `destination` currently holds: entries by name, and the artifact ids (`<id>.<tool>.log`) already in use. */
async function destinationOccupancy(
	destination: string,
): Promise<{ occupants: Map<string, fs.Dirent>; takenIds: Set<string> }> {
	const present = await fs.promises.readdir(destination, { withFileTypes: true });
	const occupants = new Map(present.map(entry => [entry.name, entry]));
	const takenIds = new Set<string>();
	for (const entry of present) {
		const id = artifactIdOf(entry.name);
		if (id !== undefined) takenIds.add(id);
	}
	return { occupants, takenIds };
}

/**
 * Move `source`'s entries into `destination`, recursing into directories that
 * exist on both sides, then remove `source` once it is empty. Nothing at the
 * destination is ever replaced: an entry whose name — or, for `<id>.<tool>.log`
 * artifact files, whose id — is already taken stays at the source, as does one
 * whose move fails. Once moving has begun this never throws, so the caller is
 * never left with a session file rolled back away from artifacts that already
 * moved. Returns the entries left at the source, each with its reason.
 */
async function mergeDirectoryInto(
	source: string,
	destination: string,
	stranded: string[] = [],
	prefix = "",
): Promise<string[]> {
	let { occupants, takenIds } = await destinationOccupancy(destination);
	const strandedBefore = stranded.length;
	for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		const label = prefix + entry.name;
		const id = artifactIdOf(entry.name);
		try {
			// A writer can publish another `<id>.*` file while earlier entries move,
			// and a different file name slips past link(2)'s EEXIST; list again right
			// before an id-bearing move so the check is one syscall old, not the
			// whole merge. Inside the boundary: a failed listing strands this entry
			// like a failed move would, instead of aborting a merge already under way.
			if (id !== undefined) ({ occupants, takenIds } = await destinationOccupancy(destination));
			const occupant = occupants.get(entry.name);
			if (occupant === undefined && (id === undefined || !takenIds.has(id))) {
				if (entry.isDirectory()) {
					try {
						await moveEntryWithoutReplacing(from, to, true);
					} catch (err) {
						if (!isFsError(err) || err.code !== "EXDEV") throw err;
						await fs.promises.mkdir(to);
						await mergeDirectoryInto(from, to, stranded, `${label}/`);
					}
				} else {
					await moveEntryWithoutReplacing(from, to, false);
				}
			} else if (occupant?.isDirectory() && entry.isDirectory()) {
				await mergeDirectoryInto(from, to, stranded, `${label}/`);
			} else {
				stranded.push(`${label} (${occupant === undefined ? "id" : "name"} taken)`);
			}
		} catch (err) {
			// ENOENT: the entry vanished under us (a writer's temp file); nothing to move.
			if (!isEnoent(err)) stranded.push(`${label} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	try {
		await fs.promises.rmdir(source);
	} catch (err) {
		// Still occupied by a collision recorded above, by an entry a writer landed
		// mid-merge, or held open (EBUSY): the directory stays behind.
		if (!isEnoent(err) && (stranded.length === strandedBefore || !isEnotempty(err))) {
			stranded.push(`${prefix || "."} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	return stranded;
}

/**
 * Relocate a session's artifacts directory for {@link SessionManager.moveTo}.
 *
 * The destination may already exist: a session moving back into a bucket it
 * lived in before finds its own `<id>/` there whenever a writer that captured
 * the old path — subagents adopt the parent's `ArtifactManager`, eval
 * subprocesses inherit `PI_ARTIFACTS_DIR` — kept writing after the move away.
 * Renaming onto an existing directory fails with a platform-specific code
 * (ENOTEMPTY, EEXIST, EPERM on Windows), so the fallback is decided by what is
 * there, not by the code: an existing directory is merged into.
 *
 * A name or artifact id taken on both sides is left at the source rather than
 * resolved: artifact ids resolve by `<id>.` prefix against one directory, so
 * overwriting the destination copy or parking a renamed duplicate beside it
 * would each destroy or misdirect a referenced artifact. The copy already at
 * the destination keeps the id; the session's own copy stays at the source,
 * retained on disk under the path the header's `previousSessionFiles` records
 * but not reachable through `artifact://` — two writers that shared one id
 * space cannot both be.
 */
async function relocateArtifactsDirectory(source: string, destination: string): Promise<"renamed" | "merged"> {
	try {
		await fs.promises.rename(source, destination);
		return "renamed";
	} catch (err) {
		// lstat on both sides: a symlink is never merged through, whichever end it
		// is on — the destination's target is not this session's directory, and a
		// symlinked source would have its target's contents moved out from under
		// it. Only a real directory on each side is a merge.
		const [occupant, origin] = await Promise.all([
			fs.promises.lstat(destination).catch((statErr: unknown) => {
				if (isEnoent(statErr)) return null;
				throw err;
			}),
			fs.promises.lstat(source),
		]);
		if (occupant === null && origin.isDirectory() && isFsError(err) && err.code === "EXDEV") {
			await fs.promises.mkdir(destination);
		} else if (occupant === null || !occupant.isDirectory() || !origin.isDirectory()) {
			throw err;
		}
	}
	const stranded = await mergeDirectoryInto(source, destination);
	if (stranded.length > 0) {
		logger.warn("Merged session artifacts into an existing directory; some entries left at source", {
			source,
			destination,
			stranded,
		});
	} else {
		logger.info("Merged session artifacts into an existing directory", { source, destination });
	}
	return "merged";
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
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
		subagentCost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "model_usage") return entry.usage;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

/** Complete incomplete assistant usage in loaded history; returns how many messages were repaired. */
function normalizeLoadedUsage(entries: SessionEntry[]): number {
	let repaired = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant" && normalizeAssistantUsage(entry.message)) {
			repaired++;
		}
	}
	return repaired;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

/**
 * Zero the monetary attribution on one usage record in place, leaving token
 * counts untouched. Cost, credit meters, and premium-request counts describe
 * billing; forks that must not inherit spend (see {@link SessionManager.forkFrom}
 * `resetInheritedCost`) drop them while keeping the tokens compaction relies on.
 */
function resetUsageCost(usage: Usage | undefined): void {
	if (!usage) return;
	usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	usage.credits = undefined;
	usage.premiumRequests = undefined;
}

/** Clear child billing kept in task results without discarding their token counts. */
function resetTaskResultBilling(details: unknown): void {
	if (!isTaskToolDetails(details)) return;
	resetUsageCost(taskUsageFrom(details));
	for (const result of details.results) {
		if (result === null || typeof result !== "object") continue;
		resetUsageCost(taskUsageFrom(result));
		resetNestedTaskBilling(result.extractedToolData);
	}
	const progress = details.progress;
	if (Array.isArray(progress)) {
		for (const item of progress) {
			if (item === null || typeof item !== "object") continue;
			if (typeof item.cost === "number") item.cost = 0;
			resetTaskResultBilling(item.inflightTaskDetails);
			resetNestedTaskBilling(item.extractedToolData);
		}
	}
}

/** Recurse only through task snapshots extracted from the task subprocess tool. */
function resetNestedTaskBilling(extractedToolData: Record<string, unknown[]> | undefined): void {
	const tasks = extractedToolData?.task;
	if (!Array.isArray(tasks)) return;
	for (const task of tasks) resetTaskResultBilling(task);
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	// Startup-recorded selector state that does not survive as user intent
	// once the draft is cleared. `mode_change` covers the `plan.defaultOnStartup`
	// path (interactive-mode.ts enters plan mode before draft restoration) and
	// `/plan` toggles that leave the session otherwise empty; entries carrying
	// real conversation state — messages, compactions, branch summaries,
	// custom/custom_message, session_init, labels, title/tool selection — never
	// reach this branch and always keep the file resumable.
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "credential_pin":
			return true;
		default:
			return false;
	}
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
	// Branch memo: getBranch() walks leaf-to-root per call (array + Set +
	// reverse) on per-frame/per-turn paths. The branch only changes on
	// insert/rebuild/setLeaf, so cache the array keyed on (leaf, generation).
	// An insert that extends the current leaf appends to the memo in place
	// (O(1)) instead of discarding it. `branchView()` hands the memo out
	// read-only and live: it grows when such an insert lands, while a leaf
	// change or rebuild starts a fresh array (the old one is never mutated).
	#generation = 0;
	#branchCache: { leaf: string | null | undefined; generation: number; branch: SessionEntry[] } | undefined;

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
		this.#generation++;
		this.#branchCache = undefined;
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
		// A captured late-usage leaf can dangle after its target was rolled back or rewritten away.
		if (this.#leaf !== null && !this.#entriesById.has(this.#leaf)) this.setLeaf(lastSelfSelectedLeafId(entries));
	}

	insert(entry: SessionEntry): void {
		const previousLeaf = this.#leaf;
		const isNew = !this.#entriesById.has(entry.id);
		this.#entriesById.set(entry.id, entry);
		// Late usage is physically last but replays to the active leaf captured at append time.
		const nextLeaf = sessionEntryLeafId(entry);
		this.#leaf = nextLeaf;
		this.#generation++;
		const cache = this.#branchCache;
		if (
			isNew &&
			nextLeaf === entry.id &&
			cache !== undefined &&
			cache.generation === this.#generation - 1 &&
			cache.leaf === previousLeaf &&
			entry.parentId === previousLeaf &&
			entry.parentId !== null
		) {
			cache.branch.push(entry);
			cache.leaf = entry.id;
			cache.generation = this.#generation;
		} else {
			this.#branchCache = undefined;
		}

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		const usage = entryUsage(entry);
		addUsage(this.#usage, usage);
		// Completed `task` results carry the child's spend; tracked apart so the
		// status line can split the session's own cost from its subagents'.
		if (usage && entry.type === "message" && entry.message.role === "toolResult") {
			this.#usage.subagentCost += usage.cost.total;
		}
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
		if (this.#leaf === id) return;
		this.#leaf = id;
		this.#generation++;
		this.#branchCache = undefined;
	}

	/**
	 * Stop extending the issued branch view in place: the next insert starts a
	 * fresh memo. For inserts whose leaf move is undone right after, which must
	 * not grow a view held by callers.
	 */
	detachBranchView(): void {
		this.#branchCache = undefined;
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
		// The memoized default-leaf branch stays private — callers may
		// sort/reverse/splice the result (the return type is SessionEntry[]),
		// so hand out a copy. Explicit fromId walks (rare) bypass the cache.
		if (id === undefined || id === this.#leaf) return this.branchView().slice();
		return this.#walk(id);
	}

	/** The memoized active-leaf branch, without copying. Callers MUST NOT mutate it. */
	branchView(): readonly SessionEntry[] {
		const cache = this.#branchCache;
		if (cache !== undefined && cache.generation === this.#generation) return cache.branch;
		const branch = this.#walk(this.#leaf);
		this.#branchCache = { leaf: this.#leaf, generation: this.#generation, branch };
		return branch;
	}

	#walk(leaf: string | null): SessionEntry[] {
		const branch: SessionEntry[] = [];
		// Per-path visited set: a corrupt cyclic parentId chain must stop at
		// the FIRST repeated id (a bare depth cap of `size` still duplicates
		// entries when unrelated entries inflate the index — e.g. a self-cycle
		// plus one unrelated entry yields [entry, entry]).
		const seen = new Set<string>();
		let cursor = leaf ? this.#entriesById.get(leaf) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
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
	| "getRecordedCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "ensureOnDisk"
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

interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	sessionFile: string | undefined;
	expectedDiskSize: number | null;
	titleUpdatedAt: string;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	draftOnlySessionCleanupArmed: boolean;
	fallbackRuntimeOnly: boolean;
	/** Stashed sibling family candidate; moveTo drops it, so a rollback must restore it. */
	taskSiblingCandidate: string | undefined;
	header: SessionHeader;
	entries: SessionEntry[];
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

interface AtomicEntryBatch {
	collecting: boolean;
	entryIds: Set<string>;
	deferredNotifications: SessionEntry[];
	preBatchLeafId: string | null;
	externalLeafChanged: boolean;
	externalLeafId: string | null;
}

/**
 * The state a full-file body was serialized from, cheap to compare against
 * the live state. Entries change only by append, array replacement, or an
 * in-place update announced through `rewriteEntries()` (which bumps the
 * revision); the title slot and header are small and compared by value.
 */
interface SessionBodyStamp {
	entries: readonly SessionEntry[];
	entryCount: number;
	lastEntry: SessionEntry | undefined;
	revision: number;
	/** Serialized title slot and header lines. */
	prefix: string;
}

/**
 * One full-file serialization: title slot, header, and entry lines in file
 * order plus their total UTF-8 byte length. Kept as lines so the file backend
 * streams them instead of materializing one string the size of the session.
 */
interface SessionFileBody {
	lines: string[];
	bytes: number;
	stamp: SessionBodyStamp;
}

/**
 * One entry's serialized line plus the state it was computed from, so a full
 * rewrite re-serializes only the entries that changed.
 *
 * {@link #lineFor} projects the entry through `prepareEntryForPersistence`,
 * which is a pure function of the entry's own **field values** — it strips
 * replayed reasoning signatures, drops spilled MCP structured content,
 * truncates oversized strings, and externalizes image payloads to
 * content-addressed `blob:sha256:` refs (so the same payload always projects
 * to the same ref). A line is therefore valid exactly while every field value
 * it was derived from still holds, which the snapshots below check:
 *
 * `rewriteEntries()` announces an in-place update with a global `#bodyRevision`
 * bump that cannot say *which* entry moved (it bumps on every prune pass, hot
 * path included), so each entry carries its own evidence instead:
 *
 * - `fields` — the entry's own field values. Catches every in-place write this
 *   repository makes to a persisted entry: a re-parented `parentId`, a stamped
 *   `warning`, a replaced `message`, rewritten `content`/`prunedAt`
 *   (prune/shake/strip-images), and `retryRecovery`.
 * - `message` — a deep value stamp of the message's whole JSON graph, which is
 *   what makes the entry half sound. An in-place nested write such as
 *   `message.content[0].data = newBase64` keeps the entry, the message, the
 *   `content` array, and every block object identity unchanged, so identity
 *   snapshots at any depth still compare equal — yet the projection reads a
 *   different payload and would mint a different `blob:sha256:` ref. The stamp
 *   compares the payload values themselves, so a nested write misses and the
 *   line is re-projected instead of restoring the previous image on reload.
 *   Leaves compare by value, so an equal-valued replacement still hits (the
 *   projected line is byte-identical).
 * - `version` — the message's `messageEstimateVersion` owner-invalidation tag.
 *   The writers that mutate persisted message content in place (prune's
 *   `blankToolResult`, shake's `applyShakeRegion`, `stripImagesFromMessage`)
 *   are contractually required to bump it, which invalidates the line before
 *   the stamp is even consulted; the stamp is the backstop for any nested write
 *   that forgets to.
 */
interface CachedEntryLine {
	line: string;
	/** UTF-8 byte length of `line`, cached with it so the body sum never re-measures. */
	bytes: number;
	/**
	 * Deep value stamps of the entry's own fields, by field name, when the line
	 * was produced (see {@link entryFieldsValueStamp}). The message is not among
	 * them — it has its own stamp. Absent on the direct, uncached path, for
	 * entries whose graph no stamp can describe.
	 */
	fields?: Map<string, unknown[]>;
	/**
	 * Deep value stamp of `entry.message` when the line was produced (see
	 * {@link messageValueStamp}). Absent for an entry without a message — the
	 * non-message entry types — and for hook-backed messages, whose serializer
	 * output no stamp can describe.
	 */
	message?: unknown[];
	/** {@link messageEstimateVersion} of the entry's message, or 0 when it has none. */
	version: number;
}

/**
 * Whether `value` serializes through a `toJSON` hook — `JSON.stringify`'s own
 * serializer lookup, answered without invoking anything.
 *
 * A data descriptor is a hook only when its value is callable: a non-function
 * `toJSON` field shadows any inherited hook and serializes as a plain key. An
 * accessor descriptor is always treated as a hook: the getter may return a
 * function, but reading it would run user code — a stateful getter (for
 * example, one closing over `++revision`) would then observe a different state
 * when serialization reads it again, persisting bytes native serialization
 * alone never produces. Treating it as hooked leaves the message uncached, so
 * the line is always re-projected from a fresh serialization.
 */
function hasToJSONHook(value: object): boolean {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
		} catch {
			// A proxy trap controls the answer: the serializer would consult the
			// same trap, so the hook's presence is unknowable here. Leave the
			// graph uncached rather than stamp a hookless answer.
			return true;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
			return typeof descriptor.value === "function";
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return true;
		}
		current = next;
	}
	return false;
}
/**
 * Whether any indexed slot of `value` resolves through an accessor — answered
 * through property descriptors along the prototype chain, never by reading a
 * slot. A stateful or one-shot indexed getter would otherwise run here and
 * again when `#lineFor` serializes the array, persisting bytes native
 * serialization alone never produces. The object-side discipline (see
 * {@link hasSerializerHook}) applies slot by slot: any accessor-backed array
 * is left uncached instead.
 */
function hasIndexedAccessorSlot(value: unknown[]): boolean {
	const length = value.length;
	for (let index = 0; index < length; index++) {
		const slot = String(index);
		let current: object | null = value;
		for (let depth = 0; current !== null; depth++) {
			if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(current, slot);
			} catch {
				return true;
			}
			if (descriptor !== undefined) {
				if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
				break;
			}
			let next: object | null;
			try {
				next = Object.getPrototypeOf(current);
			} catch {
				return true;
			}
			current = next;
		}
	}
	return false;
}
/**
 * The projector-visible `result` of an `image_generation_call` node as
 * `truncateForPersistence` accepts it — through the prototype chain, but only
 * from a string-valued data descriptor. Answered without invoking anything:
 * an accessor anywhere on the chain yields `undefined` rather than running
 * user code, so a stateful getter keeps the node out of the stamp (see
 * {@link hasSerializerHook}) instead of shifting what serialization observes.
 * Mirrors `projectorImageField` in session-persistence.ts for the `data` key.
 */
function projectorGenerationResult(value: object): string | undefined {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return undefined;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, "result");
		} catch {
			return undefined;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return undefined;
			return typeof descriptor.value === "string" ? descriptor.value : undefined;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return undefined;
		}
		current = next;
	}
	return undefined;
}
/**
 * Message-level keys `prepareEntryForPersistence` reaches by key rather than by
 * enumerating the message: `providerPayload` and `content`
 * (`stripReplayedReasoningSignatures` reads both — `content` through its own
 * `some`/`map` methods), and `details`
 * (`stripSpilledMcpStructuredContent`). The entry-line stamp walks
 * own enumerable keys and indexed slots, so a key the projector reads any other
 * way — or an array it reads through a method or an iterator rather than its
 * indexed slots — feeds persisted bytes no stamp can describe.
 */
const PROJECTOR_MESSAGE_KEYS = ["role", "providerPayload", "content", "details"] as const;
/** The keys an OpenAI Responses `providerPayload` is itself read by. */
const RESPONSES_PAYLOAD_KEYS = ["type", "items"] as const;
/**
 * The `content` array methods `stripReplayedReasoningSignatures` calls.
 * `Array.prototype.some`/`map` read the blocks through the method — the
 * iterator protocol never enters into it, so an override is invisible to
 * {@link nonDefaultArrayIterator} — while `JSON.stringify` and the stamp ignore
 * non-index array properties entirely. A flipped method changes whether — and
 * how — the projector strips a `thinkingSignature` without moving a single
 * stamped leaf.
 */
const PROJECTOR_CONTENT_METHODS = ["some", "map"] as const;

/**
 * The reasoning-item fields `readReasoningItem` reads by key: the item's own
 * `type` marker, the `encrypted_content` blob, and the item `id` a signature
 * falls back to. The strip keeps a `thinkingSignature` only when the payload
 * carries the reasoning item that produced it, so all three decide whether
 * the projected line drops the signature — and a field the own-key stamp
 * cannot see (inherited, own non-enumerable, or an accessor) decides it
 * without moving a stamped leaf.
 */
const PROJECTOR_REASONING_ITEM_KEYS = ["type", "encrypted_content", "id"] as const;

/**
 * The fields the projector reads by key on an array itself: the image
 * classifiers (`type`, `data`, `mimeType`), the `image_generation_call`
 * result, and the typeless `anthropicCompaction` carrier's `content`. The
 * stamp records an array's indexed slots only, so a field the array carries
 * decides the projected bytes without moving a stamped leaf.
 */
const PROJECTOR_ARRAY_CARRIER_KEYS = ["type", "data", "mimeType", "result", "content"] as const;

/**
 * Whether every field the atomic classification consults for `value` is one
 * the own-key stamp can see.
 *
 * The classification decides whether the node persists verbatim, so each
 * carrier it reads decides whether a long string inside it is preserved or
 * truncated. A carrier the stamp cannot see — inherited, own non-enumerable,
 * or an accessor — therefore flips the atomic verdict while moving no
 * stamped leaf, and the memo would reuse a line the projector no longer
 * produces.
 *
 * The carriers are brand-specific (see `atomicPersistenceCarrierKeys`): a
 * `thinking` block is signed by `thinkingSignature`, a `text` block by
 * `textSignature`, a `toolCall` by `thoughtSignature`, a `redactedThinking`
 * by `data`, a `reasoning` item by `encrypted_content`, an
 * `anthropicServerTool` by its nested `block`, and the typeless
 * `anthropicCompaction` carrier by its `content`. The `type` marker itself
 * selects the brand, so it is consulted on every node.
 */
function atomicCarriersVisibleToStamp(value: object, key: string | undefined): boolean {
	if (projectorKeyHiddenFromStamp(value, "type")) return false;
	const type = ownEnumerableFieldValue(value, "type");
	for (const carrier of atomicPersistenceCarrierKeys(type, key)) {
		if (projectorKeyHiddenFromStamp(value, carrier)) return false;
	}
	// The `anthropicServerTool` classification reads the nested block's own
	// fields, and they decide the verdict exactly like the node's own carriers
	// do.
	if (type === "anthropicServerTool") {
		const block = ownEnumerableFieldValue(value, "block");
		if (typeof block !== "object" || block === null) return true;
		for (const field of ANTHROPIC_SERVER_TOOL_BLOCK_FIELDS) {
			if (projectorKeyHiddenFromStamp(block, field)) return false;
		}
	}
	return true;
}

/**
 * The value of `value`'s own `type` marker, or `undefined` when the field is
 * absent or is not an own data descriptor. Read through the descriptor, never
 * by key: the probe must not invoke user code.
 */
function ownEnumerableFieldValue(value: object, key: string): unknown {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(value, key);
	} catch {
		return undefined;
	}
	if (descriptor === undefined) return undefined;
	if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return undefined;
	return descriptor.value;
}

/**
 * Whether the projector can reach a message-level projection input the stamp
 * cannot see, so the line must be left uncacheable rather than reused from a
 * stamp of bytes the next projection will not reproduce.
 *
 * Every field here is read by key, which follows the prototype chain and runs
 * an accessor, where the stamp enumerates own enumerable keys; `content` is
 * additionally read through its own `some`/`map` methods and a Responses
 * payload's `items` with `for..of`, where the stamp reads indexed slots. Either
 * difference changes the projected line — a stripped or restored
 * `thinkingSignature`, a stripped or kept `structuredContent` — without moving
 * a single key or leaf the stamp records.
 */
function messageProjectionInputsUnstampable(message: object): boolean {
	// The reasoning-signature strip collects the replayed ids and encrypted
	// contents in a `Set`, so a replaced `Set` helper decides which signature
	// the line drops — without moving a stamped leaf.
	if (Set.prototype.add !== SET_ADD_INTRINSIC || Set.prototype.has !== SET_HAS_INTRINSIC) return true;
	const fields = message as Record<string, unknown>;
	for (const field of PROJECTOR_MESSAGE_KEYS) {
		if (projectorKeyHiddenFromStamp(message, field)) return true;
	}
	const content = fields.content;
	if (Array.isArray(content) && nonDefaultArrayIterator(content)) return true;
	if (Array.isArray(content)) {
		for (const method of PROJECTOR_CONTENT_METHODS) {
			if (nonDefaultArrayMethod(content, method)) return true;
		}
		// `map` builds its result through `ArraySpeciesCreate`, so a replaced
		// `constructor[Symbol.species]` changes the shape of the array the
		// projection produces — a shape the stamp, which records the source
		// array's indexed slots, no longer describes.
		if (arraySpeciesReplaced(content)) return true;
	}
	const payload = fields.providerPayload;
	if (payload === null || typeof payload !== "object") return false;
	for (const field of RESPONSES_PAYLOAD_KEYS) {
		if (projectorKeyHiddenFromStamp(payload, field)) return true;
	}
	if ((payload as Record<string, unknown>).type !== "openaiResponsesHistory") return false;
	const items = (payload as Record<string, unknown>).items;
	if (!Array.isArray(items)) return false;
	if (nonDefaultArrayIterator(items)) return true;
	// The reasoning items the payload carries decide whether the projected line
	// keeps a `thinkingSignature`: `readReasoningItem` reads each item's own
	// `type`, `encrypted_content` and `id` by key, so a field the own-key
	// stamp cannot see decides the strip without moving a stamped leaf.
	if (hasIndexedAccessorSlot(items)) return true;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item === null || typeof item !== "object") continue;
		for (const field of PROJECTOR_REASONING_ITEM_KEYS) {
			if (projectorKeyHiddenFromStamp(item, field)) return true;
		}
	}
	return false;
}

/**
 * Whether `key` reaches `node` only through a descriptor the own-key stamp does
 * not walk — an inherited link, an own non-enumerable descriptor, or an
 * accessor. Answered through descriptors, never by reading the key (see
 * {@link hasSerializerHook}). False when no descriptor exists anywhere on the
 * chain: the projector's read then yields `undefined`, which every gate it
 * feeds rejects before the value can reach a persisted line.
 *
 * A trap inside a proxy controls the descriptor call, so a throw reports the
 * field hidden: the answer is only ever read to decide cacheability, so the
 * conservative direction is to leave the line uncached. The alternative — an
 * escape from the probe — fails a rewrite the projector itself completes, since
 * `JSON.stringify` and `truncateForPersistence` consult descriptors only for
 * keys `ownKeys` reported (see {@link projectorImageField}). The prototype step
 * is guarded the same way and answers hidden on a throw for the same reason:
 * a proxy field the message carries can throw where `JSON.stringify` — which
 * never follows the chain — stays quiet.
 */
function projectorKeyHiddenFromStamp(node: object, key: string): boolean {
	let current: object | null = node;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, key);
		} catch {
			return true;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
			// A field the node inherits is as invisible to the own-key stamp as a
			// non-enumerable one: the stamp enumerates own enumerable keys only,
			// while the projector reads the key and so follows the chain. An
			// inherited field that changes therefore moves the projected bytes
			// without moving a stamped leaf.
			if (current !== node) return true;
			return !descriptor.enumerable;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return true;
		}
		current = next;
	}
	return false;
}

/**
 * The array helpers {@link nonDefaultArrayIterator} and
 * {@link nonDefaultArrayMethod} compare against, captured at module load.
 * Reading `Array.prototype[method]` at check time compares the descriptor
 * against the very slot a prototype-level replacement just overwrote, so a
 * replaced `some`/`map`/`Symbol.iterator` reads as the default and a graph the
 * projector traverses differently is cached as if it were unchanged.
 */
const ARRAY_ITERATOR_INTRINSIC = Array.prototype[Symbol.iterator];
const ARRAY_CONTENT_METHOD_INTRINSICS: Record<(typeof PROJECTOR_CONTENT_METHODS)[number], unknown> = {
	some: Array.prototype.some,
	map: Array.prototype.map,
};

/**
 * `Object.keys`, captured at module load. The stamp enumerates with it and the
 * projection rebuilds a node with it, so a replacement changes which fields
 * the line carries — while the stamp keeps recording the intrinsic's view.
 */
const OBJECT_KEYS_INTRINSIC = Object.keys;

/**
 * Whether `array` is read by anything other than its indexed slots — an
 * overridden or accessor `Symbol.iterator`. `JSON.stringify` and the stamp both
 * read slots up to a snapshotted length; the projector's `for..of` follows the
 * iterator, so a non-default one yields a graph the stamp never records.
 * Answered through the descriptor, never by reading the slot, and a throwing
 * trap — on either the descriptor call or the prototype step — reports
 * non-default for the same reason {@link projectorKeyHiddenFromStamp} reports a
 * field hidden.
 */
function nonDefaultArrayIterator(array: unknown[]): boolean {
	let current: object | null = array;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, Symbol.iterator);
		} catch {
			return true;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
			return descriptor.value !== ARRAY_ITERATOR_INTRINSIC;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return true;
		}
		current = next;
	}
	return false;
}

/**
 * Whether `array`'s projector-called `method` — one of
 * {@link PROJECTOR_CONTENT_METHODS} — resolves to anything but the array
 * default, or to an accessor. Answered through the descriptor, never by reading
 * the slot, and a throwing trap on either the descriptor call or the prototype
 * step reports non-default for the same reason
 * {@link projectorKeyHiddenFromStamp} reports a field hidden.
 */
function nonDefaultArrayMethod(array: unknown[], method: (typeof PROJECTOR_CONTENT_METHODS)[number]): boolean {
	let current: object | null = array;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, method);
		} catch {
			return true;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
			return descriptor.value !== ARRAY_CONTENT_METHOD_INTRINSICS[method];
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return true;
		}
		current = next;
	}
	return false;
}

/**
 * The value a field resolves to on `value` or its prototype chain, answered
 * without running user code: the data descriptor's value, `undefined` when no
 * descriptor exists, and {@link OPAQUE_FIELD} when the field resolves through
 * an accessor or a throwing trap — the two cases where the runtime value is
 * unknowable without invoking user code.
 */
const OPAQUE_FIELD = Symbol("opaque-field");

/** Every value a chain field can hold, plus the opaque marker. */
type ChainFieldValue = null | undefined | string | number | boolean | bigint | symbol | object | typeof OPAQUE_FIELD;

function readChainField(value: object, key: PropertyKey): ChainFieldValue {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return OPAQUE_FIELD;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, key);
		} catch {
			return OPAQUE_FIELD;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return OPAQUE_FIELD;
			return descriptor.value as ChainFieldValue;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return OPAQUE_FIELD;
		}
		current = next;
	}
	return undefined;
}

/**
 * Whether `value` carries any of `keys` on its own or anywhere on its
 * prototype chain. One chain walk for the whole set: the projector reads
 * these fields by key, and a field the own-key stamp cannot see — or, on an
 * array, a field the stamp never records at all — moves the projected bytes
 * without moving a stamped leaf.
 *
 * A throw answers "carries": the trap controls the answer, so the memo
 * cannot know what the projector will read.
 */
function chainCarriesAnyField(value: object, keys: readonly string[]): boolean {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
		for (const key of keys) {
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(current, key);
			} catch {
				return true;
			}
			if (descriptor !== undefined) return true;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return true;
		}
		current = next;
	}
	return false;
}

/**
 * Whether `array`'s `constructor[Symbol.species]` would replace the array the
 * projector's own `map` call creates.
 *
 * `Array.prototype.map` builds its result through `ArraySpeciesCreate`, which
 * reads `constructor[Symbol.species]` — so a replaced constructor changes the
 * shape of the array the projection produces, and the stamp, which records
 * the source array's indexed slots, no longer describes the bytes. Only the
 * intrinsic `Array` and its intrinsic `Symbol.species` getter build the
 * default array; anything else — a subclass, a replaced constructor, a
 * replaced getter — may build something that is not an array at all. Answered
 * through descriptors, never by reading the key: the probe must not invoke
 * user code.
 */
function arraySpeciesReplaced(array: unknown[]): boolean {
	const constructor = readChainField(array, "constructor");
	if (constructor === OPAQUE_FIELD) return true;
	// `ArraySpeciesCreate` uses the default array when the constructor is
	// absent or is not an object.
	if (constructor === null || constructor === undefined) return false;
	if (typeof constructor !== "object" && typeof constructor !== "function") return false;
	if (constructor !== ARRAY_INTRINSIC) return true;
	const descriptor = Object.getOwnPropertyDescriptor(ARRAY_INTRINSIC, Symbol.species);
	if (descriptor === undefined) return false;
	// The intrinsic getter yields the constructor itself, so the result is the
	// default array.
	if (typeof descriptor.get === "function") return descriptor.get !== ARRAY_SPECIES_GETTER;
	return descriptor.value !== undefined && descriptor.value !== null;
}

/**
 * The intrinsic `Array` and its intrinsic `Symbol.species` getter, captured at
 * module load. Reading them at check time hands the comparison to whatever
 * sits in those slots now.
 */
const ARRAY_INTRINSIC = Array;
const ARRAY_SPECIES_GETTER = Object.getOwnPropertyDescriptor(Array, Symbol.species)?.get;

/**
 * What the persistence projection does with this node's `structuredContent`:
 * `"strip"` when `stripSpilledMcpStructuredContent` removes the field before
 * serialization, `"keep"` when the field stays in the line, and `"opaque"`
 * when the answer depends on a value only running user code can produce.
 *
 * The mirror of `stripSpilledMcpStructuredContent` in session-persistence.ts,
 * which reads the marker fields by key — so it follows the prototype chain and
 * runs an accessor. The memo must reach the same verdict without running any
 * user code, which leaves three cases:
 *
 * - The marker fields resolve to plain data descriptors: the verdict is the
 *   projector's, wherever the descriptors sit on the chain. A marker inherited
 *   from a prototype strips the field exactly like an own one.
 * - A marker resolves through an accessor: the projector's verdict depends on
 *   what the getter returns, which the memo cannot know. The graph is left
 *   uncached instead of stamped against the wrong verdict.
 * - A marker is absent: the projector's read yields `undefined` and the field
 *   stays in the line.
 */
function mcpSpillStripDecision(
	value: object,
	key: string | undefined,
	isTopLevelToolResultDetails: boolean | undefined,
): "strip" | "keep" | "opaque" {
	if (key !== "details" || isTopLevelToolResultDetails !== true) return "keep";
	if (!Object.hasOwn(value, "structuredContent")) return "keep";
	const serverName = readChainField(value, "serverName");
	if (serverName === OPAQUE_FIELD) return "opaque";
	const mcpToolName = readChainField(value, "mcpToolName");
	if (mcpToolName === OPAQUE_FIELD) return "opaque";
	if (typeof serverName !== "string" || typeof mcpToolName !== "string") return "keep";
	const meta = readChainField(value, "meta");
	if (meta === OPAQUE_FIELD) return "opaque";
	if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return "keep";
	const truncation = readChainField(meta, "truncation");
	if (truncation === OPAQUE_FIELD) return "opaque";
	if (truncation === null || typeof truncation !== "object" || Array.isArray(truncation)) return "keep";
	const artifactId = readChainField(truncation, "artifactId");
	if (artifactId === OPAQUE_FIELD) return "opaque";
	return typeof artifactId === "string" && artifactId.length > 0 ? "strip" : "keep";
}

/**
 * Whether `childKey` of `value` is the top-level `details` of a `toolResult`
 * message — the only node `stripSpilledMcpStructuredContent` strips. True
 * only when the walk is still at the message root (`key` is `undefined`) and
 * the child's own `role` data descriptor reads `"toolResult"`: answered
 * through the descriptor, never by reading the key, so a stateful `role`
 * getter is left for the object loop to leave uncached rather than run here.
 */
function isTopLevelMessageChild(value: object, key: string | undefined, childKey: string): boolean {
	if (key !== undefined || childKey !== "details") return false;
	return Object.getOwnPropertyDescriptor(value, "role")?.value === "toolResult";
}

/**
 * Whether the entry wrapper itself would change the projected line in a way
 * the memo cannot see: a `toJSON` hook on the wrapper, or an accessor on one
 * of the wrapper's own fields.
 *
 * The memo stamps the message graph, but the projected line is the whole
 * entry — so a wrapper-level hook, whose output is a function call rather
 * than a field value, moves every byte of the line, and an accessor-backed
 * wrapper field moves the field the memo would otherwise reuse. The message
 * itself is probed on its own (see {@link hasSerializerHook}), so this probe
 * only covers the wrapper.
 */
function entryWrapperUncacheable(entry: object): boolean {
	// A proxy's own descriptors can hide a stateful `toJSON`; its stateful
	// hook is invisible to descriptor probing, so conservatively leave any
	// proxy-backed entry uncached.
	if (util.types.isProxy(entry)) return true;
	if (hasToJSONHook(entry)) return true;
	for (const key of Object.keys(entry)) {
		const descriptor = Object.getOwnPropertyDescriptor(entry, key);
		if (descriptor === undefined) continue;
		if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
	}
	return false;
}

/**
 * Whether `value`'s JSON graph passes through a `toJSON` serializer hook — or
 * through any accessor whose read the probe must not perform.
 * Hook output is a function call, not a field value: a stateful hook returns a
 * different projection on every call, so a stamp taken from one call cannot
 * describe the bytes another call produces. Hook-backed messages are left
 * uncached — re-projected on every rewrite — rather than stamped from output
 * the next check would re-invoke.
 *
 * The same holds for every other accessor: probing one by reading the key runs
 * user code, so a stateful getter (for example, one closing over `++revision`)
 * observes a different state when serialization reads it again, persisting
 * bytes native serialization alone never produces. Any accessor-backed graph
 * is left uncached instead — answered through property descriptors, never by
 * reading a key.
 *
 * Walks exactly the graph persistence serializes: transient keys are skipped
 * where `truncateForPersistence` strips them (see {@link messageValueStamp})
 * and walked whole inside an atomic node (see `isAtomicPersistenceNode`),
 * where persistence keeps the subgraph verbatim. A stripped value may be
 * cyclic — a streaming event can reference the array holding it — which this
 * walk could never escape; the projected line never contains it, so no hook
 * beneath one can reach the persisted bytes.
 *
 * The walk is an explicit worklist, not recursion: `details` is the tool
 * result's opaque slot and can hold a graph nested arbitrarily deep, and one
 * JS frame per level overflowed the stack on such input — a persistence
 * failure on a graph serialization handles fine. Every step below answers
 * through property descriptors and invokes nothing, so the order the worklist
 * visits nodes in changes nothing a caller can observe.
 *
 * A back-reference the projection does NOT strip (the MCP spill and the
 * transient keys are skipped below, so their cycles are never visited) makes
 * the live graph circular, which `JSON.stringify` rejects. A node already on
 * the walk's path is therefore skipped: its hooks were already probed when it
 * was first visited, and re-entering it would only repeat the walk forever.
 * The graph is left to the projector, which surfaces the serialization error.
 */
interface SerializerHookProbeNode {
	value: unknown;
	key: string | undefined;
	isTopLevelToolResultDetails: boolean | undefined;
	atomic: boolean;
}

/**
 * One frame in the probe's worklist: a node to visit, or the marker that ends
 * a container's visit and takes it off the active path.
 */
type SerializerHookProbeFrame =
	| ({
			readonly kind: "value";
	  } & SerializerHookProbeNode)
	| { readonly kind: "exit"; readonly value: object };

/**
 * The objects on the current walk path, for the cycle check. A set answers
 * "is this node already on the path?" in constant time; walking the ancestor
 * chain instead made a deep acyclic graph quadratic — a 25k-deep `details`
 * chain spent O(depth) per node in both this probe and the projector's
 * pre-scan.
 */
type ActivePath = Set<object>;

function hasSerializerHook(
	value: unknown,
	key?: string,
	isTopLevelToolResultDetails?: boolean,
	atomic = false,
): boolean {
	// Iterative, not recursive: `details` is the tool result's opaque slot and
	// can hold a graph nested arbitrarily deep, and one JS frame per level
	// overflowed the stack on such input — a persistence failure on a graph
	// serialization handles fine.
	const pending: SerializerHookProbeFrame[] = [{ kind: "value", value, key, isTopLevelToolResultDetails, atomic }];
	const activePath: ActivePath = new Set();
	for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
		if (frame.kind === "exit") {
			// The container's visit is over: it is no longer on the path.
			activePath.delete(frame.value);
			continue;
		}
		const { value, key, isTopLevelToolResultDetails, atomic } = frame;
		// A bigint is the one primitive `JSON.stringify` routes through a hook:
		// when an extension installs `BigInt.prototype.toJSON`, serialization
		// invokes it — so a stateful hook's first output cannot be stamped as a
		// leaf. The hook may also be installed between this probe and the write,
		// and the fallback that serializes a bigint the serializer cannot handle
		// reads `BigInt.prototype.toString`, a replaceable slot. A bigint-bearing
		// graph is therefore left uncached as a whole.
		if (typeof value === "bigint") return true;
		if (value === null) continue;
		// `JSON.stringify` invokes a `toJSON` hook on a callable value too, so a
		// function's hook must be probed like an object's — a `typeof` gate that
		// drops functions before the descriptor checks would stamp only the
		// function identity, and a stateful or in-place-changed hook would then
		// compare equal while the serialized bytes differ. Functions carry no
		// enumerable children `JSON.stringify` reads, so the hook probe is the
		// only thing left to check for them.
		if (typeof value !== "object" && typeof value !== "function") continue;
		// `JSON.stringify` consults the hook before the value shape, so the probe
		// does too — through the property descriptor, never by reading the key: a
		// stateful getter would otherwise run here and again in #lineFor.
		// A Proxy's own descriptors can hide a stateful `toJSON`; its stateful hook
		// is invisible to descriptor probing below, so conservatively leave any
		// proxy-backed opaque node uncached.
		if (util.types.isProxy(value)) return true;
		// `prepareEntryForPersistence` reads a handful of message-level fields by
		// key and iterates two of them, none of which the own-key stamp below
		// (or `JSON.stringify`) is guaranteed to describe: see
		// {@link messageProjectionInputsUnstampable}. The walk root is the
		// message the projector projects and the only node without a key, so the
		// check sits here — past the proxy short-circuit above, which already
		// leaves any proxy-backed message uncached, and before a walk that would
		// otherwise answer through descriptor calls a proxy trap controls.
		if (key === undefined && messageProjectionInputsUnstampable(value)) return true;
		// The stamp enumerates own enumerable keys, and the projection rebuilds
		// a node with the same `Object.keys` call — so a replaced `Object.keys`
		// decides which fields the line carries while the stamp keeps recording
		// the intrinsic's. The two can disagree about a field the line does
		// depend on, so the message is left uncached while it is replaced.
		if (key === undefined && Object.keys !== OBJECT_KEYS_INTRINSIC) return true;
		if (hasToJSONHook(value)) return true;
		// A callable value serializes through its hook alone (probed above) or is
		// dropped by `JSON.stringify`; its own properties never reach the line, so
		// the walk stops here.
		if (typeof value === "function") continue;
		// No hook on this node: a boxed primitive serializes as its unboxed value
		// and a rawJSON node as its payload, neither of which can harbor a hook.
		const unboxed = unboxedPrimitive(value);
		if (unboxed !== undefined) {
			// A box serializes through `ToPrimitive`, so an own or inherited
			// `valueOf`/`toString`/`Symbol.toPrimitive` override — even a
			// non-enumerable one — changes the emitted bytes while
			// {@link unboxedPrimitive}'s intrinsic call (which bypasses the
			// override on purpose, so it never runs user code) reports the boxed
			// value. Such a box is left uncached, like any other hooked graph.
			if (hasBoxCoercionOverride(value, typeof unboxed as "number" | "string" | "boolean")) return true;
			// A box with own enumerable fields is not a leaf for the projector:
			// `truncateForPersistence` rebuilds it as a plain object and strips
			// its transient keys, so the persisted bytes follow those fields
			// while the stamp would record only the unboxed value.
			if (Object.keys(value).length > 0) return true;
			continue;
		}
		if (rawJsonPayload(value) !== undefined) continue;
		// A node already on this path closes a cycle the projection does not
		// strip: its hooks were probed when it was first visited, so re-entering
		// it would repeat the walk forever. The projector surfaces the resulting
		// serialization error. The active path answers the question in constant
		// time, where walking the ancestor chain made a deep acyclic graph
		// quadratic.
		if (activePath.has(value)) continue;
		activePath.add(value);
		if (Array.isArray(value)) {
			// Indexed slots first pass through the accessor scan: a stateful or
			// one-shot indexed getter must leave the graph uncached before the
			// loop below pushes any slot.
			if (hasIndexedAccessorSlot(value)) return true;
			// The projector reads an array's own fields by key — the image
			// classifiers (`type`, `data`, `mimeType`), the `image_generation_call`
			// result, and the typeless `anthropicCompaction` carrier — while the
			// stamp records an array's indexed slots only. A field the array
			// carries therefore moves the projected bytes without moving a
			// stamped leaf, so such an array leaves the graph uncached.
			if (chainCarriesAnyField(value, PROJECTOR_ARRAY_CARRIER_KEYS)) return true;
			const length = value.length;
			// The array's own key rides along to every slot, mirroring
			// `truncateForPersistence`'s array branch (which hands the caller's
			// key to each element) and {@link messageValueStamp}: the atomic
			// classification below reads it, so a carrier that persists verbatim
			// under `anthropicCompaction` must be probed as atomic, not have its
			// transient keys skipped.
			pending.push({ kind: "exit", value });
			for (let index = 0; index < length; index++) {
				pending.push({
					kind: "value",
					value: value[index],
					key,
					isTopLevelToolResultDetails: undefined,
					atomic,
				});
			}
			continue;
		}
		// Mirror the persistence projection's MCP spill strip
		// (`stripSpilledMcpStructuredContent`): only the top-level `details` of a
		// `toolResult` message loses `structuredContent` before serialization, so
		// only there can a hook beneath it not reach the persisted bytes — and
		// only there may the live graph be cyclic where the projection is not. A
		// stateful `meta` getter would shift serialization if read, so the object
		// loop below answers it through the descriptor and leaves the graph
		// uncached. A marker the projector resolves through an accessor leaves
		// the verdict unknowable, and an unknowable verdict is not a reason to
		// walk a field the line may not contain: the graph stays uncached.
		const spillDecision = mcpSpillStripDecision(value, key, isTopLevelToolResultDetails);
		if (spillDecision === "opaque") return true;
		const skipStructuredContent = spillDecision === "strip";
		// Mirror the projection's stripping boundary: a hook beneath a stripped key
		// cannot affect the persisted bytes — and the live value may be cyclic
		// where the projection is not.
		// `isAtomicPersistenceNode` reads the node's `type` marker and the
		// brand's signature carrier by key, which runs an accessor. A stateful
		// getter would be consumed here and again inside the projection,
		// shifting what `#lineFor` serializes, so a hidden or accessor-backed
		// carrier leaves the graph uncached before the classifier is consulted —
		// the descriptor loop below would otherwise never see the key it hides.
		// The carrier list is brand-specific: only the carrier this node's own
		// `type` selects decides the atomic verdict.
		if (!atomicCarriersVisibleToStamp(value, key)) return true;
		const nodeAtomic = atomic || isAtomicPersistenceNodeOwnFields(value, key);
		// An image-shaped value whose projector classifiers ride somewhere the
		// own-key stamp below cannot see — an inherited link, or an own
		// non-enumerable descriptor — is projector-accepted
		// (`isImageBlock`/`isImageDataPayload` read `type`, `mimeType`, and
		// `data` through the prototype chain) while `JSON.stringify`, and so the
		// stamp, read own enumerable keys only. `data` outside the stamp lets
		// the backing bytes change; `type` and `mimeType` are the classifiers
		// that decide whether they are externalized at all, so flipping
		// `image/png` to `text/plain` swaps a blob ref for the raw base64 with
		// no stamped leaf moving. Leave the graph uncached so the line is always
		// re-projected from the live input.
		if (
			imageClassifierHiddenFromStamp(value, "data") ||
			imageClassifierHiddenFromStamp(value, "type") ||
			imageClassifierHiddenFromStamp(value, "mimeType")
		)
			return true;
		// Same for an `image_generation_call` whose `result` the projector reads
		// by key — `truncateForPersistence` reads it via `"result" in obj` and
		// rewrites it into an own blob ref — while the own-key stamp cannot see
		// the backing field. Any `result` that is not an own enumerable data
		// descriptor (inherited, non-enumerable, or an accessor) therefore
		// leaves the graph uncached, so the line is always re-projected from the
		// live input.
		if (Object.getOwnPropertyDescriptor(value, "type")?.value === "image_generation_call") {
			const resultDescriptor = Object.getOwnPropertyDescriptor(value, "result");
			if (resultDescriptor === undefined) {
				if (projectorGenerationResult(value) !== undefined) return true;
			} else if (!resultDescriptor.enumerable) {
				return true;
			} else if (typeof resultDescriptor.get === "function" || typeof resultDescriptor.set === "function") {
				return true;
			}
		}
		// The projector's rebuilds spread the object, and a spread copies own
		// enumerable SYMBOL properties too — running an own enumerable symbol
		// getter the own-key stamp never sees. An accessor-backed symbol leaves
		// the graph uncached; a symbol data property is copied verbatim and
		// `JSON.stringify` ignores it, so it moves no byte.
		let ownSymbols: symbol[];
		try {
			ownSymbols = Object.getOwnPropertySymbols(value);
		} catch {
			return true;
		}
		for (const symbol of ownSymbols) {
			const symbolDescriptor = Object.getOwnPropertyDescriptor(value, symbol);
			if (symbolDescriptor === undefined) continue;
			if (typeof symbolDescriptor.get === "function" || typeof symbolDescriptor.set === "function") return true;
		}
		// The container's visit ends after its children, so the exit marker sits
		// below them on the worklist.
		pending.push({ kind: "exit", value });
		for (const childKey of Object.keys(value)) {
			if (skipStructuredContent && childKey === "structuredContent") {
				// The field is stripped from the line, but the MCP spill strip
				// copies the details object wholesale, and that copy runs an own
				// enumerable getter — so an accessor-backed field leaves the
				// graph uncached rather than shifting the siblings the line does
				// record.
				const stripped = Object.getOwnPropertyDescriptor(value, childKey);
				if (stripped !== undefined && (typeof stripped.get === "function" || typeof stripped.set === "function")) {
					return true;
				}
				continue;
			}
			// Never read through an accessor: the child lookup below would invoke
			// the getter, and a stateful one then yields a different value when
			// `#lineFor` serializes the node — so leave the graph uncached instead.
			// A transient key is skipped below, but its descriptor is checked
			// first: the projection drops the field without reading it, yet the
			// MCP spill strip copies the details object wholesale, and that copy
			// runs an own enumerable getter.
			const descriptor = Object.getOwnPropertyDescriptor(value, childKey);
			if (descriptor === undefined) continue;
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
			// The snapcompact archive is rebuilt by `persistSnapcompactArchive`,
			// not by the generic path: every field but its frames is kept
			// verbatim — including a field the generic path strips — and the
			// frames and the `withoutThinking` view are read by key. The stamp
			// records the archive atomically (see `messageValueStamp`), so the
			// fields the rebuild reads by key have to be ones the own-key stamp
			// sees; a field it cannot see leaves the archive uncached and
			// re-projected.
			if (isSnapcompactArchiveSlot(key, childKey, descriptor.value)) {
				if (!snapcompactArchiveStampable(descriptor.value)) return true;
				pending.push({
					kind: "value",
					value: descriptor.value,
					key: childKey,
					isTopLevelToolResultDetails: isTopLevelMessageChild(value, key, childKey),
					atomic: true,
				});
				continue;
			}
			if (!nodeAtomic && TRANSIENT_PERSISTENCE_KEYS.includes(childKey)) continue;
			pending.push({
				kind: "value",
				value: descriptor.value,
				key: childKey,
				isTopLevelToolResultDetails: isTopLevelMessageChild(value, key, childKey),
				atomic: nodeAtomic,
			});
		}
	}
	return false;
}

/**
 * Structural markers for {@link messageValueStamp} — JSON values carry no type
 * tag of their own, and a leaf number must never compare equal to a marker.
 */
const STAMP_OBJECT = Symbol("stamp.object");
const STAMP_ARRAY = Symbol("stamp.array");
const STAMP_END = Symbol("stamp.end");
/** Brands a `JSON.rawJSON` node so it never compares equal to a same-shaped plain object. */
const STAMP_RAW_JSON = Symbol("stamp.raw-json");
/**
 * Marks a stripped transient key's presence in the stamp without walking its
 * value (see {@link messageValueStamp}). The persisted bytes never contain the
 * value, but the key's presence forces the rebuild pass that normalizes
 * neighboring fields — so a line stamped while the key was present does not
 * describe the bytes produced after it is deleted.
 */
const STAMP_TRANSIENT = Symbol("stamp.transient");

/**
 * Unboxed value `JSON.stringify` emits for a boxed primitive, or `undefined` for
 * any other object. A `Number`/`String`/`Boolean` wrapper has no enumerable own
 * keys and no `toJSON`, so stamping its container shape would call
 * `new Number(1)` and `new Number(2)` equal while the projected line reads `1`
 * and `2`. A wrapper that *does* carry `toJSON` serializes through the hook
 * instead — hooked graphs are left uncached (see {@link hasSerializerHook}) —
 * so only hookless wrappers reach here.
 *
 * Each intrinsic call is the brand check, answered without invoking an
 * override and without reading `Symbol.toStringTag`: only a genuine wrapper
 * unboxes, and anything else falls through to the object walk. There is
 * deliberately no `instanceof` gate: it answers the wrong question twice — a
 * proxy around a wrapper or an object built on `Number.prototype` passes the
 * chain check while carrying no `[[NumberData]]` slot, so `valueOf()` throws
 * on it while the serializer accepts it as `{}`; and a wrapper from another
 * realm (a `node:vm` context, an iframe) fails the local-realm chain check
 * although `valueOf` succeeds and `JSON.stringify` emits the primitive. There
 * is deliberately no `Symbol.toStringTag` dispatch either: `JSON.stringify`
 * never reads the tag, but `Object.prototype.toString` runs a getter installed
 * there — even a non-enumerable one — so dispatching on it would invoke user
 * code the serializer itself ignores, letting a throwing getter fail a probe
 * over a value that serializes normally, or a stateful one mutate fields
 * before `#lineFor` observes them. Plain objects pay for up to three throwing
 * intrinsic calls instead — a local cost that runs no user code.
 */
function unboxedPrimitive(value: object): number | string | boolean | undefined {
	// Fast path: the brand checks below each cost a caught exception, and the
	// ordinary nodes of a session graph are plain objects, arrays or
	// null-prototype values — never wrappers, whose prototype is
	// `Number.prototype`, `String.prototype`, `Boolean.prototype` or a
	// foreign realm's own. A trap here answers "keep probing", so a proxy
	// still takes the slow path.
	let proto: object | null | undefined;
	try {
		proto = Object.getPrototypeOf(value);
	} catch {
		proto = undefined;
	}
	if (proto === null || proto === Object.prototype || proto === Array.prototype) return undefined;
	try {
		return NUMBER_VALUE_OF.call(value);
	} catch {
		// Not a genuine Number wrapper: fall through to the next brand.
	}
	try {
		return STRING_VALUE_OF.call(value);
	} catch {
		// Not a genuine String wrapper: fall through to the next brand.
	}
	try {
		return BOOLEAN_VALUE_OF.call(value);
	} catch {
		return undefined;
	}
}

/**
 * The `valueOf` intrinsics the unboxing brand checks call, captured at module
 * load. Reading `Number.prototype.valueOf` at check time hands the brand check
 * to whatever sits in that slot now: an extension that replaces it with a
 * generic function would have it called for every object the probe walks, and
 * its answer would be stamped as the box's value.
 */
const NUMBER_VALUE_OF = Number.prototype.valueOf;
const STRING_VALUE_OF = String.prototype.valueOf;
const BOOLEAN_VALUE_OF = Boolean.prototype.valueOf;

/**
 * The coercion functions each boxed primitive's own chain must resolve to.
 * `JSON.stringify` unboxes a `Number` box through `Number.prototype.valueOf`,
 * a `String` box through `String.prototype.valueOf`, and a `Boolean` box
 * through `Boolean.prototype.valueOf`; the matching `toString` is the
 * fallback the primitive-hint conversion consults next. The lists are
 * brand-specific on purpose: a cross-brand list would accept
 * `Object.prototype.toString` as a `Number` box's `valueOf`, while the
 * serializer — which unboxes through the box's own chain — would read it as
 * a string and emit `null` where the stamp records the number.
 */
const BOX_BRAND_INTRINSICS = {
	number: { valueOf: NUMBER_VALUE_OF, toString: Number.prototype.toString },
	string: { valueOf: STRING_VALUE_OF, toString: String.prototype.toString },
	boolean: { valueOf: BOOLEAN_VALUE_OF, toString: Boolean.prototype.toString },
} as const;

/** Marks a coercion slot that has no built-in to compare against. */
const NO_BUILT_IN = Symbol("no-built-in");

/**
 * Whether the coercion slot `key` resolves to something other than
 * `expected` — an accessor, a throwing trap, or another function. Answered
 * through property descriptors, never by reading the key (see
 * {@link hasSerializerHook}). `expected` is {@link NO_BUILT_IN} for a slot no
 * built-in defines: any callable there is an override, while an `undefined`
 * one is not (`GetMethod` treats a non-callable `undefined` as absent).
 */
function chainCoercionOverride(value: object, key: PropertyKey, expected: unknown | typeof NO_BUILT_IN): boolean {
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) return true;
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, key);
		} catch {
			return true;
		}
		if (descriptor !== undefined) {
			if (typeof descriptor.get === "function" || typeof descriptor.set === "function") return true;
			if (expected === NO_BUILT_IN) return descriptor.value !== undefined;
			return descriptor.value !== expected;
		}
		let next: object | null;
		try {
			next = Object.getPrototypeOf(current);
		} catch {
			return true;
		}
		current = next;
	}
	return false;
}

/**
 * Whether a boxed primitive reaches its emitted value through an override
 * rather than an intrinsic. `JSON.stringify` unboxes through `ToPrimitive`,
 * which consults `Symbol.toPrimitive`, then `valueOf`, then `toString` — own
 * first, then the prototype chain — so any of them resolving to something else
 * changes the bytes while the boxed value itself is unchanged. Answered
 * through property descriptors, never by reading the key (see
 * {@link hasSerializerHook}); an accessor anywhere counts as an override, since
 * running it would invoke user code.
 */
function hasBoxCoercionOverride(value: object, brand: "number" | "string" | "boolean"): boolean {
	if (chainCoercionOverride(value, Symbol.toPrimitive, NO_BUILT_IN)) return true;
	const intrinsics = BOX_BRAND_INTRINSICS[brand];
	if (chainCoercionOverride(value, "valueOf", intrinsics.valueOf)) return true;
	return chainCoercionOverride(value, "toString", intrinsics.toString);
}

/**
 * The `JSON.isRawJSON` brand check, captured at module load. Reading it at
 * check time hands the brand check to whatever sits in that slot now, and a
 * replacement would have its answer taken for the brand.
 */
const IS_RAW_JSON = (JSON as { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

/**
 * The `Set` helpers `stripReplayedReasoningSignatures` collects the
 * replayed signature ids and encrypted contents with, captured at module load.
 * A prototype-level replacement changes which items the strip matches without
 * moving a stamped leaf.
 */
const SET_ADD_INTRINSIC = Set.prototype.add;
const SET_HAS_INTRINSIC = Set.prototype.has;

/**
 * The raw payload of a `JSON.rawJSON` branded value, or `undefined` for any
 * other object. The brand is invisible to `Object.keys` — which sees only the
 * `rawJSON` payload key — yet `JSON.stringify` emits the payload verbatim
 * (so `JSON.rawJSON("1")` serializes as `1`, not `{"rawJSON":"1"}`). The
 * detector degrades to `undefined` on runtimes without the ES2025 API, where
 * no branded value can exist. Reads through the property descriptor, never by
 * key: the probe must not invoke user code (see {@link hasSerializerHook}).
 */
function rawJsonPayload(value: object): string | undefined {
	if (IS_RAW_JSON === undefined || !IS_RAW_JSON.call(JSON, value)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, "rawJSON");
	if (descriptor === undefined || typeof descriptor.get === "function" || typeof descriptor.value !== "string") {
		return undefined;
	}
	return descriptor.value;
}

/**
 * Flatten `value`'s JSON graph — the graph `stringifyJson` in {@link #lineFor}
 * projects — into `out` as structure markers, own keys, and leaf values, never
 * object identity. Used by the entry-line memo to see nested mutation that
 * identity checks cannot: the graph is walked once when the line is produced
 * and re-walked (versus the stamp, not against the serialized bytes) whenever
 * the line is considered for reuse.
 *
 * Values that `JSON.stringify` would replace are stamped as their projected
 * output instead of their live shape — a `JSON.rawJSON` node as a brand
 * marker plus its raw payload, `undefined` as the `null` (in arrays) or
 * dropped key (in objects) it emits. Graphs passing through a `toJSON`
 * serializer hook are never stamped (see {@link hasSerializerHook}): hook
 * output is a function call, not a field value, so no stamp taken from one
 * call can describe the bytes another call produces. Transient keys are
 * recorded as presence-only markers where persistence strips them (see below)
 * and walked whole inside an atomic node (see `isAtomicPersistenceNode`),
 * where persistence keeps the whole subgraph verbatim. Arrays are walked by
 * indexed slots with a snapshotted length, the way `JSON.stringify` reads
 * them, never through the iterator protocol.
 *
 * The walk is an explicit worklist, not recursion: `details` is the tool
 * result's opaque slot and can hold a graph nested arbitrarily deep, and one
 * JS frame per level overflowed the stack on such input (~13k levels) — a
 * persistence failure on a graph serialization handles fine. Every step
 * invokes no user code, so the order the worklist visits nodes in changes
 * nothing a caller can observe.
 */
/** One node pending in {@link messageValueStamp}'s worklist. */
type StampPending =
	| {
			readonly kind: "value";
			readonly value: unknown;
			/**
			 * Key the value sits under, as the projection reads it — the walk
			 * root carries none and so does every array slot, whose key the
			 * caller's key provides (see the array branch below).
			 */
			readonly key: string | undefined;
			/**
			 * True when the stamp records {@link key} ahead of the value — object
			 * children only. Arrays emit no keys: `JSON.stringify` delimits slots
			 * by the array marker alone, so a key written for one would shift
			 * every element the matcher reads after it.
			 */
			readonly keyed: boolean;
			readonly isTopLevelToolResultDetails: boolean | undefined;
			readonly atomic: boolean;
	  }
	/** A stripped transient key: emits the key's presence without walking its value. */
	| { readonly kind: "transient"; readonly key: string }
	/** Emits the closing marker of the container that scheduled it. */
	| { readonly kind: "end" };

/**
 * The deep value stamp of `value`: a flat list of markers, keys and leaves
 * that describes the graph the projector serializes.
 *
 * `rootKey` is the key `value` sits under, when it is not the walk root — the
 * projection hands every field the key it was read under, and the atomic
 * classification and the MCP spill strip both read it, so a field stamped
 * without its key would answer a different question than the projector does.
 */
function messageValueStamp(value: unknown, out: unknown[] = [], rootKey?: string): unknown[] {
	// Iterative, not recursive — one JS stack frame per level overflowed on a
	// graph `details` can hold (see above). Children are queued below their
	// container's own closing marker and popped in queue order, so the
	// worklist emits exactly the order the recursive walk did.
	const pending: StampPending[] = [
		{
			kind: "value",
			value,
			key: rootKey,
			keyed: false,
			isTopLevelToolResultDetails: undefined,
			atomic: false,
		},
	];
	for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
		if (frame.kind === "end") {
			out.push(STAMP_END);
			continue;
		}
		if (frame.kind === "transient") {
			out.push(frame.key, STAMP_TRANSIENT);
			continue;
		}
		const { value, key, keyed, isTopLevelToolResultDetails, atomic } = frame;
		if (keyed && key !== undefined) out.push(key);
		if (value === null || typeof value !== "object") {
			out.push(value);
			continue;
		}
		// A `toJSON` hook makes the graph unstampable — see {@link hasSerializerHook}.
		// The memo never reaches this walk with a hooked graph; the box below is the
		// hookless path `JSON.stringify` takes when no hook is present.
		const unboxed = unboxedPrimitive(value);
		if (unboxed !== undefined) {
			out.push(unboxed);
			continue;
		}
		// A rawJSON node serializes as its payload verbatim, not as its one-key
		// container shape — stamp the brand and payload, never the keys.
		const rawPayload = rawJsonPayload(value);
		if (rawPayload !== undefined) {
			out.push(STAMP_RAW_JSON, rawPayload, STAMP_END);
			continue;
		}
		if (Array.isArray(value)) {
			out.push(STAMP_ARRAY);
			// `JSON.stringify` reads indexed slots up to a snapshotted length, not
			// the iterator protocol — an overridden `Symbol.iterator` changes the
			// latter while the former (and the persisted bytes) stays fixed.
			const length = value.length;
			// The closing marker sits below every child, and the children are
			// queued last-first, so the worklist pops them first-first. The
			// array's own key rides along to every slot, exactly as
			// `truncateForPersistence`'s array branch hands the caller's key to
			// each element: the atomic classification and the transient-key strip
			// both read it, so dropping it here would stamp a verbatim carrier as
			// a stripped one. It is not a stamp key — the array marker already
			// delimits the slots, and the stamp records no key for them.
			pending.push({ kind: "end" });
			for (let index = length - 1; index >= 0; index--) {
				pending.push({
					kind: "value",
					value: value[index],
					key,
					keyed: false,
					isTopLevelToolResultDetails: undefined,
					atomic,
				});
			}
			continue;
		}
		const fields = value as Record<string, unknown>;
		// Atomic nodes persist verbatim: `truncateForPersistence` returns before
		// its key-stripping loop, so transient keys inside one reach the line and
		// must be stamped. Only non-atomic containers strip them.
		const atomicNode = atomic || isAtomicPersistenceNodeOwnFields(value, key);
		// Only the top-level `details` of a `toolResult` message loses
		// `structuredContent` before serialization (see
		// `mcpSpillStripDecision`), so only there is the field skipped
		// outright: unlike the transient keys below it forces no rebuild
		// pass, and the live graph may be cyclic where the projection is
		// not. Any other marker-shaped `details` keeps its field in the
		// projected line and is stamped whole. An unknowable verdict means the
		// graph never reached this walk uncached (the hook probe leaves it
		// uncached), so the field is skipped here as well — walking a cycle the
		// line may not contain is what this skip exists to prevent.
		const skipStructuredContent = mcpSpillStripDecision(value, key, isTopLevelToolResultDetails) !== "keep";
		out.push(STAMP_OBJECT);
		const children: StampPending[] = [];
		for (const childKey of Object.keys(fields)) {
			if (skipStructuredContent && childKey === "structuredContent") continue;
			// Stripped from the persisted line by `truncateForPersistence` before
			// serialization, so the projected bytes never depend on the value —
			// but the key's presence alone forces the rebuild pass that drops it
			// and normalizes sibling fields (e.g. `lineCount`), so the stamp
			// records the presence without traversing the value. The live field
			// may be cyclic (a streaming event can reference the array holding
			// it), which this walk could never escape.
			if (!atomicNode && TRANSIENT_PERSISTENCE_KEYS.includes(childKey)) {
				children.push({ kind: "transient", key: childKey });
				continue;
			}
			children.push({
				kind: "value",
				value: fields[childKey],
				key: childKey,
				keyed: true,
				isTopLevelToolResultDetails: isTopLevelMessageChild(value, key, childKey),
				// The snapcompact archive is rebuilt by `persistSnapcompactArchive`,
				// which keeps every field but its frames verbatim — so a transient
				// key inside the archive reaches the line, and the stamp has to
				// record it whole rather than by presence. The archive is
				// therefore stamped like an atomic node (see
				// `snapcompactArchiveStampable` for the fields the rebuild reads
				// by key, which the own-key stamp has to see).
				atomic: atomicNode || isSnapcompactArchiveSlot(key, childKey, fields[childKey]),
			});
		}
		pending.push({ kind: "end" });
		for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
	}
	return out;
}

/**
 * Whether one of the persistence projector's image classifiers — `type` for a
 * content block, `mimeType` for an `images[]`/`frames[]` entry, `data` for both
 * — sits where the own-key stamp cannot see it: on an inherited link, or on an
 * own non-enumerable descriptor. Both readers look at the same field
 * ({@link projectorImageField} through the chain, the stamp through
 * `Object.keys`), so a hidden field moves the projected bytes — the
 * externalization decision and the externalized bytes alike — without moving
 * anything the stamp records. Answered through descriptors, never by reading
 * the key (see {@link hasSerializerHook}); an accessor anywhere on the chain
 * yields no classifier at all, so `undefined` there means "not an image
 * payload", not "hidden".
 */
function imageClassifierHiddenFromStamp(value: object, key: "data" | "mimeType" | "type"): boolean {
	// An accessor anywhere on the chain: the projector reads the field by key
	// — which runs the getter — while the stamp records own enumerable keys
	// only, so the projected bytes can move without a stamped leaf moving.
	if (readChainField(value, key) === OPAQUE_FIELD) return true;
	if (projectorImageField(value, key) === undefined) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor === undefined || !descriptor.enumerable;
}

/**
 * Whether `stamp` (from {@link messageValueStamp}) still describes `value`.
 * Compares structure, keys, and leaf values in one lockstep walk with early
 * exit — an unchanged graph never re-serializes, and the first differing leaf
 * stops the walk. Object identity is never trusted: two structurally equal
 * graphs compare equal (their projected lines are byte-identical), and a leaf
 * swapped for a different-typed value falls out of the marker comparison.
 *
 * The walk is an explicit worklist, not recursion: `details` is the tool
 * result's opaque slot and can hold a graph nested arbitrarily deep, and one
 * JS frame per level overflowed the stack on such input — the same failure
 * {@link messageValueStamp} hit, one rewrite later. Every step invokes no user
 * code, so the order the worklist visits nodes in changes nothing a caller
 * can observe.
 */
/** One node pending in {@link stampMatches}'s worklist. */
type StampMatchPending =
	| {
			readonly kind: "value";
			readonly live: unknown;
			readonly key: string | undefined;
			/**
			 * True when the stamp records `key` ahead of the value — object
			 * children only. The walk root and every array slot sit in the stamp
			 * without one: the root has no key, and {@link messageValueStamp}
			 * emits the array marker straight into its indexed slots.
			 */
			readonly keyed: boolean;
			readonly isTopLevelToolResultDetails: boolean | undefined;
			readonly atomic: boolean;
	  }
	/** Checks a stripped transient key's presence-only record. */
	| { readonly kind: "transient"; readonly key: string }
	/** Checks the closing marker of the container that scheduled it. */
	| { readonly kind: "end"; readonly live: object };

/**
 * Whether `stamp` (from {@link messageValueStamp}) still describes `value`.
 *
 * `rootKey` is the key `value` sits under, when it is not the walk root — the
 * same key the stamp was taken with, so the atomic classification and the MCP
 * spill strip answer the question the projection answers.
 */
function stampMatches(stamp: readonly unknown[], value: unknown, rootKey?: string): boolean {
	let index = 0;
	// Iterative, not recursive — one JS stack frame per level overflowed on a
	// graph `details` can hold (see above). Children are queued below their
	// container's own closing-marker check and popped in queue order, so the
	// worklist consumes the stamp in exactly the order the recursive walk did.
	const pending: StampMatchPending[] = [
		{
			kind: "value",
			live: value,
			key: rootKey,
			keyed: false,
			isTopLevelToolResultDetails: undefined,
			atomic: false,
		},
	];
	// The live objects on the current path. The stamp is a tree, so a live
	// graph that closes a cycle is deeper than the stamp and the match has
	// already failed when the walk runs out of stamp — the check below answers
	// the revisit directly, so a cyclic graph can never be walked twice.
	const activePath = new Set<object>();
	for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
		if (frame.kind === "end") {
			if (stamp[index++] !== STAMP_END) return false;
			activePath.delete(frame.live);
			continue;
		}
		if (frame.kind === "transient") {
			// The key and its marker sit together in the stamp (see
			// {@link messageValueStamp}), so both are read here, in this frame's
			// own turn — never in the container's loop, which runs before any
			// sibling value is consumed.
			if (stamp[index++] !== frame.key || stamp[index++] !== STAMP_TRANSIENT) return false;
			continue;
		}
		const { live, key, keyed, isTopLevelToolResultDetails, atomic } = frame;
		// An object child's key sits ahead of its value in the stamp (see
		// {@link messageValueStamp}), so each child consumes its own key here —
		// per child, never in the container's loop. Hoisting the check into the
		// loop reads the keys back to back against a stamp that interleaves each
		// key with its value, so every container with two or more children fails
		// to match: the memo can never reuse a line, and a full rewrite
		// re-serializes the whole session on every publish.
		if (keyed && stamp[index++] !== key) return false;
		const expected = stamp[index++];
		// The stamp never invokes a `toJSON` hook: a hooked graph is left
		// uncached (see {@link hasSerializerHook}), so reaching one here means
		// the hook arrived after the stamp was taken — the line cannot be reused.
		if (live !== null && typeof live === "object") {
			// The hook lookup never reads the key — see {@link hasSerializerHook}:
			// a stateful getter would otherwise run here and again in #lineFor.
			// Presence alone fails the match; the hook is never invoked.
			if (hasToJSONHook(live)) return false;
			// Hookless wrappers were stamped as their unboxed value — one leaf,
			// not the empty container `unboxedPrimitive` explains. A match is
			// one leaf matched, never the whole graph: the frames queued behind
			// this one still owe their own visit, so an in-place change to a
			// sibling re-projects the line instead of restoring this leaf-era
			// verdict for the entire message.
			const unboxed = unboxedPrimitive(live);
			if (unboxed !== undefined) {
				if (unboxed !== expected) return false;
				continue;
			}
			// A rawJSON node was stamped as its brand plus payload — see
			// {@link messageValueStamp} — so a plain object with the same
			// `{ rawJSON }` keys falls out at the brand marker. The same leaf
			// rule as the wrapper above: brand, payload, and closing marker all
			// matching is one leaf matched, and the walk continues to the
			// siblings behind it.
			const rawPayload = rawJsonPayload(live);
			if (rawPayload !== undefined) {
				if (expected !== STAMP_RAW_JSON) return false;
				if (stamp[index++] !== rawPayload) return false;
				if (stamp[index++] !== STAMP_END) return false;
				continue;
			}
			if (expected === STAMP_RAW_JSON) return false;
		}
		if (expected === STAMP_OBJECT || expected === STAMP_ARRAY) {
			if (live === null || typeof live !== "object") return false;
			if (Array.isArray(live) !== (expected === STAMP_ARRAY)) return false;
			// A live object already on the current path closes a cycle the stamp
			// — a tree — cannot describe. The match fails here, so the line is
			// re-projected and the projector surfaces the serialization error.
			if (activePath.has(live)) return false;
			activePath.add(live);
			if (Array.isArray(live)) {
				// Indexed slots with a snapshotted length, mirroring both
				// `JSON.stringify` and {@link messageValueStamp} — never the
				// iterator protocol. The array's own key rides along to every
				// slot: the stamp's atomic classification reads it exactly as
				// `truncateForPersistence` does, whose array branch hands the
				// caller's key to each element. It is not a stamp key — array
				// slots record none (`keyed` below).
				const length = live.length;
				pending.push({ kind: "end", live });
				for (let position = length - 1; position >= 0; position--) {
					pending.push({
						kind: "value",
						live: live[position],
						key,
						keyed: false,
						isTopLevelToolResultDetails: undefined,
						atomic,
					});
				}
				continue;
			}
			const fields = live as Record<string, unknown>;
			// Mirror the stamp side: transient keys were recorded whole
			// inside atomic nodes (persistence keeps them) and as
			// presence-only markers elsewhere.
			const nodeAtomic = atomic || isAtomicPersistenceNodeOwnFields(live, key);
			// The stamp skipped the top-level toolResult's MCP-stripped
			// field outright (see {@link messageValueStamp}), so the
			// matcher skips it too — the value was never recorded and may
			// be cyclic. Any other marker-shaped `details` was stamped
			// whole and is matched whole.
			const skipStructuredContent = mcpSpillStripDecision(live, key, isTopLevelToolResultDetails) !== "keep";
			const children: StampMatchPending[] = [];
			for (const childKey of Object.keys(fields)) {
				if (skipStructuredContent && childKey === "structuredContent") continue;
				// Stripped before serialization by `truncateForPersistence`,
				// so only the key's presence was recorded — its value was
				// never walked (and may be cyclic) — see
				// {@link messageValueStamp}.
				if (!nodeAtomic && TRANSIENT_PERSISTENCE_KEYS.includes(childKey)) {
					children.push({ kind: "transient", key: childKey });
					continue;
				}
				children.push({
					kind: "value",
					live: fields[childKey],
					key: childKey,
					keyed: true,
					isTopLevelToolResultDetails: isTopLevelMessageChild(live, key, childKey),
					// The archive is stamped atomically (see
					// {@link messageValueStamp}), so the matcher reads it the
					// same way: the flag has to be derived identically or the two
					// walks disagree about the archive's transient keys.
					atomic: nodeAtomic || isSnapcompactArchiveSlot(key, childKey, fields[childKey]),
				});
			}
			pending.push({ kind: "end", live });
			for (let position = children.length - 1; position >= 0; position--) pending.push(children[position]);
			continue;
		}
		// NaN never equals itself, but JSON renders it `null` for every path,
		// so a NaN leaf describes the same line either way.
		if (expected === live) continue;
		if (typeof expected === "number" && Number.isNaN(expected) && typeof live === "number" && Number.isNaN(live)) {
			continue;
		}
		return false;
	}
	return index === stamp.length;
}

/**
 * The entry field the message lives under. The message keeps its own stamp —
 * taken with the message as the walk root, because the MCP spill strip and
 * the reasoning-signature strip only apply there — so the entry's own field
 * stamps skip it.
 */
const ENTRY_MESSAGE_FIELD = "message";

/**
 * The entry's own field values, stamped by value: one deep value stamp per
 * own enumerable field, each rooted at the key the field sits under.
 *
 * A shallow snapshot (own enumerable values compared by identity) cannot see
 * a field mutated in place: `entry.runtime.version = "..."` keeps the same
 * object, so the snapshot compares equal and the rewrite reuses the line the
 * mutation invalidated — a reload then restores the old metadata. The value
 * stamp compares the leaves, so the mutation is a miss and the line is
 * re-projected.
 *
 * The message is skipped: it has its own stamp (see {@link ENTRY_MESSAGE_FIELD}),
 * and stamping it here would walk it with the entry as the walk root — the
 * wrong root for the MCP spill strip, whose boundary would then walk a
 * `structuredContent` cycle the projection strips.
 */
function entryFieldsValueStamp(entry: object): Map<string, unknown[]> {
	const stamps = new Map<string, unknown[]>();
	const fields = entry as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (key === ENTRY_MESSAGE_FIELD) continue;
		stamps.set(key, messageValueStamp(fields[key], [], key));
	}
	return stamps;
}

/**
 * Whether the stamps from {@link entryFieldsValueStamp} still describe the
 * entry's own fields. The key sets must match — a field added or removed
 * changes the line — and every field's value must still match its stamp.
 */
function entryFieldsUnchanged(stamps: Map<string, unknown[]>, entry: object): boolean {
	const fields = entry as Record<string, unknown>;
	const keys = Object.keys(entry);
	let own = 0;
	for (const key of keys) {
		if (key === ENTRY_MESSAGE_FIELD) continue;
		own++;
		const stamp = stamps.get(key);
		if (stamp === undefined) return false;
		if (!stampMatches(stamp, fields[key], key)) return false;
	}
	return own === stamps.size;
}

/**
 * Whether one of the entry's own field graphs would change the projected line
 * in a way the value stamp cannot see: a `toJSON` hook, or an accessor.
 *
 * The message is probed on its own (see {@link hasSerializerHook}); the
 * wrapper's own accessors are covered by {@link entryWrapperUncacheable}. The
 * entry's other fields carry their own graphs — a `runtime` identity, a
 * compaction's `preserveData` archive, an extension's `data` — and a hook or
 * an accessor inside one of them moves the persisted bytes without moving a
 * stamped leaf, so those graphs are probed too.
 */
function entryFieldsUncacheable(entry: object): boolean {
	// The stamp enumerates the fields with `Object.keys` and the projection
	// rebuilds the node with it, so a replacement decides which fields the
	// line carries while the stamp keeps recording the intrinsic's view.
	if (Object.keys !== OBJECT_KEYS_INTRINSIC) return true;
	const fields = entry as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (key === ENTRY_MESSAGE_FIELD) continue;
		// The field's own key rides along: the atomic classification and the
		// MCP spill strip both read it, exactly as the projection does when it
		// hands the field's key to the field's value.
		if (hasSerializerHook(fields[key], key, false, false)) return true;
	}
	return false;
}

/** Whether `text` is exactly the concatenation of `lines`, compared without building it. */
function textMatchesLines(text: string, lines: readonly string[]): boolean {
	let offset = 0;
	for (const line of lines) {
		if (!text.startsWith(line, offset)) return false;
		offset += line.length;
	}
	return offset === text.length;
}

/**
 * The storage may have published a write that rejected, and an authoritative
 * repair could not be proven durable. Callers must fail closed until recovery.
 */
export class SessionPersistenceIndeterminateError extends AggregateError {
	readonly operationError: Error;
	readonly recoveryErrors: readonly Error[];

	constructor(operationError: Error, recoveryErrors: readonly Error[]) {
		super(
			[operationError, ...recoveryErrors],
			`Session persistence is indeterminate after "${operationError.message}" and authoritative repair failed.`,
		);
		this.name = "SessionPersistenceIndeterminateError";
		this.operationError = operationError;
		this.recoveryErrors = [...recoveryErrors];
	}
}

/**
 * This session moved to a new file and keeps saving there. Not a failure:
 * nothing is latched. Delivered through {@link SessionManager.onPersistenceNotice}.
 */
export interface SessionPersistenceNotice {
	/**
	 * `"open-elsewhere"`: another live omp process wrote `from` first and still
	 * has it open, so this process saves its entries elsewhere instead of mixing
	 * them into that file. `"replaced"`: `from` changed on disk and no longer
	 * reads as this session's journal, so it is left untouched. `"contested"`:
	 * a writer without the ownership lease kept changing `from` through every
	 * read-back-and-retry pass, so this session stops racing it.
	 */
	reason: "open-elsewhere" | "replaced" | "contested";
	/** The session file this session was saving to. */
	from: string;
	/** The fresh sibling it saves to from now on: same directory, a new session id whose `parentSession` is the old one. */
	to: string;
}

/**
 * Thrown by {@link SessionManager.forkFrom} when the fork source is missing.
 * The CLI maps this to a clean session-resolution failure at its own boundary
 * (this module must not import `main.ts`, where `SessionResolutionError` lives).
 */
export class ForkSourceNotFoundError extends Error {
	constructor(sourcePath: string) {
		super(`Session "${sourcePath}" not found.`);
		this.name = "ForkSourceNotFoundError";
	}
}

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: completed entries
 * (user/assistant/toolResult messages, tool_execution_start markers, custom
 * entries) are handed to the OS synchronously in-body on append and never
 * `fsync`'d. In-flight streaming text is intentionally not durable until
 * `message_end` persists the finished message.
 *
 * While an in-place atomic rewrite is publishing, a concurrent completed append
 * supersedes that publish with a synchronous full-body rewrite so the entry is
 * software-crash durable before the append returns; the abandoned atomic's
 * `commitGuard` then refuses to clobber the fresher body.
 *
 * During {@link moveTo}, appends write a full body to the live relocation path
 * (source until rename, destination once the rename has landed) so a crash mid-
 * move still preserves completed entries without recreating a vacated source.
 * A trailing atomic rewrite still rewrites the header cwd after the path is
 * repointed.
 */
export class SessionManager {
	#cwd: string;
	/** Additional workspace directories beyond cwd (multi-root). Normalized absolute, deduped, excludes cwd. */
	#additionalDirectories: string[] = [];
	#fallbackRuntimeOnly = false;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;

	#sessionId = "";
	/**
	 * Parent-derived sibling family candidate stashed by the Task executor once
	 * the child session exists. Session-scoped and non-persisted: the header
	 * never sees it, and forks, moves, and new-session resets start without it.
	 */
	#taskSiblingCandidate: string | undefined;
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#titleRevision = 0;
	/** Bumped by in-place entry updates, which a {@link SessionBodyStamp} cannot otherwise see. */
	#bodyRevision = 0;
	/**
	 * Serialized line per entry, reused until that entry changes (see
	 * {@link #bodyLineFor}). Weak, so replaced or released entries drop their
	 * cached bytes with the entries themselves. Dropped wholesale by
	 * {@link #forgetEntryLines} when a failed write forces the blob memo to be
	 * forgotten, so no cached line can outlive the blob refs it embeds.
	 */
	#entryLines = new WeakMap<SessionEntry, CachedEntryLine>();
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entries: SessionEntry[] = [];
	#index = new SessionEntryIndex();

	/** File reflects all current entries; appends can go incrementally. */
	#fileIsCurrent = false;
	/** In-memory entries diverged from disk (load-migration/sanitize) → next persist must full-rewrite. */
	#rewriteRequired = false;
	/** Malformed records the loader skipped for the current session file; reported by `/dump anon`. */
	#loadedMalformedRecords = 0;
	/** Byte length this manager last loaded or durably wrote; `null` means the path was absent. */
	#expectedDiskSize: number | null = null;
	/**
	 * Generation of the latest deferred publish queued on a `defersSyncPublish`
	 * backend. A deferred-rewrite confirmation older than the latest queued
	 * publish is stale (the backend no longer holds its body) and must record
	 * nothing (rvEW).
	 */
	#deferredPublishGen = 0;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;
	/**
	 * Armed only when this manager observed a draft sidecar lifecycle that
	 * materialized an otherwise metadata-only session file. Explicit
	 * ensureOnDisk() callers (ACP session/new, handoff) must survive close().
	 */
	#draftOnlySessionCleanupArmed = false;

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
	/** Sealed by {@link releaseRetainedEntries}: every later append/title/rewrite is a dropped no-op. */
	#released = false;
	/** Set by {@link releaseRetainedEntries}: `#entries` was cleared, so `#serializeBody()` is no longer authoritative. */
	#entriesReleased = false;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** FIFO reservation for atomic batches and authoritative recovery. */
	#atomicPersistenceTail: Promise<void> = Promise.resolve();
	/** Observer notifications withheld until their entries are proven durable. */
	#pendingDurabilityNotifications: SessionEntry[] = [];
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/**
	 * Epoch of the in-flight atomic rewrite, or `null` when no rewrite is running.
	 * The fence in {@link #appendToSessionFile} only applies while this matches
	 * `#diskEpoch`: once a synchronous rewrite (`flushSync` → `#rewriteSynchronously`)
	 * bumps the epoch, the pending atomic publish is guaranteed to abandon via
	 * its `commitGuard`, and appends can safely take the hot path against the
	 * freshly-published file.
	 */
	#atomicRewriteFenceEpoch: number | null = null;
	/** Set by synchronous appends that land while an atomic replacement is active. */
	#atomicRewriteDirty = false;
	/**
	 * Active {@link moveTo} relocation. Concurrent completed appends write a
	 * full body to the live path: source while it still exists, destination
	 * once rename has landed (source gone). Never recreates a vacated source.
	 * `null` outside an active relocation.
	 */
	#sessionFileRelocating: { source: string; dest: string; copying?: boolean } | null = null;
	/** Atomic entry batch currently staged for a full-file commit. */
	#atomicEntryBatch: AtomicEntryBatch | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	/**
	 * The last breadcrumb this manager wrote marked a lazy fresh session whose
	 * JSONL is not yet on disk. Cleared (and the crumb re-stamped non-fresh) once
	 * the session materializes, so a materialized-then-deleted session still falls
	 * back to the most-recent session instead of being treated as a fresh crumb.
	 */
	#breadcrumbFresh = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#persistenceErrorCallbacks = new Set<(error: Error) => void>();
	#persistenceNoticeCallbacks = new Set<(notice: SessionPersistenceNotice) => void>();
	/** Every notice raised so far, replayed to each later subscriber. */
	#persistenceNotices: SessionPersistenceNotice[] = [];
	/**
	 * This process's ownership claim on the session it last wrote (file storage
	 * only), keyed by session id so every path to the journal meets it.
	 * `release` is unset while another live process holds the session, and
	 * after {@link close} gave the claim up.
	 */
	#sessionClaim: { sessionId: string; release: (() => void) | undefined } | undefined;
	/**
	 * The background artifact copy a move or branch to `sessionFile` started (see
	 * {@link #moveOffSessionFile}, {@link createBranchedSession}). Never rejects.
	 */
	#pendingArtifactCopy: { sessionFile: string; done: Promise<void> } | undefined;

	private constructor(cwd: string, sessionDir: string, persist: boolean, storage: SessionStorage) {
		this.#cwd = cwd;
		// Absolute, so session files (and `PI_SESSION_FILE` in bash and eval) stay
		// valid after a command changes directory: `--session-dir` may be relative.
		this.#sessionDir = sessionDir ? path.resolve(sessionDir) : sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		this.#blobs = new BlobStore(getBlobsDir());

		if (persist && sessionDir) this.#storage.ensureDirSync(this.#sessionDir);
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
		this.#breadcrumbFresh = fresh;
		if (this.#suppressBreadcrumb) return;
		writeTerminalBreadcrumb(cwd, sessionFile, fresh, {
			remoteStorage: !(this.#storage instanceof FileSessionStorage),
		});
	}

	/**
	 * Re-stamp a fresh-session breadcrumb as non-fresh once the session has
	 * materialized on disk. A no-op unless the current breadcrumb is still fresh.
	 */
	#materializeBreadcrumb(): void {
		if (!this.#breadcrumbFresh || !this.#sessionFile) return;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, false);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	/**
	 * Deliver one failure or notice to a single observer. Observer failures are
	 * swallowed: a host surface that throws must not corrupt session teardown.
	 */
	#invokePersistenceObserver<T>(observer: (value: T) => void, value: T): void {
		try {
			observer(value);
		} catch (callbackError) {
			logger.warn("Session persistence observer failed", {
				error: toError(callbackError).message,
			});
		}
	}

	#notifyPersistenceErrorObservers(error: Error): void {
		for (const observer of this.#persistenceErrorCallbacks) this.#invokePersistenceObserver(observer, error);
	}

	/**
	 * Drop every memoized entry line. Called wherever the image memo is
	 * forgotten (see {@link forgetExternalizedImages}): a cached line embeds
	 * `blob:sha256:` refs minted for the blobs that line referenced, and once a
	 * write failed those blobs are unreferenced on disk and collectable by
	 * `omp gc`. Reusing the line on the recovery rewrite would publish a ref
	 * whose blob no longer exists, so the next rewrite must re-project every
	 * entry through `prepareEntryForPersistence` and re-mint the refs.
	 *
	 * The whole memo goes, not the touched entries: a WeakMap cannot enumerate
	 * which entries a failed body touched, and this runs only on failure —
	 * recovery is already paying for a full rewrite.
	 */
	#forgetEntryLines(): void {
		this.#entryLines = new WeakMap<SessionEntry, CachedEntryLine>();
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		if (!this.#diskFailure) this.#diskFailure = error;
		// A line that failed to land leaves its blob refs unreferenced on disk,
		// so the next persist must re-check those blobs instead of trusting the memo.
		forgetExternalizedImages(this.#blobs);
		this.#forgetEntryLines();

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
			this.#notifyPersistenceErrorObservers(error);
		}

		return this.#diskFailure;
	}

	#notifyPersistenceNotice(notice: SessionPersistenceNotice): void {
		logger.warn("Session moved to a new file", { ...notice });
		this.#persistenceNotices.push(notice);
		for (const observer of this.#persistenceNoticeCallbacks) this.#invokePersistenceObserver(observer, notice);
	}

	/**
	 * Hold this process's ownership claim on `#sessionId`, moving it off a
	 * previous session. Only write paths claim, so the first process to write a
	 * session owns it and inspection (`omp share`, `--export`, `render`) never
	 * does. A failed claim is retried on the next write, so a writer takes over
	 * once the owner closed the session or exited.
	 */
	#claimSession(): void {
		const sessionId = this.#sessionId;
		const sessionFile = this.#sessionFile;
		if (!this.#persist || !sessionFile || !this.#storage.claimSession) return;
		const current = this.#sessionClaim;
		if (current?.sessionId === sessionId && current.release) return;
		if (current && current.sessionId !== sessionId) current.release?.();
		// The storage also checks that the path still holds this session: if
		// another session was moved onto it, the claim fails and the next write
		// moves this session to a sibling instead of appending into that journal.
		this.#sessionClaim = { sessionId, release: this.#storage.claimSession(sessionId, sessionFile) ?? undefined };
	}

	/**
	 * Whether another live omp process owns this session, claiming it first
	 * when it is free. A non-owner never writes the session's file: its next
	 * write moves this session to a sibling with a new id instead, so two
	 * processes never mix their entries in one journal and the owner's full
	 * rewrites never race the other process's appends.
	 */
	#sessionOwnedElsewhere(): boolean {
		if (this.#released || this.#sessionFileRelocating) return false;
		this.#claimSession();
		const claim = this.#sessionClaim;
		return claim !== undefined && claim.sessionId === this.#sessionId && claim.release === undefined;
	}

	/**
	 * `#sessionFile` when `error` reports that it changed since this manager
	 * last wrote it, which the caller can recover from; `undefined` reports the
	 * conflict as before. A fresh file that already exists is never recovered,
	 * so a colliding sibling cannot move again. Backends that defer sync
	 * publishes also report as before: there a conflict can be this manager
	 * racing its own unconfirmed publish, not another writer.
	 */
	#conflictedSessionFile(error: unknown): string | undefined {
		const sessionFile = this.#sessionFile;
		if (
			!(error instanceof SessionWriteConflictError) ||
			error.expectedSize === null ||
			!sessionFile ||
			path.resolve(error.path) !== path.resolve(sessionFile) ||
			!this.#persist ||
			this.#released ||
			this.#sessionFileRelocating ||
			this.#storage.defersSyncPublish
		) {
			return undefined;
		}
		return sessionFile;
	}

	/** The entries `content` holds that this manager does not, or `undefined` when it is not this session's journal. */
	#foreignEntriesIn(content: string): SessionEntry[] | undefined {
		const { entries, invalidHeader } = parseSessionContent(content);
		const header = entries[0];
		if (invalidHeader || header?.type !== "session" || header.id !== this.#sessionId) return undefined;
		const foreign: SessionEntry[] = [];
		for (let i = 1; i < entries.length; i++) {
			const entry = entries[i] as SessionEntry;
			if (!this.#index.has(entry.id)) foreign.push(entry);
		}
		return foreign;
	}

	/**
	 * Keep the entries another writer added to `#sessionFile`, whose bytes now
	 * measure `diskSize`. They join this session's tree as a side branch (their
	 * parents are entries both writers loaded), the active leaf stays this
	 * session's, and the retried rewrite republishes them with the rest.
	 */
	#adoptForeignEntries(foreign: readonly SessionEntry[], diskSize: number): void {
		const leaf = this.#index.leafId();
		let adopted = 0;
		for (const entry of foreign) {
			// A recovery that raced this one may already have kept it.
			if (this.#index.has(entry.id)) continue;
			this.#entries.push(entry);
			this.#index.insert(entry);
			adopted++;
		}
		this.#index.setLeaf(leaf);
		this.#expectedDiskSize = diskSize;
		if (adopted > 0)
			logger.warn("Kept session entries another writer added", { sessionFile: this.#sessionFile, adopted });
	}

	/**
	 * A synchronous full rewrite of `#sessionFile` met bytes this manager did
	 * not write: usually a writer without the ownership lease (an older omp,
	 * an external tool) appending to the file this process owns. Overwriting
	 * would erase those entries and retrying blindly can never succeed, so read
	 * the file back, keep its new entries, and retry against the size just read.
	 * A deleted file is recreated; a file that no longer reads as this session
	 * is left untouched and the session moves to a sibling.
	 *
	 * After {@link MAX_WRITE_CONFLICT_RECOVERIES} passes (`recoveries`) the
	 * other writer is still racing every read-to-publish window: leave the file
	 * to it and move to a sibling rather than re-serializing on every write.
	 *
	 * Returns the path to retry, or `undefined` to report the conflict as before.
	 */
	#recoverFromWriteConflictSync(error: unknown, recoveries: number): string | undefined {
		const contested = this.#conflictedSessionFile(error);
		if (!contested) return undefined;
		if (recoveries >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
		if (!this.#storage.readTextSync) return undefined;
		let content: string;
		try {
			content = this.#storage.readTextSync(contested);
		} catch (readError) {
			if (!isEnoent(readError)) return this.#moveOffSessionFile("replaced");
			this.#expectedDiskSize = null;
			return contested;
		}
		const foreign = this.#foreignEntriesIn(content);
		if (!foreign) return this.#moveOffSessionFile("replaced");
		resolveBlobRefsInEntriesSync(foreign, this.#blobs);
		this.#adoptForeignEntries(foreign, Buffer.byteLength(content, "utf8"));
		return contested;
	}

	/** Asynchronous {@link #recoverFromWriteConflictSync}. */
	async #recoverFromWriteConflict(error: unknown, recoveries: number): Promise<string | undefined> {
		const contested = this.#conflictedSessionFile(error);
		if (!contested) return undefined;
		if (recoveries >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
		const epoch = this.#diskEpoch;
		let content: string;
		try {
			content = await this.#storage.readText(contested);
		} catch (readError) {
			// A synchronous rewrite during the read already recovered; retry against its result.
			if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
			if (!isEnoent(readError)) return this.#moveOffSessionFile("replaced");
			this.#expectedDiskSize = null;
			return contested;
		}
		if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
		const foreign = this.#foreignEntriesIn(content);
		if (!foreign) return this.#moveOffSessionFile("replaced");
		await resolveBlobRefsInEntries(foreign, this.#blobs);
		if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
		this.#adoptForeignEntries(foreign, Buffer.byteLength(content, "utf8"));
		return contested;
	}

	/**
	 * Leave `#sessionFile` untouched and continue as a fresh session in a
	 * sibling file. It gets a new session id whose header points back through
	 * `parentSession` and keeps the provider prompt-cache key, as {@link fork}
	 * does, so resume-by-id, the title index, and the picker never see two
	 * files for one id. Unlike a fork it also records `continuationOf`, so a
	 * later resume of the old file follows the conversation here (see
	 * `findSessionContinuation`). Nothing durable exists there yet: the caller
	 * publishes the whole transcript once and appends incrementally after that.
	 *
	 * The artifact copy runs in the background so a move never blocks the turn
	 * loop on a large artifacts directory; the sibling's artifact manager waits
	 * for it before scanning ids or resolving `artifact://`, and flush/close
	 * await it. Returns the sibling.
	 */
	#moveOffSessionFile(reason: SessionPersistenceNotice["reason"]): string {
		const from = this.#sessionFile as string;
		const previousSessionId = this.#sessionId;
		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		const to = path.join(path.dirname(from), `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		// The marker goes before the carried-over fields: the session listing
		// reads only the first 4 KB of a file, and a header grows with them.
		const {
			type: _type,
			id: _id,
			timestamp: _timestamp,
			parentSession: _parent,
			continuationOf: _of,
			...carried
		} = this.#header;
		this.#header = {
			type: "session",
			id: this.#sessionId,
			timestamp,
			parentSession: previousSessionId,
			continuationOf: previousSessionId,
			...carried,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
		};
		this.#closeWriterEventually();
		this.#sessionFile = to;
		this.#expectedDiskSize = null;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#pendingArtifactCopy = { sessionFile: to, done: copySessionArtifacts(from, to) };
		this.#rememberBreadcrumb(this.#cwd, to);
		this.#claimSession();
		this.#notifyPersistenceNotice({ reason, from, to });
		return to;
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

	async #withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#atomicPersistenceTail;
		const turn = Promise.withResolvers<void>();
		this.#atomicPersistenceTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
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

	#latchIndeterminate(operationError: Error, recoveryErrors: readonly Error[]): SessionPersistenceIndeterminateError {
		const error = new SessionPersistenceIndeterminateError(operationError, recoveryErrors);
		this.#diskFailure = error;
		forgetExternalizedImages(this.#blobs);
		this.#forgetEntryLines();
		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence became indeterminate.", {
				sessionFile: this.#sessionFile,
				error: error.message,
			});
			this.#notifyPersistenceErrorObservers(error);
		}
		return error;
	}

	#notifyDurableEntries(entries: readonly SessionEntry[] = []): void {
		const notifications = [...this.#pendingDurabilityNotifications, ...entries];
		this.#pendingDurabilityNotifications = [];
		const seen = new Set<string>();
		for (const entry of notifications) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			this.#notifyEntryAppended(entry);
		}
	}

	async #authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		if (this.#released) {
			// Terminal seal: repair would reset the disk tail (escaping the
			// close() serialization) and atomically publish #serializeBody() — after
			// release that truncates, and a revival may already own the file.
			// The original operation error still propagates to the caller.
			logger.warn("Skipped authoritative session repair after terminal release", {
				error: String(operationError),
			});
			return;
		}
		if (!this.#persist || !this.#sessionFile) return;
		const previousDiskTail = this.#diskTail;
		const writer = this.#writer;
		this.#diskEpoch++;
		const epoch = this.#diskEpoch;
		this.#writer = undefined;
		this.#diskTail = Promise.resolve();
		this.#forceFileCreation = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#atomicRewriteFenceEpoch = epoch;
		if (!this.#diskFailure) this.#diskFailure = operationError;
		try {
			await previousDiskTail.catch(() => undefined);
			let closeError: Error | undefined;
			if (writer) {
				try {
					await writer.close();
				} catch (error) {
					closeError = toError(error);
				}
			}
			let drainError: Error | undefined;
			try {
				await this.#storage.drain();
			} catch (error) {
				drainError = toError(error);
			}
			if (writer?.isOpen()) {
				throw this.#latchIndeterminate(operationError, [
					closeError ?? new Error("Failed to close session writer before authoritative repair."),
					...(drainError ? [drainError] : []),
				]);
			}

			do {
				this.#atomicRewriteDirty = false;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Session file disappeared during authoritative repair."),
					]);
				}
				await this.#publishAuthoritativeBody(
					sessionFile,
					operationError,
					() => !this.#released && this.#diskEpoch === epoch,
				);
				if (this.#diskEpoch !== epoch) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Authoritative session repair was superseded before verification."),
					]);
				}
			} while (this.#atomicRewriteDirty);

			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
			this.#clearDiskError();
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) throw error;
			throw this.#latchIndeterminate(operationError, [toError(error)]);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	/**
	 * Publish the current in-memory journal as `sessionFile`'s authoritative
	 * body, tolerating a write whose own acknowledgment failed but that
	 * landed anyway: a readback matching the intended body still counts as
	 * durable. Callers own serialization (the disk queue) and any
	 * `#released`/epoch guard; this only writes and repairs
	 * `#expectedDiskSize` bookkeeping via {@link #recordFullRewrite}.
	 */
	async #publishAuthoritativeBody(
		sessionFile: string,
		operationError: Error,
		commitGuard?: () => boolean,
		recoveries = 0,
	): Promise<void> {
		const target =
			sessionFile === this.#sessionFile && this.#sessionOwnedElsewhere()
				? this.#moveOffSessionFile("open-elsewhere")
				: sessionFile;
		const body = this.#serializeBody();
		const options = { expectedSize: this.#expectedDiskSize, commitGuard };
		try {
			await (this.#storage.writeLinesAtomic
				? this.#storage.writeLinesAtomic(target, body.lines, options)
				: this.#storage.writeTextAtomic(target, body.lines.join(""), options));
		} catch (error) {
			const retryPath = await this.#recoverFromWriteConflict(error, recoveries);
			if (retryPath) return this.#publishAuthoritativeBody(retryPath, operationError, commitGuard, recoveries + 1);
			const recoveryErrors = [toError(error)];
			try {
				await this.#storage.drain();
			} catch (drainFailure) {
				recoveryErrors.push(toError(drainFailure));
			}
			let actual: string;
			try {
				actual = await this.#storage.readText(target);
			} catch (readFailure) {
				recoveryErrors.push(toError(readFailure));
				throw this.#latchIndeterminate(operationError, recoveryErrors);
			}
			if (!textMatchesLines(actual, body.lines)) {
				recoveryErrors.push(new Error("Authoritative session repair did not match durable storage."));
				throw this.#latchIndeterminate(operationError, recoveryErrors);
			}
		}
		this.#recordFullRewrite(body.bytes);
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
		return `${stringifyJson(prepareEntryForPersistence(entry, this.#blobs)) ?? "null"}\n`;
	}

	/**
	 * {@link #lineFor} for the full-body path, memoized per entry so a rewrite
	 * serializes only the entries that actually changed.
	 *
	 * Keying on `#bodyRevision` cannot work: every `rewriteEntries()` bumps it,
	 * and a global bump says nothing about which entry moved, so a
	 * revision-keyed memo would miss on every rewrite. Each entry validates its
	 * own cache record instead — see {@link CachedEntryLine}.
	 *
	 * Every entry type is memoized, not just the message ones: a large
	 * non-message record — a compaction's archive, an extension's custom data,
	 * a `session_init` system prompt — costs the same to re-serialize on every
	 * rewrite as a message does, and re-serializing it keeps the quadratic
	 * hot path this memo exists to remove. What decides reuse is the entry's
	 * own value stamp (see {@link entryFieldsValueStamp}) and, for a message
	 * entry, the message's own stamp.
	 *
	 * An entry whose graph no stamp can describe is left uncached: a hook-backed
	 * message — whose graph passes through a `toJSON` serializer (see
	 * {@link hasSerializerHook}) — can emit bytes no stamp of an earlier call
	 * describes, and a field graph carrying a hook or an accessor (see
	 * {@link entryFieldsUncacheable}) moves the persisted bytes without moving
	 * a stamped leaf.
	 */
	#bodyLineFor(entry: SessionEntry): CachedEntryLine {
		const message = entry.type === "message" ? entry.message : undefined;
		if (
			entryWrapperUncacheable(entry) ||
			entryFieldsUncacheable(entry) ||
			(message !== undefined && hasSerializerHook(message))
		) {
			const line = this.#lineFor(entry);
			return { line, bytes: Buffer.byteLength(line, "utf8"), version: 0 };
		}
		const version = message === undefined ? 0 : messageEstimateVersion(message);
		const cached = this.#entryLines.get(entry);
		if (
			cached !== undefined &&
			cached.version === version &&
			cached.fields !== undefined &&
			entryFieldsUnchanged(cached.fields, entry) &&
			(message === undefined || (cached.message !== undefined && stampMatches(cached.message, message)))
		) {
			return cached;
		}
		const line = this.#lineFor(entry);
		const memo: CachedEntryLine = {
			line,
			bytes: Buffer.byteLength(line, "utf8"),
			fields: entryFieldsValueStamp(entry),
			message: message === undefined ? undefined : messageValueStamp(message),
			version,
		};
		this.#entryLines.set(entry, memo);
		return memo;
	}
	#recordDurableAppend(line: string): void {
		this.#expectedDiskSize = (this.#expectedDiskSize ?? 0) + Buffer.byteLength(line, "utf8");
	}

	#recordFullRewrite(bytes: number): void {
		this.#expectedDiskSize = bytes;
	}

	/**
	 * Confirm a publish the backend only queued. The manager's durability state
	 * (durable size, current-marking) advances only here, never at queue time:
	 * until the store confirms, the record still describes the last confirmed
	 * publish. A rejected publish is realigned with the size the store actually
	 * holds and latched, so the next append retries the transcript instead of
	 * reusing an `expectedSize` the backend never reached.
	 *
	 * `onConfirm` runs only once the backend confirms the queued publish. A
	 * deferred rewrite must neither record the replacement nor mark the manager
	 * current before then (hV-oB): an append racing the unconfirmed publish
	 * would otherwise take the hot path and land a bare append on a body the
	 * backend may still reject, inflating the CAS token past anything durable.
	 * A rewrite racing it instead carries the last confirmed token, which the
	 * store's queue-time size check fail-fasts before a second provisional
	 * publish can queue behind the unconfirmed one.
	 */
	#confirmDeferredPublish(sessionFile: string, onConfirm?: () => void): void {
		const confirmed = this.#storage.confirmWrites?.(sessionFile);
		if (!confirmed) return;
		void confirmed
			.then(() => {
				onConfirm?.();
			})
			.catch(err => {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				try {
					this.#expectedDiskSize = this.#storage.existsSync(sessionFile)
						? this.#storage.statSync(sessionFile).size
						: null;
				} catch {
					// Backend unreadable: leave the record for the next write to re-establish.
				}
				this.#noteDiskFailure(err);
			});
	}

	#titleSlotLine(): string {
		return serializeTitleSlot({
			title: this.#sessionName,
			source: this.#titleSource,
			updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
		});
	}

	/** Serialize the whole file — title slot, header, entries — as lines, stamped with the state they came from. */
	#serializeBody(): SessionFileBody {
		const titleLine = this.#titleSlotLine();
		const headerLine = this.#lineFor(this.#header);
		const entries = this.#entries;
		const lines = [titleLine, headerLine];
		let bytes = Buffer.byteLength(titleLine, "utf8") + Buffer.byteLength(headerLine, "utf8");
		for (const entry of entries) {
			const memo = this.#bodyLineFor(entry);
			lines.push(memo.line);
			bytes += memo.bytes;
		}
		const stamp: SessionBodyStamp = {
			entries,
			entryCount: entries.length,
			lastEntry: entries.at(-1),
			revision: this.#bodyRevision,
			prefix: titleLine + headerLine,
		};
		return { lines, bytes, stamp };
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/**
	 * Live path for concurrent completed appends during {@link moveTo}.
	 * Prefers destination once rename has landed (source gone); otherwise
	 * source. Never invents a path that does not already exist.
	 */
	#liveRelocationWritePath(): string | null {
		const relocating = this.#sessionFileRelocating;
		if (!relocating) return null;
		if (relocating.copying && this.#storage.existsSync(relocating.source)) return relocating.source;
		if (this.#storage.existsSync(relocating.dest)) return relocating.dest;
		if (this.#storage.existsSync(relocating.source)) return relocating.source;
		// Rename in flight with neither path visible (rare cross-device edge):
		// fall back to destination so we do not recreate a vacated source.
		return relocating.dest;
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 *
	 * During {@link moveTo}, writes to the live relocation path (source pre-
	 * rename, destination post-rename) rather than always `#sessionFile`, so
	 * concurrent completed entries are durable without recreating a vacated source.
	 */
	#rewriteSynchronously(): void {
		if (this.#released) return;
		if (!this.#persist || !this.#shouldHaveSessionFile()) return;
		let targetPath = this.#liveRelocationWritePath() ?? this.#sessionFile;
		if (!targetPath) return;

		try {
			if (this.#sessionOwnedElsewhere()) targetPath = this.#moveOffSessionFile("open-elsewhere");
			let body = this.#serializeBody();
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			for (let recoveries = 0; ; recoveries++) {
				try {
					const options = { expectedSize: this.#expectedDiskSize };
					if (this.#storage.writeLinesSync) this.#storage.writeLinesSync(targetPath, body.lines, options);
					else this.#storage.writeTextSync(targetPath, body.lines.join(""), options);
					break;
				} catch (err) {
					const retryPath = this.#recoverFromWriteConflictSync(err, recoveries);
					if (!retryPath) throw err;
					targetPath = retryPath;
					body = this.#serializeBody();
				}
			}
			this.#clearDiskError();
			if (this.#storage.defersSyncPublish) {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				// The publish is only queued: record nothing and stay non-current
				// until the backend confirms (hV-oB). A racing rewrite still
				// carries the last confirmed token, so the store's queue-time
				// size check fail-fasts it instead of queueing a second
				// provisional publish behind the unconfirmed one; a racing
				// append retries the transcript on the cold path instead of
				// landing a bare append on a body the backend may still reject.
				// The success handler below is the single place the replacement
				// becomes durable state.
				const generation = ++this.#deferredPublishGen;
				const { bytes, stamp } = body;
				this.#confirmDeferredPublish(targetPath, () => {
					// A newer deferred publish owns the durability record now;
					// this body is no longer on the backend, so record nothing.
					if (generation !== this.#deferredPublishGen) return;
					this.#recordFullRewrite(bytes);
					const entries = this.#entries;
					const bodyIsCurrent =
						stamp.entries === entries &&
						stamp.entryCount === entries.length &&
						stamp.lastEntry === entries.at(-1) &&
						stamp.revision === this.#bodyRevision &&
						stamp.prefix === this.#titleSlotLine() + this.#lineFor(this.#header);
					if (!bodyIsCurrent) {
						// Entries raced the unconfirmed publish: the confirmed
						// body predates them. Stay non-current and re-issue the
						// full transcript instead of declaring it durable
						// (rvEW); the re-issued publish carries the
						// just-confirmed size token, so its queue-time check
						// passes.
						this.#fileIsCurrent = false;
						this.#rewriteRequired = true;
						this.#rewriteSynchronously();
						return;
					}
					if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
						this.#fileIsCurrent = true;
						this.#materializeBreadcrumb();
						this.#rewriteRequired = false;
						this.#hasTitleSlot = true;
					}
				});
				return;
			}
			this.#recordFullRewrite(body.bytes);
			// Only mark the manager current when writing the active session path.
			// Mid-move writes update the live relocation path; `#sessionFile` is
			// still the pre-repoint source until moveTo repoints it.
			if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
				this.#fileIsCurrent = true;
				this.#materializeBreadcrumb();
				this.#rewriteRequired = false;
				this.#hasTitleSlot = true;
			} else {
				// Destination body is current on disk; in-memory still needs a
				// header-cwd rewrite after repoint, but entries are durable.
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#hasTitleSlot = true;
			}
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized after the writer is closed. The fence
	 * is enabled BEFORE `#closeWriterHandle()` and stays active until the last
	 * atomic publish returns, so a sync append landing in the close-yield window
	 * cannot open a fresh writer that the pending replacement would then detach
	 * from the current JSONL path. A `commitGuard` also prevents a superseding
	 * synchronous rewrite from being overwritten by the stale body serialized
	 * before it ran.
	 */
	async #rewriteAtomically(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#released) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch)) {
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	/**
	 * Shared fenced atomic-rewrite loop used by `#rewriteAtomically` and the
	 * `#persistTitleChangeEntry` fallback. Holds `#atomicRewriteActive` across
	 * the writer close and the full-file replace, and loops on
	 * `#atomicRewriteDirty` so any fenced append that lands during the rewrite
	 * is captured before the task resolves. Returns `false` when the disk epoch
	 * moved so callers skip current-marking updates; a body that landed before
	 * that change still advances the durable byte record after readback.
	 */
	async #runFencedAtomicRewrite(epoch: number): Promise<boolean> {
		if (this.#released) return false;
		this.#atomicRewriteFenceEpoch = epoch;
		let recoveries = 0;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				if (this.#sessionOwnedElsewhere()) this.#moveOffSessionFile("open-elsewhere");
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return false;
				if (this.#diskEpoch !== epoch) return false;
				const body = this.#serializeBody();
				const options = {
					expectedSize: this.#expectedDiskSize,
					commitGuard: () => !this.#released && this.#diskEpoch === epoch,
				};
				try {
					await (this.#storage.writeLinesAtomic
						? this.#storage.writeLinesAtomic(sessionFile, body.lines, options)
						: this.#storage.writeTextAtomic(sessionFile, body.lines.join(""), options));
				} catch (error) {
					if (await this.#recoverFromWriteConflict(error, recoveries)) {
						recoveries++;
						// Publish the whole transcript against what the recovery found on the next pass.
						this.#atomicRewriteDirty = true;
						continue;
					}
					try {
						if (textMatchesLines(await this.#storage.readText(sessionFile), body.lines)) {
							this.#recordFullRewrite(body.bytes);
						}
					} catch {
						// Preserve the publish error when durable state cannot be read back.
					}
					throw error;
				}
				if (this.#diskEpoch !== epoch) {
					try {
						if (textMatchesLines(await this.#storage.readText(sessionFile), body.lines)) {
							this.#recordFullRewrite(body.bytes);
						}
					} catch {
						// A superseding rewrite owns the durability record when its body cannot be read back.
					}
					return false;
				}
				this.#recordFullRewrite(body.bytes);
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			// Only relinquish the fence if we still own it. A superseding
			// synchronous rewrite (`flushSync` → `#rewriteSynchronously`) may
			// have reset `#diskTail`, scheduled a fresh atomic task at the new
			// epoch, and that task may have taken ownership of the fence while
			// this stale rewrite was still awaiting storage. Clearing it here
			// unconditionally would strand appends during the newer publish.
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (this.#released || !this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		if (this.#diskFailure) {
			// The failed entry and any later entries remain in memory. A full
			// replacement is the writability probe and restores all of them once
			// transient storage pressure clears.
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
		}

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// The first durable entry after draft consumption races the old manager's
		// close-time GC. Serialize that one transition with the GC; once any
		// durable entry exists, later appends cannot satisfy its delete predicate.
		if (
			this.#storage.withSessionFileLockSync &&
			this.#draftOnlySessionCleanupArmed &&
			!isDraftOnlyMetadataEntry(entry) &&
			this.#entries.every(candidate => candidate === entry || isDraftOnlyMetadataEntry(candidate))
		) {
			try {
				this.#storage.withSessionFileLockSync(this.#sessionFile, () => this.#appendToCurrentSessionFile(entry));
			} catch (err) {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#noteDiskFailure(err);
			}
			return;
		}
		this.#appendToCurrentSessionFile(entry);
	}

	#appendToCurrentSessionFile(entry: SessionEntry): void {
		// Atomic replacement / move window: do not open a fresh append writer that
		// a Windows EPERM replace could detach from the current JSONL path.
		// - moveTo: write a full body to the live relocation path (source pre-
		//   rename, destination post-rename) so completed entries are durable
		//   without recreating a vacated source.
		// - in-place atomic fence: supersede the pending publish with a
		//   synchronous full-body rewrite; bumping `#diskEpoch` abandons the
		//   in-flight atomic via its `commitGuard`.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#atomicRewriteDirty = true;
			this.#rewriteSynchronously();
			return;
		}
		// Cold/divergent: not on disk yet, in-memory entries diverged from the
		// file, or another live process owns it → rewrite the whole file
		// synchronously (to a sibling in the last case) and keep going.
		if (!this.#fileIsCurrent || this.#rewriteRequired || this.#sessionOwnedElsewhere()) {
			this.#rewriteSynchronously();
			return;
		}

		// Hot path: write the entry directly on the writer, outside the async disk
		// chain. Prefer appendSync so write failures latch `#diskFailure` before
		// this call returns (not via a discarded rejected Promise after a later
		// microtask). Callers stay non-throwing here — the core turn loop invokes
		// appendMessage/appendCustomEntry without try/catch. A later entry retries
		// all in-memory state through a full rewrite. File writers apply each line
		// to the OS page cache before return.
		// A mid-close writer leaves `#writer` undefined, so `#appendWriter` simply
		// opens a fresh append handle and the entry still lands.
		try {
			const writer = this.#appendWriter();
			const line = this.#lineFor(entry);
			if (writer.appendSync && !this.#storage.defersSyncPublish) {
				writer.appendSync(line);
				this.#recordDurableAppend(line);
			} else {
				// A backend that only queues the publish (indexed) has no synchronous
				// durability, so the durable size may advance only once it confirms
				// the line: a lost publish must not leave the record describing bytes
				// the store never accepted, or the next recovery rewrite hands the
				// backend CAS an impossible `expectedSize`.
				if (writer.appendSync) writer.appendSync(line);
				const confirmed = writer.appendSync ? writer.flush() : writer.append(line);
				void confirmed
					.then(() => this.#recordDurableAppend(line))
					.catch(err => {
						this.#fileIsCurrent = false;
						this.#rewriteRequired = true;
						this.#noteDiskFailure(err);
					});
			}
		} catch (err) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#noteDiskFailure(err);
		}
	}

	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#rewriteSynchronously();
			if (this.#diskFailure) throw this.#diskFailure;
			return;
		}

		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Title changes use their own asynchronous append path rather than
		// #appendToSessionFile. During move, write the full body (including the
		// title entry) to the live relocation path so a crash mid-move still
		// keeps the title change; the trailing rewrite still updates header cwd.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}

		if (
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			!this.#hasTitleSlot ||
			!this.#storage.existsSync(this.#sessionFile) ||
			this.#sessionOwnedElsewhere()
		) {
			await this.#rewriteAtomically();
			return;
		}

		const epoch = this.#diskEpoch;
		const line = this.#lineFor(entry);
		await this.#scheduleDiskWork(
			async () => {
				if (this.#released) return;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				try {
					await this.#appendWriter().append(line);
					this.#recordDurableAppend(line);
					await this.#storage.updateSessionTitle(sessionFile, update);
					if (this.#diskEpoch === epoch) this.#fileIsCurrent = true;
				} catch {
					if (!(await this.#runFencedAtomicRewrite(epoch))) return;
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch },
		);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("collab entry hook failed", { error: String(err) });
			}
		}
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#expectedDiskSize = null;
		this.#reconcileSessionDirForFallback();
		if (options?.sessionDir && this.#persist) {
			this.#sessionDir = path.resolve(options.sessionDir);
			this.#storage.ensureDirSync(this.#sessionDir);
		}
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
			taskPromptCacheKey: options?.taskPromptCacheKey,
		};
		const workspace = normalizeSessionWorkspace({
			cwd: this.#cwd,
			directories: options?.additionalDirectories ?? [],
		});
		this.#additionalDirectories = additionalWorkspaceDirectories(workspace);
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = [...this.#additionalDirectories];
		}
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#index.clear();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#loadedMalformedRecords = 0;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
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
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, true);
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
		this.#titleUpdatedAt = header.timestamp;
		const repairedUsage = normalizeLoadedUsage(entries);
		if (repairedUsage > 0) logger.warn("Loaded assistant messages with incomplete usage", { count: repairedUsage });
		this.#index.rebuild(entries);
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string; runtime: RuntimeIdentity } {
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
		};
	}

	#setLeaf(id: string | null): void {
		this.#index.setLeaf(id);
		const batch = this.#atomicEntryBatch;
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = id;
		}
	}

	#recordEntry(entry: SessionEntry): void {
		if (this.#released) {
			logger.warn("Dropped session entry appended after terminal release", { type: entry.type });
			return;
		}
		if (entry.type === "message" && entry.message.role === "assistant" && normalizeAssistantUsage(entry.message)) {
			logger.warn("Assistant message recorded with incomplete usage", { id: entry.id });
		}
		this.#entries.push(entry);
		this.#index.insert(entry);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			// An off-branch entry replays to the leaf it captured, not to itself.
			batch.externalLeafId = sessionEntryLeafId(entry);
		}
		this.#appendToSessionFile(entry);
		if (batch) batch.deferredNotifications.push(entry);
		else this.#notifyEntryAppended(entry);
	}

	#rollbackAtomicEntryBatch(batch: AtomicEntryBatch): void {
		const retainedAncestor = (id: string | null): string | null => {
			const seen = new Set<string>();
			while (id && batch.entryIds.has(id) && !seen.has(id)) {
				seen.add(id);
				id = this.#index.get(id)?.parentId ?? null;
			}
			return id;
		};
		const retained = this.#entries.filter(entry => !batch.entryIds.has(entry.id));
		for (const entry of retained) {
			entry.parentId = retainedAncestor(entry.parentId);
			// An off-branch entry captured a staged leaf; keep it pointing at a surviving entry.
			if (typeof entry.activeLeafId === "string") {
				entry.activeLeafId = retainedAncestor(entry.activeLeafId);
			}
		}
		const restoredLeaf = retainedAncestor(batch.externalLeafChanged ? batch.externalLeafId : batch.preBatchLeafId);
		this.#entries = retained;
		this.#index.rebuild(retained);
		this.#index.setLeaf(restoredLeaf && this.#index.has(restoredLeaf) ? restoredLeaf : null);
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsSync(markerPath);
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
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

		const pendingCopy = this.#pendingArtifactCopy;
		this.#artifactManager = new ArtifactManager(
			sessionFile.slice(0, -JSONL_SUFFIX_LENGTH),
			pendingCopy?.sessionFile === sessionFile ? pendingCopy.done : undefined,
			this.getSeanceSourceArtifactsDir() ?? undefined,
		);
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of Array.from(this.#sessionNameChangedCallbacks)) {
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
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			expectedDiskSize: this.#expectedDiskSize,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			fallbackRuntimeOnly: this.#fallbackRuntimeOnly,
			taskSiblingCandidate: this.#taskSiblingCandidate,
			// Entries are snapshotted by reference (switch/reload replaces the
			// array wholesale). The header is cloned: moveTo mutates it in place
			// (cwd, additionalDirectories), so a by-reference capture would let
			// a rollback observe the move it is undoing.
			header: structuredClone(this.#header),
			entries: [...this.#entries],
		};
	}

	/**
	 * Create an independent manager for the current logical session and branch.
	 * The clone shares the storage backend but owns its entry index and writer, so
	 * callers can finish session-owned work after this manager switches elsewhere.
	 * Set `persist` false when the original session is intentionally being dropped.
	 */
	cloneCurrentSession(options?: { persist?: boolean }): SessionManager {
		const persist = options?.persist ?? this.#persist;
		const clone = new SessionManager(this.#cwd, this.#sessionDir, persist, this.#storage);
		clone.#suppressBreadcrumb = true;
		clone.restoreState(this.captureState());
		if (!persist) {
			clone.#sessionFile = undefined;
			clone.#expectedDiskSize = null;
			clone.#fileIsCurrent = false;
			clone.#rewriteRequired = false;
			clone.#forceFileCreation = false;
		}
		return clone;
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#expectedDiskSize = snapshot.expectedDiskSize;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#fallbackRuntimeOnly = snapshot.fallbackRuntimeOnly;
		// A completed moveTo drops the stash, so a rollback restores it here.
		this.#taskSiblingCandidate = snapshot.taskSiblingCandidate;
		this.#applyEntries(snapshot.header, [...snapshot.entries]);
		this.#additionalDirectories = snapshot.header.additionalDirectories ?? [];
		this.#sessionName = snapshot.sessionName;

		this.#titleSource = snapshot.titleSource;
		this.#titleUpdatedAt = snapshot.titleUpdatedAt;
		this.#hasTitleSlot = snapshot.hasTitleSlot;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Undo a {@link moveTo} using a {@link captureState} snapshot: rename the
	 * session and artifacts back into the captured bucket, then restore the
	 * captured metadata (cwd, header, additionalDirectories) and the stashed
	 * sibling candidate the forward move dropped. The captured header is
	 * persisted after relocation so a fresh open of the source session sees the
	 * pre-move metadata, including workspace roots the move filtered out.
	 * Rollbacks must not re-enter forward-move hooks, so this bypasses
	 * AgentSession entirely. If the rename-back itself fails, the
	 * manager stays pointed at the actual moved file (restoring the snapshot
	 * would split the transcript across a recreated source and the stranded
	 * target) and the error names where the session file actually lives.
	 */
	async rollbackMove(snapshot: SessionManagerStateSnapshot): Promise<void> {
		try {
			const targetSessionDir = snapshot.sessionFile ? path.dirname(snapshot.sessionFile) : snapshot.sessionDir;
			await this.moveTo(snapshot.cwd, targetSessionDir);
		} catch (error) {
			const movedFile = this.getSessionFile();
			throw new Error(
				`could not relocate the session back to ${snapshot.sessionDir} (${error instanceof Error ? error.message : String(error)}); the session file remains at ${movedFile}`,
			);
		}
		// The inverse moveTo already rewrote the restored source file and left
		// #expectedDiskSize describing that on-disk body. restoreState resets it
		// to the pre-move snapshot size, so capture the post-relocation size and
		// reapply it — otherwise the final rewrite would compare a stale size and
		// reject an otherwise successful rollback.
		const relocatedDiskSize = this.#expectedDiskSize;
		this.restoreState(snapshot);
		// Persist the captured header so disk and memory agree after a fresh open.
		if (this.#persist && this.#sessionFile) {
			this.#expectedDiskSize = relocatedDiskSize;
			this.#forceFileCreation = true;
			this.#rewriteRequired = true;
			await this.#rewriteAtomically();
		}
	}
	/** Switch to a different session file (resume / branch). */
	async setSessionFile(sessionFile: string): Promise<void> {
		await this.#setSessionFile(sessionFile);
	}

	async #setSessionFile(
		sessionFile: string,
		loadedSession?: SessionLoadResult,
		options?: { throwIfMissing?: boolean; newSession?: NewSessionOptions },
	): Promise<void> {
		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;
		// A switch gives up the previous file. Opening claims nothing: the first
		// write does, so inspecting a session never counts as owning it.
		this.#sessionClaim?.release?.();
		this.#sessionClaim = undefined;

		const resolvedSessionFile = path.resolve(sessionFile);
		const loaded = loadedSession ?? (await loadSessionFile(resolvedSessionFile, this.#storage));
		const sourceSize =
			loaded.sourceSize !== undefined
				? loaded.sourceSize
				: this.#storage.existsSync(resolvedSessionFile)
					? this.#storage.statSync(resolvedSessionFile).size
					: null;
		if (loaded.invalidHeader) {
			throw new Error(
				`Cannot resume session "${resolvedSessionFile}": the session header is missing or malformed. The file was not modified.`,
			);
		}

		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const { entries: fileEntries, titleSlot } = loaded;
		if (fileEntries.length === 0) {
			if (options?.throwIfMissing) {
				throw new Error(
					`Cannot resume session "${resolvedSessionFile}": the session file holds no entries. The file was not modified.`,
				);
			}
			// Explicit but empty/missing path (e.g. --session flag): start fresh but
			// keep the requested path and materialize the header immediately.
			this.#resetToNewSession(options?.newSession, resolvedSessionFile);
			this.#expectedDiskSize = sourceSize;
			this.#forceFileCreation = true;
			await this.#rewriteAtomically();
			this.#fileIsCurrent = true;
			return;
		}

		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);
		// loadEntriesFromFile guarantees entries[0] is a valid session header.
		const header = fileEntries[0] as SessionHeader;

		// Adopt the loaded session's working directory only when it is verifiably
		// accessible. Sessions live in a dir keyed by their cwd, so resuming a
		// session from another project must re-point cwd/sessionDir at that
		// project — but a deleted OR permission-blocked directory (macOS TCC
		// denial) must not be adopted: callers without a cwd-change callback
		// (extension UI, RPC) would otherwise track a directory the process
		// cannot enter. Keep the current cwd so the session stays where the
		// user already is.
		const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryIsEnterable(headerCwd))) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#fallbackRuntimeOnly = false;
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		} else if (headerCwd && headerCwd !== path.resolve(this.#cwd)) {
			// Header cwd not enterable: keep runtime cwd but mark fallback
			// so workspace changes stay runtime-only until the transcript
			// is relocated.
			this.#fallbackRuntimeOnly = true;
		} else {
			this.#fallbackRuntimeOnly = false;
		}

		this.#applyEntries(header, fileEntries.slice(1) as SessionEntry[]);
		this.#expectedDiskSize = sourceSize;
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated || loaded.malformedRecords > 0;
		this.#loadedMalformedRecords = loaded.malformedRecords;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;

		if (this.sanitizeLoadedOpenAIResponsesReplayMetadata()) this.#rewriteRequired = true;
	}

	/**
	 * Start a new session and persist its header before returning, except for a
	 * `drop` (/delete) successor.
	 *
	 * The durable empty boundary prevents a later process on another terminal
	 * from selecting the previous conversation as the most recent session. The
	 * drop path does not need it: the fresh terminal breadcrumb already pins
	 * this terminal to the successor, and if deleting the predecessor failed,
	 * that surviving non-empty transcript is the correct resume target.
	 * Materializing the successor there would only leave a zero-turn stub
	 * behind when the user quits, so it keeps the ordinary lazy gate and writes
	 * once it has content.
	 */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#drainAndCloseWriter();
		const sessionFile = this.#resetToNewSession(options);
		if (options?.drop !== true) await this.ensureOnDisk();
		return sessionFile;
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
		this.#clearDiskError();
		this.#reconcileSessionDirForFallback();

		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		this.#sessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		this.#expectedDiskSize = null;
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
			parentSession: parentSessionId,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
			taskPromptCacheKey: this.#header.taskPromptCacheKey,
		};
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#draftOnlySessionCleanupArmed = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		await this.#rewriteAtomically();
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	/** Move the session to a new working directory. */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));
		const expectedSessionFile = this.#sessionFile
			? path.join(nextSessionDir, path.basename(this.#sessionFile))
			: undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			!this.#fallbackRuntimeOnly &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir)) &&
			(!expectedSessionFile || path.resolve(this.#sessionFile!) === path.resolve(expectedSessionFile))
		) {
			return;
		}

		// A move writes both paths: it must neither move a session another live
		// omp process writes nor replace a destination one writes. Checked before
		// relocation starts (appends still go to the source) and before any
		// directory is created, so a refusal touches nothing.
		let destination: { id: string; release: () => void } | undefined;
		// Hold the lease of the session in the destination file until the move
		// settles, so its owner cannot start writing mid-move. Our own id is
		// refcounted, never contended.
		const claimDestination = async (file: string): Promise<void> => {
			const id = await readSessionHeaderId(file);
			if (id === undefined || id === destination?.id) return;
			const release = this.#storage.claimSession?.(id, file);
			if (release === null) {
				throw new SessionMoveRefusedError(
					`Cannot move session to "${file}": another live omp process writes the session there. Nothing was moved.`,
				);
			}
			destination?.release();
			destination = release ? { id, release } : undefined;
		};
		// The file at the source path must still be this session: if another
		// session replaced it, moving it would carry that session away from its
		// writer, whose lease our id never covered.
		const assertSourceIsOurs = async (file: string): Promise<void> => {
			const id = await readSessionHeaderId(file);
			if (id !== undefined && id !== this.#sessionId) {
				throw new SessionMoveRefusedError(
					`Cannot move session "${file}": the file now holds a different session. Nothing was moved.`,
				);
			}
		};
		if (this.#persist && this.#sessionFile && this.#storage.claimSession) {
			// Every persisted move rewrites the journal (at least its header cwd),
			// even when the path stays the same.
			await assertSourceIsOurs(this.#sessionFile);
			this.#claimSession();
			if (this.#sessionClaim?.release === undefined) {
				throw new SessionMoveRefusedError(
					`Cannot move session "${this.#sessionFile}": another live omp process writes it. Nothing was moved.`,
				);
			}
			if (expectedSessionFile && path.resolve(this.#sessionFile) !== path.resolve(expectedSessionFile)) {
				await claimDestination(expectedSessionFile);
			}
		}

		let sessionFileExisted = false;
		// Track source+dest for concurrent completed appends during relocation
		// (see `#sessionFileRelocating`). Existence of either path decides the
		// live write target — not a `#diskEpoch` bump, which would cancel any
		// disk task already queued at the current epoch (e.g. a header-only
		// `ensureOnDisk()` materializing rewrite) before the drain below runs it.
		if (this.#persist && this.#sessionFile) {
			const source = this.#sessionFile;
			const dest = path.join(nextSessionDir, path.basename(source));
			this.#sessionFileRelocating = { source, dest };
		}

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				await this.#drainAndCloseWriter();
				this.#clearDiskError();

				const oldSessionFile = this.#sessionFile;
				const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile);
				const newArtifactsDir = artifactsDirectoryFor(newSessionFile);
				const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
				const artifactPathChanged =
					oldArtifactsDir !== null &&
					newArtifactsDir !== null &&
					path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
				sessionFileExisted = this.#storage.existsSync(oldSessionFile);
				let sessionMoved = false;
				let artifactsRenamed = false;

				try {
					if (sessionFileExisted && sessionPathChanged) {
						// The drain awaited: re-check that both paths still hold the
						// sessions we checked.
						await assertSourceIsOurs(oldSessionFile);
						await claimDestination(newSessionFile);
						try {
							await fs.promises.rename(oldSessionFile, newSessionFile);
						} catch (error) {
							if (!isFsError(error) || error.code !== "EXDEV") throw error;
							if (this.#sessionFileRelocating) this.#sessionFileRelocating.copying = true;
							await moveFileAcrossDevices(oldSessionFile, newSessionFile);
						}
						sessionMoved = true;
					}

					if (artifactPathChanged) {
						let artifactStat: fs.Stats | null = null;
						try {
							artifactStat = await fs.promises.stat(oldArtifactsDir);
						} catch (err) {
							if (!isEnoent(err)) throw err;
						}
						if (artifactStat?.isDirectory()) {
							// Only a whole-directory rename can be undone by renaming back;
							// a merge leaves the rollback below to the session file alone.
							artifactsRenamed =
								(await relocateArtifactsDirectory(oldArtifactsDir, newArtifactsDir)) === "renamed";
						}
					}
				} catch (err) {
					if (artifactsRenamed && oldArtifactsDir && newArtifactsDir) {
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
							try {
								await fs.promises.rename(newSessionFile, oldSessionFile);
							} catch (error) {
								if (!isFsError(error) || error.code !== "EXDEV") throw error;
								await moveFileAcrossDevices(newSessionFile, oldSessionFile);
							}
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move session file and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					throw err;
				}

				if (sessionFileExisted && sessionPathChanged) {
					this.#header.previousSessionFiles = [
						...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(oldSessionFile)]),
					];
				}

				this.#sessionFile = newSessionFile;
				// The freshness expectation must describe the NEW path. A successful
				// rename carried this manager's tracked bytes to `newSessionFile`, so
				// #expectedDiskSize still applies; without a rename the destination
				// holds no bytes this manager wrote, so a recreate-from-memory must
				// publish against an absent file rather than a stale size.
				if (sessionPathChanged && !sessionMoved) this.#expectedDiskSize = null;
				this.#artifactManager = null;
				this.#artifactManagerSessionFile = null;
				// Path is repointed; hot-path appends may use `#sessionFile` again.
				this.#sessionFileRelocating = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;
			// The stash is scoped to the conversation's pre-move state: a completed
			// move must not let a later opted-in request promote it. Refusals and
			// the internal rollback rethrow above, and the no-op early return never
			// relocates, so all three keep it; a caller undoing this completed move
			// through rollbackMove() re-derives it from the captureState() snapshot.
			this.clearTaskSiblingCandidate();
			// Clear only after the rename has landed. If the move threw,
			// keep the flag so the next relocation retries.
			this.#fallbackRuntimeOnly = false;
			if (this.#additionalDirectories.length === 0) {
				this.#header.additionalDirectories = undefined;
			} else {
				// Re-filter additional roots: the new cwd may have been an
				// additional root, or it may now contain one.
				this.#additionalDirectories = this.#additionalDirectories.filter(d => d !== resolvedCwd);
				this.#header.additionalDirectories =
					this.#additionalDirectories.length > 0 ? this.#additionalDirectories : undefined;
			}

			// Rewrite at the new location when the file already existed (update cwd) or
			// there is in-memory output worth materializing; otherwise stay lazy.
			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}

			if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		} finally {
			this.#sessionFileRelocating = null;
			// The destination is ours or untouched now.
			destination?.release();
		}
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

	/** Persist this session's transcript as a newly identified OMP session. */
	async persistCopy(
		options?: { sessionDir?: string; suppressBreadcrumb?: boolean },
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const sessionDir = options?.sessionDir ?? SessionManager.getDefaultSessionDir(this.#cwd, undefined, storage);
		const manager = new SessionManager(this.#cwd, sessionDir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#resetToNewSession({ taskPromptCacheKey: this.#header.taskPromptCacheKey });
		manager.#sessionName = this.#sessionName;
		manager.#titleSource = this.#titleSource;
		manager.#titleUpdatedAt = this.#titleUpdatedAt;
		manager.#header.title = this.#sessionName;
		manager.#header.titleSource = this.#titleSource;
		manager.#additionalDirectories = [...this.#additionalDirectories];
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? [...manager.#additionalDirectories] : undefined;
		manager.#entries = structuredClone(this.#entries);
		manager.#index.rebuild(manager.#entries);
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		return manager;
	}

	/**
	 * Stage a synchronous group of entry appends and publish the resulting full
	 * journal with one atomic replace. A failed publish removes only the staged
	 * entries, preserves/reparents entries appended concurrently, restores the
	 * prior durable file view, and clears the failed writer latch for retry.
	 *
	 * The callback MUST be synchronous.
	 */
	appendEntriesAtomically<T>(append: () => T): Promise<T> {
		return this.#withAtomicPersistenceLock(() => this.#appendEntriesAtomicallyLocked(append));
	}

	async #appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		if (!this.#persist || !this.#sessionFile) return append();
		if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
		try {
			await this.ensureOnDisk();
			await this.flush();
		} catch (error) {
			const operationError = toError(error);
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
			throw error;
		}

		const batch: AtomicEntryBatch = {
			collecting: true,
			entryIds: new Set(),
			deferredNotifications: [],
			preBatchLeafId: this.#index.leafId(),
			externalLeafChanged: false,
			externalLeafId: null,
		};
		this.#atomicEntryBatch = batch;
		let result!: T;
		try {
			try {
				result = append();
			} finally {
				batch.collecting = false;
			}
			await this.#rewriteAtomically();
			if (!this.#fileIsCurrent || this.#rewriteRequired) {
				throw new Error("Atomic session batch was superseded before commit.");
			}
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(batch.deferredNotifications);
			return result;
		} catch (error) {
			batch.collecting = false;
			const operationError = toError(error);
			this.#rollbackAtomicEntryBatch(batch);
			try {
				await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			} catch (repairError) {
				const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
				this.#pendingDurabilityNotifications.push(...retainedNotifications);
				this.#atomicEntryBatch = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (repairError instanceof SessionPersistenceIndeterminateError) throw repairError;
				throw this.#latchIndeterminate(operationError, [toError(repairError)]);
			}
			const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(retainedNotifications);
			throw error;
		}
	}

	/**
	 * Replace an uncertain append tail with the authoritative in-memory journal.
	 * Callers must only use this for monotonic recovery where every retained
	 * entry remains intended (for example, an explicit terminal tombstone).
	 */
	recoverPersistenceFromCurrentState(): Promise<void> {
		return this.#withAtomicPersistenceLock(async () => {
			if (!this.#persist || !this.#sessionFile) return;
			if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
			const operationError =
				this.#diskFailure ?? new Error("Authoritative session persistence recovery was requested.");
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
		});
	}

	/** Flush pending writes. Call before switching sessions or on shutdown. */
	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#scheduleDiskWork(async () => {
			if (this.#writer?.isOpen()) await this.#writer.flush();
		});
		// Drain any fire-and-forget backing writes (e.g. `writeTextSync` queued
		// on IndexedSessionStorage during `flushSync`) so callers relying on
		// flush() see the write durably visible to readers.
		await this.#scheduleDiskWork(async () => {
			await this.#storage.drain();
		});
		await this.#pendingArtifactCopy?.done;
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Synchronously makes the current append-only session durable. Avoid rewriting
	 * an already-current file: large restored sessions can contain GiB of compacted
	 * history, and Ctrl+C must not rebuild the whole JSONL string just to flush.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) throw new Error("Cannot synchronously flush during an atomic session batch.");
		if (this.#diskFailure) throw this.#diskFailure;
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			this.#writer?.flushSync?.();
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously();
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Drop only session files that this manager saw materialized for a draft and
	 * that still contain no durable conversation or extension state. Explicit
	 * ensureOnDisk() records (ACP session/new, handoff) stay resumable.
	 */
	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsSync(draftPath)) return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		// Another process can consume the draft and append a real conversation
		// while this manager still has a draft-only in-memory view. Backends that
		// cannot make the final content check and deletion one atomic operation
		// must skip this opportunistic cleanup rather than risk data loss.
		if (!this.#storage.deleteSessionWithArtifactsIf) return;
		try {
			const artifactsDir = this.getArtifactsDir();
			const deleted = await this.#storage.deleteSessionWithArtifactsIf(sessionFile, content => {
				// An `/annotate` draft is work in progress the session must keep.
				if (artifactsDir && hasAnnotationDraftsSync(artifactsDir, this.#header.id)) return false;
				const onDisk = parseSessionContent(content);
				return (
					!onDisk.invalidHeader &&
					onDisk.malformedRecords === 0 &&
					(onDisk.entries.slice(1) as SessionEntry[]).every(isDraftOnlyMetadataEntry)
				);
			});
			if (!deleted) {
				await this.#clearDraftOnlySessionMarker();
				this.#draftOnlySessionCleanupArmed = false;
				return;
			}
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	/** Flush, then close the append writer. */
	async close(): Promise<void> {
		if (!this.#persist) return;
		// Closing gives up this process's ownership claim; a later write reclaims it.
		const claim = this.#sessionClaim;
		claim?.release?.();
		if (claim) claim.release = undefined;
		// A prior `flushSync` can self-conflict with this manager's own
		// unconfirmed deferred publish; drain despite the latch so that
		// publish can still confirm before we give up on the transcript.
		await this.#scheduleDiskWork(
			async () => {
				const hadWriter = this.#writer !== undefined;
				await this.#closeWriterHandle();
				if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
					this.#fileIsCurrent = true;
			},
			{ ignorePriorError: true },
		);
		await this.#pendingArtifactCopy?.done;
		await this.#dropIfEmptyAndNoDraft();
		// Wait for any queued backing writes (IndexedSessionStorage per-path
		// tail) to become durable so a graceful shutdown does not exit while
		// a fire-and-forget publish is still on the wire.
		await this.#scheduleDiskWork(
			async () => {
				await this.#storage.drain();
			},
			{ ignorePriorError: true },
		);
		if (
			this.#diskFailure &&
			this.#sessionFile &&
			this.#storage.defersSyncPublish &&
			!this.#entriesReleased &&
			this.#shouldHaveSessionFile()
		) {
			// Deferred-publish only: a synchronous backend's drain() is a
			// no-op, so any failure there is a genuine external conflict or a
			// permanent write failure, not a self-race this retry can catch
			// up on. seal() disabled the ordinary mid-life repair path, so
			// close() issues the terminal write directly instead.
			const operationError = this.#diskFailure;
			const sessionFile = this.#sessionFile;
			await this.#scheduleDiskWork(
				async () => {
					await this.#publishAuthoritativeBody(sessionFile, operationError);
					this.#clearDiskError();
				},
				{ ignorePriorError: true },
			).catch(() => undefined);
		}
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Raise the terminal write barrier ahead of the final {@link close}. Once
	 * sealed:
	 * - every later append, title change, and rewrite is a dropped no-op —
	 *   including work an event handler tries to enqueue while dispose is
	 *   awaiting `close()` on the disk tail;
	 * - the disk epoch is bumped, so queued-but-unexecuted tail work is
	 *   superseded and an ALREADY-RUNNING fenced/repair rewrite (awaiting the
	 *   tail, drain, writer close, or the atomic stage) fails its commit guard
	 *   at the rename fence instead of publishing over a revived file.
	 * The final `close()` itself is scheduled after the bump and still runs;
	 * pre-seal hot-path appends are already in the page cache. Idempotent;
	 * terminal.
	 */
	seal(): void {
		if (this.#released) return;
		this.#released = true;
		this.#diskEpoch++;
	}

	/**
	 * Terminal release: drop the in-memory transcript and complete the
	 * {@link seal}. The entry journal and its index mirror the agent's message
	 * array (tool results, file contents, base64 frame images); on a disposed
	 * session — e.g. a parked subagent still referenced by the lifecycle
	 * adoption record — they would otherwise stay pinned for the process
	 * lifetime.
	 *
	 * Closes the append writer; with the seal up, nothing can reopen it. A
	 * revival may reopen the same JSONL through a NEW manager the moment
	 * dispose returns; a late event handler resuming on THIS manager must
	 * never race that writer — and a post-release rewrite would persist the
	 * now-empty entry list, truncating the transcript. Reads after this point
	 * reopen from disk (revival, `history://`). Only call from session
	 * dispose, after the final `close()`; idempotent.
	 */
	releaseRetainedEntries(): void {
		this.seal();
		this.#entries = [];
		this.#index.clear();
		this.#inMemoryArtifacts = null;
		this.#closeWriterEventually();
		this.#entriesReleased = true;
	}

	getCwd(): string {
		return this.#cwd;
	}

	/** Recorded cwd from the session header (original project), may differ from runtime {@link getCwd} when fallback retained launch cwd. */
	getRecordedCwd(): string | undefined {
		return this.#header?.cwd;
	}

	setCwdWithoutRelocation(newCwd: string): void {
		const resolvedCwd = path.resolve(newCwd);
		if (resolvedCwd === path.resolve(this.#cwd)) {
			this.#fallbackRuntimeOnly = true;
			return;
		}
		this.#cwd = resolvedCwd;
		this.#fallbackRuntimeOnly = true;
		if (this.#sessionFile) {
			this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		}
	}
	adoptRecordedCwd(): void {
		const recordedCwd = this.#header.cwd;
		if (!recordedCwd) return;
		this.#cwd = path.resolve(recordedCwd);
		if (this.#sessionFile) this.#sessionDir = path.dirname(this.#sessionFile);
		this.#fallbackRuntimeOnly = false;
		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Re-anchor the session bucket to the runtime cwd after a fallback.
	 * The fallback flag keeps the transcript at its recorded path (stale
	 * bucket) while runtime cwd is the launch dir; only a true relocation
	 * should recompute sessionDir. Workspace-dir mutations must not clear
	 * it early.
	 */
	#reconcileSessionDirForFallback(): void {
		if (this.#fallbackRuntimeOnly) {
			this.#sessionDir = computeDefaultSessionDir(this.#cwd, this.#storage);
			this.#fallbackRuntimeOnly = false;
		}
	}

	/** Additional workspace directories beyond cwd (multi-root), absolute and normalized. */
	getAdditionalDirectories(): string[] {
		return [...this.#additionalDirectories];
	}

	/**
	 * Persist a workspace-directory change to the session header. Respects the
	 * lazy-persistence gate: a session with no durable output yet keeps the
	 * change in memory (the header lands with the first real write), so seeding
	 * roots at launch never materializes an empty resumable session file.
	 */
	async #persistWorkspaceDirectoriesChange(): Promise<void> {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Add a workspace directory. Normalizes (relative to cwd), dedupes, rejects
	 * the cwd itself, persists to the session header, and triggers an atomic
	 * rewrite so the change survives a crash. Returns the resolved absolute
	 * path or `null` when the directory was already present (no-op).
	 */
	async addWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		if (resolved === path.resolve(this.#cwd)) {
			throw new Error("The current working directory is already the primary workspace root.");
		}
		if (this.#additionalDirectories.includes(resolved)) return null;
		this.#additionalDirectories = [...this.#additionalDirectories, resolved];
		// In fallback the transcript is still in the stale bucket; keep
		// workspace edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			return resolved;
		}
		this.#header.additionalDirectories = this.#additionalDirectories;
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/**
	 * Remove a workspace directory by absolute or cwd-relative path. Persists
	 * the trimmed header. Returns the resolved path that was removed, or
	 * `null` when the directory was not an additional root (no-op).
	 */
	async removeWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		const idx = this.#additionalDirectories.findIndex(p => path.resolve(p) === resolved);
		if (idx === -1) return null;
		this.#additionalDirectories = this.#additionalDirectories.filter((_, i) => i !== idx);
		// In fallback keep edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			return resolved;
		}
		if (this.#additionalDirectories.length === 0) {
			this.#header.additionalDirectories = undefined;
		} else {
			this.#header.additionalDirectories = this.#additionalDirectories;
		}
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/** Seed additional directories from settings or a passed list. Also called on resumed sessions with --add-dir; persists the updated header when the session file is already durable. No-op when the normalized list is unchanged (avoids rewriting large session files on every startup). */
	async setAdditionalDirectories(directories: string[]): Promise<void> {
		const workspace = normalizeSessionWorkspace({ cwd: this.#cwd, directories });
		const next = additionalWorkspaceDirectories(workspace);
		// In fallback keep edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			this.#additionalDirectories = next;
			return;
		}
		if (
			next.length === this.#additionalDirectories.length &&
			next.every((d, i) => d === this.#additionalDirectories[i])
		) {
			return;
		}
		this.#additionalDirectories = next;
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = this.#additionalDirectories;
		} else {
			this.#header.additionalDirectories = undefined;
		}
		await this.#persistWorkspaceDirectoriesChange();
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

	/**
	 * Whether the current session has actually been materialized to durable
	 * storage (the JSONL exists on disk / in the active storage backend).
	 *
	 * Session persistence is lazy: the file is only written once the history
	 * contains an assistant message (or an explicit {@link ensureOnDisk}
	 * caller forces it). Until then {@link getSessionFile} returns an allocated
	 * path that leads nowhere, so a `--resume <id>` hint built from it would
	 * always fail. Consumers that advertise a resume command must gate on this
	 * (issue #8860).
	 */
	isSessionOnDisk(): boolean {
		return !!this.#sessionFile && this.#storage.existsSync(this.#sessionFile);
	}

	/**
	 * {@link isSessionOnDisk}, counting only what the backing store has
	 * confirmed. Remote storage publishes asynchronously, so a hint printed
	 * just before the process exits must not count a write still in flight:
	 * the exit aborts it and `--resume <id>` would find nothing. A deferring
	 * store without `existsConfirmedSync` cannot vouch for its writes, so it
	 * reports false.
	 */
	isSessionConfirmedOnDisk(): boolean {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return false;
		const storage = this.#storage;
		if (storage.existsConfirmedSync) return storage.existsConfirmedSync(sessionFile);
		return !storage.defersSyncPublish && storage.existsSync(sessionFile);
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	/** Source artifacts a seance fork reads in place; null for ordinary sessions. */
	getSeanceSourceArtifactsDir(): string | null {
		return artifactsDirectoryFor(this.#header?.seanceSource);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		if (this.#released) return {};
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		if (this.#released) return undefined;
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

	/**
	 * Content of a spill artifact kept in memory by a non-persistent session.
	 * Null for unknown ids and for file-backed sessions, whose artifacts resolve
	 * through {@link getArtifactPath}.
	 */
	getArtifactContent(id: string): string | null {
		return this.#inMemoryArtifacts?.get(id) ?? null;
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

		const sessionFile = this.#sessionFile;
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			!this.#storage.existsSync(sessionFile) &&
			this.#entries.every(isDraftOnlyMetadataEntry);
		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
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
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	/** Tracks user rename requests; background title updates do not invalidate them. */
	get titleRevision(): number {
		return this.#titleRevision;
	}

	/** Malformed JSONL records skipped when this session file was loaded (0 for new sessions). */
	get loadedMalformedRecords(): number {
		return this.#loadedMalformedRecords;
	}

	/** Invalidate older generated renames before starting a new request. */
	reserveTitleRevision(): number {
		return ++this.#titleRevision;
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
	 * Subscribe to persistence failures so hosts can surface lost-durability state.
	 *
	 * A failure latched before this call — a store that failed on its first write,
	 * before the host wired its observer — is replayed to the new subscriber.
	 * Without the replay the host sees only a dispose rejection it cannot
	 * attribute to persistence (issue #11493).
	 */
	onPersistenceError(cb: (error: Error) => void): () => void {
		this.#persistenceErrorCallbacks.add(cb);
		const latched = this.#diskFailure;
		if (latched) this.#invokePersistenceObserver(cb, latched);
		return () => {
			this.#persistenceErrorCallbacks.delete(cb);
		};
	}

	/**
	 * Subscribe to {@link SessionPersistenceNotice}s: this session moved to a new
	 * file and keeps saving there, which the user should hear about but which is
	 * not a failure. Every notice raised before this call is replayed to the new
	 * subscriber, as {@link onPersistenceError} replays a latched failure, so each
	 * subscriber sees each notice once however late it subscribed.
	 */
	onPersistenceNotice(cb: (notice: SessionPersistenceNotice) => void): () => void {
		for (const notice of this.#persistenceNotices) this.#invokePersistenceObserver(cb, notice);
		this.#persistenceNoticeCallbacks.add(cb);
		return () => {
			this.#persistenceNoticeCallbacks.delete(cb);
		};
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#released) return false;
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		if (source === "user") this.#titleRevision++;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#notifyEntryAppended(entry);
		await this.#persistTitleChangeEntry(entry, { title, source, updatedAt: timestamp });
		// Keep the recent-sessions title index current so welcome-screen lookups
		// never have to content-scan this session's file.
		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordSessionTitle(this.#sessionId, title);
		}

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Rename a session file that is not loaded in this process, e.g. from the
	 * resume picker. Returns the title as stored (the session canonicalizes
	 * it), or null when the rename did not happen.
	 *
	 * The cross-process ownership lease is claimed before the transcript is
	 * loaded and held until the write is done. Claiming first is what makes
	 * the rename safe: another process appending between our load and our
	 * write would leave us parenting the title entry to a stale leaf, so the
	 * reopened session followed the older branch and hid the other process's
	 * turn. Holding the lease from before the load keeps the loaded leaf
	 * stable until the title is written.
	 */
	static async renameSessionTitle(
		sessionPath: string,
		title: string,
		options?: { cwd?: string },
	): Promise<string | null> {
		const storage = new FileSessionStorage();
		// The header id is what the lease is keyed on; a null claim means
		// another live process owns the session, so leave it alone.
		const sessionId = await readSessionHeaderId(sessionPath);
		if (!sessionId) return null;
		const probe = storage.claimSession(sessionId, sessionPath);
		if (!probe) return null;
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(sessionPath, undefined, storage, {
				initialCwd: options?.cwd,
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			if (manager.getSessionFile() !== sessionPath) return null;
			if (!(await manager.setSessionName(title, "user"))) return null;
			return manager.getSessionName() ?? null;
		} finally {
			try {
				await manager?.close();
			} finally {
				probe();
			}
		}
	}

	/**
	 * Journal an idle recap for this session in history.db. Recaps never enter
	 * the session file or LLM context; in-memory sessions are not journaled.
	 */
	recordRecap(recap: string): void {
		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordSessionRecap(this.#sessionId, this.#cwd, recap);
		}
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * The live header and entries, for collab replication. Nothing is copied:
	 * the host mutates entries in place on rewrite paths, so callers must not
	 * mutate what this returns and must serialize it synchronously, before any
	 * such rewrite can run.
	 */
	snapshotForReplication(): { header: SessionHeader; entries: readonly SessionEntry[] } {
		return { header: this.#header, entries: this.#entries };
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

	/**
	 * Append to a non-active branch without changing the current leaf.
	 * Used by work that retains ownership of a branch across tree navigation.
	 *
	 * The entry records the active leaf it interrupted (`activeLeafId`) so a
	 * reload replays the same leaf instead of adopting this off-branch tail.
	 * Pass `preserveActiveLeaf: false` when the caller selects the new entry as
	 * the leaf instead (a re-answered `ask`).
	 */
	appendMessageToBranch(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
		parentId: string | null,
		options?: { preserveActiveLeaf?: boolean },
	): string {
		if (parentId !== null && !this.#index.has(parentId)) throw new Error(`Entry ${parentId} not found`);
		const activeLeafId = this.#index.leafId();
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.#index),
			parentId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			message,
			...(options?.preserveActiveLeaf === false ? {} : { activeLeafId }),
		};
		// The entry never joins the active branch; keep it out of any branch view
		// already handed out. Recording `activeLeafId` leaves the index's leaf on
		// the active branch, as the in-memory contract requires.
		this.#index.detachBranchView();
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Record usage on its initiating branch without moving a successor branch or session. */
	appendModelUsage(
		usage: Pick<
			ModelUsageEntry,
			"purpose" | "role" | "api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage"
		>,
		owner: { sessionId: string; parentId: string | null },
	): string | undefined {
		if (this.#sessionId !== owner.sessionId || (owner.parentId !== null && !this.#index.has(owner.parentId))) {
			return undefined;
		}
		const activeLeafId = this.#index.leafId();
		const entry: ModelUsageEntry = {
			type: "model_usage",
			id: generateId(this.#index),
			parentId: owner.parentId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			...usage,
			...(activeLeafId !== owner.parentId ? { activeLeafId } : {}),
		};
		this.#recordEntry(entry);
		// Through #setLeaf so an in-flight atomic batch restores this leaf, not the usage entry, on rollback.
		if (activeLeafId !== owner.parentId) this.#setLeaf(activeLeafId);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 * @param resolvedModelIsFallback Whether this transition selected a retry-fallback model
	 */
	appendModelChange(model: string, role?: string, resolvedModelIsFallback = false): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			...this.#freshEntryFields(),
			model,
			role,
			resolvedModelIsFallback,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string[];
		task: string;
		tools: string[];
		agent?: string;
		modelRole?: string;
		resolvedModel?: string;
		retryFallback?: RetryFallbackRole;
		readOnly?: boolean;
		outputSchema?: unknown;
		outputSchemaMode?: StructuredSubagentSchemaMode;
		restrictToolNames?: boolean;
		spawns?: string;
		readSummarize?: boolean;
		advisor?: string;
		compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
		isolated?: boolean;
		workPoolYieldItems?: WorkPoolYieldItem[];
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		options: {
			details?: T;
			fromExtension?: boolean;
			preserveData?: Record<string, unknown>;
			method?: CompactionMethod;
			providerReplayThroughEntryId?: string;
			tokensAfter?: number;
		} = {},
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			tokensAfter: options.tokensAfter,
			method: options.method,
			providerReplayThroughEntryId: options.providerReplayThroughEntryId,
			details: options.details,
			fromExtension: options.fromExtension,
			preserveData: options.preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append the durable conversation boundary recorded by `/clear`. The
	 * collapsed live transcript and the model-context rebuild start after the
	 * latest one, while the full history stays on disk (the plain
	 * `transcript:true` export walks it unchanged).
	 */
	appendResetBoundary(): string {
		const entry: ResetBoundaryEntry = { type: "reset_boundary", ...this.#freshEntryFields() };
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
		this.#bodyRevision++;
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
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
		timestamp?: number,
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const fresh = this.#freshEntryFields();
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...fresh,
			// Prefer the initiating message's own timestamp: without it the entry
			// records the emission time, which on rebuild excludes provider
			// preparation / hook time from the prompt→yield anchor.
			timestamp: timestamp !== undefined ? new Date(timestamp).toISOString() : fresh.timestamp,
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

	/** Append a credential pin recording which OAuth account served `provider`. */
	appendCredentialPin(provider: string, hash: string): string {
		const entry: CredentialPinEntry = {
			type: "credential_pin",
			...this.#freshEntryFields(),
			provider,
			hash,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Latest credential pin per provider on the current branch (root → leaf),
	 * with the effective last-use time of the pinned account.
	 *
	 * Pins are appended only when the serving account *changes*, so a long
	 * session on one account carries a single old pin entry. Any assistant turn
	 * for the same provider after that pin was necessarily served by the pinned
	 * account, so its timestamp advances `lastUsedAt` — a resume seconds after
	 * the last turn seeds a warm sticky instead of a stale one.
	 */
	getCredentialPins(): Map<string, { hash: string; lastUsedAt: number }> {
		const pins = new Map<string, { hash: string; lastUsedAt: number }>();
		for (const entry of this.getBranch()) {
			if (entry.type === "credential_pin") {
				pins.set(entry.provider, { hash: entry.hash, lastUsedAt: new Date(entry.timestamp).getTime() });
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const pin = pins.get(entry.message.provider);
				if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
			}
		}
		return pins;
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded. `skipEphemeral` passes over temporary
	 * switches (retry fallback hops, prewalk, context promotion), returning the
	 * role the session was last assigned.
	 */
	getLastModelChangeRole(options?: { skipEphemeral?: boolean }): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "model_change") continue;
			const role = entry.role ?? "default";
			if (options?.skipEphemeral && (role === EPHEMERAL_MODEL_CHANGE_ROLE || role === PREWALK_MODEL_CHANGE_ROLE)) {
				continue;
			}
			return role;
		}
		return undefined;
	}

	/**
	 * The newest model change on the current branch when it selected a model for
	 * this session only (`temporary`, or a prewalk handoff); undefined when the
	 * newest change assigned a role, was a retry fallback hop, or none was recorded.
	 */
	getSessionLocalModelChange(): ModelChangeEntry | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "model_change") continue;
			return entry.role === "temporary" || entry.role === PREWALK_MODEL_CHANGE_ROLE ? entry : undefined;
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
	 * The active-leaf branch (same entries as `getBranch()`) without the
	 * defensive copy. The array is the manager's memo: never mutate it. It is
	 * live — an entry appended to the current leaf is pushed onto it — so use
	 * `getBranch()` when you need a snapshot that survives appends.
	 */
	getBranchView(): readonly SessionEntry[] {
		return this.#index.branchView();
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), {
			resolveFrameData: data => lazyImageDataSync(this.#blobs, data),
			...options,
		});
	}

	/** Prompt blocks for a snapcompact archive, budgeted and resolved as {@link buildSessionContext} attaches them. */
	snapcompactHistoryBlocks(archive: snapcompact.Archive): (TextContent | ImageContent)[] {
		const resolveFrameData = (data: string) => lazyImageDataSync(this.#blobs, data);
		return snapcompact.historyBlocks(archive, snapcompactHistoryBlockOptions(archive, { resolveFrameData }));
	}

	/** Strip stale OpenAI Responses replay metadata from loaded assistant entries. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}
		if (changed) this.#bodyRevision++;
		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	static getInheritedProviderPromptCacheKey(header: SessionHeader | undefined): string | undefined {
		return header?.taskPromptCacheKey !== undefined ? undefined : (header?.providerPromptCacheKey ?? header?.id);
	}

	/** Seed automatic affinity without turning a legacy fork identity into an explicit override. */
	async setTaskPromptCacheKey(key: string): Promise<void> {
		if (this.#header.taskPromptCacheKey === key && this.#header.providerPromptCacheKey === undefined) return;
		this.#header.taskPromptCacheKey = key;
		this.#header.providerPromptCacheKey = undefined;
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Stash the parent-derived sibling family candidate without touching the
	 * header. Unlike {@link setTaskPromptCacheKey} this is neither persisted nor
	 * carried into forks, moves, or new-session resets, so a fresh identity
	 * starts without it while the per-request policy gate still decides whether
	 * this session's requests consume it.
	 */
	setTaskSiblingCandidate(key: string): void {
		this.#taskSiblingCandidate = key;
	}

	/** Stashed sibling family candidate; consumed only when the request model opts in. */
	getTaskSiblingCandidate(): string | undefined {
		return this.#taskSiblingCandidate;
	}

	/** Drop the stash: a committed switch to a different session adopts that session's identity. */
	clearTaskSiblingCandidate(): void {
		this.#taskSiblingCandidate = undefined;
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
		this.#setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#setLeaf(null);
	}

	/**
	 * Durably move the active branch past a discarded entry.
	 *
	 * The loader reconstructs the active branch from the last physical journal
	 * entry, so changing the in-memory leaf alone is lost on reload. Known
	 * metadata children are chained onto the discarded entry's parent before the
	 * entry is removed. If any child may carry content, the subtree is preserved
	 * off-branch instead. Both paths append a metadata-only branch marker and
	 * rewrite the journal, making the selected path durable.
	 */
	async discardEntryDurably(entryId: string): Promise<void> {
		const entry = this.#index.get(entryId);
		if (!entry) return;
		const children = this.#index.childrenOf(entryId);
		const canReparentChildren = children.every(child => child.type === "service_tier_change");
		let leafId = entry.parentId;
		if (canReparentChildren) {
			for (const child of children) {
				child.parentId = leafId;
				leafId = child.id;
			}
			this.#entries = this.#entries.filter(candidate => candidate.id !== entryId);
			this.#index.rebuild(this.#entries);
		}
		this.branchWithSummary(leafId, "", {
			kind: DISCARDED_ENTRY_BRANCH_MARKER,
			discardedEntryId: entryId,
		});
		await this.rewriteEntries();
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
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
	 * With `copyArtifacts`, the source artifact directory is copied in the background;
	 * the new artifact manager waits for it before allocating ids or resolving
	 * `artifact://`, so kept references stay valid and new ids cannot collide.
	 * Returns the new file path, or undefined when not persisting.
	 */
	createBranchedSession(leafId: string, options?: { copyArtifacts?: boolean }): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);

		// Drop label entries from the path; recreate them fresh from the resolved map.
		// Every kept entry lies on the forked path, so a late-usage or off-branch leaf
		// marker no longer applies.
		const entriesToKeep: SessionEntry[] = [];
		for (const entry of branchPath) {
			if (entry.type === "label") continue;
			entriesToKeep.push(entry.activeLeafId === undefined ? entry : { ...entry, activeLeafId: undefined });
		}
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		this.#reconcileSessionDirForFallback();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				runtime: currentRuntimeIdentity(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#header = header;
		this.#entries = [...entriesToKeep, ...labels];
		this.#sessionId = newSessionId;
		this.#taskSiblingCandidate = undefined;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
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
		if (options?.copyArtifacts && sourceSessionFile) {
			this.#pendingArtifactCopy = {
				sessionFile: newSessionFile,
				done: copySessionArtifacts(sourceSessionFile, newSessionFile),
			};
		}
		this.#expectedDiskSize = null;
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
	 * Create a fresh empty session file in the default session directory for
	 * `cwd`, writing only the session header. The returned path can be passed to
	 * `setSessionFile` / `AgentSession.switchSession` when a caller explicitly
	 * needs a brand-new persisted session at a cwd-derived path.
	 */
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`);
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Artifacts are copied
	 * recursively by default; nested agents that deliberately share their parent's
	 * artifact root may disable this with `copyArtifacts: false`.
	 *
	 * `seance` creates a read-only consult fork instead: artifacts stay in the
	 * source (the header's `seanceSource` points lookups at them), inherited
	 * workspace roots are dropped, and the source's `session_init` contracts
	 * become inert `source_session_init` custom entries so revival never
	 * mistakes them for the fork's own.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: {
			copyArtifacts?: boolean;
			suppressBreadcrumb?: boolean;
			sessionFile?: string;
			resetInheritedCost?: boolean;
			repairInterruptedTail?: boolean;
			seance?: boolean;
		},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		// A missing source must fail instead of forking an empty parentless session:
		// the loader swallows ENOENT by default for fresh-session opens, so fork opts out.
		let sourceEntries: FileEntry[];
		try {
			sourceEntries = await loadEntriesFromFile(sourcePath, storage, { throwIfMissing: true });
		} catch (err) {
			if (isEnoent(err) || isEnotdir(err)) throw new ForkSourceNotFoundError(sourcePath);
			throw err;
		}
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const history = sourceEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		normalizeLoadedUsage(history);
		if (options?.resetInheritedCost) SessionManager.#resetInheritedUsageCost(history);
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(sourceHeader),
				taskPromptCacheKey: sourceHeader?.taskPromptCacheKey,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#additionalDirectories = options?.seance
			? []
			: (sourceHeader?.additionalDirectories ?? []).filter(d => d !== path.resolve(cwd));
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? manager.#additionalDirectories : undefined;
		if (options?.seance) {
			manager.#header.seanceSource = path.resolve(sourcePath);
			SessionManager.#neutralizeSessionInits(history);
		}
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		manager.#entries = history;
		manager.#index.rebuild(history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		if (options?.repairInterruptedTail) {
			SessionManager.#repairForkedInterruptedTail(history, manager.#index.pathTo());
			manager.#index.rebuild(history);
		}
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically();
		if (!options?.seance && options?.copyArtifacts !== false) {
			await copySessionArtifacts(sourcePath, manager.#sessionFile!);
		}
		return manager;
	}

	/** Replace inherited `session_init` entries, in place, with inert custom entries keeping the same tree position. */
	static #neutralizeSessionInits(history: SessionEntry[]): void {
		for (let index = 0; index < history.length; index++) {
			const entry = history[index]!;
			if (entry.type !== "session_init") continue;
			const neutralized: CustomEntry = {
				type: "custom",
				customType: "source_session_init",
				id: entry.id,
				parentId: entry.parentId,
				timestamp: entry.timestamp,
				data: entry,
			};
			history[index] = neutralized;
		}
	}

	/**
	 * Zero the monetary attribution (cost, credits, premium requests) on the
	 * forked history's assistant turns and completed `task` results, in place.
	 *
	 * A tan fork is a fresh agent that inherits the parent's transcript purely
	 * for context; its spend must reflect only its own work. Session cost is
	 * derived by summing `usage.cost` over the transcript, so without this the
	 * clone's Agent Hub row would open at the parent's entire accumulated cost.
	 * Token counts are left intact — compaction anchors and context math depend
	 * on them — since only billing attribution is inherited, not context size.
	 */
	static #resetInheritedUsageCost(history: SessionEntry[]): void {
		for (const entry of history) {
			resetUsageCost(entryUsage(entry));
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") {
				resetTaskResultBilling(entry.message.details);
			}
		}
	}

	/**
	 * Pair unresolved calls on the fork's active branch with diagnostic results.
	 *
	 * Forks can be taken while the source parent is still running. A result that
	 * arrives later is only present in that parent's history, so the child must
	 * preserve an unknown outcome instead of asserting the tool never ran.
	 *
	 * A source whose process exit follows its last message is no longer running;
	 * it keeps the resume recovery instead: startup warns about the pending
	 * calls, then pairs them with process-exit results and the interrupted-turn
	 * abort record.
	 *
	 * Sibling branches are excluded: only the root-to-active-leaf path is copied.
	 */
	static #repairForkedInterruptedTail(history: SessionEntry[], branch: readonly SessionEntry[]): void {
		const leaf = branch.at(-1);
		if (!leaf || sessionExitFollowsLastMessage(branch)) return;
		const results = createInterruptedToolResults(branch, "fork");
		if (results.length === 0) return;
		const usedIds = new Set(history.map(entry => entry.id));
		let parentId = leaf.id;
		for (const result of results) {
			const id = generateId(usedIds);
			usedIds.add(id);
			const entry: SessionMessageEntry = {
				type: "message",
				id,
				parentId,
				timestamp: nowIso(),
				runtime: currentRuntimeIdentity(),
				message: result,
			};
			history.push(entry);
			parentId = id;
		}
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 * @param options.throwIfMissing Propagate ENOENT instead of creating a new session at a missing path.
	 * @param options.parentSession Parent session file recorded when the file is empty or missing.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { initialCwd?: string; parentSession?: string; suppressBreadcrumb?: boolean; throwIfMissing?: boolean },
	): Promise<SessionManager> {
		const probed = await loadSessionFile(filePath, storage, { throwIfMissing: options?.throwIfMissing });
		const header = probed.entries.find(entry => entry.type === "session") as SessionHeader | undefined;
		// Resume into the session's recorded cwd only when it is verifiably
		// accessible. A deleted or permission-blocked (macOS TCC denial) project
		// dir would make the constructor's #cwd — and the `setProjectDir` chdir
		// interactive mode runs next — fail, so fall back to the launch cwd and
		// anchor /new and /branch there too, keeping the resumed session where
		// the user already is.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryIsEnterable(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		// Freshness gate for fail-closed callers (revive): the cwd probe above
		// yields, so re-read after it and adopt only the fresh snapshot. A
		// transcript deleted, truncated, or replaced mid-probe then fails
		// closed here (ENOENT / holds-no-entries, without minting) instead of
		// reviving stale history. Other callers keep the single probe read.
		const loaded = options?.throwIfMissing
			? await loadSessionFile(filePath, storage, { throwIfMissing: true })
			: probed;
		await manager.#setSessionFile(filePath, loaded, {
			throwIfMissing: options?.throwIfMissing,
			newSession: { parentSession: options?.parentSession },
		});
		return manager;
	}

	/**
	 * Whether `session` was recorded in a worktree of `cwd`'s repository that no
	 * longer exists, e.g. a `/wt` worktree removed since. Resume such a session
	 * through {@link openRelocated} into `cwd`: its own directory cannot be entered.
	 * @param sessionDir `cwd`'s session directory; defaults to the cwd-derived one.
	 */
	static async isFromRemovedWorktree(
		session: Pick<SessionInfo, "path" | "cwd">,
		cwd: string,
		sessionDir?: string,
	): Promise<boolean> {
		if (!session.cwd || !(await directoryIsMissing(session.cwd))) return false;
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
		const home = path.resolve(path.dirname(session.path));
		return (await worktreeSessionDirs(cwd, dir)).some(sibling => path.resolve(sibling) === home);
	}

	/**
	 * Open a session whose recorded directory `recordedCwd` is gone and move it,
	 * artifacts included, into `cwd` so it resumes from there.
	 * @param sessionDir Target session directory; defaults to `cwd`'s.
	 * @throws {SessionMoveRefusedError} when another live omp process writes the session.
	 */
	static async openRelocated(
		sessionPath: string,
		recordedCwd: string,
		cwd: string,
		sessionDir?: string,
	): Promise<SessionManager> {
		// Anchor at the missing recorded cwd: `open` otherwise falls back to the
		// launch cwd, which would make the `moveTo` below a no-op whenever the move
		// target equals it. moveTo never chdirs, so the stale cwd is only the
		// relocation source, not a directory we enter.
		const manager = await SessionManager.open(sessionPath, sessionDir, undefined, { initialCwd: recordedCwd });
		try {
			await manager.moveTo(cwd, sessionDir);
		} catch (error) {
			await manager.close();
			throw error;
		}
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
		init: PersistedSessionInit | null;
		seanceSource?: string;
	} | null> {
		let header: SessionHeader | undefined;
		const initEntries: FileEntry[] = [];
		const visit = (entry: FileEntry): void => {
			if (entry.type === "session") {
				header ??= entry;
				return;
			}
			if (entry.type === "session_init") initEntries.push(entry);
		};

		try {
			await visitEntriesFromFile(filePath, visit, storage);
		} catch {
			return null;
		}
		// A missing, empty, or invalid file has no usable session.
		if (!header) return null;
		return {
			cwd: header.cwd ?? getProjectDir(),
			init: extractSessionInit(initEntries),
			seanceSource: header.seanceSource,
		};
	}
	/**
	 * Continue the most recent session, or create a new one if none exists.
	 *
	 * When the chosen session's conversation went on in another file (it moved
	 * off its file; see `findSessionContinuation`), this opens the copy to
	 * resume instead and reports it to `onSessionContinuation`. The session the
	 * terminal's record of its last session names was chosen, as a file named
	 * to `--resume` is, so it is kept when it has turns its continuation lacks
	 * ({@link findSessionContinuation}). Without that record the pick goes by
	 * file time, and a process writes its exit record or an idle cache refresh
	 * long after its last turn, so the pick can be any copy
	 * ({@link findRecentSessionContinuation}).
	 */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options: { onSessionContinuation?: (continuation: SessionContinuation) => void } = {},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// A lazy fresh-session boundary whose JSONL was never materialized
			// (for example, initial creation followed by exit before any assistant
			// output). Honor the boundary rather than falling back to
			// findMostRecentSession(), which would resurrect an older transcript.
			// Explicit newSession() boundaries are materialized before it returns so
			// this remains correct even when the relaunch has a different terminal id.
			if (
				breadcrumb.fresh &&
				!breadcrumb.exists &&
				(!sessionDir || pathIsWithin(dir, path.dirname(breadcrumb.sessionFile)))
			) {
				const manager = new SessionManager(cwd, dir, true, storage);
				manager.#resetToNewSession();
				return manager;
			}

			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				if (!sessionDir || pathIsWithin(dir, breadcrumb.sessionFile)) {
					chosenSession = breadcrumb.sessionFile;
				}
			} else {
				// The terminal's last session started in a different cwd. Re-root only
				// when that cwd is gone *and* this location is the same directory
				// inode (a worktree move/rename). A missing path alone is not a move.
				// When an explicit sessionDir is reused across the move, the stale
				// breadcrumb file may be the newest entry there; prefer a genuine
				// current-cwd session.
				let newestInTargetDir = await findMostRecentNonEmptySession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !fs.existsSync(breadcrumbCwd);
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd &&
							!isEmptySession(session),
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const candidateForMove =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				// Absence of the recorded cwd is not a move: deleted, unmounted, and
				// offline paths also fail existsSync. Only re-root when the continue
				// cwd is the same directory inode the breadcrumb recorded — a rename.
				// Cross-filesystem `mv` (new inode) is intentionally not a re-root.
				const looksLikeMovedProject =
					candidateForMove && hasPositiveMovedProjectEvidence(breadcrumb.cwdIdentity, resolvedCwd);
				if (looksLikeMovedProject) {
					logger.warn("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					// The breadcrumb names this session, as a file named to `--resume` is named.
					const continuation = await findSessionContinuation(breadcrumb.sessionFile, storage);
					const manager = await SessionManager.open(
						continuation?.session.path ?? breadcrumb.sessionFile,
						undefined,
						storage,
						{ initialCwd: breadcrumbCwd },
					);
					try {
						await manager.moveTo(cwd, sessionDir);
						if (continuation) options.onSessionContinuation?.(continuation);
						return manager;
					} catch (err) {
						if (!(err instanceof SessionMoveRefusedError)) throw err;
						// Another live omp process still writes the session (the
						// project was renamed under it): leave it there and continue
						// as if no move were possible.
						logger.warn("Not re-rooting moved session: it is open in another omp process", {
							from: breadcrumbCwd,
							to: resolvedCwd,
						});
						await manager.close();
					}
				} else if (candidateForMove) {
					logger.warn(
						"Not relocating session: project directory is unavailable and there is no evidence it moved here",
						{ from: breadcrumbCwd, to: resolvedCwd },
					);
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentNonEmptySession(dir, storage);
		if (chosenSession) {
			const fromBreadcrumb = !!breadcrumb && path.resolve(chosenSession) === path.resolve(breadcrumb.sessionFile);
			const continuation = fromBreadcrumb
				? await findSessionContinuation(chosenSession, storage)
				: await findRecentSessionContinuation(chosenSession, storage);
			if (continuation) {
				options.onSessionContinuation?.(continuation);
				chosenSession = continuation.session.path;
			}
		}

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
		const sessions = await listSessions(dir, storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/** List all sessions across all project directories, pinned sessions first. */
	static async listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		const sessions = await listAllSessions(storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/**
	 * Picker-facing project list in recency order (the picker floats pins),
	 * untitled empties dropped. Titled empties stay — a title is user intent worth resuming.
	 * By default includes the same folder in the repository's other git worktrees,
	 * so a session `/wt` moved stays reachable from the checkout it left.
	 * The directory scope limits the picker to its own session bucket.
	 */
	static async listForPicker(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		worktreeScope: "directory" | "repo" = "repo",
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const [pinned, siblingDirs] = await Promise.all([
			loadPinnedSessionIds(),
			worktreeScope === "repo" ? worktreeSessionDirs(cwd, dir) : [],
		]);
		return filterSessionsForPicker(await listSessions(dir, storage, siblingDirs), pinned);
	}

	/** Picker-facing cross-project list, same empty-session rule as {@link listForPicker}. */
	static async listAllForPicker(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return filterSessionsForPicker(await listAllSessions(storage), await loadPinnedSessionIds());
	}
}

/** True when already-loaded entries carry at least one real user/assistant message. */
export function hasConversationalHistory(entries: readonly FileEntry[]): boolean {
	return entries.some(e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
}

/**
 * The persisted `session_init` contract a cold revive rebuilds a subagent from:
 * the {@link SessionInitEntry} payload without its tree bookkeeping fields.
 */
export interface PersistedSessionInit {
	systemPrompt: string[];
	task: string;
	tools: string[];
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	retryFallback?: RetryFallbackRole;
	readOnly?: boolean;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	restrictToolNames?: boolean;
	spawns?: string;
	readSummarize?: boolean;
	advisor?: string;
	compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
	isolated?: boolean;
	workPoolYieldItems?: WorkPoolYieldItem[];
}

/**
 * Latest persisted `session_init` contract among already-loaded entries, or
 * null when the transcript carries none.
 */
export function extractSessionInit(entries: readonly FileEntry[]): PersistedSessionInit | null {
	let init: PersistedSessionInit | null = null;
	for (const entry of entries) {
		if (entry.type !== "session_init") continue;
		init = {
			systemPrompt: typeof entry.systemPrompt === "string" ? [entry.systemPrompt] : entry.systemPrompt,
			task: entry.task,
			tools: entry.tools,
			agent: entry.agent,
			modelRole: entry.modelRole,
			resolvedModel: entry.resolvedModel,
			retryFallback: entry.retryFallback,
			readOnly: entry.readOnly,
			outputSchema: entry.outputSchema,
			outputSchemaMode: entry.outputSchemaMode,
			restrictToolNames: entry.restrictToolNames,
			readSummarize: entry.readSummarize,
			spawns: entry.spawns,
			advisor: entry.advisor,
			isolated: entry.isolated,
			...(entry.compactionThreshold !== undefined ? { compactionThreshold: entry.compactionThreshold } : undefined),
			...(entry.workPoolYieldItems !== undefined ? { workPoolYieldItems: entry.workPoolYieldItems } : undefined),
		};
	}
	return init;
}

/**
 * If the current session was created by `/move` and contains no real
 * user/assistant messages, delete it so empty move sessions don't accumulate.
 */
export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	if (hasConversationalHistory(sessionManager.getEntries())) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
