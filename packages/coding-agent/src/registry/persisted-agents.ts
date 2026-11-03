import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { resolveExplicitModelRole } from "../config/model-resolver";
import { assistantTurnProducedOutput } from "../session/messages";
import { EPHEMERAL_MODEL_CHANGE_ROLE, PREWALK_MODEL_CHANGE_ROLE } from "../session/session-entries";
import { visitEntriesFromFileStream } from "../session/session-loader";
import { isSameJournalFile, type SessionJournalLiveness, sessionJournalLiveness } from "../session/session-storage";
import { loadBundledAgents } from "../task/agents";
import { isReadOnlyAgent } from "../task/read-only-policy";
import { persistedVibeChildIds } from "../vibe/lifecycle";
import {
	type AgentHistorySummary,
	type AgentMetricsSummary,
	type AgentRef,
	type AgentRegistry,
	MAIN_AGENT_ID,
} from "./agent-registry";
import { getAgentTombstonePath } from "./agent-tombstone";

/** Maximum prefix entries inspected for task metadata. */
const MAX_METADATA_LINES = 64;
/**
 * Upper bound on records scanned to compute an advisor transcript's Hub metrics.
 * Well above any healthy advisor file (post issue #9553 the file grows O(new
 * content)); it exists only so a legacy multi-GB transcript can't stall the
 * render thread when the Hub roster is built.
 */
const MAX_ADVISOR_HISTORY_LINES = 200_000;

/** Where the live agent loop that holds a transcript's journal runs. */
export type LiveJournalHolder = Exclude<SessionJournalLiveness, "free">;

/**
 * Why a transcript whose journal a live session holds is not revivable here,
 * and what to do with it instead. A journal running in another process cannot
 * be reached locally at all; one running here under a different file is a copy
 * carrying the live session's id, which a second loop must not take; and the
 * journal of a session this process is still opening is nobody's to revive
 * until that session attaches.
 */
export function liveJournalRefusal(id: string, sessionFile: string, holder: LiveJournalHolder): string {
	switch (holder) {
		case "elsewhere":
			return `Agent "${id}" is the transcript of a session another omp process is running, so it cannot be revived here. Reach it in that process, or read history://${id}.`;
		case "copy":
			return `Agent "${id}" is a copy of the transcript this session is running and carries its session id, so reviving it here would run a second agent loop on that session. Open it in its own process (\`omp --resume ${sessionFile}\`), or read history://${id}.`;
		case "here":
			return `Agent "${id}" is the transcript of a session this process is opening right now; it is not revivable while that session takes it. Retry in a moment, or read history://${id}.`;
	}
}

/**
 * Transcripts the scan refused to offer as revivable, by the id a sender would
 * address them with. Without them a name the roster deliberately left out
 * reads as a name that never existed, and the sender is told to consult a
 * roster that will never list it. Bounded, and re-checked on read, so an entry
 * whose session has since exited disappears instead of lying.
 */
const suppressedTranscripts = new Map<string, { sessionFile: string; holder: LiveJournalHolder }>();

/** How many refusals are remembered; a tree with more live transcripts forgets the least recently met. */
const MAX_SUPPRESSED_TRANSCRIPTS = 256;

function noteSuppressedTranscript(id: string, sessionFile: string, holder: LiveJournalHolder): void {
	// Re-inserted so the bound below drops the least recently met entry.
	suppressedTranscripts.delete(id);
	suppressedTranscripts.set(id, { sessionFile, holder });
	for (const oldest of suppressedTranscripts.keys()) {
		if (suppressedTranscripts.size <= MAX_SUPPRESSED_TRANSCRIPTS) break;
		suppressedTranscripts.delete(oldest);
	}
}

/**
 * What to tell someone who addressed `id` and found no agent, when the last
 * roster scan met its transcript and refused to offer it as revivable.
 * Undefined when no scan refused that name, and when the session holding its
 * journal has since exited — the transcript is revivable again then, and the
 * next scan registers it.
 */
export function suppressedTranscriptNote(id: string): string | undefined {
	const refusal = suppressedTranscripts.get(id);
	if (!refusal) return undefined;
	if (sessionJournalLiveness(refusal.sessionFile) === "free") {
		suppressedTranscripts.delete(id);
		return undefined;
	}
	return liveJournalRefusal(id, refusal.sessionFile, refusal.holder);
}

interface PersistedAgentMetadata {
	activity?: string;
	createdAt?: number;
	lastActivity?: number;
	history?: AgentHistorySummary;
	/** True when the file is only a SessionManager header (no session_init, no messages). */
	incomplete?: boolean;
}

interface PersistedTranscript {
	id: string;
	sessionFile: string;
	createdAt?: number;
	lastActivity?: number;
}

/** Size and mtime of a transcript when a ref's history was last read from it; an unchanged transcript is not read again. */
const historyStamps = new WeakMap<AgentRef, string>();

async function transcriptStamp(sessionFile: string): Promise<string | undefined> {
	try {
		const stat = await fs.promises.stat(sessionFile);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch (error) {
		// A vanished transcript reads as empty history, as before.
		if (isFilesystemError(error)) throw error;
		return undefined;
	}
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function timestampOf(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function summarizePersistedTask(task: string): string | undefined {
	const withoutPreamble = task.replace(/^Complete the assignment below,\s*thoroughly:\s*/i, "");
	const lines = withoutPreamble.split(/\r?\n/);
	const targetIndex = lines.findIndex(line => line.trim().toLowerCase() === "# target");
	const targetLines: string[] = [];
	if (targetIndex >= 0) {
		for (const line of lines.slice(targetIndex + 1)) {
			if (line.trimStart().startsWith("# ")) break;
			targetLines.push(line);
		}
	}
	const summary = (targetLines.length > 0 ? targetLines : lines).join(" ").replace(/\s+/g, " ").trim();
	return summary ? summary.slice(0, 1_000) : undefined;
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function inferBundledAgent(systemPrompt: string): { agent?: string; modelRole?: string; readOnly?: boolean } {
	const matches = loadBundledAgents().filter(agent => {
		const rolePrompt = agent.systemPrompt.trim();
		return rolePrompt.length > 0 && systemPrompt.includes(rolePrompt);
	});
	// `task` and `sonic` intentionally share a prompt body. Ambiguous historical
	// prompts stay unlabelled rather than inventing provenance.
	if (matches.length !== 1) return {};
	const [agent] = matches;
	return {
		agent: agent.name,
		modelRole: resolveExplicitModelRole(agent.model),
		readOnly: isReadOnlyAgent(agent),
	};
}

function usageTokens(usage: Record<string, unknown>): number {
	const computed = finiteNumber(usage.input) + finiteNumber(usage.output) + finiteNumber(usage.cacheWrite);
	return computed > 0 ? computed : finiteNumber(usage.totalTokens);
}

interface AssistantMetrics {
	tokens: number;
	tools: number;
	cost: number;
	contextTokens?: number;
	resolvedModel?: string;
	/**
	 * True when this turn produced output, making its model the run's. Uses the
	 * same predicate as the live session, so replaying a transcript reaches the
	 * same verdict the session reached while running it.
	 */
	served: boolean;
}

function assistantMetrics(message: Record<string, unknown>): AssistantMetrics {
	const usage = recordOf(message.usage) ?? {};
	const cost = recordOf(usage.cost);
	const content = Array.isArray(message.content) ? message.content : [];
	const provider = typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	return {
		tokens: usageTokens(usage),
		tools: content.filter(part => recordOf(part)?.type === "toolCall").length,
		cost: finiteNumber(cost?.total),
		contextTokens: finiteNumber(usage.totalTokens) || undefined,
		resolvedModel: provider && model ? `${provider}/${model}` : undefined,
		served: assistantTurnProducedOutput({
			stopReason: message.stopReason,
			content,
		} as Pick<AssistantMessage, "stopReason" | "content">),
	};
}

/**
 * Distinguish a filesystem open/read fault (EACCES/EMFILE/EIO — any coded
 * errno except ENOENT) from content incompleteness. Malformed and truncated
 * JSONL records never surface as errors: the stream visitor skips them
 * in-band. ENOENT is the tolerated optional-file race (a transcript listed by
 * readdir can vanish before its metadata is read). So a coded non-ENOENT
 * error means the read itself failed and must propagate — dropping the
 * roster latch so the next call retries — instead of masquerading as an
 * incomplete transcript.
 */
function isFilesystemError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === "string" && code !== "ENOENT";
}

async function readPersistedAgentHistory(
	transcript: PersistedTranscript,
	shouldContinue: () => boolean,
): Promise<AgentHistorySummary> {
	const parents = new Map<string, string | undefined>();
	const assistantById = new Map<string, AssistantMetrics>();
	const modelChangeById = new Map<string, { model: string; role?: string; resolvedModelIsFallback: boolean }>();
	// Raw-record copy of `sessionEntryLeafId`/`resolveSessionLeafId` (session-entries.ts); keep them in sync.
	let leafId: string | undefined;
	let selfSelectedLeafId: string | undefined;
	let leafTimestamp: number | undefined;
	let directCost = 0;
	// Direct cost mirrors lifetime SessionManager usage; legacy metrics below stay leaf-scoped.
	try {
		await visitEntriesFromFileStream(
			transcript.sessionFile,
			entry => {
				const record = recordOf(entry);
				if (!record) return;
				const id = typeof record.id === "string" ? record.id : undefined;
				if (!id) return;
				const parentId = typeof record.parentId === "string" ? record.parentId : undefined;
				parents.set(id, parentId);
				// Same replay rule as `sessionEntryLeafId`: an entry written off the active
				// branch (late usage, a routed bash result) restores the leaf it captured
				// instead of becoming the leaf itself.
				if (typeof record.activeLeafId === "string") {
					leafId = record.activeLeafId;
				} else if (record.activeLeafId === null) {
					leafId = undefined;
				} else {
					leafId = id;
					selfSelectedLeafId = id;
				}
				const parsedTimestamp = timestampOf(record.timestamp);
				if (parsedTimestamp !== undefined) leafTimestamp = parsedTimestamp;
				if (record.type === "model_usage") {
					const usage = recordOf(record.usage);
					const cost = recordOf(usage?.cost);
					directCost += finiteNumber(cost?.total);
					return;
				}
				if (record.type === "model_change" && typeof record.model === "string") {
					modelChangeById.set(id, {
						model: record.model,
						role: typeof record.role === "string" ? record.role : undefined,
						resolvedModelIsFallback: record.resolvedModelIsFallback === true,
					});
					return;
				}
				if (record.type !== "message") return;
				const message = recordOf(record.message);
				if (message?.role === "assistant") {
					const assistant = assistantMetrics(message);
					assistantById.set(id, assistant);
					directCost += assistant.cost;
				}
			},
			// Advisor transcripts are the one file that can grow pathologically large
			// (issue #9553); cap their scan so one bad transcript can't stall the Hub
			// on the render thread. Healthy advisor files sit far below this bound,
			// so their metrics stay exact; a capped legacy file reports approximate
			// (lower-bound) cost/tokens rather than freezing `hub list`.
			{
				shouldContinue,
				maxRecords: isAdvisorTranscriptName(path.basename(transcript.sessionFile))
					? MAX_ADVISOR_HISTORY_LINES
					: undefined,
			},
		);
	} catch (error) {
		// Malformed and truncated records are skipped in-band; a vanished file
		// (ENOENT) degrades to empty history. Any other filesystem fault is
		// transient and surfaces to the caller instead of masquerading as a
		// transcript with no history.
		if (isFilesystemError(error)) throw error;
		return {};
	}

	if (leafId !== undefined && !parents.has(leafId)) leafId = selfSelectedLeafId;
	const metrics: AgentMetricsSummary = {
		tokens: 0,
		requests: 0,
		tools: 0,
		cost: 0,
		durationMs: Math.max(
			0,
			(leafTimestamp ?? transcript.lastActivity ?? transcript.createdAt ?? 0) -
				(transcript.createdAt ?? leafTimestamp ?? 0),
		),
		durationKind: "span",
	};
	// Attribution walks leaf → root and stops at the newest turn that actually
	// produced output: that model did this run's work. A `model_change` newer
	// than it was never served (a fallback the session died on), so crediting the
	// run to it would report work the previous model did.
	let resolvedModel: string | undefined;
	let resolvedModelIsFallback: boolean | undefined;
	let modelRole: string | undefined;
	let contextTokens: number | undefined;
	let servedModel: string | undefined;
	let latestModelChange: { model: string; resolvedModelIsFallback: boolean } | undefined;
	const visited = new Set<string>();
	for (let id = leafId; id && !visited.has(id); id = parents.get(id)) {
		visited.add(id);
		const modelChange = modelChangeById.get(id);
		if (modelChange) {
			latestModelChange ??= modelChange;
			if (
				modelChange.role &&
				modelChange.role !== EPHEMERAL_MODEL_CHANGE_ROLE &&
				modelChange.role !== PREWALK_MODEL_CHANGE_ROLE
			) {
				modelRole ??= modelChange.role;
			}
			// The transition that installed the serving model: it carries the
			// fallback flag the raw message lacks. Every writer records the selector
			// through `formatModelStringWithRouting`, which appends an `@upstream`
			// gateway route the message's bare `provider/model` never has.
			if (
				servedModel !== undefined &&
				resolvedModel === undefined &&
				(modelChange.model === servedModel || modelChange.model.startsWith(`${servedModel}@`))
			) {
				resolvedModel = modelChange.model;
				resolvedModelIsFallback = modelChange.resolvedModelIsFallback;
			}
		}
		const assistant = assistantById.get(id);
		if (!assistant) continue;
		if (servedModel === undefined && assistant.served && assistant.resolvedModel) {
			servedModel = assistant.resolvedModel;
		}
		metrics.requests++;
		metrics.tokens += assistant.tokens;
		metrics.tools += assistant.tools;
		metrics.cost += assistant.cost;
		contextTokens ??= assistant.contextTokens;
	}
	// No transition described the serving model (pre-`model_change` transcript, or
	// the spawn record was pruned) — the message's own model still beats a
	// transition that never ran. Nothing served at all leaves only the last
	// transition to report.
	if (resolvedModel === undefined) {
		resolvedModel = servedModel ?? latestModelChange?.model;
		resolvedModelIsFallback = servedModel !== undefined ? false : latestModelChange?.resolvedModelIsFallback;
	}
	if (contextTokens !== undefined) metrics.contextTokens = contextTokens;
	return {
		directCost,
		...(metrics.requests > 0 ? { metrics } : {}),
		...(resolvedModel ? { resolvedModel, resolvedModelIsFallback } : {}),
		...(modelRole ? { modelRole } : {}),
	};
}

/**
 * Nested-repo patch files the isolation runner wrote beside a transcript,
 * picked out of the directory listing the scan already holds:
 * `<id>.nested-<n>-<path>.patch`, in capture order.
 */
function nestedPatchFilesFor(dir: string, transcriptName: string, entries: readonly fs.Dirent[]): string[] {
	const prefix = `${transcriptName.slice(0, -".jsonl".length)}.nested-`;
	return entries
		.filter(entry => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".patch"))
		.map(entry => entry.name)
		.sort((a, b) => Number.parseInt(a.slice(prefix.length), 10) - Number.parseInt(b.slice(prefix.length), 10))
		.map(name => path.join(dir, name));
}

/**
 * Read only the small session prefix needed by the Hub. A subagent's first
 * `session_init` is written before its conversation, so this never walks a
 * multi-megabyte historical transcript just to populate one roster row.
 */
async function readPersistedAgentMetadata(
	sessionFile: string,
	nestedPatchPaths: readonly string[] = [],
): Promise<PersistedAgentMetadata> {
	// Settle immediately instead of leaving a rejecting promise pending while
	// the transcript stream runs: a stat fault (EACCES/EMFILE/EIO) must not
	// surface as an unhandled rejection if the stream errors first or takes
	// long. ENOENT stays the tolerated optional-file race (a transcript listed
	// by readdir can vanish before its metadata is read); the fault is captured
	// and rethrown only after the stream has settled, so the roster latch drops
	// and the next call retries.
	const stat: Promise<{ file?: fs.Stats; error?: unknown }> = fs.promises.stat(sessionFile).then(
		file => ({ file }),
		error => (isFilesystemError(error) ? { error } : { file: undefined }),
	);
	const artifactBase = sessionFile.slice(0, -".jsonl".length);
	const outputPath = `${artifactBase}.md`;
	const patchPath = `${artifactBase}.patch`;
	const artifactFiles = Promise.all([Bun.file(outputPath).exists(), Bun.file(patchPath).exists()]);
	let createdAt: number | undefined;
	let activity: string | undefined;
	let history: AgentHistorySummary = {};
	let hasSessionInit = false;
	let hasConversation = false;
	try {
		await visitEntriesFromFileStream(
			sessionFile,
			entry => {
				const record = recordOf(entry);
				if (!record) return;
				if (record.type === "session") {
					createdAt ??= timestampOf(record.timestamp);
					return;
				}
				if (record.type === "model_change") {
					if (typeof record.model === "string") history.resolvedModel = record.model;
					if (
						typeof record.role === "string" &&
						record.role !== EPHEMERAL_MODEL_CHANGE_ROLE &&
						record.role !== PREWALK_MODEL_CHANGE_ROLE
					) {
						history.modelRole = record.role;
					}
					if (typeof record.resolvedModelIsFallback === "boolean") {
						history.resolvedModelIsFallback = record.resolvedModelIsFallback;
					}
					return;
				}
				if (record.type === "message" || record.type === "custom_message") {
					hasConversation = true;
					return;
				}
				if (record.type !== "session_init") return;
				hasSessionInit = true;
				createdAt ??= timestampOf(record.timestamp);
				if (typeof record.task === "string") activity = summarizePersistedTask(record.task);
				const systemPrompt = Array.isArray(record.systemPrompt)
					? record.systemPrompt.join("\n\n")
					: record.systemPrompt;
				const inferred = typeof systemPrompt === "string" ? inferBundledAgent(systemPrompt) : {};
				history = {
					...history,
					...inferred,
					agent: typeof record.agent === "string" ? record.agent : inferred.agent,
					modelRole:
						typeof record.modelRole === "string" ? record.modelRole : (history.modelRole ?? inferred.modelRole),
					resolvedModel: typeof record.resolvedModel === "string" ? record.resolvedModel : history.resolvedModel,
					readOnly: typeof record.readOnly === "boolean" ? record.readOnly : inferred.readOnly,
				};
				return false;
			},
			{ maxRecords: MAX_METADATA_LINES },
		);
	} catch (error) {
		// Malformed and truncated records are skipped in-band by the stream
		// visitor, so the only errors reaching this catch are filesystem
		// faults. ENOENT races degrade to an incomplete record; transient
		// faults (EACCES/EMFILE/EIO) surface so the roster latch drops and the
		// next call retries. A readable transcript with a malformed metadata
		// prefix still yields what it can.
		if (isFilesystemError(error)) throw error;
	}
	const [statResult, [hasOutput, hasPatch]] = await Promise.all([stat, artifactFiles]);
	// A transient stat fault surfaces now that both reads have settled; ENOENT
	// already degraded to an undefined file above.
	if (statResult.error !== undefined) throw statResult.error;
	const file = statResult.file;
	return {
		activity,
		createdAt: createdAt ?? file?.birthtimeMs,
		lastActivity: file?.mtimeMs,
		incomplete: !hasSessionInit && !hasConversation,
		history: {
			...history,
			...(hasOutput ? { outputPath } : {}),
			...(hasPatch ? { patchPath } : {}),
			...(nestedPatchPaths.length > 0 ? { nestedPatchPaths: [...nestedPatchPaths] } : {}),
		},
	};
}

async function readPersistedVibeChildIds(sessionFile: string, shouldContinue: () => boolean): Promise<Set<string>> {
	const ids = new Set<string>();
	try {
		await visitEntriesFromFileStream(
			sessionFile,
			entry => {
				for (const id of persistedVibeChildIds([entry])) ids.add(id);
			},
			{ shouldContinue },
		);
		return ids;
	} catch (error) {
		if (isFilesystemError(error)) throw error;
		return new Set();
	}
}

/**
 * Upper bound on remembered roster latches. Once the bound is reached, only
 * settled entries are forgotten (oldest first), so an in-flight scan is never
 * evicted and a root whose latch was pruned is simply re-scanned on its next
 * ensure call.
 */
const MAX_PERSISTED_ROSTER_LATCHES = 32;

const kPersistedRosterLatches = Symbol("persistedRosterLatches");

/**
 * Failure-tolerant serialization tail for scan bodies. Distinct roots share one
 * process-global registry, so their scans must not interleave: a child
 * basename present in two roots' trees would otherwise be captured as
 * unregistered by both, and whichever registers last would CAS-skip the other,
 * leaving that root with a settled latch that never saw its own transcript.
 * The tail always stores a settled wrapper, so a failed scan can never poison
 * the queue for the next root.
 */
const kPersistedRosterScanTail = Symbol("persistedRosterScanTail");

interface PersistedRosterLatch {
	/** Settles when the root's roster scan finishes (success or logged failure). */
	pending: Promise<void>;
	/** True once `pending` has settled; only settled latches are evictable. */
	settled: boolean;
	/**
	 * Narrowest root-ownership token: every (id → sessionFile) pair this root's
	 * scan restored as a parked ref — registered fresh, replaced from another
	 * root, or confirmed already pointing at this root's own transcript. A
	 * settled latch is reusable only while every recorded ref still matches
	 * registry identity/session; a missing or re-targeted ref means another
	 * root's scan (or a release) moved the id, so this root must be re-scanned.
	 * Rebuilt per scan, the token stays bounded by the root's own transcript
	 * tree — no reverse global map.
	 */
	owned: Map<string, string>;
	/**
	 * The other half of the token: every (id → sessionFile) pair this scan
	 * refused to offer because a live session holds that journal. They are in
	 * no registry, so `owned` cannot speak for them, and a settled latch that
	 * ignored them would keep a sibling pane's transcript out of the roster
	 * for the rest of this process's life — long after that pane exited.
	 */
	suppressed: Map<string, string>;
}

interface RegistryWithPersistedRosterLatches extends AgentRegistry {
	[kPersistedRosterLatches]?: Map<string, PersistedRosterLatch>;
	[kPersistedRosterScanTail]?: Promise<void>;
}

/**
 * A settled latch is reusable only while every parked ref its scan restored
 * still matches registry identity/session, and every transcript it refused is
 * still held by a live session. A missing ref (released) or one re-targeted at
 * a different session file (superseded by another root's scan) invalidates the
 * latch, as does a journal whose session has since exited, forcing a re-scan
 * that restores this root's own transcripts. Refs the scan did not restore are
 * not this root's to police.
 */
function latchStillValid(registry: AgentRegistry, latch: PersistedRosterLatch): boolean {
	for (const [id, sessionFile] of latch.owned) {
		const ref = registry.get(id);
		if (!ref || ref.sessionFile !== sessionFile) return false;
	}
	for (const sessionFile of latch.suppressed.values()) {
		if (sessionJournalLiveness(sessionFile) === "free") return false;
	}
	return true;
}

async function resolveRootSessionFile(registry: AgentRegistry, hint?: string | null): Promise<string | undefined> {
	const mainFile = registry.get(MAIN_AGENT_ID)?.sessionFile;
	const candidate =
		typeof hint === "string" && hint.endsWith(".jsonl")
			? hint
			: typeof mainFile === "string" && mainFile.endsWith(".jsonl")
				? mainFile
				: undefined;
	if (candidate === undefined) return undefined;
	let current: string = path.resolve(candidate);
	// The climb is unbounded: a subagent can nest arbitrarily deep (there is no
	// fixed depth ceiling in this tree), and stopping early would make parked
	// top-level siblings invisible to deep children.
	for (;;) {
		const parentFile: string = `${path.dirname(current)}.jsonl`;
		if (parentFile === current || !(await Bun.file(parentFile).exists())) return current;
		current = parentFile;
	}
}

function rosterScanError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

/** Whether `sessionFile` is the root transcript or lives in its artifacts tree. */
export function sessionFileBelongsToRoot(sessionFile: string, rootSessionFile: string): boolean {
	const file = path.resolve(sessionFile);
	const root = path.resolve(rootSessionFile);
	const artifactRoot = root.slice(0, -".jsonl".length);
	return file === root || file.startsWith(`${artifactRoot}${path.sep}`);
}

/** Keep old parked trees out of a new/current session's model-facing roster. */
export function isCurrentSessionRosterRef(
	ref: { status: string; sessionFile: string | null },
	rootSessionFile: string | undefined,
): boolean {
	if (ref.status !== "parked" || !rootSessionFile || !ref.sessionFile) return true;
	return sessionFileBelongsToRoot(ref.sessionFile, rootSessionFile);
}

/**
 * Restore parked sibling transcripts once per current root session. Scans are
 * latched per root: concurrent calls for the same root share one in-flight
 * scan, while distinct roots stay latched independently but serialize their
 * scan bodies behind a failure-tolerant tail (a child basename shared across
 * roots must be observed as already-registered, never raced unseen). A settled
 * latch is reusable only while every parked ref its scan restored still matches
 * registry identity/session: a shared id another root's scan replaced (or a
 * released ref) invalidates the latch, so returning to this root re-scans
 * through the tail and restores its own transcripts instead of leaving the
 * other root's refs in this roster. The latch
 * cache is bounded by forgetting settled roots oldest-first, so a switch back
 * to an old root re-scans only once its latch was pruned. IO failure degrades
 * roster counts, never task startup, and remains retryable.
 */
export async function ensurePersistedRoster(
	registry: AgentRegistry,
	sessionFileHint?: string | null,
): Promise<string | undefined> {
	let root: string | undefined;
	try {
		root = await resolveRootSessionFile(registry, sessionFileHint);
	} catch (error) {
		logger.warn("Persisted agent roster root resolution failed; using in-memory peers", {
			error: rosterScanError(error),
		});
		return undefined;
	}
	if (!root) return undefined;

	const taggedRegistry = registry as RegistryWithPersistedRosterLatches;
	let latches = taggedRegistry[kPersistedRosterLatches];
	if (!latches) {
		latches = new Map();
		taggedRegistry[kPersistedRosterLatches] = latches;
	}
	const existing = latches.get(root);
	if (existing) {
		await existing.pending;
		if (existing.settled) {
			// A settled latch is reusable only while every parked ref its scan
			// restored still matches registry identity/session, and every
			// transcript it refused is still held by a live session. Another
			// root's scan can replace a shared id globally while this root's
			// latch sits settled; reusing the latch then would leave this root's
			// roster pointing at the other root's transcripts, or keep offering
			// nothing for a pane that has since exited. On any such change, drop
			// the latch and refresh this root through the same serialized scan
			// tail so its own transcripts win again.
			if (latchStillValid(registry, existing)) return root;
			if (latches.get(root) === existing) latches.delete(root);
			// A concurrent superseded waiter may already have inserted the fresh
			// latch; join it instead of scanning twice.
			const replacement = latches.get(root);
			if (replacement) {
				await replacement.pending;
				return root;
			}
		} else {
			// A failed scan already dropped its own latch; degrade to in-memory
			// peers and let the next call retry.
			return root;
		}
	}
	// Forget settled latches oldest-first once the bound is reached, so a
	// process that visits many roots doesn't accumulate one entry per root.
	// In-flight scans are never evicted: their latch is the single-flight guard.
	if (latches.size >= MAX_PERSISTED_ROSTER_LATCHES) {
		for (const [latchedRoot, latch] of latches) {
			if (latches.size < MAX_PERSISTED_ROSTER_LATCHES) break;
			if (latch.settled) latches.delete(latchedRoot);
		}
	}
	// Chain the scan body behind any other root's in-flight scan (same-root
	// calls never reach here: they joined the latch above). The tail always
	// stores a settled wrapper, so a failed scan settles it and the next root
	// still proceeds.
	const latch: PersistedRosterLatch = {
		pending: undefined!,
		settled: false,
		owned: new Map(),
		suppressed: new Map(),
	};
	const tail = taggedRegistry[kPersistedRosterScanTail] ?? Promise.resolve();
	const scan = tail.then(() =>
		registerPersistedSubagents(registry, root, {
			hydrateHistory: false,
			owned: latch.owned,
			suppressed: latch.suppressed,
		}),
	);
	taggedRegistry[kPersistedRosterScanTail] = scan.then(
		() => {},
		() => {},
	);
	latch.pending = scan.then(
		() => {
			const current = latches.get(root);
			if (current) current.settled = true;
		},
		error => {
			// A failed scan drops its latch so the next call retries; the failure
			// itself degrades to in-memory peers, never task startup.
			const current = latches.get(root);
			if (current && current.pending === latch.pending) {
				latches.delete(root);
			} else if (current) {
				current.settled = true;
			}
			logger.warn("Persisted agent roster scan failed; using in-memory peers", {
				rootSessionFile: root,
				error: rosterScanError(error),
			});
		},
	);
	latches.set(root, latch);
	await latch.pending;
	return root;
}

/** Register persisted subagent and advisor transcripts as parked registry refs. */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	options: {
		shouldContinue?: () => boolean;
		hydrateHistory?: boolean;
		/**
		 * When supplied, every (id → sessionFile) pair this scan restores or
		 * confirms as this root's parked ref is recorded here: the narrowest
		 * root-ownership token `ensurePersistedRoster` validates settled latches
		 * against, bounded by this root's own transcript tree.
		 */
		owned?: Map<string, string>;
		/**
		 * The same token for the transcripts this scan refused to offer because
		 * a live session holds their journal: no ref exists for them, so a
		 * settled latch re-probes these instead.
		 */
		suppressed?: Map<string, string>;
	} = {},
): Promise<void> {
	if (!sessionFile?.endsWith(".jsonl")) return;
	const shouldContinue = options.shouldContinue ?? (() => true);
	const hydrateHistory = options.hydrateHistory ?? true;
	if (!shouldContinue()) return;
	// The main transcript can be large: read it once, and only for a transcript the registry does not hold yet.
	let vibeOwnedIds: Promise<Set<string>> | undefined;
	const vibeOwned = () => (vibeOwnedIds ??= readPersistedVibeChildIds(sessionFile, shouldContinue));
	const root = sessionFile.slice(0, -6);
	const transcripts: PersistedTranscript[] = [];
	await registerPersistedSubagentsFromDir(
		registry,
		root,
		undefined,
		vibeOwned,
		transcripts,
		shouldContinue,
		sessionFile,
		options.owned,
		options.suppressed,
	);
	if (!hydrateHistory || !shouldContinue()) return;
	let nextTranscript = 0;
	const workers = Array.from({ length: Math.min(4, transcripts.length) }, async () => {
		for (;;) {
			if (!shouldContinue()) return;
			const index = nextTranscript++;
			const transcript = transcripts[index];
			if (!transcript) return;
			const ref = registry.get(transcript.id);
			if (!ref || ref.sessionFile !== transcript.sessionFile) continue;
			const stamp = await transcriptStamp(transcript.sessionFile);
			if (stamp !== undefined && historyStamps.get(ref) === stamp) continue;
			const history = await readPersistedAgentHistory(transcript, shouldContinue);
			if (!shouldContinue()) return;
			if (registry.setHistory(transcript.id, history, transcript.sessionFile) && stamp !== undefined) {
				historyStamps.set(ref, stamp);
			}
		}
	});
	await Promise.all(workers);
}

async function registerPersistedSubagentsFromDir(
	registry: AgentRegistry,
	dir: string,
	parentId: string | undefined,
	vibeOwned: () => Promise<ReadonlySet<string>>,
	transcripts: PersistedTranscript[],
	shouldContinue: () => boolean,
	rootSessionFile: string,
	owned?: Map<string, string>,
	suppressed?: Map<string, string>,
): Promise<void> {
	if (!shouldContinue()) return;
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return;
		throw error;
	}
	if (!shouldContinue()) return;
	const childDirectories = new Set<string>();
	for (const entry of entries) {
		if (entry.isDirectory()) childDirectories.add(entry.name);
	}
	/**
	 * Restore the transcripts in `<dir>/<id>/`, the artifacts directory of the
	 * transcript `<id>.jsonl`. A transcript stem is not proof of a child
	 * directory: "." and ".." revisit ancestors, and symlinks can point back
	 * into the same tree.
	 */
	const registerChildrenOf = async (id: string): Promise<void> => {
		if (!childDirectories.has(id)) return;
		await registerPersistedSubagentsFromDir(
			registry,
			path.join(dir, id),
			id,
			vibeOwned,
			transcripts,
			shouldContinue,
			rootSessionFile,
			owned,
			suppressed,
		);
	};
	/**
	 * Take a transcript whose journal a live agent loop holds, and report that
	 * the scan must derive nothing from it. A journal a live agent loop writes
	 * is not a parked transcript. The tree this walks holds the journal this
	 * process is itself running (`omp --resume <name>.jsonl` resumes a
	 * subagent's transcript, and the scan climbs to the root above it) and
	 * those of sibling panes in other processes. A `parked` ref derived from
	 * one of those offers a running agent as a revivable transcript, and
	 * reviving it runs a second agent loop on that session. Its own parked
	 * children stay restorable.
	 */
	const takeLiveJournal = async (entryName: string, sessionFile: string): Promise<boolean> => {
		const liveness = sessionJournalLiveness(sessionFile);
		if (liveness === "free") return false;
		// Advisor transcripts are observability-only and never peers, so a
		// live one is simply not listed.
		if (isAdvisorTranscriptName(entryName)) return true;
		const liveId = entryName.slice(0, -".jsonl".length);
		let live: AgentRef | undefined;
		if (liveness === "here") {
			for (const ref of registry.list()) {
				if (!ref.session || !ref.sessionFile) continue;
				if (!isSameJournalFile(ref.sessionFile, sessionFile)) continue;
				live = ref;
				break;
			}
		}
		const liveFile = live?.sessionFile;
		if (live && liveFile) {
			// The session running here is what this name means. Under its own
			// id it already is that agent; under another (a pane resumed on a
			// subagent's transcript runs it as `Main`) bind the name, so a
			// peer's `agent://<name>`, Hub focus and a `task` resume reach the
			// running agent, and drop the phantom an earlier scan left on the
			// journal before the session went live.
			if (live.id !== liveId) {
				const phantom = registry.get(liveId);
				if (phantom && !phantom.session && phantom.sessionFile === sessionFile) {
					registry.unregister(liveId, phantom);
				}
				registry.bindLiveName(liveId, live.id, liveFile);
			}
			// This root's to keep: the entry goes stale exactly when that
			// agent stops running this journal, which re-scans.
			owned?.set(liveId, liveFile);
		} else if (liveness === "here") {
			// This process writes this very journal, and no live ref owns it
			// yet: a revive that has claimed the file but not attached its
			// session, or an agent parking after its ref detached. Both are
			// this process's own transitions, and both end in a ref on this
			// file — touch nothing and let them finish.
			logger.debug("Roster scan skipped a journal this process is opening", { id: liveId, sessionFile });
		} else {
			// A copy of a journal running here, or a journal another omp
			// process runs: not ours to offer, and the note says why to
			// whoever addresses the name.
			noteSuppressedTranscript(liveId, sessionFile, liveness);
			suppressed?.set(liveId, sessionFile);
		}
		await registerChildrenOf(liveId);
		return true;
	};
	let entriesSinceYield = 0;
	for (const entry of entries) {
		if (!shouldContinue()) return;
		if (++entriesSinceYield >= 16) {
			entriesSinceYield = 0;
			await Bun.sleep(0);
		}
		if (!shouldContinue()) return;
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		if (await takeLiveJournal(entry.name, sessionFile)) continue;
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so the Hub can show its read-only
		// transcript, but it never joins agent-facing rosters and is not revivable.
		if (isAdvisorTranscriptName(entry.name)) {
			const owner = parentId ?? MAIN_AGENT_ID;
			// `__advisor.jsonl` → the default advisor (no slug); `__advisor.<slug>.jsonl`
			// → a named advisor, keyed and labeled by its slug.
			const slug =
				entry.name === ADVISOR_TRANSCRIPT_FILENAME ? "" : entry.name.slice("__advisor.".length, -".jsonl".length);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				const metadata = await readPersistedAgentMetadata(sessionFile);
				if (!shouldContinue()) return;
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					activity: metadata.activity,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
					history: { ...metadata.history, readOnly: true },
					status: "parked",
				});
				owned?.set(advisorId, sessionFile);
				transcripts.push({
					id: advisorId,
					sessionFile,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
				});
			} else if (existing) {
				owned?.set(advisorId, sessionFile);
				transcripts.push({
					id: advisorId,
					sessionFile,
					createdAt: existing.createdAt,
					lastActivity: existing.lastActivity,
				});
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		// Revivable again: whatever ran this journal is gone.
		suppressedTranscripts.delete(id);
		const existing = registry.get(id);
		if (existing?.sessionFile !== sessionFile && (await vibeOwned()).has(id)) continue;
		let tombstoned = false;
		try {
			await fs.promises.access(getAgentTombstonePath(sessionFile));
			tombstoned = true;
		} catch (error) {
			// A missing tombstone is the normal case. Any other fault (EACCES/
			// EMFILE/EIO) is transient: surface it so the roster latch drops and
			// the next call retries instead of silently skipping this transcript.
			if (isFilesystemError(error)) throw error;
		}
		if (!shouldContinue()) return;
		// The vibe lookup and the tombstone probe yield too, and a session can
		// take the journal while they do. Both branches below speak for this
		// transcript from here on — one latches the ref it finds, the other
		// registers a new one — so neither may run on a stale answer.
		if (await takeLiveJournal(entry.name, sessionFile)) continue;
		const replaceable =
			existing !== undefined &&
			existing.kind === "sub" &&
			existing.status === "parked" &&
			existing.session === null &&
			typeof existing.sessionFile === "string" &&
			!sessionFileBelongsToRoot(existing.sessionFile, rootSessionFile);
		if (existing && !replaceable) {
			if (existing.sessionFile === sessionFile) {
				owned?.set(id, sessionFile);
				transcripts.push({
					id,
					sessionFile,
					createdAt: existing.createdAt,
					lastActivity: existing.lastActivity,
				});
			}
		} else {
			const expected = existing ?? null;
			const metadata = await readPersistedAgentMetadata(sessionFile, nestedPatchFilesFor(dir, entry.name, entries));
			if (!shouldContinue()) return;
			// Metadata reads yield, and a session can take this journal while
			// they do: a resume claims its file before it registers its agent.
			// A parked ref derived from the answer this iteration started with
			// would be a phantom on a live session, and `owned` below would
			// latch it, so later scans keep it instead of replacing it. Ask
			// again, as late as anything is derived from the answer.
			if (await takeLiveJournal(entry.name, sessionFile)) continue;
			// A spawn may claim the id while this scan is inspecting the file;
			// never replace that live generation with a transcript-derived
			// parked ref.
			const current = registry.get(id);
			const stillUnclaimed = expected === null && !current;
			const stillReplaceable =
				expected !== null && current === expected && current.status === "parked" && current.session === null;
			// SessionManager.open writes title+session before createAgentSession
			// claims the id. Parking that stub makes the spawn's expectedAgentRef:null
			// CAS fail with "already owned by another session generation".
			if ((stillUnclaimed || stillReplaceable) && !(metadata.incomplete && !tombstoned)) {
				const input = {
					id,
					displayName: id,
					kind: "sub" as const,
					parentId: parentId ?? MAIN_AGENT_ID,
					session: null,
					sessionFile,
					activity: metadata.activity,
					createdAt: metadata.createdAt,
					lastActivity: metadata.lastActivity,
					history: metadata.history,
					status: tombstoned ? ("aborted" as const) : ("parked" as const),
				};
				const vacated = stillUnclaimed || (expected !== null && registry.unregister(id, expected));
				if (vacated && registry.registerIfAvailable(input, null)) {
					const ref = registry.get(id);
					owned?.set(id, sessionFile);
					transcripts.push({
						id,
						sessionFile,
						createdAt: ref?.createdAt,
						lastActivity: ref?.lastActivity,
					});
				}
			}
		}
		await registerChildrenOf(id);
	}
}
