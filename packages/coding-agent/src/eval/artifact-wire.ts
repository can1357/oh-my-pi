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
 * field is. The parser checks only that a field is a string, so a required
 * field must be one — never a type that admits `undefined`, which the parser
 * would refuse — and an optional one, when it is there. A field named
 * `__proto__` cannot be one at all: written into a table it sets the table's
 * prototype rather than naming a key, and the parser would never read it.
 */
type WireFields<T> = {
	[K in keyof T]: K extends "__proto__" ? never : {} extends Pick<T, K> ? string | undefined : string;
};

/**
 * `T` when it is one shape; when it is several, a type nothing a parser
 * returns can be, whose text says why. A parser table describes one shape,
 * so a union parsed for one op — two request variants with the same `op` —
 * would have every shape but one parsed into the wrong one, its own fields
 * dropped. (The answer needs no such check: an interface is always one shape.)
 *
 * Compared with the intersection of the members rather than with each
 * member: a second variant that only adds fields to the first is a subtype
 * of it, so the union is assignable to the first member alone, yet it is not
 * assignable to the shape that has every field.
 */
type OneShape<T> = [T] extends [AllOf<T>] ? T : "an op names exactly one request shape";

/** The intersection of the members of `T`. */
type AllOf<T> = (T extends unknown ? (shape: T) => void : never) extends (shape: infer All) => void ? All : never;

/** The request shape for one op. */
type RequestOf<Op extends ArtifactRequest["op"]> = Extract<ArtifactRequest, { op: Op }>;

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
 * `OneShape` of its op's requests, so an op that names two shapes is one too.
 * `artifact-wire-edits.test.ts` makes each of those edits to a copy of this
 * module and holds it to that.
 */
const REQUEST_PARSERS: {
	readonly [Op in ArtifactRequest["op"]]: (value: object) => OneShape<RequestOf<Op>> | null;
} = {
	answer: value =>
		shapeOf<RequestOf<"answer">>({ op: "required", id: "required", root: "required", token: "optional" }, value),
	locate: value =>
		shapeOf<RequestOf<"locate">>({ op: "required", id: "required", root: "required", token: "optional" }, value),
	take: value => shapeOf<RequestOf<"take">>({ op: "required", file: "required" }, value),
	release: value => shapeOf<RequestOf<"release">>({ op: "required", file: "required" }, value),
};

/**
 * Every field `fields` names, copied whole from `value`; `null` when a
 * required one is missing or is not a string.
 *
 * There is no per-field code to forget a field in: the table is the list,
 * and the table is checked against the type. The constraint is what makes
 * that check mean "parsed whole": each field of `T` is something this
 * parser hands back as it came.
 */
function shapeOf<T extends WireFields<T>>(fields: Presence<T>, value: unknown): T | null {
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
	if (typeof value !== "object" || value === null || !("op" in value) || !isRequestOp(value.op)) return null;
	return REQUEST_PARSERS[value.op](value);
}
