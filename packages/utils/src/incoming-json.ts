/**
 * Typed cursors over a JSON document while its text is still arriving.
 *
 * {@link IncomingDoc.channel} returns a push-side {@link IncomingFeed} and a
 * read-side {@link IncomingDoc}. The producer appends text fragments, then
 * explicitly calls {@link IncomingFeed.finish} or {@link IncomingFeed.abort};
 * a feed that is never closed leaves every pending pull waiting forever.
 * There is one shared append-only buffer; cursors are cheap, immutable
 * path handles over it, and every pull is an ordinary promise that
 * re-scans the buffer whenever the feed changes. There are no snapshots,
 * per-field events, or fan-out channels.
 *
 * A scalar completes at its closing quote/delimiter, and a container
 * completes only when its closing delimiter arrives. Finished-but-truncated
 * input rejects with kind `incomplete`; abandoned input rejects with
 * `aborted`. String chunks contain only decoded text whose meaning is
 * stable, so an escape or Unicode escape may span any number of fragments.
 *
 * Pulling an {@link IncomingObject.key} makes that key required: a missing
 * or mistyped value is a structured {@link IncomingJsonError}. Object members
 * never pulled are skipped without validation. {@link IncomingDoc.whole} is
 * the explicit whole-document pull and runs only after successful input
 * completion.
 *
 * Object cursors bind the first occurrence of a duplicate key, whereas
 * complete-value pulls (`value()`, `collect()`, `whole()`) go through the
 * final parser (`parseJsonWithRepair`), whose objects are last-write-wins.
 *
 * Mid-stream cursors tolerate incomplete tokens but read double-quoted
 * strings with the final parser's strict closing rule: an unescaped inner
 * `"` can never swallow a sibling key or value. A pulled scalar completes
 * only once a value terminator follows it, like numbers, so structural
 * garbage after a value surfaces as `incomplete` rather than a silently
 * misparsed pull. Single-quote recovery (`'it's'`) is shared with the final
 * parser and passes both.
 *
 * @example
 * ```ts
 * const { feed, doc } = IncomingDoc.channel();
 * const args = doc.root().object();
 * const content = args.key("content").string();
 * feed.push('{"path":"a.ts","content":"hel');
 * await content.nextChunk(); // "hel"
 * feed.push('lo"}');
 * feed.finish();
 * await content.nextChunk(); // "lo"
 * await content.nextChunk(); // undefined
 * await args.key("path").value<string>(); // "a.ts"
 * ```
 */

import { Serial } from "./async";
import {
	COLON,
	COMMA,
	isNumberStart,
	JsonLexer,
	LBRACE,
	LBRACKET,
	QUOTE,
	RBRACE,
	RBRACKET,
	SQUOTE,
} from "./json-lexer";
import { parseJsonWithRepair } from "./json-parse";

/** Maximum container nesting before a scan reports the value as pending forever. */
const MAX_DEPTH = 128;

/** Location component in a pulled JSON path: an object member name or an array index. */
export type PullPathSegment = string | number;

/** JSON shape observed by a started pull. */
export type IncomingValueKind = "null" | "boolean" | "number" | "string" | "array" | "object";

/** Why a pull could not produce the requested shape. */
export type PullIssueKind =
	/** The requested member was absent when its container completed. */
	| "missing"
	/** The producer finished before the pulled value's closing token. */
	| "incomplete"
	/** The producer abandoned the input before the pull completed. */
	| "aborted"
	/** A complete pulled value could not be parsed. */
	| "malformed"
	/** A value was present with a different JSON shape (see `found`). */
	| "mismatch";

/** Structured failure while awaiting an incoming JSON value. */
export class IncomingJsonError extends Error {
	/** Full key/index path pulled by the consumer. */
	readonly path: readonly PullPathSegment[];
	/** Shape requested by the typed cursor. */
	readonly expected: string;
	/** Why the pull could not produce that shape. */
	readonly kind: PullIssueKind;
	/** Shape observed in the input when `kind` is `mismatch`. */
	readonly found?: string;

	constructor(
		path: readonly PullPathSegment[],
		expected: string,
		kind: PullIssueKind,
		options?: { found?: string; cause?: unknown },
	) {
		const at = path.length === 0 ? "$" : `$${path.map(s => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("")}`;
		const why = kind === "mismatch" ? `found ${options?.found}` : kind;
		super(`invalid JSON pull at ${at}: expected ${expected} (${why})`, { cause: options?.cause });
		this.name = "IncomingJsonError";
		this.path = path;
		this.expected = expected;
		this.kind = kind;
		this.found = options?.found;
	}
}

type Shape =
	| { kind: "null" | "array" | "object" }
	| { kind: "boolean"; value: boolean }
	| { kind: "number"; value: number }
	| { kind: "string"; value: string; stableLen: number };

interface Located {
	tag: "located";
	/** Source offset of the value's first char. */
	start: number;
	/** Source offset just past the value's closing token; `undefined` while it is still open. */
	end: number | undefined;
	shape: Shape;
}

type Probe =
	| Located
	/** The selected value has not started, or a token on the way to it is truncated. */
	| { tag: "pending" }
	/** The selected member's container closed without it. */
	| { tag: "missing" }
	/** A container on the path has a different shape than the path segment demands. */
	| { tag: "mismatch"; expected: string; found: string };

const PENDING: Probe = { tag: "pending" };
const MISSING: Probe = { tag: "missing" };

/** Readiness predicate a pull waits for once its value has been located. */
type Ready = (located: Located) => boolean;

const STARTED: Ready = () => true;
const COMPLETE: Ready = located => located.end !== undefined;

/**
 * One member reached by a selecting scan: where it starts, and the index of
 * its container value once a scan has descended into it.
 */
interface MemberSlot {
	/** Source offset of the member's first char (key for objects, value for arrays). */
	offset: number;
	child?: ContainerIndex;
}

/**
 * Member index of one container on a pulled path, so repeated pulls resume
 * where the previous scan stopped instead of re-lexing from the container's
 * opening delimiter. `frontier` is the source offset just after the opening
 * delimiter or the comma following the last fully scanned member — recorded
 * before skipping whitespace, so an unterminated comment at the buffer edge
 * is re-read once its tail arrives. Every member starting before the frontier
 * is recorded in `keys` (first occurrence wins) or `elements`; `tail` is the
 * array element at `elements.length`, which may still be open.
 */
class ContainerIndex {
	frontier: number;
	readonly keys = new Map<string, MemberSlot>();
	readonly elements: MemberSlot[] = [];
	tail?: MemberSlot;

	constructor(frontier: number) {
		this.frontier = frontier;
	}

	/** Advance the frontier to the cursor when a frontier scan moved past it. */
	advance(lex: JsonLexer): void {
		if (lex.pos > this.frontier) this.frontier = lex.pos;
	}
}

/** Append-only buffer, terminal state, and change notification shared by one feed and its cursors. */
class Shared {
	text = "";
	end: "open" | "finished" | "aborted" = "open";
	readonly #root: MemberSlot = { offset: 0 };
	#changed = Promise.withResolvers<void>();

	/** Resolves once the buffer or terminal state changes after this call. */
	get changed(): Promise<void> {
		return this.#changed.promise;
	}

	notify(): void {
		const changed = this.#changed;
		this.#changed = Promise.withResolvers<void>();
		changed.resolve();
	}

	/** Await input completion; rejects with `aborted` when the feed was abandoned. */
	async finished(): Promise<void> {
		while (this.end === "open") await this.changed;
		if (this.end === "aborted") throw new IncomingJsonError([], "document", "aborted");
	}

	/**
	 * Await the value at `path` until `ready` accepts it. Resolves `undefined`
	 * when the value's container completed without it.
	 */
	async pull(path: readonly PullPathSegment[], expected: string, ready: Ready): Promise<Located | undefined> {
		for (;;) {
			const probe = this.#locate(path);
			switch (probe.tag) {
				case "located":
					if (ready(probe)) return probe;
					break;
				case "missing":
					return undefined;
				case "mismatch":
					throw new IncomingJsonError(path, probe.expected, "mismatch", { found: probe.found });
			}
			if (this.end === "finished") throw new IncomingJsonError(path, expected, "incomplete");
			if (this.end === "aborted") throw new IncomingJsonError(path, expected, "aborted");
			await this.changed;
		}
	}

	#locate(path: readonly PullPathSegment[]): Probe {
		const lex = new JsonLexer(this.text, "incoming");
		lex.ws();
		return selectValue(lex, path, 0, this.end === "finished", 0, this.#root);
	}
}

function mismatch(expected: string, found: string): Probe {
	return { tag: "mismatch", expected, found };
}

function located(start: number, end: number | undefined, shape: Shape): Located {
	return { tag: "located", start, end, shape };
}

/**
 * Descend into the value at the cursor following `path[at..]`. `slot` is the
 * member holding this value; its container index is created on first descent
 * and lets later pulls resume the member scan instead of restarting it.
 */
function selectValue(
	lex: JsonLexer,
	path: readonly PullPathSegment[],
	at: number,
	ended: boolean,
	depth: number,
	slot: MemberSlot,
): Probe {
	const c = lex.peek();
	if (Number.isNaN(c)) return PENDING;
	if (at >= path.length) return scanValue(lex, ended, depth);
	const segment = path[at];
	if (c !== (typeof segment === "string" ? LBRACE : LBRACKET)) {
		return mismatch(typeof segment === "string" ? "object" : "array", charName(c));
	}
	if (depth >= MAX_DEPTH) return PENDING;
	const index = (slot.child ??= new ContainerIndex(lex.pos + 1));
	if (typeof segment === "string") {
		lex.pos = index.keys.get(segment)?.offset ?? index.frontier;
		return selectKey(lex, segment, path, at + 1, ended, depth, index);
	}
	const known = index.elements[segment];
	lex.pos = known?.offset ?? index.frontier;
	return selectIndex(lex, segment, path, at + 1, ended, depth, known ? segment : index.elements.length, index);
}

/**
 * Scan object members from the cursor (positioned at a member start or the
 * closing brace) until `wanted` is found, then descend along `path[at..]`.
 * Binds the first occurrence.
 */
function selectKey(
	lex: JsonLexer,
	wanted: string,
	path: readonly PullPathSegment[],
	at: number,
	ended: boolean,
	depth: number,
	index: ContainerIndex,
): Probe {
	if (depth >= MAX_DEPTH) return PENDING;
	for (;;) {
		index.advance(lex);
		lex.ws();
		const c = lex.peek();
		if (Number.isNaN(c)) return PENDING;
		if (c === RBRACE) {
			lex.pos++;
			return MISSING;
		}
		if (c === COMMA) {
			lex.pos++;
			continue;
		}
		const memberStart = lex.pos;
		let key: string;
		if (c === QUOTE || c === SQUOTE) {
			const progress = lex.string(c);
			if (!progress.complete) return PENDING;
			key = progress.value;
		} else {
			key = lex.unquotedKey();
			if (key.length === 0) return PENDING;
		}
		lex.ws();
		if (lex.peek() !== COLON) return PENDING;
		// The colon fixes the key's spelling; only now is the member stable.
		let slot = index.keys.get(key);
		if (slot === undefined) {
			slot = { offset: memberStart };
			index.keys.set(key, slot);
		}
		lex.pos++;
		lex.ws();
		if (lex.atEnd) return PENDING;
		if (key === wanted) return selectValue(lex, path, at, ended, depth + 1, slot);
		const skipped = scanValue(lex, ended, depth + 1);
		if (skipped.tag !== "located" || skipped.end === undefined) return PENDING;
		lex.ws();
		const d = lex.peek();
		if (d === COMMA) {
			lex.pos++;
		} else if (d === RBRACE) {
			lex.pos++;
			return MISSING;
		} else {
			return PENDING;
		}
	}
}

/**
 * Scan array elements from the cursor (positioned at element `at` or the
 * closing bracket) until `wanted` is reached, then descend along `path[at..]`.
 */
function selectIndex(
	lex: JsonLexer,
	wanted: number,
	path: readonly PullPathSegment[],
	at: number,
	ended: boolean,
	depth: number,
	element: number,
	index: ContainerIndex,
): Probe {
	if (depth >= MAX_DEPTH) return PENDING;
	for (;;) {
		index.advance(lex);
		lex.ws();
		const c = lex.peek();
		if (Number.isNaN(c)) return PENDING;
		if (c === RBRACKET) {
			lex.pos++;
			return MISSING;
		}
		if (c === COMMA) {
			lex.pos++;
			continue;
		}
		const slot = index.elements[element] ?? (index.tail ??= { offset: lex.pos });
		if (element === wanted) return selectValue(lex, path, at, ended, depth + 1, slot);
		const skipped = scanValue(lex, ended, depth + 1);
		if (skipped.tag !== "located" || skipped.end === undefined) return PENDING;
		if (element === index.elements.length) {
			index.elements.push(slot);
			index.tail = undefined;
		}
		element++;
		lex.ws();
		const d = lex.peek();
		if (d === COMMA) {
			lex.pos++;
		} else if (d === RBRACKET) {
			lex.pos++;
			return MISSING;
		} else {
			return PENDING;
		}
	}
}

/** Locate the value at the cursor and determine whether it is complete. */
function scanValue(lex: JsonLexer, ended: boolean, depth: number): Probe {
	const start = lex.pos;
	const c = lex.peek();
	if (Number.isNaN(c)) return PENDING;
	if (c === LBRACE) return scanContainer(lex, ended, depth, start, "object");
	if (c === LBRACKET) return scanContainer(lex, ended, depth, start, "array");
	if (c === QUOTE || c === SQUOTE) {
		const progress = lex.string(c);
		const end = lex.pos;
		// Like numbers and keywords, a string is complete only once a value
		// terminator follows (or the input ended): an edge close may still be
		// reopened by later fragments via single-quote recovery.
		const complete = progress.complete && scalarComplete(lex, ended);
		return located(start, complete ? end : undefined, {
			kind: "string",
			value: progress.value,
			stableLen: progress.stableLen,
		});
	}
	if (isNumberStart(c)) {
		const value = lex.number();
		if (value === undefined) return PENDING;
		const end = lex.pos;
		return located(start, scalarComplete(lex, ended) ? end : undefined, { kind: "number", value });
	}
	const keyword = lex.keyword();
	if (keyword !== undefined) {
		const end = lex.pos;
		const complete = scalarComplete(lex, ended);
		return located(
			start,
			complete ? end : undefined,
			keyword === null ? { kind: "null" } : { kind: "boolean", value: keyword },
		);
	}
	const word = lex.bareword();
	if (word === undefined) return PENDING;
	const end = lex.pos;
	return located(start, scalarComplete(lex, ended) ? end : undefined, {
		kind: "string",
		value: word,
		stableLen: word.length,
	});
}

/** A scalar is complete once a value terminator follows it, or the finished input ends. */
function scalarComplete(lex: JsonLexer, ended: boolean): boolean {
	lex.ws();
	const c = lex.peek();
	return c === COMMA || c === RBRACE || c === RBRACKET || (ended && lex.atEnd);
}

function scanContainer(lex: JsonLexer, ended: boolean, depth: number, start: number, kind: "object" | "array"): Probe {
	if (depth >= MAX_DEPTH) return PENDING;
	const close = kind === "object" ? RBRACE : RBRACKET;
	const open = located(start, undefined, { kind });
	lex.pos++;
	for (;;) {
		lex.ws();
		const c = lex.peek();
		if (Number.isNaN(c)) return open;
		if (c === close) {
			lex.pos++;
			return located(start, lex.pos, { kind });
		}
		if (c === COMMA) {
			lex.pos++;
			continue;
		}
		if (kind === "object") {
			if (c === QUOTE || c === SQUOTE) {
				if (!lex.string(c).complete) return open;
			} else if (lex.unquotedKey().length === 0) {
				return open;
			}
			lex.ws();
			if (lex.peek() !== COLON) return open;
			lex.pos++;
			lex.ws();
		}
		const value = scanValue(lex, ended, depth + 1);
		if (value.tag !== "located" || value.end === undefined) return open;
		lex.ws();
		const d = lex.peek();
		if (d === COMMA) {
			lex.pos++;
		} else if (d === close) {
			lex.pos++;
			return located(start, lex.pos, { kind });
		} else {
			return open;
		}
	}
}

/** Shape name implied by a value's first char, for mismatch reports. */
function charName(c: number): string {
	if (c === LBRACE) return "object";
	if (c === LBRACKET) return "array";
	if (c === QUOTE || c === SQUOTE) return "string";
	if (isNumberStart(c)) return "number";
	if ((c | 0x20) === 0x74 /* t */ || (c | 0x20) === 0x66 /* f */) return "boolean";
	if ((c | 0x20) === 0x6e /* n */) return "null";
	return "value";
}

/**
 * Push side of an {@link IncomingDoc} channel. Call {@link finish} to mark
 * the document complete or {@link abort} to abandon it; both are idempotent
 * and every pending pull settles on the first one.
 */
export class IncomingFeed {
	readonly #shared: Shared;

	constructor(shared: Shared) {
		this.#shared = shared;
	}

	/** Append one text fragment and wake every pending cursor. Throws once the feed is closed. */
	push(fragment: string): void {
		if (this.#shared.end !== "open") throw new Error("incoming JSON feed is already closed");
		this.#shared.text += fragment;
		this.#shared.notify();
	}

	/** Mark the input complete. */
	finish(): void {
		this.#close("finished");
	}

	/** Abandon the input; pending and future pulls reject with kind `aborted`. */
	abort(): void {
		this.#close("aborted");
	}

	#close(end: "finished" | "aborted"): void {
		if (this.#shared.end !== "open") return;
		this.#shared.end = end;
		this.#shared.notify();
	}
}

/** Read side of one growing JSON document. */
export class IncomingDoc {
	readonly #shared: Shared;

	constructor(shared: Shared) {
		this.#shared = shared;
	}

	/** Create a push feed and its read-side document. */
	static channel(): { feed: IncomingFeed; doc: IncomingDoc } {
		const shared = new Shared();
		return { feed: new IncomingFeed(shared), doc: new IncomingDoc(shared) };
	}

	/** Text received so far. */
	get text(): string {
		return this.#shared.text;
	}

	/** Await explicit input completion; rejects with kind `aborted` if the feed was abandoned. */
	finished(): Promise<void> {
		return this.#shared.finished();
	}

	/**
	 * Parse the entire finished document with the final tolerant parser.
	 * Waits for {@link IncomingFeed.finish}; aborted input is not decoded and a
	 * document that fails the final parse rejects with kind `malformed`.
	 */
	async whole<T = unknown>(): Promise<T> {
		await this.#shared.finished();
		try {
			return parseJsonWithRepair<T>(this.#shared.text);
		} catch (cause) {
			throw new IncomingJsonError([], "document", "malformed", { cause });
		}
	}

	/** Cursor for the root JSON value. */
	root(): IncomingJson {
		return new IncomingJson(this.#shared, []);
	}
}

/** Await the value at `path` until `ready` accepts it; a missing member rejects with kind `missing`. */
async function pull(
	shared: Shared,
	path: readonly PullPathSegment[],
	expected: string,
	ready: Ready,
): Promise<Located> {
	const found = await shared.pull(path, expected, ready);
	if (found === undefined) throw new IncomingJsonError(path, expected, "missing");
	return found;
}

/** Await completion and materialize the value at `path`; containers go through the final tolerant parser. */
async function materialize<T>(shared: Shared, path: readonly PullPathSegment[], expected: string): Promise<T> {
	const found = await pull(shared, path, expected, COMPLETE);
	const { shape } = found;
	switch (shape.kind) {
		case "null":
			return null as T;
		case "boolean":
		case "number":
		case "string":
			return shape.value as T;
	}
	try {
		return parseJsonWithRepair<T>(shared.text.slice(found.start, found.end));
	} catch (cause) {
		throw new IncomingJsonError(path, expected, "malformed", { cause });
	}
}

function mismatchError(path: readonly PullPathSegment[], expected: string, found: string): IncomingJsonError {
	return new IncomingJsonError(path, expected, "mismatch", { found });
}

/** Cursor for one JSON value in the incoming document, addressed by path. */
export class IncomingJson {
	readonly #shared: Shared;
	readonly path: readonly PullPathSegment[];

	constructor(shared: Shared, path: readonly PullPathSegment[]) {
		this.#shared = shared;
		this.path = path;
	}

	/** Await the value's first token and report its JSON shape. */
	async kind(): Promise<IncomingValueKind> {
		return (await pull(this.#shared, this.path, "value", STARTED)).shape.kind;
	}

	/** Await and parse the complete value. Containers go through the final tolerant parser. */
	value<T = unknown>(): Promise<T> {
		return materialize<T>(this.#shared, this.path, "value");
	}

	/** Await a complete number. */
	number(): Promise<number> {
		return this.#scalar("number");
	}

	/** Await a complete boolean. */
	boolean(): Promise<boolean> {
		return this.#scalar("boolean");
	}

	/** Await a complete `null`. */
	null(): Promise<null> {
		return this.#scalar("null");
	}

	/** View this value as an incremental decoded string. */
	string(): IncomingString {
		return new IncomingString(this.#shared, this.path);
	}

	/** View this value as an array of element cursors. */
	array(): IncomingArray {
		return new IncomingArray(this.#shared, this.path);
	}

	/** View this value as an object with keyed cursors. */
	object(): IncomingObject {
		return new IncomingObject(this.#shared, this.path);
	}

	async #scalar<T>(expected: IncomingValueKind): Promise<T> {
		const found = await pull(this.#shared, this.path, expected, COMPLETE);
		if (found.shape.kind !== expected) throw mismatchError(this.path, expected, found.shape.kind);
		return materialize<T>(this.#shared, this.path, expected);
	}
}

/** Decoded-string chunk readiness: stable output past `emitted`, or the closing quote. */
function chunkReady(emitted: number): Ready {
	return located =>
		located.shape.kind !== "string" || located.shape.stableLen !== emitted || located.end !== undefined;
}

/** Line readiness: a newline in the stable output past `emitted`, or the closing quote. */
function lineReady(emitted: number): Ready {
	return located =>
		located.shape.kind !== "string" ||
		located.shape.stableLen < emitted ||
		located.end !== undefined ||
		located.shape.value.slice(emitted, located.shape.stableLen).includes("\n");
}

/**
 * Incremental decoded string consumer. Chunks are emitted in order without
 * overlap and are always prefixes of the final decoded string;
 * {@link text} returns the complete string independently of whether chunks
 * were consumed. Async iteration yields chunks. Concurrent `nextChunk` /
 * `nextLine` calls are served in call order, like a stream reader: a call
 * whose result is abandoned still consumes its chunk.
 */
export class IncomingString implements AsyncIterable<string> {
	readonly #shared: Shared;
	readonly #path: readonly PullPathSegment[];
	readonly #serial = new Serial();
	#emitted = 0;
	#done = false;

	constructor(shared: Shared, path: readonly PullPathSegment[]) {
		this.#shared = shared;
		this.#path = path;
	}

	/** Await the next stable decoded chunk, or `undefined` after the closing quote. */
	nextChunk(): Promise<string | undefined> {
		return this.#serial.run(() => this.#nextChunk());
	}

	/**
	 * Await the next complete decoded line, retaining its trailing newline.
	 * A final unterminated line is returned once the closing quote arrives.
	 */
	nextLine(): Promise<string | undefined> {
		return this.#serial.run(() => this.#nextLine());
	}

	async #nextChunk(): Promise<string | undefined> {
		if (this.#done) return undefined;
		const found = await pull(this.#shared, this.#path, "string", chunkReady(this.#emitted));
		const { stableLen, value } = this.#string(found);
		if (stableLen > this.#emitted) {
			const chunk = value.slice(this.#emitted, stableLen);
			this.#emitted = stableLen;
			return chunk;
		}
		this.#done = true;
		return undefined;
	}

	async #nextLine(): Promise<string | undefined> {
		if (this.#done) return undefined;
		const found = await pull(this.#shared, this.#path, "string", lineReady(this.#emitted));
		const { stableLen, value } = this.#string(found);
		const newline = value.indexOf("\n", this.#emitted);
		const upper =
			newline >= 0 && newline < stableLen ? newline + 1 : found.end === undefined ? this.#emitted : stableLen;
		if (upper > this.#emitted) {
			const line = value.slice(this.#emitted, upper);
			this.#emitted = upper;
			return line;
		}
		this.#done = true;
		return undefined;
	}

	/** Iterate complete decoded lines. */
	async *lines(): AsyncGenerator<string, void, undefined> {
		for (let line = await this.nextLine(); line !== undefined; line = await this.nextLine()) yield line;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<string, void, undefined> {
		for (let chunk = await this.nextChunk(); chunk !== undefined; chunk = await this.nextChunk()) yield chunk;
	}

	/** Await the closing quote and return the complete decoded string. */
	async text(): Promise<string> {
		return this.#string(await pull(this.#shared, this.#path, "string", COMPLETE)).value;
	}

	#string(found: Located): { value: string; stableLen: number } {
		const { shape } = found;
		if (shape.kind !== "string") throw mismatchError(this.#path, "string", shape.kind);
		if (shape.stableLen < this.#emitted) {
			throw new IncomingJsonError(this.#path, "valid string offset", "malformed");
		}
		return shape;
	}
}

/**
 * Linear cursor over elements of an incoming array. Async iteration yields
 * element cursors. Concurrent `next` calls are served in call order.
 */
export class IncomingArray implements AsyncIterable<IncomingJson> {
	readonly #shared: Shared;
	readonly #path: readonly PullPathSegment[];
	readonly #serial = new Serial();
	#index = 0;
	#started = false;

	constructor(shared: Shared, path: readonly PullPathSegment[]) {
		this.#shared = shared;
		this.#path = path;
	}

	/** Await the start of the next element; `undefined` only after the closing bracket. */
	next(): Promise<IncomingJson | undefined> {
		return this.#serial.run(() => this.#advance());
	}

	async #advance(): Promise<IncomingJson | undefined> {
		if (!this.#started) {
			const root = await pull(this.#shared, this.#path, "array", STARTED);
			if (root.shape.kind !== "array") throw mismatchError(this.#path, "array", root.shape.kind);
			this.#started = true;
		}
		const path = [...this.#path, this.#index];
		if ((await this.#shared.pull(path, "value", STARTED)) === undefined) return undefined;
		this.#index++;
		return new IncomingJson(this.#shared, path);
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<IncomingJson, void, undefined> {
		for (let element = await this.next(); element !== undefined; element = await this.next()) yield element;
	}

	/** Await the closing bracket and collect the fully parsed elements. */
	async collect<T = unknown>(): Promise<T[]> {
		const values = await materialize<unknown>(this.#shared, this.#path, "array");
		if (!Array.isArray(values)) throw mismatchError(this.#path, "array", valueName(values));
		return values as T[];
	}
}

/** Keyed cursor and final collection for an incoming object. */
export class IncomingObject {
	readonly #shared: Shared;
	readonly #path: readonly PullPathSegment[];

	constructor(shared: Shared, path: readonly PullPathSegment[]) {
		this.#shared = shared;
		this.#path = path;
	}

	/**
	 * Cursor bound to the first occurrence of `name`. Pulling it makes the
	 * key required: a missing member rejects with kind `missing`.
	 */
	key(name: string): IncomingJson {
		return new IncomingJson(this.#shared, [...this.#path, name]);
	}

	/**
	 * Await the closing brace and collect the object through the final parser,
	 * whose duplicate keys are last-write-wins unlike {@link key}.
	 */
	async collect<T = Record<string, unknown>>(): Promise<T> {
		const value = await materialize<unknown>(this.#shared, this.#path, "object");
		const found = valueName(value);
		if (found !== "object") throw mismatchError(this.#path, "object", found);
		return value as T;
	}
}

/** JSON shape name of a materialized value, for mismatch reports. */
function valueName(value: unknown): IncomingValueKind {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	const type = typeof value;
	return type === "boolean" || type === "number" || type === "string" ? type : "object";
}
