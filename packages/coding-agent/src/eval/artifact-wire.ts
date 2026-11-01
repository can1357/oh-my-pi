/**
 * What crosses the bridge for the artifact readiness question: its name, the
 * request a reader sends and the answer the host gives.
 *
 * In a module of its own because the worker runtime asks the question and the
 * host answers it: importing the answer's module into the worker would bring
 * the session manager with it. And in one module because both ends read these
 * shapes. A shape written out twice, or copied field by field at a hop, is a
 * field one end has and the other drops — which is how a reader lost the hold
 * its first read bound and went on to read another directory.
 *
 * The Python kernel cannot import this module, so `py/prelude.py` writes the
 * same requests and reads the same answer fields by hand. No compiler checks
 * that copy. `py/prelude.test.ts` drives the kernel through each of its four
 * requests and requires `artifactRequestOf` to take every one whole; its
 * reading of the host's real answers is checked by the real-kernel reads in
 * `artifact-reads-in-cells.test.ts`, not by any type.
 */

/** Synthetic bridge name reserved for the artifact readiness question, across both runtimes. */
export const EVAL_ARTIFACTS_READY_BRIDGE_NAME = "__artifacts_ready__";

/**
 * The key a cell's roots carry its hold on the artifacts directory under. No
 * scheme can be named this, so it is invisible to everything that reads the
 * roots as scheme-to-root. The Python prelude spells it too.
 */
export const EVAL_ARTIFACT_ROOT_TOKEN = "__artifactRoot";

/** What a reader is told about the file it asked for, so it can check what it opens. */
export interface SettledArtifact {
	path: string;
	device: string;
	inode: string;
	/**
	 * The pin this answer holds on the very file it is about, for the reader
	 * that has to come back for the bytes. A re-ask names this rather than the
	 * file, because the name is what stopped meaning the file.
	 */
	file?: string;
	/**
	 * The hold this answer was issued against: the artifacts directory, held
	 * open, that it was resolved through. Absent only when there was no
	 * directory to hold.
	 *
	 * A cell started before its artifacts directory existed has no token, and
	 * taking a fresh hold at every read would let the directory change under
	 * it between two reads. The first answer it consumes binds it, and it
	 * sends that token with everything after. An answer naming any other hold
	 * — one issued, while another read was binding, against a directory put at
	 * the name since — is refused where it is consumed, and the read is asked
	 * again through the cell's own hold.
	 */
	root?: string;
	/**
	 * The artifact's text, read from the descriptor the pin held on that very
	 * file. Sent only to a reader that took the pin, which it does when what
	 * its pathname reaches is no longer what it was answered about.
	 */
	text?: string;
}

/**
 * What a reader asks.
 *
 * - `answer`: the file for `id`, pinned for this reader until it has read it.
 * - `locate`: the file for `id` and nothing held, for a reader that hands the
 *   path on (to the read tool, with a selector) and never comes back.
 * - `take`: the bytes of a pinned answer, ending the pin. Only one reader can
 *   take a pin; the next is refused.
 * - `release`: the reader has read the answer it was given and is done with
 *   its pin. Sent after the read, never before it.
 */
export type ArtifactRequest =
	| ({ op: "answer" } & ArtifactLookup)
	| ({ op: "locate" } & ArtifactLookup)
	| { op: "take"; file: string }
	| { op: "release"; file: string };

/** Which artifact a lookup is for, and the directory the asking cell reads. */
interface ArtifactLookup {
	id: string;
	/** The cell's artifacts directory, by name. */
	root: string;
	/** The hold the cell reads that directory through, when it has one. */
	token?: string;
}

/**
 * Whether each field of `T` must be present. Written out as a value, so the
 * parser below is driven by it, and typed against `T`, so a field added to
 * `T` and left out here, or listed here and not in `T`, does not compile.
 */
type Presence<T> = { readonly [K in keyof T]-?: {} extends Pick<T, K> ? "optional" : "required" };

/**
 * What the parser can deliver for each field of `T`, so what `T` may say a
 * field is. The parser copies the fields its table lists and checks only that
 * each is a string, so:
 *
 * - a required field is a string, never a type that admits `undefined`,
 *   which the parser would refuse; an optional one is a string when present;
 * - every field has a key a table can name: an index signature, plain or a
 *   pattern, has fields a table never lists;
 * - no field is named `__proto__`: written into a table it sets the table's
 *   prototype rather than naming a key, and the parser would never read it.
 *
 * A field keyed by a symbol passes, and the parser never visits it; no
 * bridge can carry one, since JSON and `postMessage` both drop them.
 */
type WireFields<T> = {
	[K in keyof T]: K extends "__proto__"
		? never
		: {} extends Record<K, unknown>
			? never
			: {} extends Pick<T, K>
				? string | undefined
				: string;
};

/**
 * `unknown` when a table can list `T` whole; otherwise a type no table is,
 * whose text says why. Both conditions are about `T` as a whole, so they are
 * checked on its table rather than field by field in {@link WireFields}:
 *
 * - `T` is one shape (see {@link SameFields});
 * - no field of `T` is typed `any`, which every field check accepts — `any`
 *   is assignable to whatever a check asks for — while the parser refuses or
 *   drops whatever is not a string.
 */
type WholeTable<T> = [SameFields<T>] extends [true]
	? 0 extends 1 & T[keyof T]
		? "a wire field is never typed any"
		: unknown
	: "every shape of a wire message has the same fields";

/** Every field any member of `T` has. */
type FieldOf<T> = T extends unknown ? keyof T : never;

/** Every field any member of `T` has that may be absent from it. */
type OptionalFieldOf<T> = T extends unknown ? { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T] : never;

/**
 * Whether every member of `T` has the same fields, each optional in all of
 * them or in none. A parser table lists one set of fields, so a member with
 * another set is parsed into the wrong one, its own fields dropped.
 *
 * Compared field by field, never by assignability: a second member that
 * only adds an optional field, or an index signature, is assignable to the
 * first and the first to it, yet a list of the first's fields drops it.
 */
type SameFields<T, Member = T> = [
	Member extends unknown
		? [FieldOf<T>] extends [keyof Member]
			? [OptionalFieldOf<T>] extends [OptionalFieldOf<Member>]
				? never
				: false
			: false
		: never,
] extends [never]
	? true
	: false;

/**
 * `T`, the request shapes that admit `Op`, when they are one shape and name
 * `Op` alone; otherwise a type nothing a parser returns can be, whose text
 * says why. A parser's table describes one shape for one op: a second shape
 * for an op has its own fields dropped, and a shape whose `op` admits two
 * ops is parsed by each of their parsers as if it were theirs.
 */
type OneShape<T, Op> = [OtherOps<T, Op>] extends [never]
	? [SameFields<T>] extends [true]
		? T
		: "an op names exactly one request shape"
	: "a request shape names exactly one op";

/** The members of `T` whose `op` admits anything but `Op`. */
type OtherOps<T, Op> = T extends { op: infer Ops } ? ([Ops] extends [Op] ? never : T) : T;

/**
 * The request shapes for one op: every shape whose `op` admits it. Not
 * `Extract<ArtifactRequest, { op: Op }>`, which leaves a shape whose `op`
 * admits two ops out of both of their parsers, where no check sees it.
 */
type RequestOf<Op extends ArtifactRequest["op"]> = Admitting<ArtifactRequest, Op>;

/** The members of `T` whose `op` admits `Op`. */
type Admitting<T, Op> = T extends { op: infer Ops } ? (Op extends Ops ? T : never) : never;

const SETTLED_ARTIFACT_FIELDS: Presence<SettledArtifact> = {
	path: "required",
	device: "required",
	inode: "required",
	file: "optional",
	root: "optional",
	text: "optional",
};

/**
 * The parser for each op, each against the request shape that op names.
 *
 * Per op, never against the union: checked against `ArtifactRequest` as a
 * whole, a `take` given a field that is not a string still fits the
 * `release` shape and compiles — and the parser then refuses every such
 * request at run time. Each entry names its op, so its table is checked for
 * that shape's fields and `shapeOf` for their being strings; the mapped type
 * makes an op without an entry a compile error, and an entry may return only
 * `OneShape` of the shapes that admit its op, so a second shape for an op,
 * or a shape whose `op` admits two, is one too. An op that is no literal at
 * all — `string`, or a pattern such as `` `take-${string}` `` — is a key no
 * entry has to exist for, so it is refused outright.
 * `artifact-wire-edits.test.ts` makes each of those edits to a copy of this
 * module and holds it to that.
 */
const REQUEST_PARSERS: [UnlistedOp<ArtifactRequest["op"]>] extends [never]
	? { readonly [Op in ArtifactRequest["op"]]: (value: object) => OneShape<RequestOf<Op>, Op> | null }
	: "a request op is a literal string" = {
	answer: value =>
		shapeOf<RequestOf<"answer">>({ op: "required", id: "required", root: "required", token: "optional" }, value),
	locate: value =>
		shapeOf<RequestOf<"locate">>({ op: "required", id: "required", root: "required", token: "optional" }, value),
	take: value => shapeOf<RequestOf<"take">>({ op: "required", file: "required" }, value),
	release: value => shapeOf<RequestOf<"release">>({ op: "required", file: "required" }, value),
};

/** The members of `Op` no table key can name one by one: `string`, or a pattern. */
type UnlistedOp<Op> = Op extends string ? ({} extends Record<Op, unknown> ? Op : never) : never;

/**
 * Every field `fields` names, copied whole from `value`; `null` when a
 * required one is missing or is not a string.
 *
 * There is no per-field code to forget a field in: the table is the list,
 * and the table is checked against the type — against one shape of it, so
 * a type with two cannot hide the second's fields from it. The constraint is
 * what makes that check mean "parsed whole": each field of `T` is something
 * this parser hands back as it came.
 */
function shapeOf<T extends WireFields<T>>(fields: Presence<T> & WholeTable<T>, value: unknown): T | null {
	if (typeof value !== "object" || value === null) return null;
	const shaped: Record<string, string> = {};
	// `Object.keys` types its result as `string[]`; these are the table's own keys.
	for (const field of Object.keys(fields) as (keyof T & string)[]) {
		const item: unknown = Reflect.get(value, field);
		if (typeof item === "string") shaped[field] = item;
		else if (fields[field] === "required") return null;
	}
	// Every required field of `T` is here, and every field of `T` is a string.
	const settled = shaped as T;
	return settled;
}

/** The host's answer about an artifact, as it crosses the bridge (`{ text, details }`). */
export function settledArtifactOf(value: unknown): SettledArtifact | null {
	if (typeof value !== "object" || value === null || !("details" in value)) return null;
	// Named, not inferred: inferred from the table, `T` is whatever the table
	// spells, and the check that each field is a string never sees the interface.
	return shapeOf<SettledArtifact>(SETTLED_ARTIFACT_FIELDS, value.details);
}

function isRequestOp(op: unknown): op is ArtifactRequest["op"] {
	return typeof op === "string" && Object.hasOwn(REQUEST_PARSERS, op);
}

/** A reader's request, as it arrives at the host; `null` for anything that is not one. */
export function artifactRequestOf(value: unknown): ArtifactRequest | null {
	if (typeof value !== "object" || value === null) return null;
	// Every field read once, here, so the op that picks the parser is the op
	// the parser reads — whatever `value` would answer if asked again.
	const sent: Record<string, unknown> = { ...value };
	const op = sent.op;
	return isRequestOp(op) ? REQUEST_PARSERS[op](sent) : null;
}
