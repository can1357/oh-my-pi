import type { IR, PropIR } from "./ir";

export interface JsonSchemaOptions {
	description?: string;
	target?: string;
	dialect?: string | null;
	/**
	 * Which side of morphs and defaults to describe:
	 * - `'input'` — accepted payloads: morphs emit their input shape, defaulted
	 *   properties are optional (with `default` annotations).
	 * - `'output'` — produced values: morphs emit their output shape, defaulted
	 *   properties are required (always present after validation).
	 * Unset keeps the hybrid legacy behavior (morph output, defaults optional).
	 */
	io?: "input" | "output";
	fallback?: (context: { base: Record<string, unknown> }) => unknown;
}

type JsonSchema = Record<string, unknown>;

interface EmitCtx {
	options?: JsonSchemaOptions;
	/** Emitted alias definitions, attached as `$defs` on the root schema. */
	defs: Map<string, JsonSchema>;
	/** Alias resolver identity → assigned `$defs` name (cycle-safe). */
	refs: Map<() => IR, string>;
}

/** Emit the requested JSON Schema dialect represented by an IR tree. */
export function irToJsonSchema(ir: IR, options?: JsonSchemaOptions): JsonSchema {
	const ctx: EmitCtx = { options, defs: new Map(), refs: new Map() };
	let schema = emit(ir, ctx);
	if (ctx.defs.size > 0) schema.$defs = Object.fromEntries(ctx.defs);
	if (options?.target === "draft-07") schema = toDraft7(schema);
	const dialect = options?.dialect === null ? undefined : (options?.dialect ?? dialectFor(options?.target));
	if (dialect !== undefined) schema.$schema = dialect;
	if (options?.description !== undefined) schema.description = options.description;
	return schema;
}

function dialectFor(target: string | undefined): string | undefined {
	if (target === "draft-2020-12") return "https://json-schema.org/draft/2020-12/schema";
	if (target === "draft-07") return "http://json-schema.org/draft-07/schema#";
	return target !== undefined && (target.startsWith("http://") || target.startsWith("https://")) ? target : undefined;
}

function fallback(schema: JsonSchema, ctx: EmitCtx): JsonSchema {
	const replacement = ctx.options?.fallback?.({ base: schema });
	if (replacement === true) return {};
	if (replacement === false) return { not: {} };
	return typeof replacement === "object" && replacement !== null ? (replacement as JsonSchema) : schema;
}

function toDraft7(schema: JsonSchema): JsonSchema {
	const converted: JsonSchema = {};
	for (const key in schema) {
		const value = schema[key];
		if (key === "$ref" && typeof value === "string") {
			converted.$ref = value.replace("#/$defs/", "#/definitions/");
		} else if (key === "$defs") {
			converted.definitions = toDraft7(value as JsonSchema);
		} else if (key === "prefixItems" && Array.isArray(value)) {
			converted.items = value.map(item =>
				typeof item === "object" && item !== null ? toDraft7(item as JsonSchema) : item,
			);
		} else if (key === "items" && "prefixItems" in schema) {
			converted.additionalItems =
				typeof value === "object" && value !== null ? toDraft7(value as JsonSchema) : value;
		} else if (Array.isArray(value)) {
			converted[key] = value.map(item =>
				typeof item === "object" && item !== null ? toDraft7(item as JsonSchema) : item,
			);
		} else if (typeof value === "object" && value !== null) {
			converted[key] = toDraft7(value as JsonSchema);
		} else {
			converted[key] = value;
		}
	}
	return converted;
}

function emit(ir: IR, ctx: EmitCtx): JsonSchema {
	let schema: JsonSchema;
	switch (ir.k) {
		case "unknown":
			schema = {};
			break;
		case "undefined":
			schema = fallback({}, ctx);
			break;
		case "null":
			schema = { type: "null" };
			break;
		case "boolean":
			schema = { type: "boolean" };
			break;
		case "bigint":
			schema = { type: "integer" };
			break;
		case "symbol":
			schema = fallback({}, ctx);
			break;
		case "never":
			schema = { not: {} };
			break;
		case "anyobject":
			schema = { type: "object" };
			break;
		case "string":
			schema = emitString(ir);
			break;
		case "number":
			schema = emitNumber(ir);
			break;
		case "lit":
			schema = emitLiteral(ir.v);
			break;
		case "union":
			schema = emitUnion(ir.members, ctx);
			break;
		case "intersection":
			schema = { allOf: ir.members.map(member => emit(member, ctx)) };
			break;
		case "array":
			schema = { type: "array", items: emit(ir.el, ctx) };
			if (ir.min !== undefined) schema.minItems = ir.min;
			if (ir.max !== undefined) schema.maxItems = ir.max;
			break;
		case "tuple": {
			const prefixItems = ir.prefix.map(item => {
				const itemSchema = emit(item.val, ctx);
				if (item.hasDefault) {
					itemSchema.default = item.defFactory && typeof item.def === "function" ? item.def() : item.def;
				}
				return itemSchema;
			});
			const required = ir.prefix.reduce(
				(count, item) => count + (item.opt || item.hasDefault ? 0 : 1),
				ir.postfix.length,
			);
			schema = { type: "array", prefixItems, minItems: required };
			if (ir.variadic === undefined) {
				schema.items = false;
			} else {
				schema.items = emit(ir.variadic, ctx);
			}
			break;
		}
		case "object":
			schema = emitObject(ir.props, ir.index, ir.extras, ctx);
			break;
		case "instance":
			schema = ir.ctor === Date ? { type: "string", format: "date-time" } : fallback({ type: "object" }, ctx);
			break;
		case "refine":
			schema = emit(ir.base, ctx);
			if (ir.json !== undefined) Object.assign(schema, ir.json);
			break;
		case "morph":
			schema = ctx.options?.io === "input" ? emit(ir.input, ctx) : fallback(emit(ir.out ?? ir.input, ctx), ctx);
			break;
		case "alias": {
			const known = ctx.refs.get(ir.resolve);
			if (known !== undefined) {
				schema = { $ref: `#/$defs/${known}` };
				break;
			}
			// Register before lowering so cyclic aliases resolve to the same $ref
			// instead of recursing forever.
			let name = ir.name.replace(/[^\w.-]/g, "_");
			while ([...ctx.refs.values()].includes(name)) name = `${name}_`;
			ctx.refs.set(ir.resolve, name);
			ctx.defs.set(name, emit(ir.resolve(), ctx));
			schema = { $ref: `#/$defs/${name}` };
			break;
		}
		case "sub":
			if (ctx.options?.io === "output" && ir.schema.opaqueOutput) {
				schema = {};
			} else if (ctx.options?.io === "output" && ir.schema.stepOut !== undefined) {
				schema = emit(ir.schema.stepOut, ctx);
			} else if (ctx.options?.io === "input") {
				schema = emit(ir.schema.ir, ctx);
			} else {
				schema = ir.schema.hasSteps ? fallback(emit(ir.schema.ir, ctx), ctx) : emit(ir.schema.ir, ctx);
			}
			if (ir.schema.ir.desc !== undefined) schema.description = ir.schema.ir.desc;
			else if (ir.schema.description !== undefined && ir.descAuto !== true) {
				schema.description = ir.schema.description;
			}
			break;
	}
	if (ir.desc !== undefined && ir.descAuto !== true) schema.description = ir.desc;
	return schema;
}

function emitString(ir: Extract<IR, { k: "string" }>): JsonSchema {
	const schema: JsonSchema = { type: "string" };
	if (ir.min !== undefined) schema.minLength = ir.min;
	if (ir.max !== undefined) schema.maxLength = ir.max;
	if (ir.url) schema.format = "uri";
	return schema;
}

function emitNumber(ir: Extract<IR, { k: "number" }>): JsonSchema {
	const schema: JsonSchema = { type: ir.int ? "integer" : "number" };
	if (ir.min !== undefined) schema[ir.xmin ? "exclusiveMinimum" : "minimum"] = ir.min;
	if (ir.max !== undefined) schema[ir.xmax ? "exclusiveMaximum" : "maximum"] = ir.max;
	if (ir.divisor !== undefined) schema.multipleOf = ir.divisor;
	return schema;
}

function emitLiteral(value: unknown): JsonSchema {
	if (value instanceof Date) return { type: "string", format: "date-time", const: value.toISOString() };
	if (isJsonValue(value)) return { const: value };
	switch (typeof value) {
		case "string":
			return { type: "string" };
		case "number":
			return { type: "number" };
		case "boolean":
			return { type: "boolean" };
		case "bigint":
			return { type: "integer" };
		case "object":
			return { type: "object" };
		default:
			return {};
	}
}

function emitUnion(members: IR[], ctx: EmitCtx): JsonSchema {
	const defined = members.filter(member => member.k !== "undefined");
	if (defined.length === 0) return {};
	if (defined.length === 1) return emit(defined[0], ctx);
	if (defined.every(member => member.k === "lit" && isJsonValue(member.v))) {
		const values = defined.map(member => (member as Extract<IR, { k: "lit" }>).v);
		const schema: JsonSchema = { enum: values };
		const scalarType = homogeneousScalarType(values);
		if (scalarType !== undefined) schema.type = scalarType;
		return schema;
	}
	return { anyOf: defined.map(member => emit(member, ctx)) };
}

function homogeneousScalarType(values: unknown[]): string | undefined {
	const first = jsonScalarType(values[0]);
	if (first === undefined) return undefined;
	for (let i = 1; i < values.length; i++) {
		if (jsonScalarType(values[i]) !== first) return undefined;
	}
	return first;
}

function jsonScalarType(value: unknown): string | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
		case "number":
		case "boolean":
			return typeof value;
		default:
			return undefined;
	}
}

function emitObject(
	props: PropIR[],
	index: IR | undefined,
	extras: "keep" | "reject" | "delete",
	ctx: EmitCtx,
): JsonSchema {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	const filled = (prop: PropIR): boolean => !prop.opt && (ctx.options?.io === "output" || !prop.hasDefault);
	// ArkType emits required properties first (each group in declaration
	// order); downstream wire consumers rely on that stable ordering.
	const ordered = [...props.filter(filled), ...props.filter(prop => !filled(prop))];
	for (const prop of ordered) {
		if (typeof prop.key === "symbol") throw new TypeError("Cannot convert a symbol to a string");
		const key = String(prop.key);
		const propertySchema = emit(prop.val, ctx);
		if (prop.hasDefault) {
			propertySchema.default = prop.defFactory ? (prop.def as () => unknown)() : prop.def;
		}
		properties[key] = propertySchema;
		if (filled(prop)) required.push(key);
	}
	const schema: JsonSchema = { type: "object", properties };
	if (required.length > 0) schema.required = required;
	if (index !== undefined) schema.additionalProperties = emit(index, ctx);
	else if (extras === "reject") schema.additionalProperties = false;
	return schema;
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (!isJsonValue(item, seen)) return false;
		}
		seen.delete(value);
		return true;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	for (const key in value) {
		if (Object.hasOwn(value, key) && !isJsonValue((value as Record<string, unknown>)[key], seen)) return false;
	}
	seen.delete(value);
	return true;
}
