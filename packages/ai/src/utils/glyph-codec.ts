import type { AssistantMessage, Context, CursorExecHandlers, ImageContent, Message, TextContent } from "../types";
import { getStreamingPartialJson, setStreamingPartialJson } from "./block-symbols";
import { AssistantMessageEventStream } from "./event-stream";
import glyphNotice from "./glyph-notice.md" with { type: "text" };

const GLYPH_OPEN = "⟦";
const GLYPH_ESCAPE = "⟦E⟧";
const GLYPH_ENCODE_PRECHECK = /[\uE000-\uF8FF\u{F0000}-\u{10FFFD}]|⟦(?=(?:U[0-9a-fA-F]{4,6}|E)⟧)/u;
const GLYPH_ENCODE_PATTERN =
	/([\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}])|⟦(?=(?:U[0-9a-fA-F]{4,6}|E)⟧)/gu;
const GLYPH_DECODE_PATTERN = /⟦E⟧|⟦U([0-9a-fA-F]{4,6})⟧/gu;

const kGlyphEncoded = Symbol("provider.context.glyphEncoded");

interface GlyphEncodedContext extends Context {
	[kGlyphEncoded]: true;
}

/** Per-request glyph codec applied at the provider wire boundary. */
export interface GlyphCodec {
	/** Context with model-bound glyphs encoded and one conditional convention notice. */
	context: Context;
	/** Decodes glyph tokens in the stream's terminal assistant message. */
	wrap(inner: AssistantMessageEventStream): AssistantMessageEventStream;
	/** Decodes Cursor Pi calls and encodes their provider-bound results. */
	wrapCursorExecHandlers(handlers: CursorExecHandlers): CursorExecHandlers;
	/** Whether this request has encoded at least one glyph or literal token prefix. */
	active: boolean;
}

/** Encode one string; returns the same reference when nothing changed. */
export function encodeGlyphText(text: string): string {
	return encodeGlyphTextInto(text);
}

/** Decodes glyph tokens and unescapes `⟦E⟧` to `⟦`. */
export function decodeGlyphText(text: string): string {
	return text.replace(GLYPH_DECODE_PATTERN, (token: string, hex: string | undefined) => {
		if (token === GLYPH_ESCAPE) return GLYPH_OPEN;
		const codepoint = Number.parseInt(hex ?? "", 16);
		return codepoint > 0x10ffff ? token : String.fromCodePoint(codepoint);
	});
}

/**
 * Encode a context for the provider wire without mutating stored history.
 * Reapplying it to the returned branded context is an inert identity pass.
 */
export function applyGlyphCodec(context: Context): GlyphCodec {
	if (isGlyphEncodedContext(context)) {
		return {
			context,
			wrap: inner => inner,
			wrapCursorExecHandlers: handlers => handlers,
			active: false,
		};
	}

	let active = false;
	let noticeAdded = false;
	let systemPrompt = context.systemPrompt;
	let tools = context.tools;
	let messages = context.messages;

	// Context.systemPrompt is typed string[], but legacy (earendil-works)
	// extensions pass a bare string; provider paths tolerate it via
	// normalizeSystemPrompts, so normalize here before iterating.
	const rawSystemPrompt = context.systemPrompt;
	const sourceSystemPrompt = typeof rawSystemPrompt === "string" ? [rawSystemPrompt] : rawSystemPrompt;
	if (sourceSystemPrompt !== undefined) {
		let output = sourceSystemPrompt;
		for (const [index, prompt] of sourceSystemPrompt.entries()) {
			const encoded = encodeGlyphText(prompt);
			if (encoded === prompt) continue;
			active = true;
			if (output === sourceSystemPrompt) output = [...sourceSystemPrompt];
			output[index] = noticeAdded ? encoded : appendGlyphNotice(encoded);
			noticeAdded = true;
		}
		systemPrompt = output;
	}

	const sourceTools = context.tools;
	if (sourceTools !== undefined) {
		let output = sourceTools;
		for (const [index, tool] of sourceTools.entries()) {
			const encoded = encodeGlyphText(tool.description);
			if (encoded === tool.description) continue;
			active = true;
			if (output === sourceTools) output = [...sourceTools];
			output[index] = {
				...tool,
				description: noticeAdded ? encoded : appendGlyphNotice(encoded),
			};
			noticeAdded = true;
		}
		tools = output;
	}

	for (const [index, message] of context.messages.entries()) {
		const encoded = encodeMessage(message);
		if (encoded === message) continue;
		active = true;
		if (messages === context.messages) messages = [...context.messages];
		messages[index] = noticeAdded ? encoded : encodeMessageWithNotice(message);
		noticeAdded = true;
	}

	const encodedContext: GlyphEncodedContext = {
		...context,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(tools === undefined ? {} : { tools }),
		messages,
		[kGlyphEncoded]: true,
	};
	let cursorHandlersWrapped = false;
	return {
		context: encodedContext,
		wrap(inner) {
			return active || cursorHandlersWrapped ? wrapGlyphStream(inner) : inner;
		},
		wrapCursorExecHandlers(handlers) {
			cursorHandlersWrapped = true;
			const wrapped = createCursorExecHandlersCodec(handlers, () => {
				active = true;
			});
			return wrapped;
		},
		get active() {
			return active;
		},
	};
}

function encodeGlyphTextInto(text: string): string {
	if (!GLYPH_ENCODE_PRECHECK.test(text)) return text;
	return text.replace(GLYPH_ENCODE_PATTERN, (match: string, glyph: string | undefined) => {
		if (glyph === undefined) return GLYPH_ESCAPE;
		const codepoint = glyph.codePointAt(0);
		return codepoint === undefined ? match : `⟦U${codepoint.toString(16)}⟧`;
	});
}

function appendGlyphNotice(text: string): string {
	return `${text}\n\n${glyphNotice}`;
}

function isGlyphEncodedContext(context: Context): context is GlyphEncodedContext {
	return kGlyphEncoded in context;
}

type GlyphTextTransform = (text: string) => string;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function transformValue(value: unknown, transform: GlyphTextTransform): unknown {
	if (typeof value === "string") return transform(value);
	if (Array.isArray(value)) {
		const input: readonly unknown[] = value;
		let output: unknown[] | undefined;
		for (const [index, item] of input.entries()) {
			const transformed = transformValue(item, transform);
			if (output !== undefined) {
				output.push(transformed);
			} else if (transformed !== item) {
				output = input.slice(0, index);
				output.push(transformed);
			}
		}
		return output ?? value;
	}
	return isPlainRecord(value) ? transformRecord(value, transform) : value;
}

function transformRecord(input: Record<string, unknown>, transform: GlyphTextTransform): Record<string, unknown> {
	let output: Record<string, unknown> | undefined;
	for (const key in input) {
		const value = input[key];
		const transformedKey = transform(key);
		const transformedValue = transformValue(value, transform);
		if (output === undefined && (transformedKey !== key || transformedValue !== value)) {
			output = {};
			for (const priorKey in input) {
				if (priorKey === key) break;
				output[priorKey] = input[priorKey];
			}
		}
		if (output !== undefined) output[transformedKey] = transformedValue;
	}
	return output ?? input;
}

function transformTextBlocks(
	content: Array<TextContent | ImageContent>,
	transform: GlyphTextTransform,
): Array<TextContent | ImageContent> {
	let output: Array<TextContent | ImageContent> | undefined;
	for (const [index, block] of content.entries()) {
		let transformed = block;
		if (block.type === "text") {
			const text = transform(block.text);
			if (text !== block.text) transformed = { ...block, text };
		}
		if (output !== undefined) {
			output.push(transformed);
		} else if (transformed !== block) {
			output = content.slice(0, index);
			output.push(transformed);
		}
	}
	return output ?? content;
}

function transformAssistantContent(
	content: AssistantMessage["content"],
	transform: GlyphTextTransform,
): AssistantMessage["content"] {
	let output: AssistantMessage["content"] | undefined;
	for (const [index, block] of content.entries()) {
		let transformed = block;
		if (block.type === "text") {
			const text = transform(block.text);
			if (text !== block.text) transformed = { ...block, text };
		} else if (block.type === "toolCall") {
			const args = transformRecord(block.arguments, transform);
			if (args !== block.arguments) transformed = { ...block, arguments: args };
		}
		if (output !== undefined) {
			output.push(transformed);
		} else if (transformed !== block) {
			output = content.slice(0, index);
			output.push(transformed);
		}
	}
	return output ?? content;
}

function transformMessage(message: Message, transform: GlyphTextTransform): Message {
	switch (message.role) {
		case "user":
		case "developer": {
			const content =
				typeof message.content === "string"
					? transform(message.content)
					: transformTextBlocks(message.content, transform);
			return content === message.content ? message : { ...message, content };
		}
		case "toolResult": {
			const content = transformTextBlocks(message.content, transform);
			return content === message.content ? message : { ...message, content };
		}
		case "assistant": {
			const content = transformAssistantContent(message.content, transform);
			return content === message.content ? message : { ...message, content };
		}
	}
}

function encodeMessage(message: Message): Message {
	return transformMessage(message, encodeGlyphText);
}

function encodeMessageWithNotice(message: Message): Message {
	let noticeAdded = false;
	return transformMessage(message, text => {
		const encoded = encodeGlyphText(text);
		if (noticeAdded || encoded === text) return encoded;
		noticeAdded = true;
		return appendGlyphNotice(encoded);
	});
}

function decodeAssistantMessageInPlace(message: AssistantMessage): void {
	for (const block of message.content) {
		if (block.type === "text") {
			block.text = decodeGlyphText(block.text);
			continue;
		}
		if (block.type !== "toolCall") continue;
		block.arguments = transformRecord(block.arguments, decodeGlyphText);
		const partialJson = getStreamingPartialJson(block);
		if (partialJson !== undefined) setStreamingPartialJson(block, decodeGlyphText(partialJson));
	}
}

function wrapGlyphStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of inner) {
				if (event.type === "done") decodeAssistantMessageInPlace(event.message);
				else if (event.type === "error") decodeAssistantMessageInPlace(event.error);
				out.push(event);
			}
			if (!out.done) {
				const result = await inner.result();
				decodeAssistantMessageInPlace(result);
				out.end(result);
			}
		} catch (err) {
			if (!out.done) out.fail(err);
		}
	})();
	return out;
}

type GlyphStringPredicate = (text: string) => boolean;

function containsTransformableString(value: unknown, predicate: GlyphStringPredicate): boolean {
	if (typeof value === "string") return predicate(value);
	if (Array.isArray(value)) return value.some(item => containsTransformableString(item, predicate));
	if (!isPlainRecord(value)) return false;
	for (const key in value) {
		if (predicate(key) || containsTransformableString(value[key], predicate)) return true;
	}
	return false;
}

function transformClonedValue(value: unknown, transform: GlyphTextTransform): unknown {
	if (typeof value === "string") return transform(value);
	if (typeof value === "object" && value !== null) transformObjectStringsInPlace(value, transform);
	return value;
}

function transformObjectStringsInPlace(value: object, transform: GlyphTextTransform): void {
	if (Array.isArray(value)) {
		const items: unknown[] = value;
		for (const [index, item] of items.entries()) items[index] = transformClonedValue(item, transform);
		return;
	}
	if (!isPlainRecord(value)) return;
	const entries = Object.entries(value);
	const transformedEntries: Array<[string, unknown]> = [];
	let keyChanged = false;
	for (const [key, child] of entries) {
		const transformedKey = transform(key);
		keyChanged ||= transformedKey !== key;
		transformedEntries.push([transformedKey, transformClonedValue(child, transform)]);
	}
	if (keyChanged) {
		for (const [key] of entries) delete value[key];
	}
	for (const [key, child] of transformedEntries) value[key] = child;
}

function transformObjectStrings<T extends object>(
	value: T,
	predicate: GlyphStringPredicate,
	transform: GlyphTextTransform,
): T {
	if (!containsTransformableString(value, predicate)) return value;
	const cloned = structuredClone(value);
	transformObjectStringsInPlace(cloned, transform);
	return cloned;
}

function decodeCursorArgs<T extends object>(args: T): T {
	return transformObjectStrings(args, text => decodeGlyphText(text) !== text, decodeGlyphText);
}

function encodeCursorResult<T extends object>(result: T, onEncoded: () => void): T {
	return transformObjectStrings(
		result,
		text => encodeGlyphText(text) !== text,
		text => {
			const encoded = encodeGlyphText(text);
			if (encoded !== text) onEncoded();
			return encoded;
		},
	);
}

function createCursorExecHandlersCodec(handlers: CursorExecHandlers, onEncoded: () => void): CursorExecHandlers {
	const sourcePiRead = handlers.piRead;
	const piRead: CursorExecHandlers["piRead"] = sourcePiRead
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiRead.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;
	const sourcePiBash = handlers.piBash;
	const piBash: CursorExecHandlers["piBash"] = sourcePiBash
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiBash.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;
	const sourcePiEdit = handlers.piEdit;
	const piEdit: CursorExecHandlers["piEdit"] = sourcePiEdit
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiEdit.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;
	const sourcePiWrite = handlers.piWrite;
	const piWrite: CursorExecHandlers["piWrite"] = sourcePiWrite
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiWrite.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;
	const sourcePiGrep = handlers.piGrep;
	const piGrep: CursorExecHandlers["piGrep"] = sourcePiGrep
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiGrep.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;
	const sourcePiFind = handlers.piFind;
	const piFind: CursorExecHandlers["piFind"] = sourcePiFind
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiFind.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;
	const sourcePiLs = handlers.piLs;
	const piLs: CursorExecHandlers["piLs"] = sourcePiLs
		? async call => {
				const args = decodeCursorArgs(call.args);
				const result = await sourcePiLs.call(handlers, args === call.args ? call : { ...call, args });
				return encodeCursorResult(result, onEncoded);
			}
		: undefined;

	// Preserve class-backed handler objects; object spread drops prototype methods.
	return new Proxy(handlers, {
		get(target, property, receiver) {
			switch (property) {
				case "piRead":
					return piRead;
				case "piBash":
					return piBash;
				case "piEdit":
					return piEdit;
				case "piWrite":
					return piWrite;
				case "piGrep":
					return piGrep;
				case "piFind":
					return piFind;
				case "piLs":
					return piLs;
				default:
					return Reflect.get(target, property, receiver);
			}
		},
	});
}
