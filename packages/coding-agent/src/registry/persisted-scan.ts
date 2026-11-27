import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-names";
import { resolveExplicitModelRole } from "../config/model-resolver";
import { assistantTurnProducedOutput, usageContextTokens } from "../session/messages";
import { modelRoleOf } from "../session/session-entries";
import { readSessionHeaderId, visitEntriesFromFileStream } from "../session/session-loader";
import { type AiuTotals, addCallAiu, callAiu } from "../session/aiu-billing";
import { loadBundledAgents } from "../task/agents";
import { isReadOnlyAgent } from "../task/read-only-policy";
import { persistedVibeChildIds } from "../vibe/lifecycle";
import {
	type AgentHistorySummary,
	type AgentMetricsSummary,
	type AgentRef,
	type AgentRegistryApi,
	MAIN_AGENT_ID,
} from "./agent-registry";
import { type PersistedScanOptions, sessionFileBelongsToRoot } from "./persisted-agents";
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
		contextTokens: usageContextTokens(usage) || undefined,
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
	const directAiu: AiuTotals = { nano: 0, unknownCalls: 0 };
	// Direct cost and credits mirror lifetime SessionManager usage; legacy metrics below stay leaf-scoped.
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
					addCallAiu(directAiu, callAiu(record));
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
					addCallAiu(directAiu, callAiu(message));
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
			modelRole ??= modelRoleOf(modelChange.role);
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
		directAiu,
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
					const role = modelRoleOf(typeof record.role === "string" ? record.role : undefined);
					if (role) history.modelRole = role;
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

export async function scanPersistedSubagents(
	registry: AgentRegistryApi,
	sessionFile: string,
	options: PersistedScanOptions,
): Promise<void> {
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
		options.onCopiedRef,
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
	registry: AgentRegistryApi,
	dir: string,
	parentId: string | undefined,
	vibeOwned: () => Promise<ReadonlySet<string>>,
	transcripts: PersistedTranscript[],
	shouldContinue: () => boolean,
	rootSessionFile: string,
	owned?: Map<string, string>,
	onCopiedRef?: (ref: AgentRef) => void,
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
		const replaceable =
			existing !== undefined &&
			existing.kind === "sub" &&
			existing.status === "parked" &&
			existing.session === null &&
			typeof existing.sessionFile === "string" &&
			!sessionFileBelongsToRoot(existing.sessionFile, rootSessionFile);
		if (existing && !replaceable) {
			// A fork can copy a live idle or killed transcript without detaching its
			// source ref. The copy keeps the source transcript's header id; a
			// separately created same-id agent does not. Report only proven copies,
			// and never replace the live owner.
			if (
				existing.kind === "sub" &&
				existing.sessionFile !== null &&
				existing.sessionFile !== sessionFile &&
				(existing.status === "idle" || existing.status === "aborted")
			) {
				const [sourceHeaderId, copiedHeaderId] = await Promise.all([
					readSessionHeaderId(existing.sessionFile),
					readSessionHeaderId(sessionFile),
				]);
				if (!shouldContinue()) return;
				if (sourceHeaderId !== undefined && sourceHeaderId === copiedHeaderId && registry.get(id) === existing) {
					onCopiedRef?.(existing);
				}
			}
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
			// Metadata reads yield. A spawn may claim the id while this scan is
			// inspecting the file; never replace that live generation with a
			// transcript-derived parked ref.
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
		// A transcript stem is not proof of a child directory: "." and ".."
		// revisit ancestors, and symlinks can point back into the same tree.
		if (childDirectories.has(id)) {
			await registerPersistedSubagentsFromDir(
				registry,
				path.join(dir, id),
				id,
				vibeOwned,
				transcripts,
				shouldContinue,
				rootSessionFile,
				owned,
				onCopiedRef,
			);
		}
	}
}
