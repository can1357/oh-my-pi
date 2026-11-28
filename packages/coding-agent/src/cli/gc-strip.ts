/**
 * Provider replay data stripping for idle session transcripts (`omp gc --strip`).
 *
 * Assistant turns persist state only their provider can read back, so a
 * resumed turn replays natively: signed or encrypted reasoning, the verbatim
 * wire response kept for prompt caching, request controls, uploaded-file
 * references. Once a transcript has sat idle past every provider's cache and
 * response retention, that state is dead weight. {@link stripRecord} removes
 * it, leaving each turn as one recorded by another model, which every provider
 * already replays (reasoning as plain text, or not at all), so the session
 * stays resumable on any model.
 *
 * Kept on purpose:
 * - The latest replay turn, verbatim: the run of assistant responses that ends
 *   the latest surviving assistant turn, joined by tool results or adjacency as
 *   a provider's message list joins them. Providers validate that run as one
 *   assistant message, so a resumed turn that continues its tool loop must
 *   replay each response's reasoning unmodified.
 * - Replay state that carries context found nowhere else: reasoning source
 *   markers ({@link isReasoningSourceSignature}, also the one a
 *   `reasoning_details` envelope carries), text signatures (OpenAI
 *   message phase), Anthropic message controls and native compaction blocks,
 *   OpenAI snapshot histories, and compaction entries (an OpenAI remote
 *   compaction's stored summary is a placeholder for its encrypted history).
 *
 * A rewrite keeps every line without replay data byte for byte (the title slot
 * included) and the transcript's timestamps. The latest replay turn is found
 * with the transcript's `entry_patch` records applied, as a resume applies
 * them (a retry saga's `retryRecovery` decides which attempt survives), and a
 * record that sets the `content` of a message outside that turn loses its
 * replay data as the message's own line does: a resume sets that content over
 * the stripped line. A record every reader skips stays as written, so the
 * strip never turns it into one they apply.
 */
import type { BigIntStats } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ProviderPayload } from "@oh-my-pi/pi-ai";
import { isReplayTurnBoundary, isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isReasoningSourceSignature, parseReasoningDetailsSignature } from "@oh-my-pi/pi-ai/utils/reasoning-source";
import { isRecord, readLines, tryParseJson } from "@oh-my-pi/pi-utils";
import { isEntryPatchData, isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import { applyEntryPatches } from "../session/entry-patches";
import { convertMessagesForContextView } from "../session/messages";
import { buildSessionContext } from "../session/session-context";
import type { FileEntry, RawFileEntry, SessionEntry } from "../session/session-entries";
import { migrateToCurrentVersion } from "../session/session-migrations";
import { type FileSessionStorage, sessionStagingPath } from "../session/session-storage";

const GZIP_SUFFIX = ".gz";
/** Keys only replay data uses: a line without one has nothing to strip. */
const REPLAY_KEY_RE =
	/"(?:providerPayload|requestControls|inputTransformations|thinkingSignature|itemId|redactedThinking|thoughtSignature|partialArgs|streamIndex|providerFile)"/;
const NEWLINE = new Uint8Array([0x0a]);
const WRITE_CHUNK_BYTES = 1 << 20;
const FILE_PERMISSION_MASK = 0o7777n;
/** Carries a message entry's physical JSONL line index through context rebuilding. */
const LINE_INDEX = Symbol("lineIndex");

type TaggedMessage = AgentMessage & { [LINE_INDEX]?: number };

/** What stripping one transcript removes, planned against the file as it was at `stat`. */
export interface StripPlan {
	file: string;
	stat: BigIntStats;
	/** Line indices whose replay data is removed. */
	strip: ReadonlySet<number>;
	/** Ids of the messages of the latest replay turn: a record's patch of one keeps its replay data. */
	protectedIds: ReadonlySet<string>;
	/** Records that lose replay data. */
	records: number;
	/** JSONL bytes removed; uncompressed for an archived `.jsonl.gz`. */
	bytes: number;
}

/**
 * Whether `payload` caches the wire form of content its turn already holds,
 * which replay rebuilds from the content when it is absent. An OpenAI history
 * without `dt` is a snapshot that replaces the whole input, so it stays.
 */
function isContentCache(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	switch (payload.type) {
		case "openaiResponsesHistory" satisfies ProviderPayload["type"]:
			return payload.dt === true;
		case "cursorHistory" satisfies ProviderPayload["type"]:
		case "geminiNativeContent" satisfies ProviderPayload["type"]:
			return true;
		default:
			return false;
	}
}

/** Delete `keys` from `target`; whether any was present. */
function drop(target: Record<string, unknown>, keys: readonly string[]): boolean {
	let dropped = false;
	for (const key of keys) {
		if (!Object.hasOwn(target, key)) continue;
		delete target[key];
		dropped = true;
	}
	return dropped;
}

function hasImageSource(block: Record<string, unknown>): boolean {
	return (
		(typeof block.data === "string" && block.data.length > 0) ||
		(typeof block.url === "string" && block.url.length > 0)
	);
}

function stripBlock(block: Record<string, unknown>): boolean {
	switch (block.type) {
		case "thinking": {
			const signature = block.thinkingSignature;
			if (typeof signature !== "string" || isReasoningSourceSignature(signature)) return drop(block, ["itemId"]);
			// A `reasoning_details` envelope reduces to the reasoning field marker it carries.
			const field = parseReasoningDetailsSignature(signature)?.field;
			if (field) block.thinkingSignature = field;
			else delete block.thinkingSignature;
			drop(block, ["itemId"]);
			return true;
		}
		case "toolCall":
			// `partialArgs`/`streamIndex`: streaming state an interrupted openai-completions stream left behind.
			return drop(block, ["thoughtSignature", "partialArgs", "streamIndex"]);
		case "image":
			return hasImageSource(block) && drop(block, ["providerFile"]);
		default:
			return false;
	}
}

/** Remove replay data from `holder.content`, a message's content or a patch of it, in place; whether any was removed. */
function stripContent(holder: Record<string, unknown>): boolean {
	if (!Array.isArray(holder.content)) return false;
	let changed = false;
	// Redacted thinking is nothing but the encrypted reasoning.
	const content = holder.content.filter(block => !isRecord(block) || block.type !== "redactedThinking");
	if (content.length !== holder.content.length) {
		holder.content = content;
		changed = true;
	}
	for (const block of content) {
		if (isRecord(block)) changed = stripBlock(block) || changed;
	}
	return changed;
}

/**
 * Remove provider replay data from one parsed session record, in place: a
 * message, or an `entry_patch` record's patches of the content of messages
 * outside `protectedIds`. Returns whether anything was removed; other records
 * are never touched, nor is an `entry_patch` record whose `data` the readers
 * skip whole (`isEntryPatchData`).
 */
function stripRecord(record: unknown, protectedIds: ReadonlySet<string>): boolean {
	if (!isRecord(record)) return false;
	if (isEntryPatchRecord(record)) {
		const data = record.data;
		if (!isEntryPatchData(data)) return false;
		let changed = false;
		for (const patch of data.patches) {
			if (protectedIds.has(patch.entryId) || !isRecord(patch.message)) continue;
			changed = stripContent(patch.message) || changed;
		}
		return changed;
	}
	if (record.type !== "message" || !isRecord(record.message)) return false;
	const message = record.message;
	let changed = false;
	if (message.role === "assistant") {
		if (isContentCache(message.providerPayload)) changed = drop(message, ["providerPayload"]);
		changed = drop(message, ["requestControls", "inputTransformations"]) || changed;
	}
	return stripContent(message) || changed;
}

function parseRecord(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// A malformed line is kept as it is.
		return undefined;
	}
}

/**
 * Parse a JSONL line into a {@link FileEntry} tagged with its physical line
 * index for {@link buildSessionContext}.
 */
function parseFileEntry(text: string, index: number): FileEntry | undefined {
	const entry = tryParseJson<RawFileEntry>(text);
	if (!isRecord(entry) || typeof entry.type !== "string" || entry.type === "title") return undefined;
	if (entry.type === "message") {
		const message: unknown = entry.message;
		if (!isRecord(message) || typeof message.role !== "string") return undefined;
		if (message.role === "assistant" && !Array.isArray(message.content)) return undefined;
		if (message.role === "toolResult" && typeof message.toolName !== "string") message.toolName = "";
		(entry.message as TaggedMessage)[LINE_INDEX] = index;
	}
	return entry;
}

/**
 * Line indices belonging to the latest replay turn on the active branch, as
 * {@link buildSessionContext} and {@link convertMessagesForContextView} rebuild
 * it on resume: the run of surviving assistant responses joined only by tool
 * results that ends at the last surviving assistant response. Undefined when a
 * message in that run lost its physical line index, so the caller fails closed.
 */
function protectedTurnLines(entries: SessionEntry[]): Set<number> | undefined {
	const keep = new Set<number>();
	if (entries.length === 0) return keep;
	const context = buildSessionContext(entries, undefined, undefined, {
		maxFrameDataBytes: 0,
	});
	const converted = convertMessagesForContextView(context.messages);
	const lastAssistant = converted.findLastIndex(
		({ message }) => message.role === "assistant" && isSurvivingAssistant(message),
	);
	if (lastAssistant < 0) return keep;
	let firstAssistant = lastAssistant;
	for (let i = lastAssistant - 1; i >= 0; i--) {
		const { message } = converted[i]!;
		if (message.role === "assistant") {
			if (isSurvivingAssistant(message)) firstAssistant = i;
		} else if (message.role === "toolResult") {
			continue;
		} else if (isReplayTurnBoundary(message)) {
			break;
		}
	}
	let turnEnd = lastAssistant;
	while (turnEnd + 1 < converted.length && converted[turnEnd + 1]!.message.role === "toolResult") {
		turnEnd += 1;
	}
	for (let i = firstAssistant; i <= turnEnd; i++) {
		const { message, sourceIndex } = converted[i]!;
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		if (message.role === "assistant" && !isSurvivingAssistant(message)) continue;
		const lineIndex = (context.messages[sourceIndex] as TaggedMessage | undefined)?.[LINE_INDEX];
		if (lineIndex === undefined) return undefined;
		keep.add(lineIndex);
	}
	return keep;
}

/** Decoded lines of a transcript, gunzipped for an archived `.jsonl.gz`. */
async function* transcriptLines(file: string): AsyncGenerator<{ bytes: Uint8Array; text: string }> {
	const decoder = new TextDecoder();
	const source = Bun.file(file).stream();
	const stream = file.endsWith(GZIP_SUFFIX) ? source.pipeThrough(new DecompressionStream("gzip")) : source;
	for await (const bytes of readLines(stream)) yield { bytes, text: decoder.decode(bytes) };
}

/**
 * Plan stripping `file`. Undefined when it was modified after `idleBeforeMs`,
 * is not a regular file with a single link (a rename would split the links),
 * or carries no replay data outside its latest replay turn.
 */
export async function planStrip(file: string, idleBeforeMs: number): Promise<StripPlan | undefined> {
	const stat = await fs.lstat(file, { bigint: true });
	if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mtimeMs) > idleBeforeMs) return undefined;
	const fileEntries: FileEntry[] = [];
	const candidates: Array<{ index: number; byteLength: number; record: Record<string, unknown> }> = [];
	let index = -1;

	for await (const { bytes, text } of transcriptLines(file)) {
		index += 1;
		const entry = parseFileEntry(text, index);
		if (!entry) continue;
		fileEntries.push(entry);
		if ((entry.type === "message" || isEntryPatchRecord(entry)) && REPLAY_KEY_RE.test(text)) {
			const record = parseRecord(text);
			if (isRecord(record)) candidates.push({ index, byteLength: bytes.length, record });
		}
	}
	if (candidates.length === 0) return undefined;
	migrateToCurrentVersion(fileEntries);
	// The turn a resume replays, with the fields the records set (a recovered attempt's marker).
	applyEntryPatches(fileEntries);
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const keep = protectedTurnLines(entries);
	if (!keep) return undefined;
	const protectedIds = new Set<string>();
	for (const entry of entries) {
		const lineIndex = entry.type === "message" ? (entry.message as TaggedMessage)[LINE_INDEX] : undefined;
		if (lineIndex !== undefined && keep.has(lineIndex)) protectedIds.add(entry.id);
	}

	const strip = new Set<number>();
	const plan: StripPlan = { file, stat, strip, protectedIds, records: 0, bytes: 0 };
	for (const { index: lineIndex, byteLength, record } of candidates) {
		if (keep.has(lineIndex) || !stripRecord(record, protectedIds)) continue;
		strip.add(lineIndex);
		plan.records += 1;
		plan.bytes += byteLength - Buffer.byteLength(JSON.stringify(record));
	}
	return plan.records > 0 ? plan : undefined;
}

/** The planned file's lines, stripped, batched into write-sized chunks. */
async function* strippedChunks(plan: StripPlan): AsyncGenerator<Buffer> {
	const parts: Uint8Array[] = [];
	let size = 0;
	let index = -1;
	for await (const { bytes, text } of transcriptLines(plan.file)) {
		index += 1;
		const record = plan.strip.has(index) ? parseRecord(text) : undefined;
		const line = stripRecord(record, plan.protectedIds) ? Buffer.from(JSON.stringify(record)) : bytes;
		parts.push(line, NEWLINE);
		size += line.length + 1;
		if (size < WRITE_CHUNK_BYTES) continue;
		yield Buffer.concat(parts, size);
		parts.length = 0;
		size = 0;
	}
	if (size > 0) yield Buffer.concat(parts, size);
}

/** The planned file is still the one scanned: same inode, size, and mtime, and still its only link. */
function unchangedSincePlan(plan: StripPlan): boolean {
	const current = fsSync.lstatSync(plan.file, { bigint: true });
	return (
		current.ino === plan.stat.ino &&
		current.nlink === 1n &&
		current.size === plan.stat.size &&
		current.mtimeNs === plan.stat.mtimeNs &&
		current.mode === plan.stat.mode
	);
}

/** `fs.utimes` seconds for a nanosecond timestamp, to the microsecond. */
function utimeSeconds(ns: bigint): number {
	return Number(ns / 1000n) / 1e6;
}

/**
 * Replace the planned transcript with its stripped copy, staged beside it with
 * the original's timestamps. A `.jsonl` transcript is swapped under the session
 * publish lock that serializes appends. Returns false, replacing nothing, when
 * the file changed since it was planned.
 *
 * @throws When the copy cannot be written or a writer holds the publish lock.
 */
export async function applyStrip(plan: StripPlan, storage: FileSessionStorage): Promise<boolean> {
	const staged = sessionStagingPath(plan.file);
	const mode = Number(plan.stat.mode & FILE_PERMISSION_MASK);
	try {
		const handle = await fs.open(staged, "wx", mode);
		try {
			await handle.chmod(mode);
		} catch (error) {
			await handle.close();
			throw error;
		}
		const sink = handle.createWriteStream();
		if (plan.file.endsWith(GZIP_SUFFIX)) await pipeline(strippedChunks(plan), createGzip({ level: 9 }), sink);
		else await pipeline(strippedChunks(plan), sink);
		await fs.utimes(staged, utimeSeconds(plan.stat.atimeNs), utimeSeconds(plan.stat.mtimeNs));
		if (!plan.file.endsWith(GZIP_SUFFIX)) {
			return storage.replaceSessionFileSync(plan.file, staged, () => unchangedSincePlan(plan));
		}
		// No process appends to an archive.
		if (!unchangedSincePlan(plan)) return false;
		fsSync.renameSync(staged, plan.file);
		return true;
	} finally {
		// Gone after a publish; otherwise the unpublished copy.
		await fs.rm(staged, { force: true });
	}
}
