/**
 * Session trace assembly for the Traces dashboard section.
 *
 * Builds a span tree (turns, model calls, tool calls, subagents, background
 * jobs) directly from raw session JSONL — the only source with tool start/end
 * times — while stats.db supplies the session-list rollups. Entry shapes are
 * mirrored structurally from the coding-agent journal (`tool_execution_start`,
 * `session_exit`, task results, async-result batches); stats never imports
 * coding-agent.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getSessionRollups, getToolCallCountsBySession } from "./db";
import { extractFolderFromPath, parseAllSessionEntries } from "./parser";
import type {
	SessionEntry,
	SessionSummary,
	SessionTrace,
	TraceMarker,
	TraceSpan,
	TraceSummary,
	TraceToolStat,
	TraceTrack,
} from "./types";

/** Client-supplied path escaped the sessions root or is not a transcript. Maps to HTTP 400. */
export class TracePathError extends Error {}
/**
 * Trace payload schema/assembly revision, folded into the HTTP ETag. Bump when
 * span assembly changes so browsers don't revalidate stale cached bodies
 * against an unchanged transcript mtime.
 */
export const TRACE_ETAG_VERSION = 2;

const MAX_TRACK_DEPTH = 6;
const LABEL_MAX = 80;
const DETAIL_MAX = 160;
const TITLE_SCAN_BYTES = 4096;
const LIST_FOLD_LIMIT = 300;

// ---------------------------------------------------------------------------
// Structural entry views (journal shapes mirrored without importing coding-agent)

/**
 * Loose structural view of one journal entry. Session JSONL is
 * outside-controlled data (old versions, crash-truncated turns), so every
 * field is optional and reads are re-checked with `typeof` before use.
 */
interface EntryView {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	customType?: string;
	data?: Record<string, unknown>;
	message?: MessageView;
	// session header
	cwd?: string;
	title?: string;
	// session_init
	agent?: string;
	resolvedModel?: string;
	// compaction
	tokensBefore?: number;
	tokensAfter?: number;
	// model_change / mode_change
	model?: string;
	mode?: string;
}

/** Loose structural view of a persisted message payload. */
interface MessageView {
	role?: string;
	synthetic?: boolean;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: Record<string, unknown>;
	customType?: string;
	timestamp?: number;
	completedAt?: number;
	duration?: number;
	ttft?: number;
	usage?: { totalTokens?: number; cost?: { total?: number } };
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** `tool_execution_start` marker facts joined to tool spans by call id. */
interface ToolStartFact {
	start: number;
	detail?: string;
}

/** Pending tool call recorded from an assistant turn's `toolCall` blocks. */
interface PendingToolCall {
	callId: string;
	name: string;
	argsPreview?: string;
	assistantEntryId: string;
	modelEnd: number;
}

/** Task tool result row, used to place subagent spans on the parent track. */
interface TaskResultFact {
	childId: string;
	agent?: string;
	task?: string;
	durationMs?: number;
	resultEntryId: string;
	toolSpanEnd: number;
}

/** Everything one transcript contributes before cross-track assembly. */
interface TrackScan {
	track: TraceTrack;
	taskResults: TaskResultFact[];
	requests: number;
	toolCalls: number;
	cwd: string | null;
	title: string | null;
	/** Session-header envelope timestamp (ms), for spanless traces. */
	headerTs: number | undefined;
	firstActivity: number | undefined;
	lastActivity: number | undefined;
}

// ---------------------------------------------------------------------------
// Path containment + transcript IO

/** Resolve a client-supplied transcript path, enforcing sessions-root containment. */
function resolveSessionPath(fileParam: string): string {
	const resolved = path.resolve(fileParam);
	const rel = path.relative(getSessionsDir(), resolved);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new TracePathError(`Path is outside the sessions directory: ${fileParam}`);
	}
	const base = path.basename(resolved);
	if (!base.endsWith(".jsonl") && !base.endsWith(".jsonl.gz")) {
		throw new TracePathError(`Not a session transcript: ${fileParam}`);
	}
	return resolved;
}

/** Read a transcript, transparently gunzipping gc-compressed sessions. */
async function readTranscript(resolved: string): Promise<Uint8Array> {
	const bytes = await Bun.file(resolved).bytes();
	return resolved.endsWith(".gz") ? Bun.gunzipSync(bytes) : bytes;
}

// ---------------------------------------------------------------------------
// Small pure helpers

/** ISO string → ms epoch, undefined when absent/unparseable. */
function toMs(iso: string | undefined): number | undefined {
	if (typeof iso !== "string") return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Whitespace-collapsed head of a string, capped at `max` chars. */
function headText(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** First text-block head of a message content payload. */
function contentHead(content: unknown, max: number): string | undefined {
	if (typeof content === "string") return content.trim() ? headText(content, max) : undefined;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string" && block.text.trim()) return headText(block.text, max);
	}
	return undefined;
}

/** Compact token count for marker labels (142_000 → "142k"). */
function compactTokens(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "?";
	return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

/** Merge intervals and return covered length. Mutates (sorts) its input. */
function unionLength(intervals: Array<[number, number]>): number {
	if (intervals.length === 0) return 0;
	intervals.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let [curStart, curEnd] = intervals[0];
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i];
		if (s > curEnd) {
			total += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	return total + (curEnd - curStart);
}

// ---------------------------------------------------------------------------
// Single-transcript scan

/** Keep only the active branch: the parentId chain walked back from the last entry. */
function activeChain(views: EntryView[]): EntryView[] {
	const byId = new Map<string, EntryView>();
	let last: EntryView | undefined;
	for (const entry of views) {
		if (typeof entry.id === "string" && entry.id.length > 0) {
			byId.set(entry.id, entry);
			last = entry;
		}
	}
	if (!last) return [];
	const keep = new Set<string>();
	let cursor: EntryView | undefined = last;
	while (cursor) {
		if (typeof cursor.id !== "string" || keep.has(cursor.id)) break;
		keep.add(cursor.id);
		cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
	}
	return views.filter(entry => typeof entry.id === "string" && keep.has(entry.id));
}

/** Argument projection for tool-span details: command/path/intent, else nothing. */
function toolStartDetail(data: Record<string, unknown>): string | undefined {
	let candidate: unknown;
	const args = data.args;
	if (args && typeof args === "object") {
		if ("command" in args && typeof args.command === "string") candidate = args.command;
		else if ("path" in args && typeof args.path === "string") candidate = args.path;
	}
	candidate ??= data.intent;
	if (typeof candidate === "string" && candidate.trim()) return headText(candidate, DETAIL_MAX);
	return undefined;
}

/** Serialize tool-call arguments into a bounded preview. */
function argsPreview(args: unknown): string | undefined {
	if (args === undefined || args === null) return undefined;
	try {
		return headText(JSON.stringify(args), DETAIL_MAX);
	} catch {
		return undefined;
	}
}

/**
 * Scan one transcript into a track: model/tool/turn/background spans plus
 * markers, and the cross-track facts (task results, request counts).
 */
function scanTranscript(
	entries: SessionEntry[],
	trackId: string,
	parentTrackId: string | null,
	file: string,
): TrackScan {
	// Boundary cast: persisted JSONL entries are re-validated field-by-field below.
	const views = entries as EntryView[];
	const chain = activeChain(views);
	const spans: TraceSpan[] = [];
	const markers: TraceMarker[] = [];
	const pendingTools: PendingToolCall[] = [];
	const toolStarts = new Map<string, ToolStartFact>();
	const toolResults = new Map<string, { end: number; isError: boolean; entryId?: string; toolName: string }>();
	const backgroundOpens: Array<{ jobId: string; start: number; label: string; entryId?: string }> = [];
	const asyncCloses = new Map<string, number>();
	const turns: Array<{ time: number; label: string; entryId?: string }> = [];
	const taskResults: TaskResultFact[] = [];

	let sessionExit: { recordedAt: number; pendingIds: Set<string> } | undefined;
	let cwd: string | null = null;
	let headerTitle: string | null = null;
	let headerTs: number | undefined;
	let slotTitle: string | null = null;
	let initAgent: string | null = null;
	let initModel: string | null = null;
	let firstAssistantModel: string | null = null;
	let requests = 0;
	let lastChainTs = 0;

	// Title slot and session header may sit outside the id chain — scan all entries.
	for (const raw of views) {
		if (raw.type === "title" && typeof raw.title === "string") slotTitle = raw.title;
		else if (raw.type === "session") {
			if (typeof raw.cwd === "string") cwd = raw.cwd;
			if (typeof raw.title === "string") headerTitle = raw.title;
			headerTs = toMs(raw.timestamp);
		} else if (raw.type === "session_init") {
			if (typeof raw.agent === "string") initAgent = raw.agent;
			if (typeof raw.resolvedModel === "string") initModel = raw.resolvedModel;
		}
	}

	for (const entry of chain) {
		const envelopeTs = toMs(entry.timestamp);
		if (envelopeTs !== undefined && envelopeTs > lastChainTs) lastChainTs = envelopeTs;

		if (entry.type === "custom") {
			const data = entry.data ?? {};
			if (entry.customType === "tool_execution_start") {
				const callId = data.toolCallId;
				if (typeof callId === "string") {
					const start = (typeof data.startedAt === "string" ? toMs(data.startedAt) : undefined) ?? envelopeTs;
					if (start !== undefined) toolStarts.set(callId, { start, detail: toolStartDetail(data) });
				}
			} else if (entry.customType === "session_exit") {
				const recordedAt = (typeof data.recordedAt === "string" ? toMs(data.recordedAt) : undefined) ?? envelopeTs;
				const pendingIds = new Set<string>();
				if (Array.isArray(data.pendingToolCalls)) {
					for (const pending of data.pendingToolCalls) {
						if (!pending || typeof pending !== "object" || !("toolCallId" in pending)) continue;
						if (typeof pending.toolCallId === "string") pendingIds.add(pending.toolCallId);
					}
				}
				if (recordedAt !== undefined) {
					sessionExit = { recordedAt, pendingIds };
					markers.push({
						time: recordedAt,
						kind: "session_exit",
						label: typeof data.kind === "string" ? data.kind : "exit",
					});
				}
			}
			continue;
		}

		if (entry.type === "compaction" && envelopeTs !== undefined) {
			markers.push({
				time: envelopeTs,
				kind: "compaction",
				label: `compaction ${compactTokens(entry.tokensBefore)}→${compactTokens(entry.tokensAfter)}`,
			});
			continue;
		}
		if (entry.type === "model_change" && envelopeTs !== undefined) {
			markers.push({ time: envelopeTs, kind: "model_change", label: String(entry.model ?? "model change") });
			continue;
		}
		if (entry.type === "mode_change" && envelopeTs !== undefined) {
			markers.push({ time: envelopeTs, kind: "mode_change", label: String(entry.mode ?? "mode change") });
			continue;
		}
		if (entry.type === "reset_boundary" && envelopeTs !== undefined) {
			markers.push({ time: envelopeTs, kind: "reset", label: "reset" });
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		if (msg.role === "assistant") {
			requests++;
			let start = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : undefined;
			let end =
				typeof msg.completedAt === "number" && Number.isFinite(msg.completedAt)
					? msg.completedAt
					: start !== undefined && typeof msg.duration === "number"
						? start + msg.duration
						: undefined;
			if (start === undefined) {
				const fallbackEnd = end ?? envelopeTs;
				if (fallbackEnd === undefined) continue;
				end = fallbackEnd;
				start = end - (typeof msg.duration === "number" ? msg.duration : 0);
			}
			if (end === undefined) end = envelopeTs ?? start;
			end = Math.max(start, end);
			if (typeof msg.model === "string" && firstAssistantModel === null) firstAssistantModel = msg.model;

			const span: TraceSpan = {
				id: `${trackId}:${entry.id}`,
				kind: "model",
				start,
				end,
				label: headText(msg.model ?? "model", LABEL_MAX),
			};
			const detail = contentHead(msg.content, DETAIL_MAX);
			if (detail) span.detail = detail;
			if (entry.id) span.entryId = entry.id;
			if (typeof msg.model === "string") span.model = msg.model;
			if (typeof msg.usage?.totalTokens === "number") span.tokens = msg.usage.totalTokens;
			if (typeof msg.usage?.cost?.total === "number") span.cost = msg.usage.cost.total;
			if (typeof msg.ttft === "number") span.ttft = msg.ttft;
			if (msg.stopReason === "error" || msg.errorMessage) span.isError = true;
			spans.push(span);

			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
					if (!("id" in block) || typeof block.id !== "string") continue;
					if (!("name" in block) || typeof block.name !== "string") continue;
					pendingTools.push({
						callId: block.id,
						name: block.name,
						argsPreview: argsPreview("arguments" in block ? block.arguments : undefined),
						assistantEntryId: entry.id ?? "",
						modelEnd: end,
					});
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			if (typeof msg.toolCallId !== "string") continue;
			const end = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : envelopeTs;
			if (end === undefined) continue;
			toolResults.set(msg.toolCallId, {
				end,
				isError: msg.isError === true,
				entryId: entry.id,
				toolName: msg.toolName ?? "tool",
			});

			const details = msg.details;
			const asyncInfo = details?.async;
			if (
				asyncInfo &&
				typeof asyncInfo === "object" &&
				"state" in asyncInfo &&
				asyncInfo.state === "running" &&
				"jobId" in asyncInfo &&
				typeof asyncInfo.jobId === "string"
			) {
				backgroundOpens.push({
					jobId: asyncInfo.jobId,
					start: end,
					label: headText(`${msg.toolName ?? "tool"} job`, LABEL_MAX),
					entryId: entry.id,
				});
			}
			if (msg.toolName === "task" && Array.isArray(details?.results)) {
				for (const result of details.results) {
					if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string")
						continue;
					taskResults.push({
						childId: result.id,
						agent: "agent" in result && typeof result.agent === "string" ? result.agent : undefined,
						task: "task" in result && typeof result.task === "string" ? result.task : undefined,
						durationMs:
							"durationMs" in result && typeof result.durationMs === "number" ? result.durationMs : undefined,
						resultEntryId: entry.id ?? "",
						toolSpanEnd: end,
					});
				}
			}
			continue;
		}

		if (msg.role === "custom" && msg.customType === "async-result") {
			const closeAt =
				typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : envelopeTs;
			const jobs = msg.details?.jobs;
			if (closeAt !== undefined && Array.isArray(jobs)) {
				for (const job of jobs) {
					if (!job || typeof job !== "object" || !("jobId" in job) || typeof job.jobId !== "string") continue;
					if (!asyncCloses.has(job.jobId)) asyncCloses.set(job.jobId, closeAt);
				}
			}
			continue;
		}

		if (msg.role === "user" && msg.synthetic !== true) {
			const time = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : envelopeTs;
			if (time === undefined) continue;
			turns.push({
				time,
				label: contentHead(msg.content, LABEL_MAX) ?? "user",
				entryId: entry.id,
			});
		}
	}

	// Tool spans: join call blocks with start markers and results.
	for (const pending of pendingTools) {
		const marker = toolStarts.get(pending.callId);
		const result = toolResults.get(pending.callId);
		const start = marker?.start ?? pending.modelEnd;
		let end: number;
		let unterminated = false;
		if (result) {
			end = result.end;
		} else if (sessionExit?.pendingIds.has(pending.callId)) {
			end = sessionExit.recordedAt;
			unterminated = true;
		} else {
			end = lastChainTs || start;
			unterminated = true;
		}
		const span: TraceSpan = {
			id: `${trackId}:${pending.assistantEntryId}:${pending.callId}`,
			kind: "tool",
			start,
			end: Math.max(start, end),
			label: headText(pending.name, LABEL_MAX),
			toolCallId: pending.callId,
		};
		const detail = marker?.detail ?? pending.argsPreview;
		if (detail) span.detail = detail;
		const entryId = result?.entryId ?? pending.assistantEntryId;
		if (entryId) span.entryId = entryId;
		if (result?.isError) span.isError = true;
		if (unterminated) span.unterminated = true;
		spans.push(span);
	}

	// Background spans: opened by an async-running tool result, closed by async-result delivery.
	for (const open of backgroundOpens) {
		const close = asyncCloses.get(open.jobId);
		const end = close ?? (lastChainTs || open.start);
		const span: TraceSpan = {
			id: `${trackId}:bg:${open.jobId}`,
			kind: "background",
			start: open.start,
			end: Math.max(open.start, end),
			label: open.label,
		};
		if (open.entryId) span.entryId = open.entryId;
		if (close === undefined) span.unterminated = true;
		spans.push(span);
	}

	// Turn spans: user message → max end of spans starting before the next turn.
	turns.sort((a, b) => a.time - b.time);
	for (let i = 0; i < turns.length; i++) {
		const turn = turns[i];
		const nextTime = i + 1 < turns.length ? turns[i + 1].time : Number.POSITIVE_INFINITY;
		let end = turn.time;
		for (const span of spans) {
			if (span.start >= turn.time && span.start < nextTime && span.end > end) end = span.end;
		}
		const span: TraceSpan = {
			id: `${trackId}:${turn.entryId ?? `turn${i}`}`,
			kind: "turn",
			start: turn.time,
			end,
			label: turn.label,
		};
		if (turn.entryId) span.entryId = turn.entryId;
		spans.push(span);
	}

	spans.sort((a, b) => a.start - b.start || a.end - b.end);
	markers.sort((a, b) => a.time - b.time);

	let firstActivity: number | undefined;
	let lastActivity: number | undefined;
	for (const span of spans) {
		if (firstActivity === undefined || span.start < firstActivity) firstActivity = span.start;
		if (lastActivity === undefined || span.end > lastActivity) lastActivity = span.end;
	}

	return {
		track: {
			id: trackId,
			parentId: parentTrackId,
			label: "",
			agent: initAgent,
			model: initModel ?? firstAssistantModel,
			file,
			spans,
			markers,
		},
		taskResults,
		requests,
		toolCalls: pendingTools.length,
		cwd,
		title: slotTitle ?? headerTitle,
		headerTs,
		firstActivity,
		lastActivity,
	};
}

// ---------------------------------------------------------------------------
// Recursive track tree

/** Strip the transcript extension (`.jsonl` / `.jsonl.gz`). */
function transcriptStem(file: string): string {
	return file.endsWith(".jsonl.gz") ? file.slice(0, -".jsonl.gz".length) : file.slice(0, -".jsonl".length);
}

/**
 * Build the track for one transcript and recurse into its artifacts directory.
 * Appends tracks to `out` in DFS order and places subagent spans on parents.
 */
async function buildTrackTree(
	file: string,
	trackId: string,
	parentTrackId: string | null,
	depth: number,
	visited: Set<string>,
	out: TraceTrack[],
	scans: TrackScan[],
): Promise<TrackScan | null> {
	if (visited.has(file)) return null;
	visited.add(file);

	let bytes: Uint8Array;
	try {
		bytes = await readTranscript(file);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}

	const scan = scanTranscript(parseAllSessionEntries(bytes), trackId, parentTrackId, file);
	out.push(scan.track);
	scans.push(scan);

	const childrenById = new Map<string, TrackScan>();
	if (depth < MAX_TRACK_DEPTH) {
		const artifactsDir = transcriptStem(file);
		let names: string[] = [];
		try {
			names = await fs.readdir(artifactsDir);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		names.sort();
		for (const name of names) {
			// `.jsonl.*.bak` backups fail both suffix checks and are skipped.
			if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.gz")) continue;
			const childFile = path.join(artifactsDir, name);
			const stem = path.basename(transcriptStem(childFile));
			const childTrackId = trackId === "main" ? stem : `${trackId}/${stem}`;
			const childScan = await buildTrackTree(childFile, childTrackId, trackId, depth + 1, visited, out, scans);
			if (!childScan) continue;
			const isAdvisor = name === "__advisor.jsonl" || (name.startsWith("__advisor.") && name.endsWith(".jsonl"));
			childScan.track.label = isAdvisor
				? "Advisor"
				: headText(`${childScan.track.agent ?? "agent"} ${stem}`, LABEL_MAX);
			childrenById.set(stem, childScan);
		}
	}

	// Subagent spans on this track, one per task SingleResult.
	const linkedChildren = new Set<string>();
	for (const result of scan.taskResults) {
		const child = childrenById.get(result.childId);
		if (child) linkedChildren.add(result.childId);
		let start: number;
		let end: number;
		if (child && child.firstActivity !== undefined && child.lastActivity !== undefined) {
			start = child.firstActivity;
			end = child.lastActivity;
		} else if (result.durationMs !== undefined) {
			start = result.toolSpanEnd - result.durationMs;
			end = result.toolSpanEnd;
		} else {
			continue;
		}
		const span: TraceSpan = {
			id: `${trackId}:${result.resultEntryId}:${result.childId}`,
			kind: "subagent",
			start,
			end: Math.max(start, end),
			label: headText(result.agent ?? result.childId, LABEL_MAX),
		};
		if (result.task) span.detail = headText(result.task, DETAIL_MAX);
		if (result.resultEntryId) span.entryId = result.resultEntryId;
		if (child) {
			span.childTrackId = child.track.id;
			if (child.track.model) span.model = child.track.model;
		}
		scan.track.spans.push(span);
	}
	// Children with no structured task result — async task jobs (results are
	// delivered as formatted text), crashed parents, advisors — still get a
	// parent span from their own activity bounds so the Agents lane shows them.
	for (const [stem, child] of childrenById) {
		if (linkedChildren.has(stem)) continue;
		if (child.firstActivity === undefined || child.lastActivity === undefined) continue;
		const span: TraceSpan = {
			id: `${trackId}:sub:${stem}`,
			kind: "subagent",
			start: child.firstActivity,
			end: Math.max(child.firstActivity, child.lastActivity),
			label: headText(child.track.agent ?? child.track.label, LABEL_MAX),
			childTrackId: child.track.id,
		};
		if (child.track.model) span.model = child.track.model;
		scan.track.spans.push(span);
	}
	scan.track.spans.sort((a, b) => a.start - b.start || a.end - b.end);

	return scan;
}

// ---------------------------------------------------------------------------
// Public surface

/**
 * Assemble the full span tree for one root session transcript.
 * Throws {@link TracePathError} for paths outside the sessions root; ENOENT
 * passes through for the caller's 404 mapping.
 */
export async function buildSessionTrace(fileParam: string): Promise<SessionTrace> {
	const resolved = resolveSessionPath(fileParam);
	const rootStat = await fs.stat(resolved);

	const tracks: TraceTrack[] = [];
	const scans: TrackScan[] = [];
	const rootScan = await buildTrackTree(resolved, "main", null, 0, new Set(), tracks, scans);
	if (!rootScan) {
		throw Object.assign(new Error(`ENOENT: session not found: ${resolved}`), { code: "ENOENT" });
	}
	rootScan.track.label = "Main";

	let startedAt: number | undefined;
	let endedAt: number | undefined;
	const intervals: Array<[number, number]> = [];
	let toolCalls = 0;
	let requests = 0;
	let totalTokens = 0;
	let costTotal = 0;
	const toolStats = new Map<string, TraceToolStat>();

	for (const scan of scans) {
		requests += scan.requests;
		toolCalls += scan.toolCalls;
		for (const span of scan.track.spans) {
			intervals.push([span.start, span.end]);
			if (startedAt === undefined || span.start < startedAt) startedAt = span.start;
			if (endedAt === undefined || span.end > endedAt) endedAt = span.end;
			if (span.kind === "model") {
				if (span.tokens) totalTokens += span.tokens;
				if (span.cost) costTotal += span.cost;
			} else if (span.kind === "tool") {
				const duration = span.end - span.start;
				const agg = toolStats.get(span.label);
				if (agg) {
					agg.calls++;
					if (span.isError) agg.errors++;
					agg.totalMs += duration;
					if (duration > agg.maxMs) agg.maxMs = duration;
				} else {
					toolStats.set(span.label, {
						tool: span.label,
						calls: 1,
						errors: span.isError ? 1 : 0,
						totalMs: duration,
						maxMs: duration,
					});
				}
			}
		}
	}

	let modelMs = 0;
	let toolMs = 0;
	let turns = 0;
	for (const span of rootScan.track.spans) {
		if (span.kind === "model") modelMs += span.end - span.start;
		else if (span.kind === "tool") toolMs += span.end - span.start;
		else if (span.kind === "turn") turns++;
	}

	const start = startedAt ?? rootScan.headerTs ?? rootStat.mtimeMs;
	const end = endedAt ?? start;
	const wallMs = end - start;

	const summary: TraceSummary = {
		wallMs,
		modelMs,
		toolMs,
		idleMs: Math.max(0, wallMs - unionLength(intervals)),
		turns,
		requests,
		toolCalls,
		subagents: tracks.length - 1,
		totalTokens,
		costTotal,
		toolStats: [...toolStats.values()].sort((a, b) => b.totalMs - a.totalMs),
	};

	return {
		file: resolved,
		title: rootScan.title,
		cwd: rootScan.cwd,
		startedAt: start,
		endedAt: end,
		mtimeMs: rootStat.mtimeMs,
		tracks,
		summary,
	};
}

/** Fetch one full journal entry by id from a transcript, for the span drawer. */
export async function getTraceEntry(fileParam: string, entryId: string): Promise<SessionEntry | null> {
	const resolved = resolveSessionPath(fileParam);
	let bytes: Uint8Array;
	try {
		bytes = await readTranscript(resolved);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	for (const entry of parseAllSessionEntries(bytes)) {
		if ("id" in entry && entry.id === entryId) return entry;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Session list

const titleCache = new Map<string, { mtimeMs: number; title: string | null }>();

/** Read the session title from the fixed title slot or the header line. */
async function readSessionTitle(file: string): Promise<string | null> {
	let mtimeMs: number;
	try {
		mtimeMs = (await fs.stat(file)).mtimeMs;
	} catch {
		return null;
	}
	const cached = titleCache.get(file);
	if (cached && cached.mtimeMs === mtimeMs) return cached.title;

	let title: string | null = null;
	try {
		const head = await Bun.file(file).slice(0, TITLE_SCAN_BYTES).text();
		for (const line of head.split("\n")) {
			if (!line.trim()) continue;
			let parsed: EntryView;
			try {
				// Boundary cast: fields re-checked with typeof below.
				parsed = JSON.parse(line) as EntryView;
			} catch {
				continue;
			}
			if (parsed.type === "title" && typeof parsed.title === "string") {
				title = parsed.title;
				break;
			}
			if (parsed.type === "session") {
				if (typeof parsed.title === "string") title = parsed.title;
				break;
			}
		}
	} catch {
		// Unreadable head (gc'd, gz, permission) → keep the row, title null.
	}
	titleCache.set(file, { mtimeMs, title });
	return title;
}

interface SummaryFold extends SessionSummary {
	modelSet: Set<string>;
}
/** Parse the ms timestamp from a session basename (`2026-09-01T10-24-49-741Z_<uuid>.jsonl`). */
function basenameTimestamp(base: string): number | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(base);
	if (!match) return undefined;
	const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Root session transcripts found on disk, newest-first by mtime. Lets the
 * Traces list include sessions the sync pass hasn't indexed yet (most
 * importantly the currently running one).
 */
async function scanDiskRoots(limit: number): Promise<Array<{ file: string; mtimeMs: number; startedAt: number }>> {
	const sessionsDir = getSessionsDir();
	let projects: string[] = [];
	try {
		projects = await fs.readdir(sessionsDir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const roots: Array<{ file: string; mtimeMs: number; startedAt: number }> = [];
	await Promise.all(
		projects.map(async project => {
			let names: string[] = [];
			try {
				names = await fs.readdir(path.join(sessionsDir, project));
			} catch {
				return; // Not a directory or unreadable — skip.
			}
			await Promise.all(
				names.map(async name => {
					if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.gz")) return;
					const file = path.join(sessionsDir, project, name);
					try {
						const stat = await fs.stat(file);
						roots.push({ file, mtimeMs: stat.mtimeMs, startedAt: basenameTimestamp(name) ?? stat.mtimeMs });
					} catch {
						// Raced with gc — skip.
					}
				}),
			);
		}),
	);
	roots.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return roots.slice(0, limit);
}

/**
 * List root sessions for the Traces section, folding every synced child
 * transcript (subagents, advisors) into its root row.
 */
export async function listSessionSummaries(limit = 100, q?: string): Promise<SessionSummary[]> {
	const sessionsDir = getSessionsDir();
	const toolCounts = getToolCallCountsBySession();
	const byRoot = new Map<string, SummaryFold>();

	for (const row of getSessionRollups()) {
		const rel = path.relative(sessionsDir, row.sessionFile);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
		const segments = rel.split(path.sep);
		if (segments.length < 2) continue;
		const isChild = segments.length > 2;
		const rootFile = isChild ? path.join(sessionsDir, segments[0], `${segments[1]}.jsonl`) : row.sessionFile;

		let fold = byRoot.get(rootFile);
		if (!fold) {
			fold = {
				file: rootFile,
				folder: extractFolderFromPath(rootFile),
				title: null,
				startedAt: row.startedAt,
				endedAt: row.endedAt,
				requests: 0,
				toolCalls: 0,
				subagents: 0,
				totalTokens: 0,
				costTotal: 0,
				models: [],
				modelSet: new Set(),
			};
			byRoot.set(rootFile, fold);
		}
		fold.requests += row.requests;
		fold.toolCalls += toolCounts.get(row.sessionFile) ?? 0;
		if (isChild) fold.subagents++;
		if (row.startedAt < fold.startedAt) fold.startedAt = row.startedAt;
		if (row.endedAt > fold.endedAt) fold.endedAt = row.endedAt;
		fold.totalTokens += row.totalTokens ?? 0;
		fold.costTotal += row.costTotal ?? 0;
		if (row.models) {
			for (const model of row.models.split(",")) {
				if (model) fold.modelSet.add(model);
			}
		}
	}

	// Fold in on-disk roots the sync pass hasn't indexed yet, so the currently
	// running session shows up without a manual Sync.
	for (const root of await scanDiskRoots(LIST_FOLD_LIMIT)) {
		const existing = byRoot.get(root.file);
		if (existing) {
			// Live sessions keep writing after the last sync; sort by real recency.
			if (root.mtimeMs > existing.endedAt) existing.endedAt = root.mtimeMs;
			continue;
		}
		byRoot.set(root.file, {
			file: root.file,
			folder: extractFolderFromPath(root.file),
			title: null,
			startedAt: root.startedAt,
			endedAt: root.mtimeMs,
			requests: 0,
			toolCalls: 0,
			subagents: 0,
			totalTokens: 0,
			costTotal: 0,
			models: [],
			modelSet: new Set(),
		});
	}

	const folds = [...byRoot.values()].sort((a, b) => b.endedAt - a.endedAt).slice(0, LIST_FOLD_LIMIT);
	await Promise.all(
		folds.map(async fold => {
			fold.title = await readSessionTitle(fold.file);
			fold.models = [...fold.modelSet].sort();
		}),
	);

	let rows: SessionSummary[] = folds.map(({ modelSet: _modelSet, ...summary }) => summary);
	if (q?.trim()) {
		const needle = q.trim().toLowerCase();
		rows = rows.filter(
			row =>
				(row.title ?? "").toLowerCase().includes(needle) ||
				row.folder.toLowerCase().includes(needle) ||
				path.basename(row.file).toLowerCase().includes(needle),
		);
	}
	return rows.slice(0, limit);
}
