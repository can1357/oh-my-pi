/**
 * Render a JSON Schema as a simplified, human-readable TypeScript type.
 *
 * This is a *display* conversion, not a faithful TS codegen: it surfaces the
 * shape (objects, arrays, unions, enums, records) and property descriptions so
 * a model — or a human reading `/dump` — can grasp a tool's parameters at a
 * glance, far more legibly than raw JSON Schema. Refinement keywords
 * (min/max/pattern/format) are intentionally dropped; only type structure,
 * literal enums/consts, and descriptions survive.
 */

import { isJsonObject } from "./types";

export interface JsonSchemaToTsOptions {
	/** Indentation unit for nested object bodies. Default two spaces (none in `harmony` style). */
	readonly indent?: string;
	/** Emit `description` keywords as comments on object properties. Default true. */
	readonly comments?: boolean;
	/**
	 * Output flavor. `default` renders JSDoc comments, `;` delimiters, and
	 * indented bodies; `harmony` renders the flat OpenAI-Harmony convention —
	 * `//` line comments, `,` delimiters, no indentation.
	 */
	readonly style?: "default" | "harmony";
}

interface Ctx {
	readonly indent: string;
	readonly comments: boolean;
	readonly harmony: boolean;
	readonly defs: Record<string, unknown> | undefined;
	readonly seen: Set<unknown>;
}

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LOCAL_REF = /^#\/(?:\$defs|definitions)\/(.+)$/;
/** Inline an array item as `T[]` only while it stays a short single token. */
const INLINE_ARRAY_LIMIT = 40;

function literal(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return JSON.stringify(value) ?? "unknown";
}

/** Join member types into a TS union, deduping structurally identical renders. */
function joinUnion(parts: readonly string[]): string {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const part of parts) {
		if (seen.has(part)) continue;
		seen.add(part);
		unique.push(part);
	}
	return unique.length > 0 ? unique.join(" | ") : "never";
}

function emitDescription(lines: string[], description: string, ctx: Ctx, pad: string): void {
	if (ctx.harmony) {
		for (const line of description.split("\n")) lines.push(`${pad}// ${line}`.trimEnd());
		return;
	}
	// `* /` keeps a stray closing token inside the description from ending the comment.
	const safe = description.replace(/\*\//g, "* /");
	if (!safe.includes("\n")) {
		lines.push(`${pad}/** ${safe} */`);
		return;
	}
	lines.push(`${pad}/**`);
	for (const line of safe.split("\n")) lines.push(`${pad} * ${line}`);
	lines.push(`${pad} */`);
}

function convertArray(node: Record<string, unknown>, ctx: Ctx, pad: string): string {
	const prefixItems = node.prefixItems;
	if (Array.isArray(prefixItems)) {
		return `[${prefixItems.map(item => convert(item, ctx, pad)).join(", ")}]`;
	}
	const items = node.items;
	if (items === undefined || items === true) return "unknown[]";
	if (items === false) return "never[]";
	const inner = convert(items, ctx, pad);
	if (inner.includes("\n") || inner.includes(" | ") || inner.length > INLINE_ARRAY_LIMIT) {
		return `Array<${inner}>`;
	}
	return `${inner}[]`;
}

function convertObject(node: Record<string, unknown>, ctx: Ctx, pad: string): string {
	const properties = isJsonObject(node.properties) ? node.properties : undefined;
	const additional = node.additionalProperties;
	const childPad = pad + ctx.indent;

	const body: string[] = [];
	if (properties) {
		const required = new Set(
			Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === "string") : [],
		);
		const delimiter = ctx.harmony ? "," : ";";
		for (const key in properties) {
			const value = properties[key];
			if (
				ctx.comments &&
				isJsonObject(value) &&
				typeof value.description === "string" &&
				value.description.length > 0
			) {
				emitDescription(body, value.description, ctx, childPad);
			}
			const optional = required.has(key) ? "" : "?";
			const name = SAFE_KEY.test(key) ? key : JSON.stringify(key);
			body.push(`${childPad}${name}${optional}: ${convert(value, ctx, childPad)}${delimiter}`);
		}
	}

	// No named properties: pure record / open / empty object.
	if (body.length === 0) {
		if (isJsonObject(additional)) return `Record<string, ${convert(additional, ctx, pad)}>`;
		if (additional === true) return "Record<string, unknown>";
		return "{}";
	}

	// Named properties alongside a free-form value schema → index signature.
	if (isJsonObject(additional)) {
		body.push(`${childPad}[key: string]: ${convert(additional, ctx, childPad)}${ctx.harmony ? "," : ";"}`);
	}
	return `{\n${body.join("\n")}\n${pad}}`;
}

function convertType(type: string, node: Record<string, unknown>, ctx: Ctx, pad: string): string {
	switch (type) {
		case "string":
			return "string";
		case "integer":
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return convertArray(node, ctx, pad);
		case "object":
			return convertObject(node, ctx, pad);
		default:
			return "unknown";
	}
}

function convert(node: unknown, ctx: Ctx, pad: string): string {
	if (node === true) return "unknown";
	if (node === false) return "never";
	if (!isJsonObject(node)) return "unknown";

	const ref = node.$ref;
	if (typeof ref === "string") {
		const match = LOCAL_REF.exec(ref);
		const resolved = match && ctx.defs ? ctx.defs[match[1]] : undefined;
		if (isJsonObject(resolved) && !ctx.seen.has(resolved)) {
			ctx.seen.add(resolved);
			const out = convert(resolved, ctx, pad);
			ctx.seen.delete(resolved);
			return out;
		}
		return ref.slice(ref.lastIndexOf("/") + 1);
	}

	if ("const" in node) return literal(node.const);

	if (Array.isArray(node.enum)) {
		return node.enum.length > 0 ? joinUnion(node.enum.map(literal)) : "never";
	}

	const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
	if (union) return joinUnion(union.map(variant => convert(variant, ctx, pad)));

	if (Array.isArray(node.allOf)) {
		return node.allOf.map(variant => convert(variant, ctx, pad)).join(" & ");
	}

	const type = node.type;
	if (Array.isArray(type)) {
		return joinUnion(type.map(entry => convertType(String(entry), node, ctx, pad)));
	}
	if (typeof type === "string") return convertType(type, node, ctx, pad);

	return "unknown";
}

/** Convert a JSON Schema object into a simplified TypeScript type string. */
export function jsonSchemaToTypeScript(schema: unknown, options?: JsonSchemaToTsOptions): string {
	const root = isJsonObject(schema) ? schema : undefined;
	let defs: Record<string, unknown> | undefined;
	if (root) {
		for (const key of ["definitions", "$defs"] as const) {
			const value = root[key];
			if (isJsonObject(value)) {
				defs ??= {};
				Object.assign(defs, value);
			}
		}
	}
	const harmony = options?.style === "harmony";
	const ctx: Ctx = {
		indent: options?.indent ?? (harmony ? "" : "  "),
		comments: options?.comments ?? true,
		harmony,
		defs,
		seen: new Set(),
	};
	return convert(schema, ctx, "");
}
