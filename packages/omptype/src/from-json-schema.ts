/**
 * JSON Schema → omptype importer.
 *
 * Rebuilds a callable schema from JSON Schema documents — the inverse of
 * `Type.toJsonSchema()` for the dialect omptype (and its Zod/TypeBox
 * adapters) emits: draft-07 and draft-2020-12 structural keywords, string
 * formats, `$defs`/`definitions` references (including recursion), enums,
 * and composition via `anyOf`/`oneOf`/`allOf`.
 *
 * Unknown or non-structural keywords are ignored, matching lenient importer
 * behavior: the result validates every constraint the schema can express in
 * omptype IR and passes the rest through.
 */
import { OmpTypeError } from "./errors";
import { type EmbeddableSchema, type IR, IR_BRAND, type PropIR, type TupleItemIR } from "./ir";
import { keywordIR, patternIR } from "./keywords";
import { type BaseType, type } from "./type";

type JsonSchema = Record<string, unknown>;

/** `format` values lowered to built-in keyword validators. */
const FORMAT_KEYWORDS: Record<string, string> = {
	email: "string.email",
	uuid: "string.uuid",
	"date-time": "string.date.iso",
	date: "string.date.iso",
	ipv4: "string.ip.v4",
	ipv6: "string.ip.v6",
	regex: "string.regex",
};

class Importer {
	readonly #root: JsonSchema;
	readonly #aliases = new Map<string, IR>();

	constructor(root: JsonSchema) {
		this.#root = root;
	}

	resolveRef(ref: string): IR {
		const cached = this.#aliases.get(ref);
		if (cached !== undefined) return cached;

		let target: unknown;
		if (ref === "#") {
			target = this.#root;
		} else {
			const defsMatch = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
			if (defsMatch === null) throw new OmpTypeError(`unsupported $ref: ${ref}`);
			const defs = this.#root[defsMatch[1]];
			target = typeof defs === "object" && defs !== null ? (defs as JsonSchema)[defsMatch[2]] : undefined;
			if (target === undefined) throw new OmpTypeError(`unresolved $ref: ${ref}`);
		}

		// Register the alias before lowering so recursive references resolve
		// to the same node instead of recursing forever.
		let lowered: IR | undefined;
		const alias: IR = {
			k: "alias",
			name: ref,
			resolve: () => {
				lowered ??= this.lower(target);
				return lowered;
			},
		};
		this.#aliases.set(ref, alias);
		return alias;
	}

	lower(schema: unknown): IR {
		if (schema === true) return { k: "unknown" };
		if (schema === false) return { k: "never" };
		if (typeof schema !== "object" || schema === null) {
			throw new OmpTypeError("JSON Schema nodes must be booleans or objects");
		}
		const node = schema as JsonSchema;
		const desc = typeof node.description === "string" ? node.description : undefined;
		const ir = this.#lowerNode(node);
		return desc === undefined ? ir : { ...ir, desc };
	}

	#lowerNode(node: JsonSchema): IR {
		if (typeof node.$ref === "string") return this.resolveRef(node.$ref);

		if (Array.isArray(node.enum)) {
			const members = node.enum.map((v): IR => ({ k: "lit", v }));
			return members.length === 1 ? members[0] : { k: "union", members };
		}
		if ("const" in node) return { k: "lit", v: node.const };

		const branches = node.anyOf ?? node.oneOf;
		if (Array.isArray(branches)) {
			return { k: "union", members: branches.map(branch => this.lower(branch)) };
		}
		if (Array.isArray(node.allOf)) {
			const members = node.allOf.map(branch => this.lower(branch));
			return members.length === 1 ? members[0] : { k: "intersection", members };
		}
		if (typeof node.not === "object" && node.not !== null && Object.keys(node.not).length === 0) {
			return { k: "never" };
		}

		if (Array.isArray(node.type)) {
			const members = node.type.map(t => this.#lowerTyped(node, String(t)));
			return members.length === 1 ? members[0] : { k: "union", members };
		}
		if (typeof node.type === "string") return this.#lowerTyped(node, node.type);

		// No explicit type: infer from structural keywords, else accept anything.
		if (node.properties !== undefined || node.required !== undefined) return this.#lowerObject(node);
		if (node.items !== undefined || node.prefixItems !== undefined) return this.#lowerArray(node);
		return { k: "unknown" };
	}

	#lowerTyped(node: JsonSchema, kind: string): IR {
		switch (kind) {
			case "null":
				return { k: "null" };
			case "boolean":
				return { k: "boolean" };
			case "string":
				return this.#lowerString(node);
			case "number":
			case "integer": {
				const ir: IR = { k: "number" };
				if (kind === "integer") ir.int = true;
				if (typeof node.minimum === "number") ir.min = node.minimum;
				if (typeof node.maximum === "number") ir.max = node.maximum;
				if (typeof node.exclusiveMinimum === "number") {
					ir.min = node.exclusiveMinimum;
					ir.xmin = true;
				}
				if (typeof node.exclusiveMaximum === "number") {
					ir.max = node.exclusiveMaximum;
					ir.xmax = true;
				}
				if (typeof node.multipleOf === "number") ir.divisor = node.multipleOf;
				return ir;
			}
			case "object":
				return this.#lowerObject(node);
			case "array":
				return this.#lowerArray(node);
			default:
				throw new OmpTypeError(`unsupported JSON Schema type: ${kind}`);
		}
	}

	#lowerString(node: JsonSchema): IR {
		const base: IR = { k: "string" };
		if (typeof node.minLength === "number") base.min = node.minLength;
		if (typeof node.maxLength === "number") base.max = node.maxLength;
		if (node.format === "uri" || node.format === "url") base.url = true;

		const members: IR[] = [];
		if (typeof node.format === "string") {
			const keyword = FORMAT_KEYWORDS[node.format];
			if (keyword !== undefined) {
				const formatIR = keywordIR(keyword);
				if (formatIR !== undefined) members.push(formatIR);
			}
		}
		if (typeof node.pattern === "string") members.push(patternIR(new RegExp(node.pattern)));

		if (members.length === 0) return base;
		if (base.min !== undefined || base.max !== undefined || base.url) members.unshift(base);
		return members.length === 1 ? members[0] : { k: "intersection", members };
	}

	#lowerObject(node: JsonSchema): IR {
		const required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
		const props: PropIR[] = [];
		if (typeof node.properties === "object" && node.properties !== null) {
			for (const [key, value] of Object.entries(node.properties)) {
				const prop: PropIR = { key, opt: !required.has(key), val: this.lower(value) };
				if (typeof value === "object" && value !== null && "default" in value) {
					prop.hasDefault = true;
					prop.def = (value as JsonSchema).default;
					prop.opt = true;
				}
				props.push(prop);
			}
		}
		const extra = node.additionalProperties;
		return {
			k: "object",
			props,
			extras: extra === false ? "reject" : "keep",
			...(typeof extra === "object" && extra !== null ? { index: this.lower(extra) } : {}),
		};
	}

	#lowerArray(node: JsonSchema): IR {
		if (Array.isArray(node.prefixItems)) {
			const minItems = typeof node.minItems === "number" ? node.minItems : node.prefixItems.length;
			const prefix: TupleItemIR[] = node.prefixItems.map((item, index) => ({
				val: this.lower(item),
				opt: index >= minItems,
			}));
			return {
				k: "tuple",
				prefix,
				postfix: [],
				...(node.items !== undefined && node.items !== false ? { variadic: this.lower(node.items) } : {}),
			};
		}
		const ir: IR = { k: "array", el: node.items === undefined ? { k: "unknown" } : this.lower(node.items) };
		if (typeof node.minItems === "number") ir.min = node.minItems;
		if (typeof node.maxItems === "number") ir.max = node.maxItems;
		return ir;
	}
}

/**
 * Build a callable omptype schema from a JSON Schema document.
 *
 * # Errors
 * Throws {@link OmpTypeError} on malformed nodes, unresolvable `$ref`s, or
 * types omptype cannot represent.
 */
export function fromJsonSchema(schema: unknown): BaseType {
	const importer = new Importer(typeof schema === "object" && schema !== null ? (schema as JsonSchema) : {});
	const embedded: EmbeddableSchema = {
		[IR_BRAND]: true,
		ir: importer.lower(schema),
		hasSteps: false,
		hasDefault: false,
		run: value => value,
	};
	return type.raw(embedded);
}
