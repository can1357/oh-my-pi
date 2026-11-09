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
 *   markers ({@link isReasoningSourceSignature}), text signatures (OpenAI
 *   message phase), Anthropic message controls and native compaction blocks,
 *   OpenAI snapshot histories, and compaction entries (an OpenAI remote
 *   compaction's stored summary is a placeholder for its encrypted history).
 *
 * A rewrite keeps every line without replay data byte for byte (the title slot
 * included) and the transcript's timestamps.
 */
import type { BigIntStats } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, ProviderPayload } from "@oh-my-pi/pi-ai";
import { isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isReasoningSourceSignature } from "@oh-my-pi/pi-ai/utils/reasoning-source";
import { isRecord, readLines } from "@oh-my-pi/pi-utils";
import { convertMessagesForContextView } from "../session/messages";
import { buildSessionContext } from "../session/session-context";
import type { CompactionEntry, SessionEntry } from "../session/session-entries";
import { type FileSessionStorage, sessionStagingPath } from "../session/session-storage";

const GZIP_SUFFIX = ".gz";
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
	/**
	 * Line indices of the latest replay turn on the active branch, kept verbatim:
	 * its first assistant record through its last surviving assistant and the tool
	 * results of that turn.
	 */
	keep: ReadonlySet<number>;
	/** Line indices whose replay data is removed. */
	strip: ReadonlySet<number>;
	/** First and last kept line index, or -1 when `keep` is empty. */
	keepStart: number;
	keepEnd: number;
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

function stripBlock(block: Record<string, unknown>): boolean {
	switch (block.type) {
		case "thinking": {
			const signature = block.thinkingSignature;
			const opaque = typeof signature === "string" && !isReasoningSourceSignature(signature);
			return drop(block, opaque ? ["thinkingSignature", "itemId"] : ["itemId"]);
		}
		case "toolCall":
			// `partialArgs`/`streamIndex`: streaming state an interrupted openai-completions stream left behind.
			return drop(block, ["thoughtSignature", "partialArgs", "streamIndex"]);
		case "image":
			return drop(block, ["providerFile"]);
		default:
			return false;
	}
}

/**
 * Remove provider replay data from one parsed session record, in place.
 * Returns whether anything was removed; records other than messages are never touched.
 */
function stripRecord(record: unknown): boolean {
	if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) return false;
	const message = record.message;
	let changed = false;
	if (message.role === "assistant") {
		if (isContentCache(message.providerPayload)) changed = drop(message, ["providerPayload"]);
		changed = drop(message, ["requestControls", "inputTransformations"]) || changed;
	}
	if (!Array.isArray(message.content)) return changed;
	// Redacted thinking is nothing but the encrypted reasoning.
	const content = message.content.filter(block => !isRecord(block) || block.type !== "redactedThinking");
	if (content.length !== message.content.length) {
		message.content = content;
		changed = true;
	}
	for (const block of content) {
		if (isRecord(block)) changed = stripBlock(block) || changed;
	}
	return changed;
}

function parseRecord(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// A malformed line is kept as it is.
		return undefined;
	}
}

/** Whether `message` emits a non-tool-result wire message that ends an assistant run. */
function isBoundaryMessage(message: Message): boolean {
	if (message.role === "assistant" || message.role === "toolResult") return false;
	if (
		message.role === "developer" &&
		isRecord(message.providerPayload) &&
		message.providerPayload.type === "anthropicMessage"
	) {
		const payload = message.providerPayload;
		if (
			payload.clearAt !== undefined ||
			payload.effort !== undefined ||
			(Array.isArray(payload.toolChanges) && payload.toolChanges.length > 0)
		) {
			return true;
		}
	}
	if (typeof message.content === "string") return message.content.trim().length > 0;
	if (!Array.isArray(message.content)) return false;
	return message.content.some(
		block =>
			isRecord(block) &&
			((block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) ||
				block.type === "image"),
	);
}

/**
 * Normalize a parsed JSONL object into a {@link SessionEntry} for
 * {@link buildSessionContext} without mutating `record`. Entries that omit
 * `id` or `parentId` (legacy v1 sessions, minimal fixtures) chain in file
 * order; entries with explicit tree links keep them.
 */
function toSessionEntry(
	record: Record<string, unknown>,
	index: number,
	prevId: string | null,
	v1Compactions: Array<{ entry: CompactionEntry; firstKeptEntryIndex: number }>,
): SessionEntry {
	const id = typeof record.id === "string" && record.id.length > 0 ? record.id : `\0line:${index}`;
	const parentId =
		record.parentId === null
			? null
			: typeof record.parentId === "string" && record.parentId.length > 0
				? record.parentId
				: prevId;
	const activeLeafId =
		record.activeLeafId === null || (typeof record.activeLeafId === "string" && record.activeLeafId.length > 0)
			? record.activeLeafId
			: undefined;
	const timestamp = typeof record.timestamp === "string" ? record.timestamp : "1970-01-01T00:00:00.000Z";

	switch (record.type) {
		case "message": {
			if (!isRecord(record.message) || typeof record.message.role !== "string") {
				return { type: "custom", customType: "", id, parentId, activeLeafId, timestamp };
			}
			const rawMsg = record.message;
			const role = rawMsg.role === "hookMessage" ? "custom" : rawMsg.role;
			const msgTimestamp =
				typeof rawMsg.timestamp === "number" && Number.isFinite(rawMsg.timestamp) ? rawMsg.timestamp : 0;
			if (role === "assistant") {
				if (!Array.isArray(rawMsg.content) || !rawMsg.content.every(isRecord)) {
					return { type: "custom", customType: "", id, parentId, activeLeafId, timestamp };
				}
				const content = rawMsg.content.map(block => {
					if (block.type === "text" && typeof block.text !== "string") return { ...block, text: "" };
					if (block.type === "thinking") {
						return {
							...block,
							thinking: typeof block.thinking === "string" ? block.thinking : "",
							...(block.thinkingSignature !== undefined && typeof block.thinkingSignature !== "string"
								? { thinkingSignature: undefined }
								: {}),
						};
					}
					if (block.type === "redactedThinking" && typeof block.data !== "string") return { ...block, data: "" };
					if (block.type === "toolCall" && typeof block.name !== "string") return { ...block, name: "" };
					return block;
				});
				const stopReason = typeof rawMsg.stopReason === "string" ? rawMsg.stopReason : "stop";
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role: "assistant",
						stopReason,
						content,
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (rawMsg.excludeFromContext === true) {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role: "bashExecution",
						command: typeof rawMsg.command === "string" ? rawMsg.command : "",
						output: typeof rawMsg.output === "string" ? rawMsg.output : "",
						excludeFromContext: true,
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (role === "toolResult") {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role: "toolResult",
						content: Array.isArray(rawMsg.content) ? rawMsg.content.filter(isRecord) : [],
						toolName: typeof rawMsg.toolName === "string" ? rawMsg.toolName : "",
						toolCallId: typeof rawMsg.toolCallId === "string" ? rawMsg.toolCallId : "",
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (role === "bashExecution") {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role: "bashExecution",
						command: typeof rawMsg.command === "string" ? rawMsg.command : "",
						output: typeof rawMsg.output === "string" ? rawMsg.output : "",
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (role === "pythonExecution") {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role: "pythonExecution",
						code: typeof rawMsg.code === "string" ? rawMsg.code : "",
						output: typeof rawMsg.output === "string" ? rawMsg.output : "",
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (role === "fileMention") {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role: "fileMention",
						files: Array.isArray(rawMsg.files)
							? rawMsg.files
									.filter(isRecord)
									.map(file => ({ ...file, path: typeof file.path === "string" ? file.path : "" }))
							: [],
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (role === "branchSummary" || role === "compactionSummary") {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role,
						summary: typeof rawMsg.summary === "string" ? rawMsg.summary : "",
						fromId: typeof rawMsg.fromId === "string" ? rawMsg.fromId : "",
						tokensBefore: typeof rawMsg.tokensBefore === "number" ? rawMsg.tokensBefore : 0,
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			if (role === "user" || role === "developer" || role === "custom") {
				return {
					...record,
					type: "message",
					id,
					parentId,
					activeLeafId,
					timestamp,
					message: {
						...rawMsg,
						role,
						content: typeof rawMsg.content === "string" || Array.isArray(rawMsg.content) ? rawMsg.content : "",
						customType: typeof rawMsg.customType === "string" ? rawMsg.customType : "",
						timestamp: msgTimestamp,
						[LINE_INDEX]: index,
					},
				} as unknown as SessionEntry;
			}
			return {
				...record,
				type: "message",
				id,
				parentId,
				activeLeafId,
				timestamp,
				message: {
					...rawMsg,
					role: "user",
					content:
						typeof rawMsg.content === "string" || Array.isArray(rawMsg.content)
							? rawMsg.content
							: [{ type: "text", text: role }],
					timestamp: msgTimestamp,
					[LINE_INDEX]: index,
				},
			} as unknown as SessionEntry;
		}
		case "custom_message":
			return {
				...record,
				type: "custom_message",
				id,
				parentId,
				activeLeafId,
				timestamp,
				customType: typeof record.customType === "string" ? record.customType : "",
				content: typeof record.content === "string" || Array.isArray(record.content) ? record.content : "",
				display: typeof record.display === "boolean" ? record.display : false,
			} as unknown as SessionEntry;
		case "branch_summary":
			return {
				...record,
				type: "branch_summary",
				id,
				parentId,
				activeLeafId,
				timestamp,
				summary: typeof record.summary === "string" ? record.summary : "",
				fromId: typeof record.fromId === "string" ? record.fromId : "",
			} as unknown as SessionEntry;
		case "compaction": {
			const entry = {
				...record,
				type: "compaction",
				id,
				parentId,
				activeLeafId,
				timestamp,
				summary: typeof record.summary === "string" ? record.summary : "Compacted",
				firstKeptEntryId: typeof record.firstKeptEntryId === "string" ? record.firstKeptEntryId : "",
				tokensBefore: typeof record.tokensBefore === "number" ? record.tokensBefore : 0,
			} as unknown as CompactionEntry;
			if (typeof record.firstKeptEntryId !== "string" && typeof record.firstKeptEntryIndex === "number") {
				v1Compactions.push({ entry, firstKeptEntryIndex: record.firstKeptEntryIndex });
			}
			return entry;
		}
		case "ttsr_injection":
			return {
				...record,
				type: "ttsr_injection",
				id,
				parentId,
				activeLeafId,
				timestamp,
				injectedRules: Array.isArray(record.injectedRules)
					? record.injectedRules.filter((rule): rule is string => typeof rule === "string")
					: [],
			} as unknown as SessionEntry;
		default:
			return { ...record, id, parentId, activeLeafId, timestamp } as unknown as SessionEntry;
	}
}

/**
 * Line indices belonging to the latest replay turn on the active branch, as
 * {@link buildSessionContext} and {@link convertMessagesForContextView} rebuild
 * it on resume: the run of surviving assistant responses joined only by tool
 * results that ends at the last surviving assistant response.
 */
function protectedTurnLines(entries: SessionEntry[]): Set<number> {
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
		} else if (isBoundaryMessage(message)) {
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
		if (lineIndex !== undefined) keep.add(lineIndex);
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
	const entries: SessionEntry[] = [];
	const fileEntries: Array<SessionEntry | { type: "session" }> = [];
	const v1Compactions: Array<{ entry: CompactionEntry; firstKeptEntryIndex: number }> = [];
	const candidates: Array<{ index: number; byteLength: number; record: Record<string, unknown> }> = [];
	let prevId: string | null = null;

	let index = -1;
	for await (const { bytes, text } of transcriptLines(file)) {
		index += 1;
		const record = parseRecord(text);
		if (!isRecord(record) || typeof record.type !== "string" || record.type === "title") continue;
		if (record.type === "session") {
			fileEntries.push({ type: "session" });
			continue;
		}
		if (record.type === "message") {
			candidates.push({ index, byteLength: bytes.length, record });
		}
		const entry = toSessionEntry(record, index, prevId, v1Compactions);
		entries.push(entry);
		fileEntries.push(entry);
		if (entry.activeLeafId === undefined || entry.activeLeafId === entry.id) {
			prevId = entry.id;
		}
	}
	if (candidates.length === 0) return undefined;
	for (const { entry, firstKeptEntryIndex } of v1Compactions) {
		const target = fileEntries[firstKeptEntryIndex] ?? entries[firstKeptEntryIndex];
		if (target && target.type !== "session") {
			entry.firstKeptEntryId = target.id;
		}
	}

	const keep = protectedTurnLines(entries);
	let keepStart = -1;
	let keepEnd = -1;
	for (const lineIndex of keep) {
		if (keepStart < 0 || lineIndex < keepStart) keepStart = lineIndex;
		if (lineIndex > keepEnd) keepEnd = lineIndex;
	}
	const strip = new Set<number>();
	const plan: StripPlan = { file, stat, keep, strip, keepStart, keepEnd, records: 0, bytes: 0 };
	for (const { index: lineIndex, byteLength, record } of candidates) {
		if (keep.has(lineIndex) || !stripRecord(record)) continue;
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
		const line = stripRecord(record) ? Buffer.from(JSON.stringify(record)) : bytes;
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
