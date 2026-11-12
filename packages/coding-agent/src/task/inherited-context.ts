/**
 * Inherited parent context for task subagents (a task item's `inheritContext: true`, offered
 * while `task.inheritContext` is on).
 *
 * The parent's most recent conversation tail rides into the child's initial context with a
 * text sidecar of the exact identifiers (hashes, paths, flags, numbers) found in it. The child
 * persists both as text, as an agent-authored user turn (background, never developer authority).
 * On each request to a vision model, {@link InheritedContextFrames} swaps the tail for at most
 * two snapcompact frames and lists the identifiers of the part those frames hold: frame readers
 * recover gist well but misread long hashes and paths, so the sidecar carries those verbatim.
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
import { PLACEHOLDER_RE } from "../secrets/placeholder";

/** Tail size measured in the inheritance experiment: two frames of the 1568px dense shape. */
export const INHERITED_CONTEXT_CHARS = 27_832;
/** Frames kept from the end of the rendered tail. */
export const INHERITED_CONTEXT_MAX_FRAMES = 2;
/** Most recent distinct identifiers listed in the sidecar. */
export const INHERITED_CONTEXT_MAX_IDENTIFIERS = 120;
const IDENTIFIER_MAX_CHARS = 240;
/** A tail cut mid-line advances to the next line start when one is this close. */
const LINE_SNAP_CHARS = 400;

/** The session's secret encoder, as {@link buildInheritedContext} uses it. */
export interface InheritedContextSecrets {
	obfuscate(text: string): string;
	deobfuscate(text: string): string;
}

/** Parent tail and its identifiers: plain data, safe to structured-clone into a worker. */
export interface InheritedContext {
	text: string;
	identifiers: string[];
}

const IDENTIFIER_PATTERNS: readonly RegExp[] = [
	// URLs.
	/\bhttps?:\/\/[^\s"'`<>()[\]{}]+/g,
	// Paths with at least one separator, optionally ~ / ./ ../ rooted, with an optional :line(-line) suffix.
	/(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)+\/?(?::\d+(?:-\d+)?)?/g,
	// Bare file names with an extension, optionally with :line(-line).
	/\b[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5}(?::\d+(?:-\d+)?)?\b/g,
	// Hex digests and commit ids (checked below for mixed letters/digits).
	/\b[0-9a-fA-F]{7,128}\b/g,
	// Long CLI flags, with an inline value when present.
	/(?<![\w-])--[A-Za-z][\w-]*(?:=[^\s"'`]+)?/g,
	// Numbers with at least four digits, or decimals: counts, sizes, ports, scores.
	/(?<![\w.])\d[\d,_]*(?:\.\d+)?(?![\w.]*\w)/g,
	// Secret placeholders (`$$NAME_HASH:CASE$$`): drawn into frames once the child's boundary encodes,
	// and only an exact copy decodes.
	new RegExp(PLACEHOLDER_RE.source, "g"),
];

function isIdentifier(token: string, patternIndex: number): boolean {
	if (token.length > IDENTIFIER_MAX_CHARS) return false;
	switch (patternIndex) {
		case 1:
			// Prose writes "jobs/services" and "status/output"; an unrooted path needs three
			// segments or a character words lack (digit, dot, dash, underscore, @, +).
			return /^[~./]/.test(token) || token.split("/").filter(Boolean).length >= 3 || /[\d._@+-]/.test(token);
		case 3:
			// A hex run needs both a digit and a letter; pure digits are numbers, pure letters words.
			return /\d/.test(token) && /[a-fA-F]/.test(token);
		case 5: {
			const digits = token.replace(/\D/g, "").length;
			return token.includes(".") ? digits >= 3 : digits >= 4;
		}
		default:
			return true;
	}
}

/**
 * Exact identifiers in `text`, most recent {@link INHERITED_CONTEXT_MAX_IDENTIFIERS} kept, in order
 * of last appearance. A token contained in a longer kept token (a hash inside a path) is dropped.
 */
export function extractIdentifiers(text: string, limit: number = INHERITED_CONTEXT_MAX_IDENTIFIERS): string[] {
	const lastSeen = new Map<string, number>();
	IDENTIFIER_PATTERNS.forEach((pattern, index) => {
		for (const match of text.matchAll(pattern)) {
			const token = match[0].replace(/[.,:;]+$/, "");
			if (!token || !isIdentifier(token, index)) continue;
			const end = (match.index ?? 0) + token.length;
			if ((lastSeen.get(token) ?? -1) < end) lastSeen.set(token, end);
		}
	});
	const byLength = [...lastSeen.keys()].sort((a, b) => b.length - a.length);
	const kept: string[] = [];
	for (const token of byLength) {
		if (!kept.some(longer => longer.includes(token))) kept.push(token);
	}
	return kept.sort((a, b) => lastSeen.get(a)! - lastSeen.get(b)!).slice(-limit);
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
function decodeForChild(encodedTail: string, secrets: InheritedContextSecrets): string | undefined {
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
 * Serialize the parent's live context (thinking excluded) and keep the tail and its identifiers.
 * With `secrets`, the tail is cut on encoded text (a secret at the cut is dropped whole, never
 * split) and decoded afterwards ({@link decodeForChild}), for the child's own provider boundary to
 * encode with placeholders it can decode. `undefined` when the parent has no conversation text yet.
 */
export function buildInheritedContext(
	messages: readonly Message[],
	secrets: InheritedContextSecrets | undefined,
): InheritedContext | undefined {
	// Encode the whole conversation, as the provider boundary does: a pre-encode slice would cut a
	// secret (or the context its rule needs) at its start, and redaction can shrink the slice until
	// that raw fragment lands inside the tail.
	// Plain tool output: dim markers mean something only to the rasterizer, and the text turn sends them as-is.
	const raw = snapcompact.serializeConversation([...messages], { includeThinking: false, dimToolResults: false });
	const encoded = (secrets ? secrets.obfuscate(raw) : raw).trim();
	if (!encoded) return undefined;
	const tail = tailText(encoded, INHERITED_CONTEXT_CHARS);
	const text = secrets ? decodeForChild(tail, secrets) : tail;
	if (!text?.trim()) return undefined;
	// Identifiers come from the encoded text with its placeholders blanked: a pattern can match part of a
	// secret (a UUID's hex runs) that no whole-value rule would encode again in the persisted sidecar.
	const identifiers = extractIdentifiers(secrets ? secrets.obfuscate(text).replace(PLACEHOLDER_RE, " ") : text);
	return { text, identifiers };
}

/**
 * The tail under the parent's own placeholders, for a child whose secret rules can differ from the
 * parent's: an isolated worktree lacks the project's untracked `.omp/secrets.yml`, so its boundary
 * would send those secrets raw. Exact, because {@link decodeForChild} only returns text that
 * re-encodes to the cut it came from. The child cannot decode these placeholders.
 */
export function encodedInheritedContext(
	context: InheritedContext,
	secrets: InheritedContextSecrets | undefined,
): InheritedContext {
	if (!secrets) return context;
	const text = secrets.obfuscate(context.text);
	return { text, identifiers: extractIdentifiers(text) };
}

function renderPreamble(frames: number, identifiers: readonly string[]): string {
	return prompt.render(inheritedContextTemplate, { frames, identifiers });
}

export interface InheritedContextMessage {
	content: TextContent[];
	details: { chars: number; identifiers: number };
}

/** The child's persisted inherited-context turn: preamble with sidecar, then the tail as text. */
export function inheritedContextMessage(context: InheritedContext): InheritedContextMessage {
	return {
		content: [
			{ type: "text", text: renderPreamble(0, context.identifiers) },
			{ type: "text", text: context.text },
		],
		details: { chars: context.text.length, identifiers: context.identifiers.length },
	};
}

/** Most re-cuts while fitting the tail into {@link INHERITED_CONTEXT_MAX_FRAMES} frames. */
const FIT_ATTEMPTS = 6;

/**
 * The latest part of `text` that fits {@link INHERITED_CONTEXT_MAX_FRAMES} frames of the shape
 * `model` resolves for it, or `undefined` when no cut fits. Shapes differ in capacity (provider
 * geometry, the CJK grid), so the cut follows the shape instead of keeping the last frames of an
 * overflowing render, which would drop text the sidecar still lists.
 */
function fitTail(text: string, model: Model): { text: string; shape: snapcompact.Shape; frames: number } | undefined {
	let fitted = text;
	for (let attempt = 0; attempt < FIT_ATTEMPTS && fitted; attempt++) {
		const shape = snapcompact.resolveShapeForText(fitted, model);
		const frames = snapcompact.frames(fitted, { shape });
		if (frames <= INHERITED_CONTEXT_MAX_FRAMES) return { text: fitted, shape, frames };
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
 * {@link restoreEvicted} puts it back when a later clamp (the inline-image byte budget, which
 * evicts oldest first) drops any frame; a switch between frames and text rewrites the first
 * turn, which costs one prompt-cache miss. Holds the last render, so a session re-sends
 * identical bytes (prompt caches stay warm) without re-rasterizing. One instance per
 * conversation: it remembers the turn it swapped in the request it is transforming.
 */
export class InheritedContextFrames {
	#last?: { key: string; content: (TextContent | ImageContent)[] };
	#swapped?: { text: UserMessage; frames: number };

	async transform(context: Context, model: Model, blockImages: boolean): Promise<Context> {
		this.#swapped = undefined;
		if (blockImages || !sendsImageInputOnWire(model)) return context;
		const index = context.messages.findIndex(isInheritedContextTurn);
		if (index === -1) return context;
		const message = context.messages[index] as UserMessage & { content: TextContent[] };
		const room = snapcompact.providerImageBudget(model) - imageCount(context.messages);
		const content = await this.#render(message.content[1]!.text, model, room);
		if (!content) return context;
		this.#swapped = { text: message, frames: content.length - 1 };
		const messages = context.messages.slice();
		messages[index] = { ...message, content };
		return { ...context, messages };
	}

	/**
	 * After the provider's image clamps: when they dropped any of the frames {@link transform} swapped
	 * in, send the text turn instead, so the child keeps the tail rather than a preamble without it.
	 */
	restoreEvicted(context: Context): Context {
		const swapped = this.#swapped;
		this.#swapped = undefined;
		if (!swapped) return context;
		const index = context.messages.findIndex(message => message.role === "user" && message.inheritedContext === true);
		if (index === -1) return context;
		const content = context.messages[index]!.content;
		const frames = Array.isArray(content) ? content.filter(block => block.type === "image").length : 0;
		if (frames >= swapped.frames) return context;
		logger.debug("task: inherited context frames evicted by the image byte budget; sending text");
		const messages = context.messages.slice();
		messages[index] = swapped.text;
		return { ...context, messages };
	}

	async #render(tail: string, model: Model, room: number): Promise<(TextContent | ImageContent)[] | undefined> {
		// The fit depends only on the tail and the model's shape inputs; reuse it before re-wrapping ~28k chars.
		const key = `${model.provider}\0${model.id}\0${tail}`;
		if (this.#last?.key === key) return this.#last.content.length - 1 > room ? undefined : this.#last.content;
		const fit = fitTail(tail, model);
		if (!fit || fit.frames > room) return undefined;
		let frames: ImageContent[];
		try {
			frames = await snapcompact.renderMany(fit.text, { shape: fit.shape, maxFrames: INHERITED_CONTEXT_MAX_FRAMES });
		} catch (error) {
			// Background, not the assignment: a render failure leaves the text turn in place.
			logger.warn("task: inherited context frames failed to render; sending text", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (frames.length === 0) return undefined;
		const content = [
			{ type: "text", text: renderPreamble(frames.length, extractIdentifiers(fit.text)) } satisfies TextContent,
			...frames,
		];
		this.#last = { key, content };
		return content;
	}
}
