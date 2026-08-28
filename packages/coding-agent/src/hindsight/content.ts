/**
 * Pure content utilities for the Hindsight backend.
 *
 * Ports the semantics of the upstream OpenCode plugin
 * (vectorize-io/hindsight @ hindsight-integrations/opencode/src/content.ts):
 *   - tag stripping for anti-feedback (a recalled <memories> block must
 *     never end up retained as a new memory)
 *   - recall query composition + truncation under a character budget
 *   - retention transcript framing
 */

export interface HindsightMessage {
	role: string;
	content: string;
	/** Original SessionEntry.timestamp; omitted when the source had none. */
	timestamp?: string;
}

export interface RecallResultLike {
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
}

const MEMORIES_REGEX = /<memories>[\s\S]*?<\/memories>/g;
const LEGACY_HINDSIGHT_MEMORIES_REGEX = /<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g;
const LEGACY_RELEVANT_MEMORIES_REGEX = /<relevant_memories>[\s\S]*?<\/relevant_memories>/g;
const MENTAL_MODELS_REGEX = /<mental_models>[\s\S]*?<\/mental_models>/g;

const RETENTION_PROTOCOL_MARKER_REGEX = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end|timestamp:\s+.+)\]$/;
/**
 * Strip `<memories>`, `<mental_models>`, and legacy memory blocks.
 *
 * Both `<memories>` (per-turn recall) and `<mental_models>` (curated semantic
 * memory) are injected into the system prompt. If either leaks into the
 * retention transcript, every retain becomes a tighter feedback loop —
 * paraphrased memories feed the next consolidation, which feeds the next
 * mental-model refresh, which feeds the next retain. Always strip before
 * retaining.
 */
export function stripMemoryTags(content: string): string {
	return content
		.replace(MEMORIES_REGEX, "")
		.replace(MENTAL_MODELS_REGEX, "")
		.replace(LEGACY_HINDSIGHT_MEMORIES_REGEX, "")
		.replace(LEGACY_RELEVANT_MEMORIES_REGEX, "");
}

// At least one letter or digit means the message carries a token a retriever
// can actually match on. Punctuation/whitespace-only strings (e.g. the lone
// `.` some providers emit for tool-call-only or thinking-only assistant turns)
// are dropped before retain/recall touches them — see issue #1806.
const SUBSTANTIVE_CHAR_RE = /[\p{L}\p{N}]/u;

/**
 * True when `content` carries at least one letter or digit. Used by retain
 * and recall paths to drop placeholder assistant turns ("." / "..." / pure
 * whitespace) that would otherwise pollute the bank and waste tokens on
 * embeddings with no semantic content.
 */
export function hasSubstantiveContent(content: string): boolean {
	return SUBSTANTIVE_CHAR_RE.test(content);
}

/** Format recall results into a bullet list for context injection. */
export function formatMemories(results: RecallResultLike[]): string {
	if (results.length === 0) return "";
	return results
		.map(r => {
			const typeStr = r.type ? ` [${r.type}]` : "";
			const dateStr = r.mentioned_at ? ` (${r.mentioned_at})` : "";
			return `- ${r.text}${typeStr}${dateStr}`;
		})
		.join("\n\n");
}

/** Format current UTC time for the recall preamble. */
export function formatCurrentTime(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const h = String(now.getUTCHours()).padStart(2, "0");
	const min = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${h}:${min}`;
}

/**
 * Slice messages to the last N turns, where a turn boundary is a user message.
 * Returns the trailing tail starting at the (N-th from the end) user message.
 */
export function sliceLastTurnsByUserBoundary(messages: HindsightMessage[], turns: number): HindsightMessage[] {
	if (messages.length === 0 || turns <= 0) return [];

	let userTurnsSeen = 0;
	let startIndex = -1;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userTurnsSeen += 1;
			if (userTurnsSeen >= turns) {
				startIndex = i;
				break;
			}
		}
	}

	return startIndex === -1 ? [...messages] : messages.slice(startIndex);
}

/**
 * Compose a recall query from the latest user prompt plus optional prior context.
 *
 * When `recallContextTurns <= 1` the query is just the trimmed latest prompt.
 * Otherwise we prepend a `Prior context:` block built from the trailing
 * `recallContextTurns` user-bounded turns (memory tags stripped, latest prompt
 * suppressed to avoid duplicating it inside the context block).
 */
export function composeRecallQuery(
	latestQuery: string,
	messages: HindsightMessage[],
	recallContextTurns: number,
): string {
	const latest = latestQuery.trim();
	if (recallContextTurns <= 1 || messages.length === 0) return latest;

	const contextual = sliceLastTurnsByUserBoundary(messages, recallContextTurns);
	const contextLines: string[] = [];

	for (const msg of contextual) {
		const content = stripMemoryTags(msg.content).trim();
		if (!content) continue;
		if (msg.role === "user" && content === latest) continue;
		contextLines.push(`${msg.role}: ${content}`);
	}

	if (contextLines.length === 0) return latest;
	return ["Prior context:", contextLines.join("\n"), latest].join("\n\n");
}

/**
 * Truncate a composed recall query to `maxChars`.
 *
 * Always preserves the latest user message. Drops oldest context lines first
 * and degrades gracefully when even the latest message exceeds the budget.
 */
export function truncateRecallQuery(query: string, latestQuery: string, maxChars: number): string {
	if (maxChars <= 0 || query.length <= maxChars) return query;

	const latest = latestQuery.trim();
	const latestOnly = latest.length > maxChars ? latest.slice(0, maxChars) : latest;

	if (!query.includes("Prior context:")) return latestOnly;

	const contextMarker = "Prior context:\n\n";
	const markerIndex = query.indexOf(contextMarker);
	if (markerIndex === -1) return latestOnly;

	const suffix = `\n\n${latest}`;
	const suffixIndex = query.lastIndexOf(suffix);
	if (suffixIndex === -1) return latestOnly;
	if (suffix.length >= maxChars) return latestOnly;

	const contextBody = query.slice(markerIndex + contextMarker.length, suffixIndex);
	const contextLines = contextBody.split("\n").filter(Boolean);

	const kept: string[] = [];
	for (let i = contextLines.length - 1; i >= 0; i--) {
		kept.unshift(contextLines[i]);
		const candidate = `${contextMarker}${kept.join("\n")}${suffix}`;
		if (candidate.length > maxChars) {
			kept.shift();
			break;
		}
	}

	if (kept.length > 0) return `${contextMarker}${kept.join("\n")}${suffix}`;
	return latestOnly;
}

export interface RetentionTranscript {
	transcript: string | null;
	messageCount: number;
}

/**
 * Format messages into a retention transcript using `[role: ...]` markers.
 *
 * - When `retainFullWindow` is true, all messages are included (used when the
 *   caller pre-sliced the window itself).
 * - Otherwise, only the last user turn (last user message → end) is retained.
 *
 * Messages are tag-stripped before framing to break the recall→retain loop.
 * Returns `{ transcript: null }` when nothing meaningful survives.
 */
function formatRetentionMessage(msg: HindsightMessage, includeTimestamps = false): string | null {
	const content = stripMemoryTags(msg.content).trim();
	if (!hasSubstantiveContent(content)) return null;
	const header = `[role: ${msg.role}]`;
	const timestamp = includeTimestamps ? msg.timestamp?.trim() : undefined;
	const stamped = timestamp ? `${header}\n[timestamp: ${timestamp}]` : header;
	return `${stamped}\n${content}\n[${msg.role}:end]`;
}

function formatRetentionMessages(messages: HindsightMessage[], includeTimestamps = false): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const formatted = formatRetentionMessage(msg, includeTimestamps);
		if (formatted) parts.push(formatted);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

function formatEmbeddableRetentionMessages(messages: HindsightMessage[]): RetentionTranscript {
	const parts: string[] = [];
	for (const msg of messages) {
		const content = stripRetentionProtocolMarkers(stripMemoryTags(msg.content)).trim();
		if (!hasSubstantiveContent(content)) continue;
		parts.push(content);
	}

	if (parts.length === 0) return { transcript: null, messageCount: 0 };

	const transcript = parts.join("\n\n");
	if (transcript.trim().length < 10) return { transcript: null, messageCount: 0 };

	return { transcript, messageCount: parts.length };
}

/** Remove retention framing lines from a stored coding-agent episode transcript. */
export function stripRetentionProtocolMarkers(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_PROTOCOL_MARKER_REGEX.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function prepareRetentionTranscript(
	messages: HindsightMessage[],
	retainFullWindow = false,
	options?: { includeTimestamps?: boolean },
): RetentionTranscript {
	if (messages.length === 0) return { transcript: null, messageCount: 0 };

	let targetMessages: HindsightMessage[];
	if (retainFullWindow) {
		targetMessages = messages;
	} else {
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) return { transcript: null, messageCount: 0 };
		targetMessages = messages.slice(lastUserIdx);
	}

	return formatRetentionMessages(targetMessages, options?.includeTimestamps === true);
}

/** Format all retention messages without protocol markers for embedding, FTS, and recall display. */
export function prepareEmbeddableRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatEmbeddableRetentionMessages(messages);
}
/** Format only user-authored messages for memory fact/entity extraction. */
export function prepareUserRetentionTranscript(messages: HindsightMessage[]): RetentionTranscript {
	return formatRetentionMessages(messages.filter(message => message.role === "user"));
}

/**
 * A source-message slice contributed to a {@link RetentionChunk}. `messageIndex` is the
 * position of the contributing message in the array originally passed to
 * {@link chunkRetentionMessages}; `start`/`end` are UTF-16 char offsets (Unicode-code-point
 * safe) into that message's own `content`. `role` is the message's TRUE role, independent of
 * whatever role the chunk's stored piece is framed under (a chunk that merges several
 * messages to fit the cap frames them as one `"turn"`-role block — `ranges` is what lets
 * {@link reconstructRetentionChunks} recover the original per-message roles).
 */
export interface RetentionChunkRange {
	readonly messageIndex: number;
	readonly start: number;
	readonly end: number;
	readonly role: string;
}

/** One bounded piece of a retained transcript, sized to fit under a `maxChars` cap. */
export interface RetentionChunk {
	readonly messages: HindsightMessage[];
	readonly ranges: readonly RetentionChunkRange[];
	/** Cumulative user turns fully persisted by the chunks emitted so far (including this one). */
	readonly completedUserTurns: number;
	/**
	 * Which user-bounded turn this chunk came from, 1-based within the input; `0` for a leading
	 * preamble that precedes the first user message.
	 *
	 * Together with {@link pieceIndex} this locates a chunk in a way that does NOT depend on how the
	 * input was batched. Turns are segmented before packing and each turn is packed independently, so
	 * the same turn yields the same pieces whether it arrives alone or alongside its neighbours --
	 * which is what lets a caller derive a stable identity for a chunk across differently sliced
	 * retention passes. A plain index over the returned array does not have that property.
	 */
	readonly turnNumber: number;
	/** Ordinal of this piece within its own turn, 0-based. */
	readonly pieceIndex: number;
}

/** Synthetic frame role for a chunk that merges multiple original messages (spanning more
 * than one true role) into a single `[role: turn]...[turn:end]` block to fit under a tight
 * cap. Never appears in `ranges[].role`, which always carries the true per-message role. */
const RETENTION_TURN_ROLE = "turn";
/** Separator joining distinct source messages inside one merged or split chunk's content,
 * and the corresponding offset the reconstructor skips between consecutive ranges. */
const RETENTION_CHUNK_SEPARATOR = "\n\n";

interface RetentionAtom {
	readonly messageIndex: number;
	readonly role: string;
	readonly content: string;
}

interface RetentionPiece {
	readonly messages: HindsightMessage[];
	readonly ranges: readonly RetentionChunkRange[];
}

interface RetentionTurnSegment {
	readonly turnNumber: number;
	readonly startIndex: number;
	readonly endIndex: number;
}

function retentionFramedLength(messages: HindsightMessage[]): number {
	return prepareRetentionTranscript(messages, true).transcript?.length ?? 0;
}

/**
 * Group `messages` into user-bounded turns: each turn starts at a `user` message and runs up
 * to (not including) the next `user` message. Leading non-user messages (e.g. a lone tool
 * call before the first user turn) form turn `0`, which never advances `completedUserTurns`.
 */
function segmentRetentionTurns(messages: readonly HindsightMessage[]): RetentionTurnSegment[] {
	const segments: RetentionTurnSegment[] = [];
	const firstUserIndex = messages.findIndex(message => message.role === "user");
	if (firstUserIndex === -1) {
		if (messages.length > 0) segments.push({ turnNumber: 0, startIndex: 0, endIndex: messages.length });
		return segments;
	}
	if (firstUserIndex > 0) segments.push({ turnNumber: 0, startIndex: 0, endIndex: firstUserIndex });
	let turnNumber = 0;
	let index = firstUserIndex;
	while (index < messages.length) {
		turnNumber++;
		let end = index + 1;
		while (end < messages.length && messages[end].role !== "user") end++;
		segments.push({ turnNumber, startIndex: index, endIndex: end });
		index = end;
	}
	return segments;
}

/** Largest prefix, in Unicode code points, of `codePoints` whose own frame under `role` fits
 * within `maxChars`. Binary search relies on framed length being non-decreasing in prefix
 * length. */
function maxFittingCodePointPrefix(role: string, codePoints: readonly string[], maxChars: number): number {
	let low = 0;
	let high = codePoints.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (retentionFramedLength([{ role, content: codePoints.slice(0, mid).join("") }]) <= maxChars) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** Split one oversized message into consecutive, Unicode-code-point-safe, own-role pieces,
 * each independently framed and within `maxChars`. */
function splitAtomIntoPieces(atom: RetentionAtom, maxChars: number): RetentionPiece[] {
	const codePoints = Array.from(atom.content);
	const pieces: RetentionPiece[] = [];
	let codePointOffset = 0;
	let charOffset = 0;
	while (codePointOffset < codePoints.length) {
		const remaining = codePoints.slice(codePointOffset);
		let fitCount = maxFittingCodePointPrefix(atom.role, remaining, maxChars);
		if (fitCount === 0) {
			throw new Error(
				`retentionChunkMaxChars (${maxChars}) is too small to hold a single framed code point for role "${atom.role}"`,
			);
		}
		// Each stored chunk is framed through prepareRetentionTranscript(), which trims
		// its message content. Never put whitespace on either side of an internal split
		// boundary: it would be trimmed from one piece and exact reconstruction would
		// silently join two words. Back up to a deterministic mid-token boundary instead.
		if (fitCount < remaining.length) {
			while (fitCount > 1 && (/\s/u.test(remaining[fitCount - 1] ?? "") || /\s/u.test(remaining[fitCount] ?? ""))) {
				fitCount--;
			}
		}
		const pieceContent = remaining.slice(0, fitCount).join("");
		const start = charOffset;
		const end = start + pieceContent.length;
		pieces.push({
			messages: [{ role: atom.role, content: pieceContent }],
			ranges: [{ messageIndex: atom.messageIndex, start, end, role: atom.role }],
		});
		charOffset = end;
		codePointOffset += fitCount;
	}
	return pieces;
}

/**
 * Pack a user-bounded turn's messages ("atoms") into the fewest pieces that fit under
 * `maxChars`, preferring (in order): the whole turn framed with each message's own role; the
 * whole turn merged into one `"turn"`-role block (cheaper than N separate frames, needed when
 * per-message overhead alone exceeds the cap); or, when even merged the turn is oversized,
 * each message packed independently (splitting any message that is still oversized alone).
 */
function packRetentionAtoms(atoms: readonly RetentionAtom[], maxChars: number): RetentionPiece[] {
	const unmerged = atoms.map(atom => ({ role: atom.role, content: atom.content }));
	if (retentionFramedLength(unmerged) <= maxChars) {
		return [
			{
				messages: unmerged,
				ranges: atoms.map(atom => ({
					messageIndex: atom.messageIndex,
					start: 0,
					end: atom.content.length,
					role: atom.role,
				})),
			},
		];
	}
	if (atoms.length > 1) {
		const merged = atoms.map(atom => atom.content).join(RETENTION_CHUNK_SEPARATOR);
		if (retentionFramedLength([{ role: RETENTION_TURN_ROLE, content: merged }]) <= maxChars) {
			return [
				{
					messages: [{ role: RETENTION_TURN_ROLE, content: merged }],
					ranges: atoms.map(atom => ({
						messageIndex: atom.messageIndex,
						start: 0,
						end: atom.content.length,
						role: atom.role,
					})),
				},
			];
		}
		return atoms.flatMap(atom => packRetentionAtoms([atom], maxChars));
	}
	const [atom] = atoms;
	return atom === undefined ? [] : splitAtomIntoPieces(atom, maxChars);
}

/**
 * Strip memory tags from every message BEFORE chunking, mirroring what the per-message framing in
 * `prepareRetentionTranscript()` does (strip, trim, drop anything non-substantive).
 *
 * Chunking splits on the framed length, so a `<memories>` or `<mental_models>` block can straddle a
 * chunk boundary whenever the non-memory text alone exceeds `retentionChunkMaxChars`. Neither half
 * then matches the tag regexes, framing cannot strip them, and recalled memories get persisted --
 * exactly the recall->retain feedback loop the stripping exists to prevent.
 *
 * Sanitizing first removes the possibility rather than trying to split around it: a block larger
 * than the cap would otherwise force a choice between an oversized chunk and a leak. Callers MUST
 * chunk this array and resolve chunk source messages from this SAME array, so the ranges recorded
 * for reconstruction are offsets into the content that was actually stored.
 */
export function sanitizeRetentionMessages(messages: readonly HindsightMessage[]): HindsightMessage[] {
	const sanitized: HindsightMessage[] = [];
	for (const message of messages) {
		const content = stripMemoryTags(message.content).trim();
		if (!hasSubstantiveContent(content)) continue;
		sanitized.push({ ...message, content });
	}
	return sanitized;
}

/**
 * Split `messages` into {@link RetentionChunk}s whose framed transcript
 * (`prepareRetentionTranscript(chunk.messages, true).transcript`) never exceeds `maxChars`.
 *
 * Turns (a `user` message through the messages preceding the next `user` message) are kept
 * together whenever they fit; a turn too large for its own frames is merged into one block,
 * and a turn too large even merged is packed message-by-message, splitting any individually
 * oversized message at Unicode-code-point-safe boundaries. Content is never truncated or
 * dropped — only re-chunked — and `completedUserTurns` only advances past a turn once every
 * message (and, for a split message, every piece) belonging to it has been emitted.
 *
 * Throws when `maxChars` cannot hold even one framed code point for some message's role.
 */
export function chunkRetentionMessages(messages: HindsightMessage[], maxChars: number): RetentionChunk[] {
	if (messages.length === 0) return [];
	const segments = segmentRetentionTurns(messages);
	const chunks: RetentionChunk[] = [];
	let cumulativeCompleted = 0;
	for (const segment of segments) {
		const atoms: RetentionAtom[] = [];
		for (let index = segment.startIndex; index < segment.endIndex; index++) {
			const message = messages[index];
			if (message !== undefined) atoms.push({ messageIndex: index, role: message.role, content: message.content });
		}
		const pieces = packRetentionAtoms(atoms, maxChars);
		const lastPieceIndex = pieces.length - 1;
		pieces.forEach((piece, pieceIndex) => {
			const isFinalPiece = pieceIndex === lastPieceIndex;
			const completedUserTurns = isFinalPiece && segment.turnNumber > 0 ? segment.turnNumber : cumulativeCompleted;
			chunks.push({
				messages: piece.messages,
				ranges: piece.ranges,
				completedUserTurns,
				turnNumber: segment.turnNumber,
				pieceIndex,
			});
		});
		if (segment.turnNumber > 0) cumulativeCompleted = segment.turnNumber;
	}
	return chunks;
}

/**
 * Invert {@link chunkRetentionMessages}: reassemble the original `HindsightMessage[]` (role,
 * content, and order all exactly preserved) from its chunks' `ranges`, regardless of whether a
 * given chunk stored its pieces as separate own-role messages or merged under one `"turn"`
 * block.
 */
export function reconstructRetentionChunks(
	// Only the framed text and its ranges are read. Narrowed deliberately: reconstruction also runs
	// over chunks rebuilt from STORED rows, where a chunk's turn locator is not persisted and cannot
	// be supplied honestly.
	chunks: readonly Pick<RetentionChunk, "messages" | "ranges">[],
): HindsightMessage[] {
	const contentPartsByIndex = new Map<number, string[]>();
	const roleByIndex = new Map<number, string>();
	for (const chunk of chunks) {
		const joined = chunk.messages.map(message => message.content).join(RETENTION_CHUNK_SEPARATOR);
		let cursor = 0;
		for (const range of chunk.ranges) {
			const length = range.end - range.start;
			const piece = joined.slice(cursor, cursor + length);
			cursor += length + RETENTION_CHUNK_SEPARATOR.length;
			const parts = contentPartsByIndex.get(range.messageIndex) ?? [];
			parts.push(piece);
			contentPartsByIndex.set(range.messageIndex, parts);
			roleByIndex.set(range.messageIndex, range.role);
		}
	}
	return [...roleByIndex.entries()]
		.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
		.map(([messageIndex, role]) => ({
			role,
			content: (contentPartsByIndex.get(messageIndex) ?? []).join(""),
		}));
}
