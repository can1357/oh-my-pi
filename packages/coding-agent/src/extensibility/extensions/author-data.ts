import { types } from "node:util";

/**
 * How {@link snapshotAuthorData} copies one value of a session's data.
 *
 * - `data`: an open value — a record whose keys are its content (headers, `compat`, `extraBody`,
 *   a tool's `details`, a provider request payload), a list, or a primitive. Copied as JSON copies
 *   it: each own enumerable string key and each array element, read once. `compat` is one:
 *   unknown keys from a newer release stay intact.
 * - `fields`: a known shape — a model, its cost, its thinking, a hook's result. Copied by reading
 *   each field the shape has, the way a field read reads it, so an inherited or non-enumerable
 *   field and a prototype getter arrive as they would for the host. Nothing else on the object is
 *   read. A field may be symbol-keyed: a host marker the host reads back from what it handed out.
 * - `variants`: a union told apart by one field (`by`) — a content block by `type`, a message by
 *   `role`. That field is read once and the fields of the variant it names are copied. A value no
 *   variant names is a shape the host does not know; it is copied as data.
 * - `items` / `entries`: a list, or an open record, whose values all have one schema.
 * - `callback`: a function the registry calls through its registration's gate — a projected
 *   `resolveHeaders` — kept as it is.
 */
export type AuthorDataSchema =
	| { readonly kind: "data" }
	| { readonly kind: "callback" }
	| AuthorDataFields
	| { readonly kind: "variants"; readonly by: string; readonly variants: ReadonlyMap<unknown, AuthorDataFields> }
	| { readonly kind: "items"; readonly items: AuthorDataSchema }
	| { readonly kind: "entries"; readonly entries: AuthorDataSchema };

export interface AuthorDataFields {
	readonly kind: "fields";
	readonly fields: readonly (readonly [field: PropertyKey, schema: AuthorDataSchema])[];
}

export const DATA: AuthorDataSchema = { kind: "data" };
export const CALLBACK: AuthorDataSchema = { kind: "callback" };

/** Every key any member of `T` has. A union's own `keyof` is only the keys its members share, so
 *  a field one member alone declares would otherwise go uncopied without a compile error. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** One entry for every field of `T`, including every member's fields when `T` is a union. */
export type AuthorDataFieldMap<T> = { readonly [K in KeysOfUnion<T>]-?: AuthorDataSchema };

/** `Omit` applied to each member of a union, rather than to the keys the members share. */
type OmitFromEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A known shape: one entry for every field of `T`, so a field added to `T` does not compile until
 *  it says how it is copied. */
export function fieldsOf<T>(fields: AuthorDataFieldMap<T>): AuthorDataFields {
	return {
		kind: "fields",
		fields: Reflect.ownKeys(fields).map(field => [field, Reflect.get(fields, field) as AuthorDataSchema] as const),
	};
}

/** A union told apart by `by`: one entry for every value `by` takes, each with every field of the
 *  members that carry it but `by` itself — so neither a new member nor a new field compiles until
 *  it says how it is copied. */
export function variantsOf<U, K extends keyof U & string>(
	by: K,
	variants: {
		readonly [V in U[K] & PropertyKey]: AuthorDataFieldMap<OmitFromEach<Extract<U, Record<K, V>>, K>>;
	},
): AuthorDataSchema {
	return {
		kind: "variants",
		by,
		variants: new Map(
			Reflect.ownKeys(variants).map(tag => [tag, fieldsOf<object>(Reflect.get(variants, tag))] as const),
		),
	};
}

/** Where a copy is taken, for the error that refuses a function where data belongs: whose data,
 *  the path walked to the value (its root first), and what the author does instead. */
export interface AuthorDataSite {
	readonly subject: string;
	readonly path: PropertyKey[];
	readonly advice: string;
}

function renderAuthorDataPath(path: readonly PropertyKey[]): string {
	let rendered = "";
	for (const step of path) {
		if (rendered === "") rendered = String(step);
		else if (typeof step === "number" || typeof step === "symbol") rendered += `[${String(step)}]`;
		else if (/^[A-Za-z_$][\w$]*$/.test(step)) rendered += `.${step}`;
		else rendered += `[${JSON.stringify(step)}]`;
	}
	return rendered;
}

type TypedArrayConstructor = new (source: ArrayBufferView) => ArrayBufferView;

/** `%TypedArray%.prototype[Symbol.toStringTag]`: a typed array's own kind, read from its internal
 *  slot — not from its prototype chain, which its author may have replaced. */
const typedArrayKind = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)
	?.get as (this: unknown) => string | undefined;

/**
 * The copy of a built-in that carries data JSON cannot: a typed array or an array buffer (a request
 * payload carries image bytes as one), or a date. Each is read from its internal slots, so no
 * author code runs, and the copy is a fresh object the author holds no reference to — a shared
 * buffer included. `undefined` for anything else.
 */
export function copyBuiltInData(value: object): object | undefined {
	if (ArrayBuffer.isView(value)) {
		const kind = Reflect.apply(typedArrayKind, value, []);
		if (kind === undefined) return undefined;
		return new (Reflect.get(globalThis, kind) as TypedArrayConstructor)(value);
	}
	if (types.isAnyArrayBuffer(value)) return new Uint8Array(value).slice().buffer;
	if (types.isDate(value)) return new Date(Reflect.apply(Date.prototype.getTime, value, []));
	return undefined;
}

function copyAuthorFields(
	value: object,
	fields: AuthorDataFields["fields"],
	copy: Record<PropertyKey, unknown>,
	site: AuthorDataSite,
	copies: Map<AuthorDataSchema, Map<object, unknown>>,
): void {
	for (const [key, fieldSchema] of fields) {
		site.path.push(key);
		const item = snapshotAuthorData((value as Record<PropertyKey, unknown>)[key], fieldSchema, site, copies);
		site.path.pop();
		if (item !== undefined) copy[key] = item;
	}
}

function copyAuthorEntries(
	value: object,
	entrySchema: AuthorDataSchema,
	copy: Record<string, unknown>,
	site: AuthorDataSite,
	copies: Map<AuthorDataSchema, Map<object, unknown>>,
	skip?: string,
): void {
	for (const key of Object.keys(value)) {
		if (key === skip) continue;
		site.path.push(key);
		const item = snapshotAuthorData((value as Record<string, unknown>)[key], entrySchema, site, copies);
		site.path.pop();
		// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
		if (key === "__proto__") {
			Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
		} else {
			copy[key] = item;
		}
	}
}

/**
 * A host-owned plain copy of data an author handed over, taken inside that author's admission: a
 * provider registration's data, what a provider callback returns, what a hook returns, what a tool
 * returns or streams.
 *
 * The objects an author hands over are the author's code just the same as its functions: a
 * getter, or a Proxy's `ownKeys`, `getOwnPropertyDescriptor` and `get` traps, runs whenever the
 * host enumerates or reads them — and the host does both long after the call, merging headers and
 * serializing `compat` into a request, persisting a tool result, acting on a hook's verdict. So
 * the data the host keeps is copied here by its {@link AuthorDataSchema}, each value read once,
 * and only the copy is consumed afterwards. This reads the author's data under admission; it does
 * not wrap the author's object.
 *
 * Data holds no functions. A function where data belongs — a `toJSON` a request's serializer would
 * call, a callable record whose reflection the request builder would run — would be author code
 * the host invokes later with no admission to run under, so it is refused, with the field it was
 * found at. The callbacks the registry invokes itself are not data: they stay on the author's
 * object, read and called through their registration's gate when used. The data is JSON-shaped;
 * of the other built-ins only binary data and dates are reproduced ({@link copyBuiltInData}).
 *
 * Shared by `config/model-registry.ts` (provider registrations and what their callbacks return),
 * `extensions/runner.ts` (hook results) and `extensions/wrapper.ts` (tool results).
 */
export function snapshotAuthorData(
	value: unknown,
	schema: AuthorDataSchema,
	site: AuthorDataSite,
	copies: Map<AuthorDataSchema, Map<object, unknown>>,
): unknown {
	if (schema.kind === "callback") return value;
	if (typeof value === "function") {
		throw new Error(
			`${site.subject}: ${renderAuthorDataPath(site.path)} is a function, but it must be data. ${site.advice}`,
		);
	}
	if (typeof value !== "object" || value === null) return value;
	let copied = copies.get(schema);
	if (!copied) {
		copied = new Map();
		copies.set(schema, copied);
	}
	const known = copied.get(value);
	if (known !== undefined) return known;
	const builtIn = copyBuiltInData(value);
	if (builtIn !== undefined) {
		copied.set(value, builtIn);
		return builtIn;
	}
	if (Array.isArray(value)) {
		const itemSchema = schema.kind === "items" ? schema.items : DATA;
		const copy: unknown[] = [];
		copied.set(value, copy);
		const length = value.length;
		for (let index = 0; index < length; index++) {
			site.path.push(index);
			copy[index] = snapshotAuthorData(value[index], itemSchema, site, copies);
			site.path.pop();
		}
		return copy;
	}
	const copy: Record<PropertyKey, unknown> = {};
	copied.set(value, copy);
	switch (schema.kind) {
		case "fields":
			copyAuthorFields(value, schema.fields, copy, site, copies);
			return copy;
		case "variants": {
			site.path.push(schema.by);
			const tag = snapshotAuthorData((value as Record<string, unknown>)[schema.by], DATA, site, copies);
			site.path.pop();
			if (tag !== undefined) copy[schema.by] = tag;
			const variant = schema.variants.get(tag);
			if (variant) copyAuthorFields(value, variant.fields, copy, site, copies);
			else copyAuthorEntries(value, DATA, copy, site, copies, schema.by);
			return copy;
		}
		default:
			copyAuthorEntries(value, schema.kind === "entries" ? schema.entries : DATA, copy, site, copies);
			return copy;
	}
}
