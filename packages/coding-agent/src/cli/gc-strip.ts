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
 * - The latest surviving assistant turn, verbatim: a resumed turn that
 *   continues its tool loop must replay the most recent response's reasoning
 *   unmodified.
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
import type { AssistantMessage, ProviderPayload } from "@oh-my-pi/pi-ai";
import { isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isReasoningSourceSignature } from "@oh-my-pi/pi-ai/utils/reasoning-source";
import { isRecord, readLines } from "@oh-my-pi/pi-utils";
import { type FileSessionStorage, sessionStagingPath } from "../session/session-storage";

const GZIP_SUFFIX = ".gz";
/** Keys only replay data uses: a line without one has nothing to strip and is never parsed. */
const REPLAY_KEY_RE =
	/"(?:providerPayload|requestControls|inputTransformations|thinkingSignature|itemId|redactedThinking|thoughtSignature|partialArgs|streamIndex|providerFile)"/;
const ASSISTANT_RE = /"role":"assistant"/;
const NEWLINE = new Uint8Array([0x0a]);
const WRITE_CHUNK_BYTES = 1 << 20;

/** What stripping one transcript removes, planned against the file as it was at `stat`. */
export interface StripPlan {
	file: string;
	stat: BigIntStats;
	/** Line index of the latest surviving assistant turn, which stays verbatim; -1 when there is none. */
	keep: number;
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

/** Whether `record` is an assistant turn a provider would replay as its most recent response. */
function isSurvivingAssistantRecord(record: unknown): boolean {
	if (!isRecord(record) || record.type !== "message") return false;
	const message = record.message;
	return isAssistantMessage(message) && isSurvivingAssistant(message);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return (
		isRecord(value) && value.role === "assistant" && Array.isArray(value.content) && value.content.every(isRecord)
	);
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
 * or carries no replay data outside its latest surviving assistant turn.
 */
export async function planStrip(file: string, idleBeforeMs: number): Promise<StripPlan | undefined> {
	const stat = await fs.lstat(file, { bigint: true });
	if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mtimeMs) > idleBeforeMs) return undefined;
	const plan: StripPlan = { file, stat, keep: -1, records: 0, bytes: 0 };
	// Removable bytes of the kept turn: they count once a later turn supersedes it.
	let keptBytes: number | undefined;
	let index = -1;
	for await (const { bytes, text } of transcriptLines(file)) {
		index += 1;
		const replay = REPLAY_KEY_RE.test(text);
		if (!replay && !ASSISTANT_RE.test(text)) continue;
		const record = parseRecord(text);
		if (isSurvivingAssistantRecord(record)) {
			if (keptBytes !== undefined) {
				plan.records += 1;
				plan.bytes += keptBytes;
			}
			keptBytes = undefined;
			plan.keep = index;
		}
		if (!replay || !stripRecord(record)) continue;
		const removed = bytes.length - Buffer.byteLength(JSON.stringify(record));
		if (index === plan.keep) {
			keptBytes = removed;
		} else {
			plan.records += 1;
			plan.bytes += removed;
		}
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
		const record = index !== plan.keep && REPLAY_KEY_RE.test(text) ? parseRecord(text) : undefined;
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
		current.mtimeNs === plan.stat.mtimeNs
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
	try {
		const sink = (await fs.open(staged, "wx")).createWriteStream();
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
