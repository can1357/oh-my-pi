import type { Message } from "@oh-my-pi/pi-ai";
import { messageTexts } from "../context";
import type { CallContext, ShapedTool } from "../types";
import { identifiers, norm, pairKey, WITNESS_CHARS, words } from "./lines";

/** What of the model's context a result's lines are checked against before they collapse as shown before. */
export interface Seen {
	/** Normalised lines (≥ {@link WITNESS_CHARS} chars). */
	lines: Set<string>;
	/**
	 * Each normalised line paired with the next of the same text ({@link pairKey}), short and blank lines included: a
	 * run collapses only in the order the context holds it, so a dropped, moved or changed line splits it.
	 */
	pairs: Set<string>;
}

/** Keys of one text (or several) for a {@link Seen}. */
interface SeenKeys {
	lines: string[];
	pairs: string[];
}

const emptySeen = (): Seen => ({ lines: new Set(), pairs: new Set() });

/**
 * Per-session shaping state. Every result is decided once, at arrival; this is what later results read:
 * what the agent has already seen, what cuts hid, which code spans were folded.
 */
export interface ShapeState {
	/**
	 * Lines already in the agent's context, and their order: task, its words, commands, earlier results. Rebuilt
	 * from the model's context before each result ({@link syncSeen}), so lines that left it (compaction, a prune, a
	 * clear, another branch) no longer count.
	 */
	seen: Seen;
	/**
	 * Keys noted per call whose result is not in the context yet (a sibling call of the same turn): they stay seen
	 * across a {@link syncSeen} until the call's result lands there or the call leaves the context.
	 */
	pending: Map<string, SeenKeys>;
	/** Identifiers of the conversation (task, what the agent said, intents, commands): bodies it names stay open. */
	names: Set<string>;
	/** Lowercase words of the conversation, for the window's lexical score. */
	words: Set<string>;
	/** Normalised lines a window or valve cut hid: a later result holding enough of them is a re-ask, shown whole. */
	hidden: Set<string>;
	/** Folded code spans (1-based, inclusive) per absolute path: a later read overlapping one is shown whole. */
	folded: Map<string, [number, number][]>;
	/** The task text last recorded, so it is added once. */
	task: string;
	/** The `said` text last recorded, so a turn with several calls adds it once. */
	said: string;
	/** Shaped results so far. */
	calls: number;
}

export function newShapeState(): ShapeState {
	return {
		seen: emptySeen(),
		pending: new Map(),
		names: new Set(),
		words: new Set(),
		hidden: new Set(),
		folded: new Map(),
		task: "",
		said: "",
		calls: 0,
	};
}

/**
 * Seen keys of one message of the context, kept on it: the context keeps its messages until it rewrites them. The
 * property is not enumerable, so a clone spread from the message with other content (an elided result) starts without.
 */
const kSeenKeys = Symbol("spotlight.seenKeys");

type KeyedMessage = Message & { [kSeenKeys]?: SeenKeys };

function seenKeys(text: string, out: SeenKeys = { lines: [], pairs: [] }): SeenKeys {
	let prev: string | undefined;
	for (const line of text.split("\n")) {
		const key = norm(line);
		if (key.length >= WITNESS_CHARS) out.lines.push(key);
		if (prev !== undefined) out.pairs.push(pairKey(prev, key));
		prev = key;
	}
	return out;
}

function addKeys(seen: Seen, keys: SeenKeys): void {
	for (const key of keys.lines) seen.lines.add(key);
	for (const pair of keys.pairs) seen.pairs.add(pair);
}

/**
 * Rebuilds what the agent has seen from the model's context as it stands (`messages`, as sent to the model): the
 * text of every message in it ({@link messageTexts}) and the lines noted for calls whose results have not landed yet.
 * Whatever left the context (a compaction, a prune or elision of old results, a clear, a move to another branch) no
 * longer counts, so its lines never collapse to "as shown before". Each call shaped resyncs first.
 */
export function syncSeen(state: ShapeState, messages: readonly Message[]): void {
	const seen = emptySeen();
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		const keyed = message as KeyedMessage;
		let keys = keyed[kSeenKeys];
		if (!keys) {
			keys = { lines: [], pairs: [] };
			for (const text of messageTexts(message)) seenKeys(text, keys);
			if (Object.isExtensible(keyed)) Object.defineProperty(keyed, kSeenKeys, { value: keys });
		}
		addKeys(seen, keys);
		if (message.role === "toolResult") results.add(message.toolCallId);
		else if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
		}
	}
	for (const [id, keys] of state.pending) {
		if (results.has(id) || !calls.has(id)) {
			state.pending.delete(id);
			continue;
		}
		addKeys(seen, keys);
	}
	state.seen = seen;
}

function addSeen(state: ShapeState, text: string, toolCallId: string | undefined): void {
	const keys = seenKeys(text);
	addKeys(state.seen, keys);
	if (toolCallId === undefined || (keys.lines.length === 0 && keys.pairs.length === 0)) return;
	const pending = state.pending.get(toolCallId);
	if (!pending) state.pending.set(toolCallId, keys);
	else {
		for (const key of keys.lines) pending.lines.push(key);
		for (const pair of keys.pairs) pending.pairs.push(pair);
	}
}

function addConversation(state: ShapeState, text: string): void {
	for (const id of identifiers(text)) state.names.add(id);
	for (const w of words(text)) state.words.add(w);
}

/**
 * Records what the agent has said and run up to and including this call: the task, its last words, its earlier
 * commands and this call's command count as seen; the intent only feeds names and words (the seen set
 * leaves `i` out). What it notes for call `toolCallId` stays seen until its result is in the context ({@link syncSeen}).
 */
export function noteCall(
	state: ShapeState,
	ctx: CallContext,
	tool: ShapedTool,
	command: string,
	toolCallId?: string,
): void {
	state.calls++;
	if (ctx.task && ctx.task !== state.task) {
		state.task = ctx.task;
		addSeen(state, ctx.task, toolCallId);
		addConversation(state, ctx.task);
	}
	if (ctx.said && ctx.said !== state.said) {
		state.said = ctx.said;
		addSeen(state, ctx.said, toolCallId);
		addConversation(state, ctx.said);
	}
	if (ctx.intent) addConversation(state, ctx.intent);
	for (const c of ctx.commands) {
		addSeen(state, c.replace(/\\n/g, "\n"), toolCallId);
		addConversation(state, c);
	}
	const source = command || ctx.source;
	addConversation(state, source);
	// A heredoc the agent wrote or a patch it applied is in its context; so is the code it ran with eval.
	if (tool !== "read") addSeen(state, source.replace(/\\n/g, "\n"), toolCallId);
}

/** Records a result of call `toolCallId` as the agent is shown it. */
export function noteShown(state: ShapeState, text: string, toolCallId?: string): void {
	addSeen(state, text, toolCallId);
}
