/**
 * Emits `sdk/go/omp-rpc/wire.go`: Go types, JSON codecs, and typed command methods
 * for the RPC wire bundle.
 *
 * Mapping:
 * - string enums → named string types with constants; decoding rejects unknown values
 * - closed objects → structs; decoding requires required keys, applies defaults, ignores unknown keys
 * - open records (`x-open`) → structs whose declared keys may be absent, plus `Extra` holding the rest
 * - required constants (discriminators) → no struct field; written on encode, checked on decode
 * - discriminated unions → a wrapper struct around a sealed `<Union>Variant` interface; nested unions
 *   whose variants keep distinct discriminator values are flattened into the outer union
 * - commands → `<Name>Command` parameter structs and one `Commands` method each
 *
 * The output must be gofmt-clean byte for byte: struct fields and constants are
 * column-aligned per block exactly as gofmt does (doc comments break blocks).
 * Decoding helpers, `Transport`, `Commands`, and `UnknownNotification` live in
 * the hand-written `runtime.go`.
 */
import {
	constantOf,
	nonNull,
	unionDispatch,
	unionLeaves,
	unionMembers,
	type WireDef,
	type WireField,
	type WireModel,
	type WireType,
} from "./model";
import type { RpcWireCommand } from "../../src/modes/rpc/wire";

type ObjectDef = Extract<WireDef, { kind: "object" }>;

/** One case of a union: a Go type and the discriminator values routed to it. */
interface Variant {
	type: string;
	values: string[];
}

interface UnionPlan {
	/** Discriminator; undefined for encode-only unions. */
	property?: string;
	variants: Variant[];
	/** Unrecognized discriminators decode to `UnknownNotification`. */
	unknown: boolean;
}

interface StructField {
	doc?: string;
	name: string;
	type: string;
	tag?: string;
}

/** How a struct field is typed and decoded. */
interface FieldPlan {
	type: string;
	omitempty: boolean;
	decoder: "required" | "nullable" | "optional" | "defaulted";
}

const UNKNOWN_NOTIFICATION = "UnknownNotification";

const INITIALISMS: Record<string, true> = {
	api: true,
	html: true,
	http: true,
	id: true,
	json: true,
	ui: true,
	uri: true,
	url: true,
};

/** Identifiers declared by the hand-written files of the package. */
const RUNTIME_NAMES = [
	"Client",
	"CommandError",
	"Commands",
	"DefaultPromptTimeout",
	"DefaultTimeout",
	"EncodeCommand",
	"ErrClosed",
	"ErrProtocol",
	"HostTool",
	"HostToolCall",
	"HostToolHandler",
	"HostUri",
	"HostUriReadResult",
	"NewClient",
	"Option",
	"PromptTurn",
	"Ptr",
	"Start",
	"TextResult",
	"Transport",
	UNKNOWN_NOTIFICATION,
	"WithHostTools",
	"WithHostUris",
	"WithRequestID",
];

/**
 * Members of `Client` (and `Commands`) that a promoted command method must not
 * collide with. `GetMessages` is absent on purpose: `Client.GetMessages` pages
 * over protocol v2 and deliberately shadows the generated command.
 */
const CLIENT_MEMBERS: Record<string, true> = {
	Call: true,
	Close: true,
	Err: true,
	Frames: true,
	PromptAndWait: true,
	ProtocolVersion: true,
	Ready: true,
	Send: true,
	SetCustomTools: true,
	SetHostUris: true,
	Transport: true,
};

const KEY = /^[A-Za-z0-9_]+$/;
const IDENTIFIER = /^[A-Z][A-Za-z0-9]*$/;

function words(text: string): string[] {
	return text
		.split(/[^A-Za-z0-9]+/)
		.flatMap(part =>
			part
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
				.split(" "),
		)
		.filter(word => word.length > 0);
}

/** Exported Go identifier for a wire name, with Go initialisms (`sessionId` → `SessionID`). */
function pascal(text: string): string {
	return words(text)
		.map(word => {
			const lower = word.toLowerCase();
			return INITIALISMS[lower] ? lower.toUpperCase() : word[0].toUpperCase() + word.slice(1);
		})
		.join("");
}

function goString(value: string): string {
	return JSON.stringify(value);
}

/** Go string literal for `text`, raw when possible. */
function goLiteral(text: string): string {
	return text.includes("`") || text.includes("\r") ? JSON.stringify(text) : `\`${text}\``;
}

function jsonTag(key: string, omitempty: boolean): string {
	if (!KEY.test(key)) throw new Error(`Wire key ${JSON.stringify(key)} cannot be a Go struct tag`);
	return `\`json:"${key}${omitempty ? ",omitempty" : ""}"\``;
}

function comment(text: string | undefined, indent: string): string {
	if (!text) return "";
	return text
		.split("\n")
		.map(line => (line.trim() ? `${indent}// ${line.trimEnd()}\n` : `${indent}//\n`))
		.join("");
}

function nilable(type: string): boolean {
	return type.startsWith("*") || type.startsWith("[]") || type.startsWith("map[") || type === "json.RawMessage";
}

/** Rows aligned like gofmt: each run of rows without an intervening comment is one block. */
function alignRows(rows: { doc?: string; cells: string[] }[], indent: string): string {
	const out: string[] = [];
	let block: string[][] = [];
	const flush = (): void => {
		const columns = block[0]?.length ?? 0;
		if (block.some(cells => cells.length !== columns)) throw new Error("Aligned rows need equal cell counts");
		const widths = Array.from({ length: columns }, (_, index) =>
			Math.max(...block.map(cells => cells[index].length)),
		);
		for (const cells of block) {
			out.push(
				`${indent}${cells.map((cell, index) => (index === columns - 1 ? cell : cell.padEnd(widths[index]))).join(" ")}\n`,
			);
		}
		block = [];
	};
	for (const row of rows) {
		if (row.doc) {
			flush();
			out.push(comment(row.doc, indent));
		}
		block.push(row.cells);
	}
	flush();
	return out.join("");
}

function renderStruct(name: string, doc: string | undefined, fields: StructField[]): string {
	const head = `${comment(doc, "")}type ${name} struct`;
	if (fields.length === 0) return `${head}{}\n`;
	const rows = fields.map(field => ({
		doc: field.doc,
		cells: field.tag === undefined ? [field.name, field.type] : [field.name, field.type, field.tag],
	}));
	return `${head} {\n${alignRows(rows, "\t")}}\n`;
}

class GoEmitter {
	readonly #model: WireModel;
	readonly #plans = new Map<string, UnionPlan>();
	/** Go top-level identifier → what declared it. */
	readonly #names = new Map<string, string>();
	/** Inline enums and JSON-kind unions, by Go name → signature. */
	readonly #synthetic = new Map<string, string>();
	/** Synthetic declarations waiting to follow the declaration that introduced them. */
	#pending: string[] = [];
	/** Unions that hold `UnknownNotification` when an `x-unknown-fallback` field fails to decode. */
	readonly #fallbackUnions = new Set<string>();
	#usesTime = false;

	constructor(model: WireModel) {
		this.#model = model;
		for (const name of RUNTIME_NAMES) this.#claim(name, "runtime.go");
	}

	#def(name: string): WireDef {
		const def = this.#model.defs.get(name);
		if (!def) throw new Error(`Unknown definition ${name}`);
		return def;
	}

	#isUnion(name: string): boolean {
		return name !== UNKNOWN_NOTIFICATION && unionMembers(this.#model.defs.get(name)) !== undefined;
	}

	#claim(name: string, origin: string): void {
		if (!IDENTIFIER.test(name))
			throw new Error(`${origin}: ${JSON.stringify(name)} is not an exported Go identifier`);
		const prior = this.#names.get(name);
		if (prior !== undefined && prior !== origin)
			throw new Error(`Go name ${name} (${origin}) collides with ${prior}`);
		this.#names.set(name, origin);
	}

	// --- Unions ------------------------------------------------------------------

	/** Union variants on `property`, flattening nested unions whose variants keep distinct values. */
	#dispatchVariants(name: string, property: string): Variant[] | undefined {
		const variants: Variant[] = [];
		for (const member of unionMembers(this.#def(name)) ?? []) {
			if (this.#isUnion(member)) {
				const inner = this.#dispatchVariants(member, property);
				const flat =
					inner?.every(variant => variant.values.length === 1) &&
					inner.every(variant => !this.#isUnion(variant.type) || this.#decodable(variant.type));
				if (inner && flat) {
					variants.push(...inner);
					continue;
				}
				const values = new Set<string>();
				for (const leaf of unionLeaves(this.#model, member)) {
					const value = constantOf(this.#def(leaf), property);
					if (value === undefined) return undefined;
					values.add(value);
				}
				variants.push({ type: member, values: [...values] });
				continue;
			}
			const value = constantOf(this.#def(member), property);
			if (value === undefined) return undefined;
			variants.push({ type: member, values: [value] });
		}
		const seen = new Set<string>();
		for (const variant of variants) {
			for (const value of variant.values) {
				if (seen.has(value)) return undefined;
				seen.add(value);
			}
		}
		return variants;
	}

	#decodable(name: string): boolean {
		const plan = this.#plan(name);
		return plan.property !== undefined && !plan.unknown;
	}

	#plan(name: string): UnionPlan {
		const known = this.#plans.get(name);
		if (known) return known;
		const unknown = name === this.#model.notification || name === this.#model.serverFrame;
		const property = unionDispatch(this.#model, name)?.property;
		const variants = property === undefined ? undefined : this.#dispatchVariants(name, property);
		const decodable = variants?.every(variant => !this.#isUnion(variant.type) || this.#decodable(variant.type));
		let plan: UnionPlan;
		if (property !== undefined && variants && decodable) {
			plan = {
				property,
				variants: unknown ? [...variants, { type: UNKNOWN_NOTIFICATION, values: [] }] : variants,
				unknown,
			};
		} else {
			if (unknown) throw new Error(`${name}: frame unions must be decodable`);
			// Encode-only: nothing routes on decode, so every leaf is a variant.
			plan = { variants: unionLeaves(this.#model, name).map(leaf => ({ type: leaf, values: [] })), unknown };
		}
		this.#plans.set(name, plan);
		return plan;
	}

	#unionBlock(name: string, doc: string | undefined): string {
		const plan = this.#plan(name);
		const variant = `${name}Variant`;
		const marker = `is${name}`;
		this.#claim(variant, `${name} variants`);
		const parts: string[] = [];
		const fallback = this.#fallbackUnions.has(name);
		let summary = plan.property
			? `Value holds one variant, chosen by ${goString(plan.property)} on decode.`
			: "Value holds one variant. Encode-only: no discriminator tells the variants apart.";
		if (fallback) summary += "\nIt is an UnknownNotification when a fallback field's value failed to decode.";
		parts.push(renderStruct(name, doc, [{ name: "Value", type: variant, doc: summary }]));
		parts.push(
			`// ${variant} is implemented by the types ${name} can hold.\ntype ${variant} interface {\n\t${marker}()\n}\n`,
		);
		// gofmt aligns the bodies of consecutive one-line functions.
		const markers = fallback && !plan.unknown ? [...plan.variants, { type: UNKNOWN_NOTIFICATION }] : plan.variants;
		parts.push(
			alignRows(
				markers.map(entry => ({ cells: [`func (${entry.type}) ${marker}()`, "{}"] })),
				"",
			),
		);
		parts.push(
			`func (v ${name}) MarshalJSON() ([]byte, error) {\n\treturn encodeVariant(${goString(name)}, v.Value)\n}\n`,
		);
		if (fallback) {
			parts.push(`func (v *${name}) setUnknown(value UnknownNotification) {\n\tv.Value = value\n}\n`);
		}
		if (!plan.property) return parts.join("\n");

		const cases = plan.variants
			.filter(entry => entry.type !== UNKNOWN_NOTIFICATION)
			.map(
				entry =>
					`\tcase ${entry.values.map(goString).join(", ")}:\n\t\tvalue, err = decodeVariant[${entry.type}](raw)\n`,
			)
			.join("");
		const tail = `\tif err != nil {\n\t\treturn err\n\t}\n\tv.Value = value\n\treturn nil\n}\n`;
		if (plan.unknown) {
			parts.push(
				`func (v *${name}) UnmarshalJSON(data []byte) error {\n` +
					`\traw, err := decodeObject(data, ${goString(name)})\n\tif err != nil {\n\t\treturn err\n\t}\n` +
					`\ttag, _ := unionTag(raw, ${goString(name)}, ${goString(plan.property)})\n` +
					`\tvar value ${variant}\n\tswitch tag {\n${cases}` +
					`\tdefault:\n\t\tvalue = newUnknownNotification(tag, data)\n\t}\n${tail}`,
			);
			return parts.join("\n");
		}
		parts.push(
			`func (v *${name}) UnmarshalJSON(data []byte) error {\n\treturn decodeWith(data, ${goString(name)}, v.decodeFrom)\n}\n`,
		);
		parts.push(
			`func (v *${name}) decodeFrom(raw map[string]json.RawMessage) error {\n` +
				`\ttag, err := unionTag(raw, ${goString(name)}, ${goString(plan.property)})\n\tif err != nil {\n\t\treturn err\n\t}\n` +
				`\tvar value ${variant}\n\tswitch tag {\n${cases}` +
				`\tdefault:\n\t\treturn unknownValue(${goString(`${name}.${plan.property}`)}, tag)\n\t}\n${tail}`,
		);
		return parts.join("\n");
	}

	// --- Types -------------------------------------------------------------------

	#goType(type: WireType, owner: string): string {
		switch (type.kind) {
			case "string":
				return "string";
			case "integer":
				return "int64";
			case "number":
				return "float64";
			case "boolean":
				return "bool";
			case "unknown":
				return "json.RawMessage";
			case "null":
				throw new Error(`${owner}: bare null type`);
			case "literal":
				if (typeof type.value !== "string") throw new Error(`${owner}: only string literals can be optional`);
				return this.#syntheticEnum(owner, [type.value]);
			case "enum":
				return this.#syntheticEnum(owner, type.values);
			case "ref":
				this.#def(type.name);
				return type.name;
			case "array":
				return `[]${this.#goType(type.items, owner)}`;
			case "record":
				return `map[string]${this.#goType(type.values, owner)}`;
			case "union": {
				const inner = nonNull(type);
				if (!inner) return this.#kindUnion(type);
				const base = this.#goType(inner, owner);
				return nilable(base) ? base : `*${base}`;
			}
		}
	}

	#fieldPlan(owner: string, field: WireField): FieldPlan {
		const type = this.#goType(field.type, `${owner}${pascal(field.key)}`);
		if (field.hasDefault) return { type, omitempty: false, decoder: "defaulted" };
		if (field.required) {
			return { type, omitempty: false, decoder: nonNull(field.type) ? "nullable" : "required" };
		}
		return { type: nilable(type) ? type : `*${type}`, omitempty: true, decoder: "optional" };
	}

	#syntheticEnum(name: string, values: string[]): string {
		const signature = `enum:${JSON.stringify(values)}`;
		const known = this.#synthetic.get(name);
		if (known !== undefined) {
			if (known !== signature) throw new Error(`Synthetic enum ${name} has two value sets`);
			return name;
		}
		this.#synthetic.set(name, signature);
		this.#pending.push(this.#enumBlock(name, undefined, values));
		return name;
	}

	#enumBlock(name: string, doc: string | undefined, values: string[]): string {
		this.#claim(name, `enum ${name}`);
		const constants = values.map(value => {
			const constant = `${name}${pascal(value)}`;
			this.#claim(constant, `${name} value ${JSON.stringify(value)}`);
			return constant;
		});
		const rows = values.map((value, index) => ({ cells: [constants[index], name, `= ${goString(value)}`] }));
		return [
			`${comment(doc, "")}type ${name} string\n`,
			`const (\n${alignRows(rows, "\t")})\n`,
			`func (v *${name}) UnmarshalJSON(data []byte) error {\n` +
				`\ts, err := decodeString(data, ${goString(name)})\n\tif err != nil {\n\t\treturn err\n\t}\n` +
				`\tswitch value := ${name}(s); value {\n\tcase ${constants.join(", ")}:\n\t\t*v = value\n\t\treturn nil\n\t}\n` +
				`\treturn unknownValue(${goString(name)}, s)\n}\n`,
		].join("\n");
	}

	/** Go label of a JSON-kind union member, used for type and field names. */
	#label(type: WireType, where: string): string {
		switch (type.kind) {
			case "string":
			case "integer":
			case "number":
			case "boolean":
				return type.kind[0].toUpperCase() + type.kind.slice(1);
			case "ref":
				return type.name;
			case "array":
				return `${this.#label(type.items, where)}Array`;
			case "record":
				return `${this.#label(type.values, where)}Map`;
			default:
				throw new Error(`${where}: unsupported union member ${type.kind}`);
		}
	}

	/** First byte class of a member's JSON encoding, as `jsonKind` reports it. */
	#jsonKind(type: WireType, where: string): string {
		switch (type.kind) {
			case "string":
				return '"';
			case "integer":
			case "number":
				return "0";
			case "boolean":
				return "t";
			case "array":
				return "[";
			case "record":
				return "{";
			case "ref": {
				const def = this.#def(type.name);
				return def.kind === "alias" && def.type.kind === "enum" ? '"' : "{";
			}
			default:
				throw new Error(`${where}: unsupported union member ${type.kind}`);
		}
	}

	/**
	 * A union of members with distinct JSON kinds (`string | UserContent[]`); inline
	 * ones are named after their members.
	 */
	#kindUnion(type: Extract<WireType, { kind: "union" }>, alias?: { name: string; doc?: string }): string {
		const where = JSON.stringify(type);
		const name = alias?.name ?? type.members.map(member => this.#label(member, where)).join("Or");
		const known = this.#synthetic.get(name);
		if (known !== undefined) {
			if (known !== where) throw new Error(`Synthetic union ${name} has two shapes`);
			return name;
		}
		this.#synthetic.set(name, where);
		this.#claim(name, `union ${where}`);
		const members = type.members.map(member => {
			const field =
				member.kind === "ref" ? member.name : this.#label(member, where).replace(/^.*(Array|Map)$/, "$1");
			const goType = this.#goType(member, name);
			return { field, type: nilable(goType) ? goType : `*${goType}`, kind: this.#jsonKind(member, where) };
		});
		if (new Set(members.map(member => member.kind)).size !== members.length) {
			throw new Error(`${name}: union members share a JSON kind`);
		}
		const summary = `${name} holds exactly one of its fields, chosen by the JSON kind of the value.`;
		const struct = renderStruct(
			name,
			alias?.doc ? `${alias.doc}\n${summary}` : summary,
			members.map(member => ({ name: member.field, type: member.type })),
		);
		const marshal =
			`func (v ${name}) MarshalJSON() ([]byte, error) {\n\tswitch {\n` +
			members
				.map(
					member =>
						`\tcase v.${member.field} != nil:\n\t\treturn json.Marshal(${member.type.startsWith("*") ? "*" : ""}v.${member.field})\n`,
				)
				.join("") +
			`\t}\n\treturn nil, emptyUnion(${goString(name)})\n}\n`;
		const unmarshal =
			`func (v *${name}) UnmarshalJSON(data []byte) error {\n\tvar out ${name}\n\tvar err error\n\tswitch jsonKind(data) {\n` +
			members
				.map(member => `\tcase '${member.kind}':\n\t\terr = json.Unmarshal(data, &out.${member.field})\n`)
				.join("") +
			`\tdefault:\n\t\treturn unexpectedKind(${goString(name)}, data)\n\t}\n` +
			`\tif err != nil {\n\t\treturn err\n\t}\n\t*v = out\n\treturn nil\n}\n`;
		this.#pending.push([struct, marshal, unmarshal].join("\n"));
		return name;
	}

	// --- Objects -----------------------------------------------------------------

	#objectBlock(def: ObjectDef): string {
		this.#claim(def.name, `definition ${def.name}`);
		const fields: StructField[] = [];
		const decode: string[] = [];
		const constants: string[] = [];
		const fieldNames = new Set<string>();
		for (const field of def.fields) {
			if (field.required && field.type.kind === "literal") {
				const value = field.type.value;
				if (typeof value === "number")
					throw new Error(`${def.name}.${field.key}: numeric constants are not supported`);
				constants.push(`${JSON.stringify(field.key)}:${JSON.stringify(value)}`);
				decode.push(
					`\td.constant(${goString(field.key)}, ${typeof value === "string" ? goString(value) : value})\n`,
				);
				continue;
			}
			const name = pascal(field.key);
			if (fieldNames.has(name) || (def.open && name === "Extra")) {
				throw new Error(`${def.name}.${field.key}: Go field ${name} is taken`);
			}
			fieldNames.add(name);
			const plan = this.#fieldPlan(def.name, field);
			fields.push({ doc: field.doc, name, type: plan.type, tag: jsonTag(field.key, plan.omitempty) });
			const args = `${goString(field.key)}, &out.${name}`;
			if (field.scalarOrArray) {
				if ((nonNull(field.type) ?? field.type).kind !== "array") {
					throw new Error(`${def.name}.${field.key}: x-scalar-or-array needs an array type`);
				}
				decode.push(`\td.scalarOrArray(${goString(field.key)})\n`);
			}
			if (field.unknownFallback) {
				const property = field.type.kind === "ref" ? this.#fallbackProperty(field.type.name) : undefined;
				if (!property || plan.decoder !== "required") {
					throw new Error(`${def.name}.${field.key}: x-unknown-fallback needs a required, decodable union`);
				}
				decode.push(`\td.fallback(${args}, ${goString(property)})\n`);
			} else {
				decode.push(
					plan.decoder === "defaulted"
						? `\td.defaulted(${args}, ${goLiteral(JSON.stringify(field.default))})\n`
						: `\td.${plan.decoder}(${args})\n`,
				);
			}
		}
		if (def.open) {
			fields.push({
				doc: "Extra holds undeclared keys and declared keys whose value did not decode (that field stays zero).\nEncoding writes them back, over a declared field with the same key.",
				name: "Extra",
				type: "map[string]json.RawMessage",
				tag: '`json:"-"`',
			});
		}
		const parts = [renderStruct(def.name, def.doc, fields)];
		parts.push(
			`func (v *${def.name}) UnmarshalJSON(data []byte) error {\n\treturn decodeWith(data, ${goString(def.name)}, v.decodeFrom)\n}\n`,
		);
		parts.push(
			`func (v *${def.name}) decodeFrom(raw map[string]json.RawMessage) error {\n` +
				`\tvar out ${def.name}\n` +
				`\td := fieldDecoder{raw: raw, owner: ${goString(def.name)}${def.open ? ", open: true" : ""}}\n` +
				decode.join("") +
				(def.open ? "\tout.Extra = d.rest()\n" : "") +
				`\tif d.err != nil {\n\t\treturn d.err\n\t}\n\t*v = out\n\treturn nil\n}\n`,
		);
		if (constants.length > 0 || def.open) {
			parts.push(
				`func (v ${def.name}) MarshalJSON() ([]byte, error) {\n\ttype plain ${def.name}\n` +
					`\treturn encodeObject(plain(v), ${constants.length > 0 ? goLiteral(constants.join(",")) : '""'}, ${def.open ? "v.Extra" : "nil"})\n}\n`,
			);
		}
		return parts.join("\n");
	}

	/** Discriminator of a union that can absorb an `x-unknown-fallback` failure. */
	#fallbackProperty(name: string): string | undefined {
		if (!this.#isUnion(name)) return undefined;
		const plan = this.#plan(name);
		if (plan.property === undefined || plan.unknown) return undefined;
		this.#fallbackUnions.add(name);
		return plan.property;
	}

	// --- Commands ----------------------------------------------------------------

	#commandBlock(command: RpcWireCommand, methods: Set<string>): string {
		const method = pascal(command.name);
		if (CLIENT_MEMBERS[method] || methods.has(method)) {
			throw new Error(`${command.name}: Commands method ${method} collides with another member`);
		}
		methods.add(method);
		const parts: string[] = [];
		let params = "";
		let value = "nil";
		if (command.params) {
			const def = this.#def(command.params);
			if (def.kind !== "object") throw new Error(`${command.name}: params must be an object`);
			const visible = def.fields.filter(field => !command.clientOmit.includes(field.key));
			for (const field of def.fields) {
				if (command.clientOmit.includes(field.key) && field.required) {
					throw new Error(`${command.name}.${field.key}: a required parameter cannot be client-omitted`);
				}
			}
			if (visible.length > 0) {
				const struct = `${method}Command`;
				this.#claim(struct, `parameters of ${command.name}`);
				const fields = visible.map(field => {
					if (field.type.kind === "literal" || field.hasDefault) {
						throw new Error(`${command.name}.${field.key}: constant or defaulted parameters are not supported`);
					}
					const plan = this.#fieldPlan(struct, field);
					return {
						doc: field.doc,
						name: pascal(field.key),
						type: plan.type,
						tag: jsonTag(field.key, plan.omitempty),
					};
				});
				parts.push(renderStruct(struct, `${struct} holds the parameters of ${goString(command.name)}.`, fields));
				params = `, p ${struct}`;
				value = "p";
			}
		}
		let timeout = "0";
		if (command.timeoutMs !== null) {
			this.#usesTime = true;
			timeout =
				command.timeoutMs % 1000 === 0
					? `${command.timeoutMs / 1000}*time.Second`
					: `${command.timeoutMs}*time.Millisecond`;
		}
		const docLines = [`${method} sends ${goString(command.name)}: ${command.doc}`];
		if (command.completion === "prompt_result") {
			docLines.push(
				"Its work completes later with a prompt_result frame carrying the request id (see WithRequestID).",
			);
		}
		const head = `${comment(docLines.join("\n"), "")}func (c Commands) ${method}(ctx context.Context${params})`;
		const call = `c.call(ctx, ${goString(command.name)}, ${value}, ${timeout}`;
		if (!command.result) {
			parts.push(`${head} error {\n\treturn ${call}, nil)\n}\n`);
			return parts.join("\n");
		}
		const result = this.#def(command.result);
		if (result.kind !== "object") throw new Error(`${command.name}: result must be an object`);
		if (command.unwrap) {
			if (command.nullable) throw new Error(`${command.name}: nullable unwrapped results are not supported`);
			const field = result.fields.find(candidate => candidate.key === command.unwrap);
			if (!field) throw new Error(`${command.name}: unwrap field ${command.unwrap} not in ${command.result}`);
			const type = this.#fieldPlan(result.name, field).type;
			parts.push(
				`${head} (${type}, error) {\n\tvar out ${result.name}\n\terr := ${call}, &out)\n\treturn out.${pascal(field.key)}, err\n}\n`,
			);
			return parts.join("\n");
		}
		const type = command.nullable ? `*${result.name}` : result.name;
		parts.push(`${head} (${type}, error) {\n\tvar out ${type}\n\terr := ${call}, &out)\n\treturn out, err\n}\n`);
		return parts.join("\n");
	}

	// --- File --------------------------------------------------------------------

	/** Definitions with a Go counterpart: reachable from frames, inbound frames, results, and parameter fields. */
	#reachable(): Set<string> {
		const reached = new Set<string>();
		const visitType = (type: WireType): void => {
			switch (type.kind) {
				case "ref":
					visitDef(type.name);
					break;
				case "array":
					visitType(type.items);
					break;
				case "record":
					visitType(type.values);
					break;
				case "union":
					for (const member of type.members) visitType(member);
					break;
			}
		};
		const visitDef = (name: string): void => {
			if (reached.has(name)) return;
			reached.add(name);
			const def = this.#def(name);
			if (def.kind === "object") for (const field of def.fields) visitType(field.type);
			else visitType(def.type);
		};
		for (const root of [
			this.#model.serverFrame,
			this.#model.notification,
			this.#model.sessionEvent,
			this.#model.inbound,
		]) {
			visitDef(root);
		}
		for (const command of this.#model.commands) {
			if (command.result) visitDef(command.result);
			if (!command.params) continue;
			const def = this.#def(command.params);
			if (def.kind !== "object") continue;
			for (const field of def.fields) if (!command.clientOmit.includes(field.key)) visitType(field.type);
		}
		return reached;
	}

	emit(): string {
		const blocks: string[] = [];
		const takePending = (): void => {
			blocks.push(...this.#pending);
			this.#pending = [];
		};
		const reached = this.#reachable();
		// A union learns it must hold UnknownNotification from a fallback field that may come later.
		for (const name of reached) {
			const def = this.#def(name);
			if (def.kind !== "object") continue;
			for (const field of def.fields) {
				if (field.unknownFallback && field.type.kind === "ref") this.#fallbackProperty(field.type.name);
			}
		}
		for (const [name, def] of this.#model.defs) {
			if (!reached.has(name)) continue;
			if (def.kind === "object") blocks.push(this.#objectBlock(def));
			else if (def.type.kind === "enum") blocks.push(this.#enumBlock(name, def.doc, def.type.values));
			else if (unionMembers(def)) {
				this.#claim(name, `union ${name}`);
				blocks.push(this.#unionBlock(name, def.doc));
			} else if (def.type.kind === "union" && !nonNull(def.type)) {
				this.#kindUnion(def.type, { name, doc: def.doc });
			} else throw new Error(`${name}: unsupported alias for Go`);
			takePending();
		}
		const methods = new Set<string>();
		for (const command of this.#model.commands) {
			blocks.push(this.#commandBlock(command, methods));
			takePending();
		}
		const imports = ['"context"', '"encoding/json"', ...(this.#usesTime ? ['"time"'] : [])];
		const header = [
			"// Code generated by bun run gen:rpc; DO NOT EDIT.\n",
			"package omprpc\n",
			`import (\n${imports.map(path => `\t${path}\n`).join("")})\n`,
		];
		return [...header, ...blocks].join("\n");
	}
}

/** Renders `sdk/go/omp-rpc/wire.go`. */
export function emitGo(model: WireModel): string {
	return new GoEmitter(model).emit();
}
