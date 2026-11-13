/**
 * Inherited parent context for task subagents (a task item's `inheritContext: true`, offered
 * while `task.inheritContext` is on).
 *
 * The parent's most recent conversation tail rides into the child's initial context. The child
 * persists it as text, as an agent-authored user turn (background, never developer authority).
 * On each request to a vision model, {@link InheritedContextFrames} swaps the tail for at most
 * two snapcompact frames and, for readers it helps, adds a text sidecar of the exact identifiers
 * (hashes, paths, flags, numbers) in the part those frames hold: frame readers recover gist well
 * but misread long hashes and paths, so the sidecar carries those verbatim. A text reader has
 * them verbatim in the tail already, so the text turn carries no sidecar.
 * Like other snapcompact frames, these are built per request and never reach session.jsonl, so
 * a text-only model, blocked images, or a model switch get the text instead.
 *
 * Secrets: the parent cuts the tail on secret-encoded text, so a secret at the cut is dropped
 * whole rather than split, then decodes the kept tail ({@link buildInheritedContext}). The child
 * stores raw text, as it stores its raw brief, and its own provider boundary encodes it with
 * placeholders the child can decode; frames are drawn after that encoding.
 */
import type { Context, ImageContent, Message, Model, TextContent, UserMessage } from "@oh-my-pi/pi-ai";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import inheritedContextTemplate from "../prompts/system/subagent-inherited-context.md" with { type: "text" };
import { obfuscateMessages } from "../secrets/message-transform";
import { INHERITED_CONTEXT_MESSAGE_TYPE } from "../session/messages";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { PLACEHOLDER_RE } from "../secrets/placeholder";

/** Tail size measured in the inheritance experiment: two frames of the 1568px dense shape. */
export const INHERITED_CONTEXT_CHARS = 27_832;
/** Frames kept from the end of the rendered tail. */
export const INHERITED_CONTEXT_MAX_FRAMES = 2;
/**
 * Sidecar budget in chars, one line per identifier: 15% of a full tail (~190 identifiers), the
 * sidecar measured to cut Claude's exact-string errors from 5.9% to 2.7%. Fixed rather than a
 * share of each text, so a short tail still lists every identifier it has.
 */
export const INHERITED_CONTEXT_IDENTIFIER_CHARS = Math.floor(INHERITED_CONTEXT_CHARS * 0.15);
/** Longer tokens are skipped: one would otherwise spend the whole budget and end the list. */
const IDENTIFIER_MAX_CHARS = 240;
/** A tail cut mid-line advances to the next line start when one is this close. */
const LINE_SNAP_CHARS = 400;

/** Parent tail: plain data, safe to structured-clone into a worker. */
export interface InheritedContext {
	text: string;
}

const FILE_EXTENSIONS =
	"ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|mdx|py|rs|go|toml|yaml|yml|sh|bash|zsh|txt|png|jpg|jpeg|gif|svg|html|css|lock|xlsx|xlsm|xls|csv|tsv|pdf|sql|c|h|cc|cpp|hpp|swift|kt|java|rb|zig|wasm|log|env|ini|cfg|conf|xml|db|sqlite|plist|docx|pptx|zip|tar|gz";
const LINE_REF = "(?::\\d+(?:-\\d+)?)?";
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"]+$/;
const VALUE_LIKE = /[\d/._=:~$@]/;
const IDENTIFIER_RE = {
	url: /\bhttps?:\/\/[^\s<>"'`]+/g,
	backtick: /`([^`\n]{1,120})`/g,
	path: new RegExp(
		`(?<![\\w@~./:$\\\\-])(?:(?:~|\\.{1,2})?(?:\\/[\\w@.+$-]+)+\\/?|[\\w@.+$-]+(?:\\/[\\w@.+$-]+)+\\/?)${LINE_REF}`,
		"g",
	),
	file: new RegExp(`(?<![\\w@~./-])[\\w@+-][\\w@.+-]*\\.(?:${FILE_EXTENSIONS})${LINE_REF}(?![\\w])`, "g"),
	longFlag: /(?<![\w-])--[A-Za-z][\w-]*(?:=([^\s'"`<>]+)|[ \t]+([^\s'"`<>-][^\s'"`<>]*))?/g,
	shortFlag: /(?<![\w-])-[A-Za-z]([^\s'"`<>]*)(?:[ \t]+([^\s'"`<>-][^\s'"`<>]*))?/g,
	version: /(?<![\w.])(?:v?\d+\.\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]*[0-9A-Za-z])?|v\d+(?:\.\d+)+)(?![\w])/g,
	number: /(?<![\w.])\d+(?:[.,:/-]\d+)*(?!\d)/g,
	hex: /(?<![0-9A-Za-z])[0-9a-fA-F]{7,}(?![0-9A-Za-z])/g,
	dotted: /(?<![\w$.:\\])[A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)+/g,
	underscore: /(?<![\w$\\])[\w$]*_[\w$]*(?![\w$])/g,
	camel: /(?<![\w$\\])[A-Za-z][A-Za-z0-9]{7,}(?![\w$])/g,
	// Secret placeholders (`$$NAME_HASH:CASE$$`): drawn into frames once the child's boundary
	// encodes, and only an exact copy decodes.
	placeholder: new RegExp(PLACEHOLDER_RE.source, "g"),
};

const trimTrailing = (token: string) => token.replace(TRAILING_PUNCTUATION, "");

/** Every identifier occurrence in `text` with the offset its match ends at. */
function identifierHits(text: string): { token: string; end: number }[] {
	const hits: { token: string; end: number }[] = [];
	const push = (token: string, match: RegExpMatchArray) => {
		if (token) hits.push({ token, end: match.index! + match[0].length });
	};
	const re = IDENTIFIER_RE;
	for (const m of text.matchAll(re.url)) push(trimTrailing(m[0]), m);
	for (const m of text.matchAll(re.backtick)) push(m[1]!.trim(), m);
	for (const m of text.matchAll(re.path)) {
		const token = trimTrailing(m[0]);
		// Fractions such as 2/3.
		if (!/^[\d/]+$/.test(token)) push(token, m);
	}
	for (const m of text.matchAll(re.file)) push(m[0], m);
	for (const m of text.matchAll(re.longFlag)) {
		const flag = m[0].match(/^--[A-Za-z][\w-]*/)![0];
		if (m[1] !== undefined) {
			push(`${flag}=${trimTrailing(m[1])}`.replace(/=$/, ""), m);
		} else {
			const value = m[2] !== undefined ? trimTrailing(m[2]) : "";
			push(value && VALUE_LIKE.test(value) ? `${flag} ${value}` : trimTrailing(flag), m);
		}
	}
	for (const m of text.matchAll(re.shortFlag)) {
		// A short flag alone (`-v`, or prose such as "-based") is noise; listed only with a value.
		const flag = m[0].slice(0, 2);
		const attached = trimTrailing(m[1] ?? "");
		const value = m[2] !== undefined ? trimTrailing(m[2]) : "";
		const valueLike = value !== "" && VALUE_LIKE.test(value);
		if (attached && (VALUE_LIKE.test(attached) || attached.startsWith("="))) {
			push(`${flag}${attached}${valueLike ? ` ${value}` : ""}`, m);
		} else if (!attached && valueLike) {
			push(`${flag} ${value}`, m);
		}
	}
	for (const m of text.matchAll(re.version)) push(m[0], m);
	for (const m of text.matchAll(re.number)) {
		// Counts, sizes, ports, scores: four digits or a decimal.
		if (m[0].replace(/\D/g, "").length >= 4 || /\d\.\d/.test(m[0])) push(m[0], m);
	}
	// A letters-only run is a word.
	for (const m of text.matchAll(re.hex)) if (/\d/.test(m[0])) push(m[0], m);
	for (const m of text.matchAll(re.dotted)) if (m[0].length >= 4) push(m[0], m);
	for (const m of text.matchAll(re.underscore)) if (m[0].length >= 3 && /[A-Za-z]/.test(m[0])) push(m[0], m);
	for (const m of text.matchAll(re.camel)) if (/[a-z][A-Z]/.test(m[0])) push(m[0], m);
	for (const m of text.matchAll(re.placeholder)) push(m[0], m);
	return hits;
}

/**
 * Exact identifiers in `text` (URLs, backtick spans, paths and `file:line` refs, flags with values,
 * versions, numbers, hex runs, dotted, `::`, underscore and camelCase names, secret placeholders),
 * in order of last mention. Walks back from the most recent, skips a token contained in a more
 * recent kept one (a hash inside its path), and stops at the first that would pass `budget` chars
 * (one line per token), so the list is the latest run of the conversation's identifiers.
 */
export function extractIdentifiers(text: string, budget: number = INHERITED_CONTEXT_IDENTIFIER_CHARS): string[] {
	const lastEnd = new Map<string, number>();
	for (const { token, end } of identifierHits(text)) {
		if (token.length <= IDENTIFIER_MAX_CHARS && (lastEnd.get(token) ?? -1) < end) lastEnd.set(token, end);
	}
	// Ascending by last mention; at one end offset the shorter first, so the walk back meets the longer first.
	const ordered = [...lastEnd].sort(
		([a, aEnd], [b, bEnd]) => aEnd - bEnd || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
	);
	const kept: string[] = [];
	let chars = 0;
	for (let index = ordered.length - 1; index >= 0; index--) {
		const token = ordered[index]![0];
		if (kept.some(recent => recent.includes(token))) continue;
		if (chars + token.length + 1 > budget) break;
		kept.push(token);
		chars += token.length + 1;
	}
	return kept.reverse();
}

/** The last `chars` of `text`, advanced to a line start when the cut lands mid-line. */
function tailText(text: string, chars: number): string {
	if (text.length <= chars) return text;
	const start = text.length - chars;
	const lineStart = text.indexOf("\n", start);
	return lineStart !== -1 && lineStart - start < LINE_SNAP_CHARS ? text.slice(lineStart + 1) : text.slice(start);
}

/** Most re-cuts while making a decoded tail re-encode on its own; past this, nothing is inherited. */
const SECRET_RECUT_ATTEMPTS = 8;

/**
 * Decode an encoded tail into text whose secrets a fresh pass of the same rules encodes again,
 * as the child's boundary will. A rule that needs context (a `Bearer ` lookbehind) can lose it at
 * the cut; the re-cut then moves past the placeholder where the fresh pass first disagrees.
 * `undefined` when no re-cut converges (fail closed).
 */
function decodeForChild(encodedTail: string, secrets: SecretObfuscator): string | undefined {
	let tail = encodedTail;
	for (let attempt = 0; attempt < SECRET_RECUT_ATTEMPTS && tail; attempt++) {
		const text = secrets.deobfuscate(tail);
		const recheck = secrets.obfuscate(text);
		if (recheck === tail) return text;
		let at = 0;
		while (at < tail.length && tail[at] === recheck[at]) at++;
		const close = tail.indexOf("$$", tail.startsWith("$$", at) ? at + 2 : at);
		if (close === -1) return undefined;
		tail = tail.slice(close + 2);
	}
	return undefined;
}

/**
 * Serialize the parent's live context (thinking excluded) and keep its tail.
 * With `secrets`, the messages are encoded block by block before serialization, as the provider
 * boundary encodes them, so the serializer's truncation and JSON escaping never see a raw secret;
 * the tail is cut on that encoded text (a secret at the cut is dropped whole, never split) and
 * decoded afterwards ({@link decodeForChild}), for the child's own provider boundary to encode with
 * placeholders it can decode. `undefined` when the parent has no conversation text yet, or when the
 * decoded tail would not re-encode (fail closed).
 */
export function buildInheritedContext(
	messages: readonly Message[],
	secrets: SecretObfuscator | undefined,
): InheritedContext | undefined {
	const source = secrets ? obfuscateMessages(secrets, [...messages]) : [...messages];
	// The whole conversation, not a slice: a pre-encode slice would cut a secret (or the context its
	// rule needs) at its start. Plain tool output: dim markers mean something only to the rasterizer,
	// and the text turn sends them as-is.
	const serialized = snapcompact.serializeConversation(source, { includeThinking: false, dimToolResults: false });
	// A second pass for rules that span blocks the per-block pass saw apart.
	const encoded = (secrets ? secrets.obfuscate(serialized) : serialized).trim();
	if (!encoded) return undefined;
	const tail = tailText(encoded, INHERITED_CONTEXT_CHARS);
	const text = secrets ? decodeForChild(tail, secrets) : tail;
	if (!text?.trim()) {
		logger.warn("task: inherited context dropped; its secrets would not re-encode at any tail cut");
		return undefined;
	}
	return { text };
}

/**
 * The tail under the parent's own placeholders, for a child whose secret rules can differ from the
 * parent's: an isolated worktree lacks the project's untracked `.omp/secrets.yml`, so its boundary
 * would send those secrets raw. Exact, because {@link decodeForChild} only returns text that
 * re-encodes to the cut it came from. The child cannot decode these placeholders.
 */
export function encodedInheritedContext(
	context: InheritedContext,
	secrets: SecretObfuscator | undefined,
): InheritedContext {
	return secrets ? { text: secrets.obfuscate(context.text) } : context;
}

function renderPreamble(frames: number, identifiers: readonly string[]): string {
	return prompt.render(inheritedContextTemplate, { frames, identifiers });
}

export interface InheritedContextMessage {
	customType: typeof INHERITED_CONTEXT_MESSAGE_TYPE;
	content: TextContent[];
	display: false;
	details: { chars: number };
	attribution: "user";
}

/** The child's persisted inherited-context record: preamble, then the tail as text. */
export function inheritedContextMessage(context: InheritedContext): InheritedContextMessage {
	return {
		customType: INHERITED_CONTEXT_MESSAGE_TYPE,
		display: false,
		// This build sends the record as an agent-attributed user turn whatever this says. A build that
		// predates the type replays it as a developer message, and its secret boundary encodes a
		// developer message only when user-attributed: the tail is stored decoded.
		attribution: "user",
		content: [
			{ type: "text", text: renderPreamble(0, []) },
			{ type: "text", text: context.text },
		],
		details: { chars: context.text.length },
	};
}

/** The `snapcompact.shape` setting: a named frame shape, or `auto` to resolve one per model. */
export type ShapeSetting = snapcompact.ShapeVariantName | "auto";

/** The cut of the tail that fits, its frame count, and the shape it was fitted to. */
interface FittedTail extends snapcompact.TailShape {
	text: string;
	frames: number;
}

/** Most re-cuts while fitting the tail into {@link INHERITED_CONTEXT_MAX_FRAMES} frames. */
const FIT_ATTEMPTS = 6;

/**
 * The latest part of `text` that fits {@link INHERITED_CONTEXT_MAX_FRAMES} frames of the tail shape
 * `model` resolves for it ({@link snapcompact.resolveTailShapeForText}: an explicit `snapcompact.shape`
 * wins), or `undefined` when no cut fits. Shapes differ in capacity (provider geometry, the CJK
 * grid), so the cut follows the shape instead of keeping the last frames of an overflowing render,
 * which would drop text the sidecar still lists.
 */
function fitTail(text: string, model: Model, setting: ShapeSetting): FittedTail | undefined {
	let fitted = text;
	for (let attempt = 0; attempt < FIT_ATTEMPTS && fitted; attempt++) {
		const tail = snapcompact.resolveTailShapeForText(fitted, model, setting);
		const frames = snapcompact.frames(fitted, { shape: tail.shape });
		if (frames <= INHERITED_CONTEXT_MAX_FRAMES) return { text: fitted, frames, ...tail };
		// Proportional cut with a margin: line snapping and wrapping make capacity uneven.
		fitted = tailText(fitted, Math.floor(((fitted.length * INHERITED_CONTEXT_MAX_FRAMES) / frames) * 0.95));
	}
	return undefined;
}

function imageCount(messages: readonly Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) if (block.type === "image") count++;
	}
	return count;
}

function isInheritedContextTurn(message: Message): message is UserMessage & { content: TextContent[] } {
	return (
		message.role === "user" &&
		message.inheritedContext === true &&
		Array.isArray(message.content) &&
		message.content.length === 2 &&
		message.content.every(block => block.type === "text")
	);
}

/**
 * Per-request provider transform: renders the inherited tail of an agent-authored
 * inherited-context turn as frames for a vision model. Runs after secret obfuscation, so frames
 * only ever draw encoded text, and before snapcompact's inline transform, whose planner then
 * counts these frames and whose system-prompt frames land in front of this turn. Keeps the text
 * turn when the frames would push the request past the provider image count budget, and
 * {@link restoreEvictedFrames} puts it back when a later clamp (the inline-image byte budget,
 * which evicts oldest first) drops any frame; a switch between frames and text rewrites the first
 * turn, which costs one prompt-cache miss. Holds the last render, so a session re-sends
 * identical bytes (prompt caches stay warm) without re-rasterizing.
 */
export class InheritedContextFrames {
	/** The latest fit and its render (`null` once it failed), so a failure is not redone or logged per request. */
	#last?: { key: string; fit: FittedTail | undefined; content?: (TextContent | ImageContent)[] | null };

	/** `context` itself when the turn stays text. */
	async transform(
		context: Context,
		model: Model,
		blockImages: boolean,
		shape: ShapeSetting = "auto",
	): Promise<Context> {
		if (blockImages || !sendsImageInputOnWire(model)) return context;
		const index = context.messages.findIndex(isInheritedContextTurn);
		if (index === -1) return context;
		const message = context.messages[index] as UserMessage & { content: TextContent[] };
		const room = snapcompact.providerImageBudget(model) - imageCount(context.messages);
		const content = await this.#render(message.content[1]!.text, model, shape, room);
		if (!content) return context;
		const messages = context.messages.slice();
		messages[index] = { ...message, content };
		return { ...context, messages };
	}

	async #render(
		tail: string,
		model: Model,
		shape: ShapeSetting,
		room: number,
	): Promise<(TextContent | ImageContent)[] | undefined> {
		// The fit depends only on the tail, the shape setting, and the model; reuse it before re-wrapping ~28k chars.
		const key = `${model.provider}\0${model.id}\0${shape}\0${tail}`;
		if (this.#last?.key !== key) this.#last = { key, fit: fitTail(tail, model, shape) };
		const last = this.#last;
		const { fit } = last;
		if (!fit || fit.frames > room) return undefined;
		if (last.content !== undefined) return last.content ?? undefined;
		let frames: ImageContent[];
		try {
			frames = await snapcompact.renderMany(fit.text, { shape: fit.shape, maxFrames: INHERITED_CONTEXT_MAX_FRAMES });
		} catch (error) {
			// Background, not the assignment: a render failure leaves the text turn in place.
			logger.warn("task: inherited context frames failed to render; sending text", {
				error: error instanceof Error ? error.message : String(error),
			});
			last.content = null;
			return undefined;
		}
		last.content =
			frames.length === 0
				? null
				: [
						{
							type: "text",
							text: renderPreamble(frames.length, fit.identifierList ? extractIdentifiers(fit.text) : []),
						} satisfies TextContent,
						...frames,
					];
		return last.content ?? undefined;
	}
}

/**
 * After the provider's image clamps: when they dropped any frame {@link InheritedContextFrames}
 * swapped into `framed` (its result for `unframed`), send the text tail instead, so the child
 * keeps the tail rather than a preamble without it. Only this turn's own part counts and is
 * replaced: inline snapcompact prepends its system-prompt note and frames to the first user turn,
 * which is this one unless the child's autoloaded skills come first, and those stay whichever images
 * a clamp evicts. Stateless, so
 * overlapping requests on one transform (side requests, compaction) cannot mix up each other's turns.
 */
export function restoreEvictedFrames(context: Context, unframed: Context, framed: Context): Context {
	if (framed === unframed) return context;
	const textTurn = unframed.messages.find(isInheritedContextTurn);
	const framedTurn = framed.messages.find(message => message.role === "user" && message.inheritedContext === true);
	const index = context.messages.findIndex(message => message.role === "user" && message.inheritedContext === true);
	if (!textTurn || !framedTurn || index === -1 || !Array.isArray(framedTurn.content)) return context;
	const preamble = framedTurn.content[0];
	const sent = context.messages[index] as UserMessage;
	const content = typeof sent.content === "string" ? [{ type: "text" as const, text: sent.content }] : sent.content;
	const own = content.findIndex(
		block => block.type === "text" && preamble?.type === "text" && block.text === preamble.text,
	);
	// Without its preamble the turn was rewritten past recognition; the whole text turn is the safe send.
	const prefix = own === -1 ? [] : content.slice(0, own);
	const sentFrames = imageCount([{ ...sent, content: own === -1 ? content : content.slice(own) }]);
	if (sentFrames >= imageCount([framedTurn])) return context;
	logger.debug("task: inherited context frames evicted by the image byte budget; sending text");
	const messages = context.messages.slice();
	messages[index] = prefix.length === 0 ? textTurn : { ...textTurn, content: [...prefix, ...textTurn.content] };
	return { ...context, messages };
}
