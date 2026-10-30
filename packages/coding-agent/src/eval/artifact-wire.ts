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
	 * The hold this answer was read through, for a cell that was given none.
	 *
	 * A cell started before its artifacts directory existed has no token, and
	 * taking a fresh hold at every read would let the directory change under
	 * it between two reads. Its first read binds it: the token comes back here
	 * and the reader sends it with everything after.
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

/** A shape every field of which is a string, which is all this wire carries. */
type StringShape<T> = { [K in keyof T]: string | undefined };

const SETTLED_ARTIFACT_FIELDS: Presence<SettledArtifact> = {
	path: "required",
	device: "required",
	inode: "required",
	file: "optional",
	root: "optional",
	text: "optional",
};

const REQUEST_FIELDS: { readonly [Op in ArtifactRequest["op"]]: Presence<Extract<ArtifactRequest, { op: Op }>> } = {
	answer: { op: "required", id: "required", root: "required", token: "optional" },
	locate: { op: "required", id: "required", root: "required", token: "optional" },
	take: { op: "required", file: "required" },
	release: { op: "required", file: "required" },
};

/**
 * Every field `fields` names, copied whole from `value`; `null` when a
 * required one is missing or is not a string.
 *
 * There is no per-field code to forget a field in: the table is the list,
 * and the table is checked against the type.
 */
function shapeOf<T extends StringShape<T>>(fields: Presence<T>, value: unknown): T | null {
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
	return shapeOf(SETTLED_ARTIFACT_FIELDS, value.details);
}

function isRequestOp(op: unknown): op is ArtifactRequest["op"] {
	return typeof op === "string" && Object.hasOwn(REQUEST_FIELDS, op);
}

/** A reader's request, as it arrives at the host; `null` for anything that is not one. */
export function artifactRequestOf(value: unknown): ArtifactRequest | null {
	if (typeof value !== "object" || value === null || !("op" in value) || !isRequestOp(value.op)) return null;
	// The table for this request's own op: the shape it is parsed into is the one its op names.
	const fields = REQUEST_FIELDS[value.op] as Presence<ArtifactRequest>;
	return shapeOf<ArtifactRequest>(fields, value);
}
