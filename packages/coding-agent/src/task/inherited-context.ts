/**
 * Inherited parent context for task subagents (a task item's `inheritContext: true`, offered
 * while `task.inheritContext` is on).
 *
 * The parent's most recent conversation tail rides into the child's initial context as
 * snapcompact frames, with a text sidecar of the exact identifiers (hashes, paths, flags,
 * numbers) found in that tail: frame readers recover gist well but misread long hashes and
 * paths, so the sidecar carries those verbatim. A child model without image input gets the
 * tail as plain text instead.
 *
 * Secrets are encoded before anything is cut, listed, or drawn: the provider boundary only
 * rewrites text blocks, so a secret rendered into a frame would otherwise leave as pixels.
 *
 * The parent prepares the tail ({@link buildInheritedContext}, plain data that crosses into a
 * worker); the child renders frames for its own model ({@link inheritedContextMessage}).
 */
import type { ImageContent, Message, Model, TextContent } from "@oh-my-pi/pi-ai";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import inheritedContextTemplate from "../prompts/system/subagent-inherited-context.md" with { type: "text" };

export const INHERITED_CONTEXT_MESSAGE_TYPE = "task-inherited-context";

/** Tail size measured in the inheritance experiment: two frames of the 1568px dense shape. */
export const INHERITED_CONTEXT_CHARS = 27_832;
/** Frames kept from the end of the rendered tail. */
export const INHERITED_CONTEXT_MAX_FRAMES = 2;
/** Most recent distinct identifiers listed in the sidecar. */
export const INHERITED_CONTEXT_MAX_IDENTIFIERS = 120;
const IDENTIFIER_MAX_CHARS = 240;
/** A tail cut mid-line advances to the next line start when one is this close. */
const LINE_SNAP_CHARS = 400;
/**
 * Raw text kept around the tail before secrets are encoded. Encoding a slice can miss a secret
 * (or the context its rule needs) cut at the slice start; the slack puts that cut far before the
 * final tail, so the final cut drops it.
 */
const ENCODE_WINDOW_CHARS = 2 * INHERITED_CONTEXT_CHARS;

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

/** Raw serialized window per context array, so a batch of spawns serializes once. */
const rawWindows = new WeakMap<readonly Message[], string>();

/**
 * Serialize the parent's live context (thinking excluded), encode its secrets with `obfuscate`,
 * and keep the tail and its identifiers. Encoding runs per call, so a redaction toggle between
 * spawns takes effect. `undefined` when the parent has no conversation text yet.
 */
export function buildInheritedContext(
	messages: readonly Message[],
	obfuscate: ((text: string) => string) | undefined,
): InheritedContext | undefined {
	let raw = rawWindows.get(messages);
	if (raw === undefined) {
		raw = snapcompact.serializeConversation([...messages], { includeThinking: false }).slice(-ENCODE_WINDOW_CHARS);
		rawWindows.set(messages, raw);
	}
	const encoded = (obfuscate ? obfuscate(raw) : raw).trim();
	if (!encoded) return undefined;
	const text = tailText(encoded, INHERITED_CONTEXT_CHARS);
	return { text, identifiers: extractIdentifiers(text) };
}

export interface InheritedContextMessage {
	content: (TextContent | ImageContent)[];
	details: { frames: number; chars: number; identifiers: number };
}

/** The child's hidden context message: preamble and sidecar, then the frames (or the tail as text). */
export async function inheritedContextMessage(
	context: InheritedContext,
	model: Model | undefined,
): Promise<InheritedContextMessage> {
	let frames: ImageContent[] = [];
	if (model && sendsImageInputOnWire(model)) {
		try {
			const shape = snapcompact.resolveShapeForText(context.text, model);
			frames = (await snapcompact.renderMany(context.text, { shape })).slice(-INHERITED_CONTEXT_MAX_FRAMES);
		} catch (error) {
			// Background, not the assignment: a render failure degrades to the text tail instead of failing the spawn.
			logger.warn("task: inherited context frames failed to render; sending text", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const preamble = prompt.render(inheritedContextTemplate, {
		frames: frames.length,
		identifiers: context.identifiers,
	});
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: preamble }];
	if (frames.length > 0) content.push(...frames);
	else content.push({ type: "text", text: context.text });
	return {
		content,
		details: { frames: frames.length, chars: context.text.length, identifiers: context.identifiers.length },
	};
}
