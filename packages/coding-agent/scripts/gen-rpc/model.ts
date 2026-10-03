/**
 * Normalizes the RPC wire bundle (JSON Schema 2020-12 + `x-rpc`) into a small
 * type model shared by every language emitter.
 *
 * Emitters read only the bundle, never the omptype source, so the bundle is
 * proven sufficient for generators written in other languages.
 */
import type { RpcWireBundle, RpcWireCommand } from "../../src/modes/rpc/wire";

/** A wire type reference or inline shape. */
export type WireType =
	| { kind: "string" | "integer" | "number" | "boolean" | "null" | "unknown" }
	| { kind: "literal"; value: string | number | boolean }
	| { kind: "enum"; values: string[] }
	| { kind: "ref"; name: string }
	| { kind: "array"; items: WireType }
	| { kind: "record"; values: WireType }
	| { kind: "union"; members: WireType[] };

/** One property of an object definition. */
export interface WireField {
	/** Wire key. */
	key: string;
	type: WireType;
	/** Must be present on the wire. */
	required: boolean;
	/** Decoders substitute this when the key is absent; `hasDefault` distinguishes a `null` default. */
	hasDefault: boolean;
	default?: unknown;
	doc?: string;
	/** `x-unknown-fallback`: a value that fails to decode becomes an unknown notification. */
	unknownFallback?: boolean;
	/** `x-scalar-or-array`: an array field older servers sent as a bare scalar. */
	scalarOrArray?: boolean;
}

/** A named definition. */
export type WireDef =
	| {
			name: string;
			doc?: string;
			kind: "object";
			fields: WireField[];
			/** Open record (`x-open`): decoders check the discriminator and keep every key. */
			open: boolean;
	  }
	| { name: string; doc?: string; kind: "alias"; type: WireType };

/** Discriminated union definition: dispatch on `property` to a direct member. */
export interface WireDispatch {
	property: string;
	/** Discriminator value → direct member definition name. */
	cases: Map<string, string>;
}

export interface WireModel {
	defs: Map<string, WireDef>;
	commands: RpcWireCommand[];
	notification: string;
	sessionEvent: string;
	serverFrame: string;
	inbound: string;
}

type JsonSchema = Record<string, unknown>;

const REF_PREFIX = "#/$defs/";

function parseType(schema: JsonSchema, where: string): WireType {
	if (typeof schema.$ref === "string") {
		if (!schema.$ref.startsWith(REF_PREFIX)) throw new Error(`${where}: unsupported $ref ${schema.$ref}`);
		return { kind: "ref", name: schema.$ref.slice(REF_PREFIX.length) };
	}
	if ("const" in schema) {
		const value = schema.const;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
			throw new Error(`${where}: unsupported const`);
		}
		return { kind: "literal", value };
	}
	if (Array.isArray(schema.enum)) {
		if (!schema.enum.every(value => typeof value === "string")) throw new Error(`${where}: non-string enum`);
		return { kind: "enum", values: schema.enum as string[] };
	}
	if (Array.isArray(schema.anyOf)) {
		return {
			kind: "union",
			members: (schema.anyOf as JsonSchema[]).map((member, index) => parseType(member, `${where}|${index}`)),
		};
	}
	switch (schema.type) {
		case "string":
		case "integer":
		case "number":
		case "boolean":
		case "null":
			return { kind: schema.type };
		case "array":
			if (schema.prefixItems) throw new Error(`${where}: tuples are not supported on the wire`);
			return { kind: "array", items: parseType((schema.items ?? {}) as JsonSchema, `${where}[]`) };
		case "object": {
			const properties = (schema.properties ?? {}) as JsonSchema;
			if (Object.keys(properties).length > 0) {
				throw new Error(`${where}: inline objects must be named definitions`);
			}
			return { kind: "record", values: parseType((schema.additionalProperties ?? {}) as JsonSchema, `${where}{}`) };
		}
		case undefined:
			if (Object.keys(schema).every(key => key === "description" || key === "default")) return { kind: "unknown" };
	}
	throw new Error(`${where}: unsupported schema ${JSON.stringify(schema)}`);
}

function parseDef(name: string, schema: JsonSchema): WireDef {
	const doc = typeof schema.description === "string" ? schema.description : undefined;
	const properties = schema.properties as Record<string, JsonSchema> | undefined;
	if (schema.type === "object" && properties && Object.keys(properties).length > 0) {
		const required = new Set((schema.required ?? []) as string[]);
		const fields: WireField[] = [];
		for (const key in properties) {
			const property = properties[key];
			fields.push({
				key,
				type: parseType(property, `${name}.${key}`),
				required: required.has(key),
				hasDefault: "default" in property,
				default: property.default,
				doc: typeof property.description === "string" ? property.description : undefined,
				unknownFallback: property["x-unknown-fallback"] === true,
				scalarOrArray: property["x-scalar-or-array"] === true,
			});
		}
		return { name, doc, kind: "object", fields, open: schema["x-open"] === true };
	}
	return { name, doc, kind: "alias", type: parseType(schema, name) };
}

/** Builds the emitter model; throws on schema constructs no emitter supports. */
export function buildWireModel(bundle: RpcWireBundle): WireModel {
	const defs = new Map<string, WireDef>();
	for (const name in bundle.$defs) defs.set(name, parseDef(name, bundle.$defs[name]));
	return {
		defs,
		commands: bundle["x-rpc"].commands,
		notification: bundle["x-rpc"].notification,
		sessionEvent: bundle["x-rpc"].sessionEvent,
		serverFrame: bundle["x-rpc"].serverFrame,
		inbound: bundle["x-rpc"].inbound,
	};
}

/** Literal value of `property` on an object definition, if it is a constant. */
export function constantOf(def: WireDef | undefined, property: string): string | undefined {
	if (def?.kind !== "object") return undefined;
	const field = def.fields.find(candidate => candidate.key === property);
	return field?.type.kind === "literal" && typeof field.type.value === "string" ? field.type.value : undefined;
}

/** Members of a union alias that are all definition references; undefined otherwise. */
export function unionMembers(def: WireDef | undefined): string[] | undefined {
	if (def?.kind !== "alias" || def.type.kind !== "union") return undefined;
	const names: string[] = [];
	for (const member of def.type.members) {
		if (member.kind !== "ref") return undefined;
		names.push(member.name);
	}
	return names;
}

/** Object definitions reachable through nested union aliases, in declaration order. */
export function unionLeaves(model: WireModel, name: string): string[] {
	const members = unionMembers(model.defs.get(name));
	if (!members) return [name];
	return members.flatMap(member => unionLeaves(model, member));
}

/**
 * Finds the property that routes a union to its direct members: every leaf has
 * a constant for it, and no value reaches two direct members.
 */
export function unionDispatch(model: WireModel, name: string): WireDispatch | undefined {
	const members = unionMembers(model.defs.get(name));
	if (!members) return undefined;
	for (const property of ["type", "role", "method"]) {
		const cases = new Map<string, string>();
		let routes = true;
		for (const member of members) {
			for (const leaf of unionLeaves(model, member)) {
				const value = constantOf(model.defs.get(leaf), property);
				const routed = value === undefined ? undefined : cases.get(value);
				if (value === undefined || (routed !== undefined && routed !== member)) {
					routes = false;
					break;
				}
				cases.set(value, member);
			}
			if (!routes) break;
		}
		if (routes) return { property, cases };
	}
	return undefined;
}

/** Splits `T | null` into the non-null type, or returns undefined when `type` is not nullable. */
export function nonNull(type: WireType): WireType | undefined {
	if (type.kind !== "union" || !type.members.some(member => member.kind === "null")) return undefined;
	const rest = type.members.filter(member => member.kind !== "null");
	return rest.length === 1 ? rest[0] : { kind: "union", members: rest };
}
