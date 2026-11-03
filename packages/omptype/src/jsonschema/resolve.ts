/**
 * Schema resource registry: base URIs, `$id`/`$anchor`/`$dynamicAnchor`
 * identifiers, dialects, vocabularies, and `$ref` resolution across the root
 * document and caller-supplied documents.
 *
 * Only subschemas under known applicator keywords are indexed, so an `$id`
 * inside `enum` or an unknown keyword is not an identifier. JSON Pointer
 * fragments may still point anywhere; their target inherits the base URI of
 * the nearest indexed ancestor.
 */
import { OmpTypeError } from "../errors";
import { parseLocalRefPointer } from "../local-ref";

/** Keyword semantics: draft 2020-12, 2019-09 (array `items`, no `$dynamicRef`), or 7 (also 4/6). */
export type Draft = "2020-12" | "2019-09" | "7";

/** Vocabulary flags gating keyword groups; resources default to all of them. */
export const VOCAB_APPLICATOR = 1;
export const VOCAB_VALIDATION = 2;
export const VOCAB_UNEVALUATED = 4;
const VOCAB_ALL = VOCAB_APPLICATOR | VOCAB_VALIDATION | VOCAB_UNEVALUATED;

/** A schema resource: a document root or a subschema with its own `$id`. */
export interface Resource {
	/** Absolute URI without fragment. */
	readonly uri: string;
	readonly root: object;
	readonly draft: Draft;
	readonly vocab: number;
	/** `$dynamicAnchor` names declared in this resource, with their subschemas. */
	readonly dynamicAnchors: Map<string, object>;
}

/** Base URI and enclosing resource of a subschema. */
export interface Location {
	readonly base: string;
	readonly resource: Resource;
}

/** A schema reached through a reference, with the location it evaluates in. */
export interface Target {
	readonly schema: unknown;
	readonly location: Location;
}

/** Base URI for documents without an absolute `$id`. */
const DEFAULT_BASE = "omptype:/schema.json";

const SCHEMAS = 1;
const SCHEMA_MAP = 2;

/**
 * Keywords holding subschemas: a schema or array of schemas, or a map of names
 * to schemas. A `Map`, so `then` is no thenable key and `constructor` no hit.
 */
const SUBSCHEMA_KEYWORDS = new Map<string, typeof SCHEMAS | typeof SCHEMA_MAP>([
	["items", SCHEMAS],
	["additionalItems", SCHEMAS],
	["prefixItems", SCHEMAS],
	["contains", SCHEMAS],
	["additionalProperties", SCHEMAS],
	["propertyNames", SCHEMAS],
	["unevaluatedItems", SCHEMAS],
	["unevaluatedProperties", SCHEMAS],
	["not", SCHEMAS],
	["if", SCHEMAS],
	["then", SCHEMAS],
	["else", SCHEMAS],
	["allOf", SCHEMAS],
	["anyOf", SCHEMAS],
	["oneOf", SCHEMAS],
	["contentSchema", SCHEMAS],
	["properties", SCHEMA_MAP],
	["patternProperties", SCHEMA_MAP],
	["$defs", SCHEMA_MAP],
	["definitions", SCHEMA_MAP],
	["dependentSchemas", SCHEMA_MAP],
	["dependencies", SCHEMA_MAP],
]);

const VOCABULARIES: Record<string, number> = {
	applicator: VOCAB_APPLICATOR,
	validation: VOCAB_VALIDATION,
	unevaluated: VOCAB_UNEVALUATED,
};

/** Registry of the documents one `fromJsonSchema` call can reference. */
export class Registry {
	readonly #resources = new Map<string, Resource>();
	readonly #anchors = new Map<string, Target>();
	/** Per-registry index: one subschema object can sit at different bases in different registries. */
	readonly #locations = new Map<object, Location>();
	/** Caller-supplied documents by fragment-free URI, indexed on first use. */
	readonly #pending = new Map<string, unknown>();
	readonly #draft: Draft;

	constructor(draft: Draft, documents: Readonly<Record<string, unknown>> | undefined) {
		this.#draft = draft;
		if (documents === undefined) return;
		for (const key in documents) {
			const uri = stripFragment(parseUri(key) ?? key);
			this.#pending.set(uri, documents[key]);
		}
	}

	/** Index `schema` as the root document and return its target. */
	addRoot(schema: unknown): Target {
		if (typeof schema !== "object" || schema === null) {
			return {
				schema,
				location: { base: DEFAULT_BASE, resource: this.#newResource(DEFAULT_BASE, {}, this.#draft) },
			};
		}
		return this.#addDocument(DEFAULT_BASE, schema);
	}

	/** Location recorded for an indexed subschema. */
	location(schema: object): Location | undefined {
		return this.#locations.get(schema);
	}

	/**
	 * Resolve `ref` against `base` to a schema and its location.
	 *
	 * # Errors
	 * Throws {@link OmpTypeError} for malformed URI references or fragments, and
	 * for targets no known document contains.
	 */
	resolve(ref: string, base: string): Target {
		let uri: string;
		let fragment: string;
		if (ref.charCodeAt(0) === 35) {
			uri = base;
			fragment = ref.slice(1);
		} else {
			const absolute = parseUri(ref, base);
			if (absolute === undefined) throw new OmpTypeError(`invalid $ref: ${ref}`);
			const hash = absolute.indexOf("#");
			uri = hash < 0 ? absolute : absolute.slice(0, hash);
			fragment = hash < 0 ? "" : absolute.slice(hash + 1);
		}
		const resource = this.#resource(uri);
		if (resource === undefined) throw new OmpTypeError(`unresolved $ref: ${ref}`);
		if (fragment === "") return { schema: resource.root, location: this.#locations.get(resource.root)! };
		if (fragment.charCodeAt(0) === 47) return this.#pointer(resource, fragment, ref);
		let name: string;
		try {
			name = decodeURIComponent(fragment);
		} catch {
			throw new OmpTypeError(`invalid $ref: ${ref}`);
		}
		const anchor = this.#anchors.get(`${uri}#${name}`) ?? this.#anchorFromPending(`${uri}#${name}`);
		if (anchor === undefined) throw new OmpTypeError(`unresolved $ref: ${ref}`);
		return anchor;
	}

	#anchorFromPending(key: string): Target | undefined {
		if (this.#pending.size === 0) return undefined;
		this.#indexPending();
		return this.#anchors.get(key);
	}

	#pointer(resource: Resource, fragment: string, ref: string): Target {
		const tokens = parseLocalRefPointer(`#${fragment}`);
		if (tokens === undefined) throw new OmpTypeError(`invalid $ref: ${ref}`);
		let node: unknown = resource.root;
		let location = this.#locations.get(resource.root)!;
		for (const token of tokens) {
			if (Array.isArray(node)) {
				if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= node.length) {
					throw new OmpTypeError(`unresolved $ref: ${ref}`);
				}
				node = node[Number(token)];
			} else if (typeof node === "object" && node !== null && Object.hasOwn(node, token)) {
				node = (node as Record<string, unknown>)[token];
			} else {
				throw new OmpTypeError(`unresolved $ref: ${ref}`);
			}
			if (typeof node === "object" && node !== null) location = this.#locations.get(node) ?? location;
		}
		return { schema: node, location };
	}

	#resource(uri: string): Resource | undefined {
		const known = this.#resources.get(uri);
		if (known !== undefined) return known;
		const document = this.#pending.get(uri);
		if (document !== undefined) {
			this.#pending.delete(uri);
			if (typeof document === "object" && document !== null) this.#addDocument(uri, document);
			return this.#resources.get(uri);
		}
		// The URI may name a resource embedded in a document not yet indexed.
		if (this.#pending.size === 0) return undefined;
		this.#indexPending();
		return this.#resources.get(uri);
	}

	#indexPending(): void {
		for (const [uri, document] of this.#pending) {
			this.#pending.delete(uri);
			if (typeof document === "object" && document !== null && !this.#resources.has(uri)) {
				this.#addDocument(uri, document);
			}
		}
	}

	#addDocument(retrieval: string, root: object): Target {
		const resource = this.#newResource(retrieval, root, this.#draft);
		const location: Location = { base: retrieval, resource };
		this.#index(root, location);
		const own = this.#locations.get(root) ?? location;
		return { schema: root, location: own };
	}

	#newResource(uri: string, root: object, inherited: Draft): Resource {
		const dialect = (root as Record<string, unknown>).$schema;
		let draft = inherited;
		let vocab = VOCAB_ALL;
		if (typeof dialect === "string") {
			const resolved = this.#dialect(stripFragment(parseUri(dialect) ?? dialect), 0);
			if (resolved !== undefined) {
				draft = resolved.draft ?? inherited;
				vocab = resolved.vocab;
			}
		}
		const resource: Resource = { uri, root, draft, vocab, dynamicAnchors: new Map() };
		if (!this.#resources.has(uri)) this.#resources.set(uri, resource);
		return resource;
	}

	/** Draft and vocabularies a `$schema` URI selects; unknown dialects inherit. */
	#dialect(uri: string, depth: number): { draft?: Draft; vocab: number } | undefined {
		if (/^https?:\/\/json-schema\.org\/draft-0[3-7]\/schema$/.test(uri)) return { draft: "7", vocab: VOCAB_ALL };
		if (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema$/.test(uri))
			return { draft: "2020-12", vocab: VOCAB_ALL };
		if (/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema$/.test(uri))
			return { draft: "2019-09", vocab: VOCAB_ALL };
		if (depth > 8) return undefined;
		const meta = this.#resources.get(uri)?.root ?? this.#pending.get(uri);
		if (typeof meta !== "object" || meta === null) return undefined;
		const metaSchema = meta as Record<string, unknown>;
		const parent =
			typeof metaSchema.$schema === "string" && stripFragment(metaSchema.$schema) !== uri
				? this.#dialect(stripFragment(parseUri(metaSchema.$schema) ?? metaSchema.$schema), depth + 1)
				: undefined;
		const vocabularies = metaSchema.$vocabulary;
		if (typeof vocabularies !== "object" || vocabularies === null) return parent;
		let vocab = 0;
		for (const vocabulary in vocabularies) {
			const name = vocabulary.slice(vocabulary.lastIndexOf("/") + 1);
			vocab |= VOCABULARIES[name] ?? 0;
			// Draft 2019-09 kept the unevaluated keywords in its applicator vocabulary.
			if (name === "applicator" && vocabulary.includes("/2019-09/")) vocab |= VOCAB_UNEVALUATED;
		}
		return { draft: parent?.draft ?? "2020-12", vocab };
	}

	#index(node: unknown, parent: Location): void {
		if (typeof node !== "object" || node === null || Array.isArray(node)) return;
		if (this.#locations.has(node)) return;
		const schema = node as Record<string, unknown>;
		let location = parent;
		const draft7 = parent.resource.draft === "7";
		const id = schema.$id;
		let idAnchor: string | undefined;
		if (typeof id === "string" && !(draft7 && typeof schema.$ref === "string")) {
			if (id.charCodeAt(0) === 35) {
				// Draft 7 location-independent identifier: `"$id": "#name"`.
				idAnchor = id.slice(1);
			} else {
				const absolute = parseUri(id, parent.base);
				if (absolute !== undefined) {
					const hash = absolute.indexOf("#");
					const uri = hash < 0 ? absolute : absolute.slice(0, hash);
					if (hash >= 0 && hash < absolute.length - 1) idAnchor = absolute.slice(hash + 1);
					const resource =
						node === parent.resource.root && parent.base === parent.resource.uri
							? this.#adoptRoot(parent.resource, uri)
							: this.#newResource(uri, schema, parent.resource.draft);
					location = { base: uri, resource };
				}
			}
		}
		this.#locations.set(schema, location);
		const anchor = schema.$anchor;
		const dynamicAnchor = schema.$dynamicAnchor;
		if (idAnchor !== undefined || typeof anchor === "string" || typeof dynamicAnchor === "string") {
			const target: Target = { schema, location };
			if (idAnchor !== undefined) this.#anchors.set(`${location.base}#${idAnchor}`, target);
			if (typeof anchor === "string") this.#anchors.set(`${location.base}#${anchor}`, target);
			if (typeof dynamicAnchor === "string") {
				this.#anchors.set(`${location.base}#${dynamicAnchor}`, target);
				location.resource.dynamicAnchors.set(dynamicAnchor, schema);
			}
		}
		for (const keyword in schema) {
			const kind = SUBSCHEMA_KEYWORDS.get(keyword);
			if (kind === undefined) continue;
			const value = schema[keyword];
			if (kind === SCHEMAS) {
				if (Array.isArray(value)) for (const item of value) this.#index(item, location);
				else this.#index(value, location);
			} else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				for (const key in value) this.#index((value as Record<string, unknown>)[key], location);
			}
		}
	}

	/** The document root's own `$id` names the same resource as its retrieval URI. */
	#adoptRoot(resource: Resource, uri: string): Resource {
		if (uri === resource.uri) return resource;
		const adopted: Resource = { ...resource, uri };
		if (!this.#resources.has(uri)) this.#resources.set(uri, adopted);
		// Retrieval URI keeps resolving to the root, now evaluated under its `$id`.
		this.#resources.set(resource.uri, adopted);
		return adopted;
	}
}

/** Absolute form of `reference` resolved against `base`, or `undefined` when unparsable. */
function parseUri(reference: string, base?: string): string | undefined {
	try {
		return new URL(reference, base).href;
	} catch {
		return undefined;
	}
}

function stripFragment(uri: string): string {
	const hash = uri.indexOf("#");
	return hash < 0 ? uri : uri.slice(0, hash);
}
