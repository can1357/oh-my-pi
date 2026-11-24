/**
 * Activity views of the `archive` prelude: tool calls, regex matches over
 * transcript text, call counts, and one transcript's records.
 *
 * This module picks the transcripts in scope from file metadata alone (the
 * project's session directory, modification and creation times within the
 * window, and, with `subagents`, the subagent transcripts of those sessions);
 * the native scanner (`transcriptCalls` and friends in pi-natives) reads them
 * in parallel off the JS thread and filters records by time, tool, and regex.
 */
import * as fs from "node:fs";
import {
	type TranscriptCallFilter,
	type TranscriptFile,
	type TranscriptHeader,
	TranscriptRecordKind,
	type TranscriptRegexFlags,
	TranscriptSource,
	TranscriptStatsKey,
	transcriptCalls,
	transcriptGrep,
	transcriptMessages,
	transcriptStats,
} from "@oh-my-pi/pi-natives";
import { ToolError } from "../tools/tool-errors";
import { previewLine, shortenPath } from "../utils/render-utils";
import { formatCount, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { listStatedSessionFiles, parseSessionFileName } from "../session/session-listing";
import { sessionDirForCwd } from "../session/session-paths";
import { listSubSessionFiles } from "../session/sub-sessions";
import type { TimeWindow } from "../session/time-window";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";
import { type ArchiveScope, type ArchiveView, ago, resolveSessionFile, scopeLabel, shortId } from "./archive";

/** Text a `grep` searches: a message's text, or a tool call's arguments or result. */
export type GrepSource = "user" | "assistant" | "thinking" | "args" | "result";
/** Kinds of transcript records `messages` returns. */
export type MessageKind = "user" | "assistant" | "thinking" | "call" | "result";
/** Facts `archive.stats` counts calls by. */
export type ArchiveStatsKey = "tool" | "day" | "model" | "version" | "project" | "session";

/** Which transcript a record came from. */
export interface ArchiveOrigin {
	/** Id of the top-level session. */
	session: string;
	/** Slash-joined subagent id within the session ("Scout", "Scout/Helper"); `null` for the session itself. */
	agent: string | null;
	project: string;
	/** Transcript JSONL file; pass it to `archive.messages`. */
	file: string;
}

/** A tool call with its result and the reasoning before it. */
export interface ArchiveCall extends ArchiveOrigin {
	at: string | null;
	/** Session entry id of the assistant message holding the call. */
	entry: string | null;
	callId: string;
	tool: string;
	/** Arguments; strings longer than 4,000 characters keep their first and last 2,000. */
	args: Record<string, unknown>;
	/** Result text; longer than 1,000 characters keeps its first and last 500. `null` until the result exists. */
	result: string | null;
	/** Characters of the whole result. */
	resultChars: number | null;
	isError: boolean | null;
	/** The last 4,000 characters of the thinking and reply before the call. */
	reasoning: string | null;
	model: string | null;
	/** omp version that recorded the call. */
	version: string | null;
}

/** One place a `grep` pattern matched. */
export interface ArchiveGrepHit extends ArchiveOrigin {
	at: string | null;
	entry: string | null;
	source: TranscriptSource;
	/** Tool whose arguments or result matched. */
	tool: string | null;
	callId: string | null;
	/** Snippet around the match. */
	text: string;
	/** The matched text. */
	match: string;
}

/** Calls counted under one key. */
export interface ArchiveStat {
	/** Tool, local day (`YYYY-MM-DD`), model, version, project path, or session id; `null` when unknown. */
	key: string | null;
	calls: number;
	errors: number;
}

/** One record of a transcript, whole. */
export interface ArchiveMessage {
	entry: string | null;
	at: string | null;
	kind: TranscriptRecordKind;
	/** Message or result text; `null` for calls. */
	text: string | null;
	tool: string | null;
	callId: string | null;
	args: Record<string, unknown> | null;
	isError: boolean | null;
}

/** An activity view's scope: an {@link ArchiveScope}, plus the subagent transcripts of its sessions when `subagents`. */
export interface ActivityScope extends ArchiveScope {
	subagents: boolean;
}

/** Regex flags of an activity view: the grep tool's dialect. */
export type ActivityFlags = TranscriptRegexFlags;

/** Which tool calls count; omitted fields match every call. */
export type ActivityCallFilter = TranscriptCallFilter;

/** The transcripts a view reads, in scanner order, with where each came from. */
interface Transcripts {
	files: TranscriptFile[];
	origins: TranscriptOrigin[];
}

/** Where a scanned transcript came from, before its header is read. */
interface TranscriptOrigin {
	/** Session id from the file name; the scanner's header fills it in when the name holds none. */
	session: string | undefined;
	agent: string | null;
	/** Index of the top-level session's transcript in {@link Transcripts.files}. */
	main: number;
}

/** Most records a listing prints; records always hold every one. */
const LISTED_RECORDS = 30;
/** Display width of a listing's text previews. */
const PREVIEW_WIDTH = 160;
/** Session directories read at once while listing subagent transcripts. */
const SUBAGENT_LISTING_CONCURRENCY = 32;

const SOURCE: Record<GrepSource, TranscriptSource> = {
	user: TranscriptSource.User,
	assistant: TranscriptSource.Assistant,
	thinking: TranscriptSource.Thinking,
	args: TranscriptSource.Args,
	result: TranscriptSource.Result,
};

const RECORD_KIND: Record<MessageKind, TranscriptRecordKind> = {
	user: TranscriptRecordKind.User,
	assistant: TranscriptRecordKind.Assistant,
	thinking: TranscriptRecordKind.Thinking,
	call: TranscriptRecordKind.Call,
	result: TranscriptRecordKind.Result,
};

/** The newest `scope.limit` tool calls in scope matching `filter`. */
export async function archiveCalls(
	filter: ActivityCallFilter,
	flags: ActivityFlags,
	scope: ActivityScope,
	signal?: AbortSignal,
): Promise<ArchiveView<ArchiveCall[]>> {
	const transcripts = await transcriptsInScope(scope);
	const found = await transcriptCalls({ ...transcripts, ...scope.window, filter, flags, limit: scope.limit, signal });
	const origin = originOf(transcripts, found.headers, scope);
	const calls = found.calls.map((call): ArchiveCall => ({
		...origin(call.file),
		at: isoTime(call.at),
		entry: call.entry ?? null,
		callId: call.callId,
		tool: call.tool,
		args: parseArgs(call.args),
		result: call.result ?? null,
		resultChars: call.resultChars ?? null,
		isError: call.isError ?? null,
		reasoning: call.reasoning ?? null,
		model: call.model ?? null,
		version: call.version ?? null,
	}));
	const lines =
		calls.length === 0 ? [`No tool calls ${scopeLabel(scope)}.`] : [`Tool calls ${scopeLabel(scope)}, newest first:`];
	for (const call of calls.slice(0, LISTED_RECORDS)) {
		const facts = [originLabel(call, scope), call.at ? ago(call.at) : "undated", call.tool];
		if (call.isError) facts.push("error");
		lines.push(`- ${facts.join(" · ")}`, `  ${previewLine(primaryArgument(call.args), PREVIEW_WIDTH)}`);
		if (call.result !== null) lines.push(`  → ${previewLine(call.result, PREVIEW_WIDTH)}`);
	}
	return { text: finish(lines, calls.length), records: calls };
}

/** The newest `scope.limit` matches of `pattern` in `sources` in scope; `tools` narrows the argument and result sources. */
export async function archiveGrep(
	pattern: string,
	flags: ActivityFlags,
	options: { sources: readonly GrepSource[]; tools?: string[] },
	scope: ActivityScope,
	signal?: AbortSignal,
): Promise<ArchiveView<ArchiveGrepHit[]>> {
	const transcripts = await transcriptsInScope(scope);
	const found = await transcriptGrep({
		...transcripts,
		...scope.window,
		pattern,
		flags,
		sources: options.sources.map(source => SOURCE[source]),
		tools: options.tools,
		limit: scope.limit,
		signal,
	});
	const origin = originOf(transcripts, found.headers, scope);
	const hits = found.hits.map((hit): ArchiveGrepHit => ({
		...origin(hit.file),
		at: isoTime(hit.at),
		entry: hit.entry ?? null,
		source: hit.source,
		tool: hit.tool ?? null,
		callId: hit.callId ?? null,
		text: hit.text,
		match: hit.matched,
	}));
	const subject = `of ${JSON.stringify(pattern)} ${scopeLabel(scope)}`;
	const lines = hits.length === 0 ? [`No matches ${subject}.`] : [`Matches ${subject}, newest first:`];
	for (const hit of hits.slice(0, LISTED_RECORDS)) {
		const where = hit.tool ? `${hit.source} of ${hit.tool}` : hit.source;
		const facts = [originLabel(hit, scope), hit.at ? ago(hit.at) : "undated", where];
		lines.push(`- ${facts.join(" · ")}`, `  ${previewLine(hit.text, PREVIEW_WIDTH)}`);
	}
	return { text: finish(lines, hits.length), records: hits };
}

/** Tool calls in scope matching `filter`, counted by `by`: most calls first, days newest first; the top `scope.limit` keys. */
export async function archiveStats(
	by: ArchiveStatsKey,
	filter: ActivityCallFilter,
	flags: ActivityFlags,
	scope: ActivityScope,
	signal?: AbortSignal,
): Promise<ArchiveView<ArchiveStat[]>> {
	const transcripts = await transcriptsInScope(scope);
	const perTranscript: Record<ArchiveStatsKey, TranscriptStatsKey> = {
		tool: TranscriptStatsKey.Tool,
		day: TranscriptStatsKey.Day,
		model: TranscriptStatsKey.Model,
		version: TranscriptStatsKey.Version,
		project: TranscriptStatsKey.PerTranscript,
		session: TranscriptStatsKey.PerTranscript,
	};
	const found = await transcriptStats({
		...transcripts,
		...scope.window,
		filter,
		flags,
		by: perTranscript[by],
		signal,
	});
	const origin = originOf(transcripts, found.headers, scope);
	const buckets = new Map<string | null, ArchiveStat>();
	for (const counted of found.stats) {
		let key = counted.key ?? null;
		if (by === "project") key = origin(counted.file).project;
		else if (by === "session") key = origin(counted.file).session;
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { key, calls: 0, errors: 0 };
			buckets.set(key, bucket);
		}
		bucket.calls += counted.calls;
		bucket.errors += counted.errors;
	}
	const all = [...buckets.values()];
	if (by === "day") all.sort((a, b) => (b.key ?? "").localeCompare(a.key ?? ""));
	else all.sort((a, b) => b.calls - a.calls);
	const records = all.slice(0, scope.limit);
	const totals = { calls: 0, errors: 0 };
	for (const stat of all) {
		totals.calls += stat.calls;
		totals.errors += stat.errors;
	}
	const lines =
		records.length === 0
			? [`No tool calls ${scopeLabel(scope)}.`]
			: [`Tool calls by ${by} ${scopeLabel(scope)}: ${countLabel(totals)}`];
	for (const stat of records.slice(0, LISTED_RECORDS)) {
		let key = stat.key ?? "(unknown)";
		if (stat.key !== null && by === "project") key = shortenPath(stat.key);
		else if (stat.key !== null && by === "session") key = shortId(stat.key);
		lines.push(`- ${key} · ${countLabel(stat)}`);
	}
	return { text: finish(lines, records.length), records };
}

/**
 * The newest `limit` records of `kinds` in one transcript, whole, oldest
 * first: a session by id prefix, or any transcript file (subagents included).
 *
 * @throws {ToolError} when no session or several match, or the file is not readable.
 */
export async function archiveMessages(
	idOrFile: string,
	options: { kinds?: readonly MessageKind[]; window?: TimeWindow; limit: number; signal?: AbortSignal },
): Promise<ArchiveView<ArchiveMessage[]>> {
	const file = await resolveSessionFile(idOrFile);
	try {
		await fs.promises.stat(file);
	} catch (error) {
		if (isEnoent(error)) throw new ToolError(`Not a readable session file: ${shortenPath(file)}`);
		throw error;
	}
	const found = await transcriptMessages({
		path: file,
		kinds: options.kinds?.map(kind => RECORD_KIND[kind]),
		...options.window,
		limit: options.limit,
		signal: options.signal,
	});
	const records = found.map((record): ArchiveMessage => ({
		entry: record.entry ?? null,
		at: isoTime(record.at),
		kind: record.kind,
		text: record.text ?? null,
		tool: record.tool ?? null,
		callId: record.callId ?? null,
		args: record.args === undefined ? null : parseArgs(record.args),
		isError: record.isError ?? null,
	}));
	const lines =
		records.length === 0
			? [`No messages in ${shortenPath(file)}.`]
			: [`Messages of ${shortenPath(file)}, newest ${formatCount("record", records.length)}, oldest first:`];
	// The newest records are the ones a reader came for; the listing keeps those.
	const listed = records.slice(-LISTED_RECORDS);
	if (listed.length < records.length) lines.push(`… ${records.length - listed.length} older in the returned records`);
	for (const message of listed) {
		const when = message.at ? ago(message.at) : "undated";
		const kind = message.tool ? `${message.kind} ${message.tool}${message.isError ? " (error)" : ""}` : message.kind;
		const body = message.text ?? primaryArgument(message.args ?? {});
		lines.push(`- ${when} · ${kind}: ${previewLine(body, PREVIEW_WIDTH)}`);
	}
	return { text: lines.join("\n"), records };
}

/**
 * The transcripts in scope, from file metadata only: top-level session files
 * of the project (every project when `cwd` is undefined) written since the
 * window opened and created before it closed, plus, with `subagents`, the
 * subagent transcripts of those sessions written since it opened. The scanner
 * filters each record by its own time.
 */
async function transcriptsInScope(scope: ActivityScope): Promise<Transcripts> {
	const since = scope.window?.since;
	const until = scope.window?.until;
	const transcripts: Transcripts = { files: [], origins: [] };
	const mains: { path: string; index: number }[] = [];
	const listed = await listStatedSessionFiles({ sessionDir: scope.cwd ? sessionDirForCwd(scope.cwd) : undefined });
	for (const { file, stat } of listed) {
		// Newest mtime first: every later file went quiet before the window opened.
		if (since !== undefined && stat.mtimeMs < since) break;
		const name = parseSessionFileName(file);
		if (until !== undefined && name && name.createdAt >= until) continue;
		const index = transcripts.files.length;
		transcripts.files.push({ path: file, newest: stat.mtimeMs });
		transcripts.origins.push({ session: name?.id, agent: null, main: index });
		mains.push({ path: file, index });
	}
	if (!scope.subagents) return transcripts;
	const { results } = await mapWithConcurrencyLimitAllSettled(mains, SUBAGENT_LISTING_CONCURRENCY, async main => {
		const found: { file: TranscriptFile; agent: string }[] = [];
		for (const sub of await listSubSessionFiles(main.path)) {
			const stat = await fs.promises.stat(sub.file).catch(() => undefined);
			if (stat && (since === undefined || stat.mtimeMs >= since)) {
				found.push({ file: { path: sub.file, newest: stat.mtimeMs }, agent: sub.key });
			}
		}
		return found;
	});
	for (const [index, result] of results.entries()) {
		if (result?.status !== "fulfilled") {
			if (result) logger.debug("Subagent transcripts not listed", { error: String(result.reason) });
			continue;
		}
		const main = mains[index];
		for (const { file, agent } of result.value) {
			transcripts.files.push(file);
			transcripts.origins.push({ session: transcripts.origins[main.index].session, agent, main: main.index });
		}
	}
	return transcripts;
}

/**
 * Resolves a scanned file index to its origin. The project is the top-level
 * session's working directory (a subagent may run in a worktree of its own),
 * else the transcript's own, else the scope's.
 */
function originOf(
	transcripts: Transcripts,
	headers: readonly TranscriptHeader[],
	scope: ActivityScope,
): (file: number) => ArchiveOrigin {
	const byFile = new Map(headers.map(header => [header.file, header]));
	return file => {
		const origin = transcripts.origins[file];
		const main = byFile.get(origin.main);
		const own = byFile.get(file);
		return {
			session: origin.session ?? main?.id ?? own?.id ?? "",
			agent: origin.agent,
			project: main?.cwd ?? own?.cwd ?? scope.cwd ?? "",
			file: transcripts.files[file].path,
		};
	};
}

/** Arguments parsed from the scanner's JSON; unparseable JSON reads as none. */
function parseArgs(json: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(json);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** ISO-8601 of Unix milliseconds; `null` for a record without a time. */
function isoTime(at: number): string | null {
	return at > 0 ? new Date(at).toISOString() : null;
}

/** `id[/agent]`, with the project when the view spans every project. */
function originLabel(origin: ArchiveOrigin, scope: ActivityScope): string {
	const label = origin.agent ? `${shortId(origin.session)}/${origin.agent}` : shortId(origin.session);
	return scope.cwd ? label : `${label} · ${shortenPath(origin.project)}`;
}

/** The longest string argument, the one that usually says what a call did (a command, a path, a pattern). */
function primaryArgument(args: Record<string, unknown>): string {
	let primary = "";
	for (const key in args) {
		const value = args[key];
		if (typeof value === "string" && value.length > primary.length) primary = value;
	}
	return primary || JSON.stringify(args);
}

/** `1,234 calls · 56 errors (4.5%)`. */
function countLabel(counted: { calls: number; errors: number }): string {
	const share = counted.calls > 0 ? ` (${((counted.errors / counted.calls) * 100).toFixed(1)}%)` : "";
	return `${formatCount("call", counted.calls)} · ${formatCount("error", counted.errors)}${share}`;
}

/** A listing's lines with its overflow note. */
function finish(lines: string[], total: number): string {
	if (total > LISTED_RECORDS) lines.push(`… ${total - LISTED_RECORDS} more in the returned records`);
	return lines.join("\n");
}
