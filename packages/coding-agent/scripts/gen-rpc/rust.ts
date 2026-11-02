/**
 * Emits `sdk/rust/omp-rpc/src/wire.rs`: serde types and command descriptors for the
 * RPC wire bundle.
 *
 * Mapping:
 * - string enums → fieldless enums with `#[serde(rename)]` variants (closed)
 * - closed object definitions → structs (snake_case fields, strict serde derive);
 *   constant discriminators consumed by a dispatching union are omitted, other
 *   constants become `Lit*` marker types that validate and re-emit the value
 * - open records (`x-open`) → structs whose declared fields are all optional and
 *   decoded leniently (a value that does not fit stays in `extra`), plus `extra`
 *   holding every other key
 * - discriminated unions → enums with hand-written serde impls that dispatch on
 *   the discriminator and re-insert it on encode; `RpcNotification` and
 *   `RpcServerFrame` keep unrecognized frames as `Unknown(Value)`
 * - unions without a discriminator → enums decoded by trying members in order
 *   (untagged serde enums for unions of inline types such as `MessageContent`)
 * - `x-unknown-fallback` fields → `OrUnknown<T>` (raw JSON + error when `T` fails);
 *   `x-scalar-or-array` fields also accept a bare scalar as a one-element list
 * - commands → `<Name>Command` structs implementing the `Command` trait
 */
import type { RpcWireCommand } from "../../src/modes/rpc/wire";
import {
	nonNull,
	unionDispatch,
	unionLeaves,
	unionMembers,
	type WireDef,
	type WireField,
	type WireModel,
	type WireType,
} from "./model";

type ObjectDef = Extract<WireDef, { kind: "object" }>;

const KEYWORDS: Record<string, true> = {
	as: true,
	async: true,
	await: true,
	box: true,
	break: true,
	const: true,
	continue: true,
	dyn: true,
	else: true,
	enum: true,
	extern: true,
	false: true,
	final: true,
	fn: true,
	for: true,
	gen: true,
	if: true,
	impl: true,
	in: true,
	let: true,
	loop: true,
	match: true,
	mod: true,
	move: true,
	mut: true,
	pub: true,
	ref: true,
	return: true,
	static: true,
	struct: true,
	trait: true,
	true: true,
	type: true,
	unsafe: true,
	use: true,
	where: true,
	while: true,
	yield: true,
	abstract: true,
	become: true,
	do: true,
	macro: true,
	override: true,
	priv: true,
	try: true,
	typeof: true,
	unsized: true,
	virtual: true,
};
/** Keywords that cannot be raw identifiers. */
const RESERVED: Record<string, true> = { self: true, super: true, crate: true, Self: true };

function words(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(word => word.length > 0);
}

function pascal(text: string): string {
	const name = words(text)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join("");
	if (name.length === 0) throw new Error(`cannot name ${JSON.stringify(text)}`);
	return /^[0-9]/.test(name) ? `V${name}` : name;
}

function snake(text: string): string {
	const name = words(text)
		.map(word => word.toLowerCase())
		.join("_");
	if (name.length === 0) throw new Error(`cannot name ${JSON.stringify(text)}`);
	if (/^[0-9]/.test(name)) return `_${name}`;
	if (RESERVED[name]) return `${name}_`;
	return KEYWORDS[name] ? `r#${name}` : name;
}

/** Rust string literal. */
function str(text: string): string {
	let out = '"';
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "\\" || char === '"') out += `\\${char}`;
		else if (char === "\n") out += "\\n";
		else if (char === "\t") out += "\\t";
		else if (char === "\r") out += "\\r";
		else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`;
		else out += char;
	}
	return `${out}"`;
}

function docs(text: string | undefined, indent: string): string {
	if (!text) return "";
	return text
		.split("\n")
		.map(line => (line.length > 0 ? `${indent}/// ${line}\n` : `${indent}///\n`))
		.join("");
}

interface FieldPlan {
	field: WireField;
	name: string;
	/** Rust type as declared on the struct. */
	type: string;
	attrs: string[];
}

class RustEmitter {
	#model: WireModel;
	/** Definitions referenced by a field, alias, or command (not only through a union). */
	#direct = new Set<string>();
	/** Object definition → constant keys omitted from its struct (re-inserted by unions). */
	#omitted = new Map<string, Set<string>>();
	/** Generated type name → emitted code; detects collisions. */
	#extra = new Map<string, string>();
	#defaults: string[] = [];
	/** Preamble helpers some field needs. */
	#helpers = new Set<"orUnknown" | "scalarOrArray">();
	#names = new Set<string>();

	constructor(model: WireModel) {
		this.#model = model;
		for (const name of model.defs.keys()) this.#names.add(name);
		const visit = (type: WireType): void => {
			if (type.kind === "ref") this.#direct.add(type.name);
			else if (type.kind === "array") visit(type.items);
			else if (type.kind === "record") visit(type.values);
			else if (type.kind === "union") for (const member of type.members) visit(member);
		};
		for (const def of model.defs.values()) {
			if (def.kind === "object") for (const field of def.fields) visit(field.type);
			else if (!unionMembers(def)) visit(def.type);
		}
		for (const command of model.commands) {
			if (command.params) this.#direct.add(command.params);
			if (command.result) this.#direct.add(command.result);
		}
		for (const def of model.defs.values()) {
			const dispatch = unionDispatch(model, def.name);
			if (!dispatch) continue;
			for (const leaf of unionLeaves(model, def.name)) {
				const leafDef = model.defs.get(leaf);
				if (leafDef?.kind !== "object" || this.#direct.has(leaf)) continue;
				const field = leafDef.fields.find(candidate => candidate.key === dispatch.property);
				if (!field?.required || field.type.kind !== "literal" || typeof field.type.value !== "string") continue;
				let keys = this.#omitted.get(leaf);
				if (!keys) {
					keys = new Set();
					this.#omitted.set(leaf, keys);
				}
				keys.add(field.key);
			}
		}
	}

	#object(name: string): ObjectDef {
		const def = this.#model.defs.get(name);
		if (def?.kind !== "object") throw new Error(`${name} is not an object definition`);
		return def;
	}

	#register(name: string, code: () => string): string {
		if (this.#extra.has(name)) return name;
		if (this.#names.has(name)) throw new Error(`generated type ${name} collides with a definition`);
		this.#names.add(name);
		this.#extra.set(name, "");
		this.#extra.set(name, code());
		return name;
	}

	#literal(value: string | number | boolean): string {
		if (typeof value === "number") throw new Error("numeric constants are not supported");
		const name = `Lit${pascal(String(value))}`;
		return this.#register(name, () => {
			const check =
				typeof value === "string" ? `value.as_str() == Some(${str(value)})` : `value.as_bool() == Some(${value})`;
			const write =
				typeof value === "string"
					? `serializer.serialize_str(${str(value)})`
					: `serializer.serialize_bool(${value})`;
			const shown = JSON.stringify(value);
			return [
				`/// The constant \`${shown}\`.`,
				"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]",
				`pub struct ${name};`,
				"",
				`impl Serialize for ${name} {`,
				"\tfn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
				`\t\t${write}`,
				"\t}",
				"}",
				"",
				`impl<'de> Deserialize<'de> for ${name} {`,
				"\tfn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
				"\t\tlet value = Value::deserialize(deserializer)?;",
				`\t\tif ${check} {`,
				"\t\t\tOk(Self)",
				"\t\t} else {",
				`\t\t\tErr(D::Error::custom(format!(${str(`expected ${shown}, got {value}`)})))`,
				"\t\t}",
				"\t}",
				"}",
				"",
			].join("\n");
		});
	}

	#enum(name: string, values: string[], doc: string | undefined): string {
		const seen = new Set<string>();
		const variants = values.map(value => {
			const variant = pascal(value);
			if (seen.has(variant)) throw new Error(`${name}: duplicate variant ${variant}`);
			seen.add(variant);
			return `\t#[serde(rename = ${str(value)})]\n\t${variant},\n`;
		});
		const asStr = values.map(value => `\t\t\tSelf::${pascal(value)} => ${str(value)},\n`).join("");
		return [
			`${docs(doc, "")}#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]`,
			`pub enum ${name} {`,
			`${variants.join("")}}`,
			"",
			`impl ${name} {`,
			"\t/// Wire value.",
			"\tpub fn as_str(self) -> &'static str {",
			"\t\tmatch self {",
			`${asStr}\t\t}`,
			"\t}",
			"}",
			"",
		].join("\n");
	}

	#unionLabel(type: WireType): string {
		switch (type.kind) {
			case "string":
				return "String";
			case "integer":
				return "Integer";
			case "number":
				return "Number";
			case "boolean":
				return "Bool";
			case "ref":
				return type.name;
			case "array":
				return `${this.#unionLabel(type.items)}List`;
			case "record":
				return `${this.#unionLabel(type.values)}Map`;
			default:
				throw new Error(`unsupported inline union member ${type.kind}`);
		}
	}

	/** Rust type for a wire type; `owner` names inline enums. */
	render(type: WireType, owner: string): string {
		switch (type.kind) {
			case "string":
				return "String";
			case "integer":
				return "i64";
			case "number":
				return "f64";
			case "boolean":
				return "bool";
			case "unknown":
				return "Value";
			case "null":
				return "()";
			case "literal":
				return this.#literal(type.value);
			case "enum":
				return this.#register(owner, () => this.#enum(owner, type.values, undefined));
			case "ref":
				return type.name;
			case "array":
				return `Vec<${this.render(type.items, owner)}>`;
			case "record":
				return type.values.kind === "unknown"
					? "Map<String, Value>"
					: `BTreeMap<String, ${this.render(type.values, owner)}>`;
			case "union": {
				const inner = nonNull(type);
				if (inner) return `Option<${this.render(inner, owner)}>`;
				const name = type.members.map(member => this.#unionLabel(member)).join("Or");
				return this.#register(name, () => this.#untagged(name, undefined, type.members, owner));
			}
		}
	}

	/** Enum over inline union members; serde tries them in order. */
	#untagged(name: string, doc: string | undefined, members: WireType[], owner: string): string {
		const variants = members
			.map(member => {
				const label = this.#unionLabel(member);
				return `\t${label}(${this.render(member, `${owner}${label}`)}),\n`;
			})
			.join("");
		return [
			`${docs(doc, "")}${doc ? "///\n" : ""}/// Untagged union: the first variant that decodes wins.`,
			"#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]",
			"#[serde(untagged)]",
			`pub enum ${name} {`,
			`${variants}}`,
			"",
		].join("\n");
	}

	#planFields(def: ObjectDef, fields: WireField[]): FieldPlan[] {
		const omitted = this.#omitted.get(def.name);
		const used = new Set<string>();
		const plans: FieldPlan[] = [];
		for (const field of fields) {
			if (omitted?.has(field.key)) continue;
			let name = snake(field.key);
			if (def.open && name === "extra") name = "extra_";
			if (used.has(name)) throw new Error(`${def.name}: duplicate field ${name}`);
			used.add(name);
			const owner = `${def.name}${pascal(field.key)}`;
			const inner = nonNull(field.type);
			const nullable = inner !== undefined;
			if (def.open && (field.unknownFallback || field.scalarOrArray)) {
				throw new Error(
					`${def.name}.${field.key}: open records decode leniently; fallback keywords are unsupported`,
				);
			}
			let base = this.render(field.type, owner);
			if (field.unknownFallback) {
				this.#helpers.add("orUnknown");
				const known = `OrUnknown<${this.render(inner ?? field.type, owner)}>`;
				base = nullable ? `Option<${known}>` : known;
			}
			const attrs: string[] = [];
			if (field.key !== name.replace(/^r#/, "")) attrs.push(`rename = ${str(field.key)}`);
			let type = base;
			if (def.open) {
				type = nullable ? base : `Option<${base}>`;
			} else if (field.hasDefault) {
				const fn = `default_${snake(def.name).replace(/^r#/, "")}_${name.replace(/^r#/, "")}`;
				this.#defaults.push(
					`fn ${fn}() -> ${base} {\n\tserde_json::from_str(${str(JSON.stringify(field.default ?? null))}).expect("valid wire default")\n}\n`,
				);
				attrs.push(`default = ${str(fn)}`);
			} else if (field.required) {
				// `deserialize_with` makes a missing key an error even for `Option`/`Value`.
				if (nullable || base === "Value") attrs.push('deserialize_with = "Deserialize::deserialize"');
			} else {
				if (!nullable) type = `Option<${base}>`;
				attrs.push("default", 'skip_serializing_if = "Option::is_none"');
			}
			if (field.scalarOrArray) {
				if ((inner ?? field.type).kind !== "array")
					throw new Error(`${def.name}.${field.key}: scalar-or-array needs an array`);
				this.#helpers.add("scalarOrArray");
				const helper = type.startsWith("Option<") ? "scalar_or_array_option" : "scalar_or_array";
				const index = attrs.indexOf('deserialize_with = "Deserialize::deserialize"');
				if (index >= 0) attrs.splice(index, 1);
				attrs.push(`deserialize_with = ${str(helper)}`);
			}
			plans.push({ field, name, type, attrs });
		}
		return plans;
	}

	#fieldLines(plans: FieldPlan[], withAttrs: boolean): string {
		return plans
			.map(plan => {
				const attr = withAttrs && plan.attrs.length > 0 ? `\t#[serde(${plan.attrs.join(", ")})]\n` : "";
				return `${docs(plan.field.doc, "\t")}${attr}\tpub ${plan.name}: ${plan.type},\n`;
			})
			.join("");
	}

	#closedStruct(name: string, doc: string | undefined, plans: FieldPlan[], derives: string): string {
		const body = plans.length === 0 ? "{}" : `{\n${this.#fieldLines(plans, true)}}`;
		return `${docs(doc, "")}#[derive(${derives})]\npub struct ${name} ${body}\n`;
	}

	#openStruct(def: ObjectDef): string {
		const plans = this.#planFields(def, def.fields);
		const writes = plans
			.map(
				plan =>
					`\t\tif let Some(value) = &self.${plan.name} {\n\t\t\tmap.serialize_entry(${str(plan.field.key)}, value)?;\n\t\t}\n`,
			)
			.join("");
		const shadows = plans
			.map(plan => `\t\t\t\t${str(plan.field.key)} if self.${plan.name}.is_some() => continue,\n`)
			.join("");
		const skip = plans.length === 0 ? "" : `\t\t\tmatch key.as_str() {\n${shadows}\t\t\t\t_ => {}\n\t\t\t}\n`;
		const reads = plans.map(plan => `\t\t\t${plan.name}: take(&mut extra, ${str(plan.field.key)}),\n`).join("");
		return [
			`${docs(def.doc, "")}///`,
			"/// Open record: declared fields are decoded leniently (a value that does not fit stays",
			"/// in `extra`) and every other key is kept in `extra`.",
			"#[derive(Debug, Clone, PartialEq, Default)]",
			`pub struct ${def.name} {`,
			`${this.#fieldLines(plans, false)}\t/// Every key not decoded into a declared field.`,
			"\tpub extra: Map<String, Value>,",
			"}",
			"",
			`impl Serialize for ${def.name} {`,
			"\tfn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
			"\t\tlet mut map = serializer.serialize_map(None)?;",
			`${writes}\t\tfor (key, value) in &self.extra {`,
			`${skip}\t\t\tmap.serialize_entry(key, value)?;`,
			"\t\t}",
			"\t\tmap.end()",
			"\t}",
			"}",
			"",
			`impl<'de> Deserialize<'de> for ${def.name} {`,
			"\tfn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
			`\t\t${plans.length === 0 ? "let" : "let mut"} extra = Map::<String, Value>::deserialize(deserializer)?;`,
			`\t\tOk(Self {\n${reads}\t\t\textra,\n\t\t})`,
			"\t}",
			"}",
			"",
		].join("\n");
	}

	/** Constant keys a union must insert when encoding `member` (a leaf). */
	#tags(member: string, property: string | undefined): [string, string][] {
		const def = this.#model.defs.get(member);
		if (def?.kind !== "object") return [];
		const omitted = this.#omitted.get(member);
		const tags: [string, string][] = [];
		for (const field of def.fields) {
			if (field.type.kind !== "literal" || typeof field.type.value !== "string") continue;
			if (omitted?.has(field.key) || field.key === property) tags.push([field.key, field.type.value]);
		}
		return tags;
	}

	#serializeArm(variant: string, member: string, property: string | undefined): string {
		const tags = this.#tags(member, property);
		if (tags.length === 0) return `\t\t\tSelf::${variant}(member) => member.serialize(serializer),\n`;
		const list = tags.map(([key, value]) => `(${str(key)}, ${str(value)})`).join(", ");
		return `\t\t\tSelf::${variant}(member) => serialize_tagged(member, &[${list}], serializer),\n`;
	}

	#union(def: WireDef, members: string[]): string {
		const model = this.#model;
		const dispatch = unionDispatch(model, def.name);
		const unknown = def.name === model.notification || def.name === model.serverFrame;
		const variants = new Map<string, string>();
		const variantOf = (member: string): string => {
			const existing = variants.get(member);
			if (existing) return existing;
			let variant = member;
			if (dispatch && !unionMembers(model.defs.get(member))) {
				for (const [value, target] of dispatch.cases) if (target === member) variant = pascal(value);
			}
			if ([...variants.values()].includes(variant) || variant === "Unknown") {
				throw new Error(`${def.name}: duplicate variant ${variant}`);
			}
			variants.set(member, variant);
			return variant;
		};
		const body = members
			.map(member => `${docs(model.defs.get(member)?.doc, "\t")}\t${variantOf(member)}(${member}),\n`)
			.join("");
		const unknownVariant = unknown
			? "\t/// A frame whose discriminator this binding does not know; the raw JSON is kept.\n\tUnknown(Value),\n"
			: "";
		const serialize = members
			.map(member => this.#serializeArm(variantOf(member), member, dispatch?.property))
			.join("");
		let decode: string;
		if (dispatch) {
			const arms = members
				.map(member => {
					const values = [...dispatch.cases]
						.filter(([, target]) => target === member)
						.map(([value]) => str(value));
					return `\t\t\tSome(${values.join(" | ")}) => |value| serde_json::from_value(value).map(Self::${variantOf(member)}),\n`;
				})
				.join("");
			const fallback = unknown
				? "\t\t\t_ => |value| Ok(Self::Unknown(value)),\n"
				: `\t\t\tother => {\n\t\t\t\treturn Err(serde_json::Error::custom(format!(${str(`unknown ${def.name} ${dispatch.property} {other:?}`)})));\n\t\t\t}\n`;
			decode = [
				`\t/// Decodes from JSON, dispatching on \`${dispatch.property}\`.`,
				"\tpub fn from_value(value: Value) -> Result<Self, serde_json::Error> {",
				`\t\tlet decode: fn(Value) -> Result<Self, serde_json::Error> = match value.get(${str(dispatch.property)}).and_then(Value::as_str) {`,
				`${arms}${fallback}\t\t};`,
				"\t\tdecode(value)",
				"\t}",
			].join("\n");
		} else {
			const tries = members
				.map(
					member =>
						`\t\tif let Ok(member) = ${member}::deserialize(&value) {\n\t\t\treturn Ok(Self::${variantOf(member)}(member));\n\t\t}\n`,
				)
				.join("");
			decode = [
				"\t/// Decodes from JSON: the first member that decodes wins.",
				"\tpub fn from_value(value: Value) -> Result<Self, serde_json::Error> {",
				`${tries}\t\tErr(serde_json::Error::custom(${str(`no ${def.name} variant matches`)}))`,
				"\t}",
			].join("\n");
		}
		return [
			`${docs(def.doc, "")}#[derive(Debug, Clone, PartialEq)]`,
			`pub enum ${def.name} {`,
			`${body}${unknownVariant}}`,
			"",
			`impl ${def.name} {`,
			decode,
			"}",
			"",
			`impl Serialize for ${def.name} {`,
			"\tfn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
			"\t\tmatch self {",
			`${serialize}${unknown ? "\t\t\tSelf::Unknown(value) => value.serialize(serializer),\n" : ""}\t\t}`,
			"\t}",
			"}",
			"",
			`impl<'de> Deserialize<'de> for ${def.name} {`,
			"\tfn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
			"\t\tSelf::from_value(Value::deserialize(deserializer)?).map_err(D::Error::custom)",
			"\t}",
			"}",
			"",
		].join("\n");
	}

	def(def: WireDef): string {
		if (def.kind === "object") {
			if (def.open) return this.#openStruct(def);
			return this.#closedStruct(
				def.name,
				def.doc,
				this.#planFields(def, def.fields),
				"Debug, Clone, PartialEq, Serialize, Deserialize",
			);
		}
		const members = unionMembers(def);
		if (members) return this.#union(def, members);
		if (def.type.kind === "enum") return this.#enum(def.name, def.type.values, def.doc);
		if (def.type.kind === "union" && !nonNull(def.type)) {
			return this.#untagged(def.name, def.doc, def.type.members, def.name);
		}
		return `${docs(def.doc, "")}pub type ${def.name} = ${this.render(def.type, def.name)};\n`;
	}

	command(command: RpcWireCommand): string {
		const name = `${pascal(command.name)}Command`;
		let plans: FieldPlan[] = [];
		if (command.params) {
			const params = this.#object(command.params);
			const fields = params.fields.filter(field => !command.clientOmit.includes(field.key));
			plans = this.#planFields(params, fields);
		}
		const defaultable = plans.every(plan => plan.type.startsWith("Option<"));
		const derives = `Debug, Clone, PartialEq, Serialize, Deserialize${defaultable ? ", Default" : ""}`;
		const completion =
			command.completion === "prompt_result"
				? "\n\nThe returned value is only the acknowledgement: the work completes with a\n`prompt_result` notification carrying this command's id."
				: "";
		const struct = this.#closedStruct(name, `${command.doc ?? ""}${completion}`, plans, derives);
		let output = "()";
		let decode = "\t\tlet _ = data;\n\t\tOk(())";
		if (command.result) {
			const result = this.#object(command.result);
			let project = "";
			output = command.result;
			if (command.unwrap) {
				const plan = this.#planFields(result, result.fields).find(
					candidate => candidate.field.key === command.unwrap,
				);
				if (!plan || result.open) throw new Error(`${command.name}: cannot unwrap ${command.unwrap}`);
				output = plan.type;
				project = `.map(|result| result.${plan.name})`;
			}
			if (command.nullable) {
				output = `Option<${output}>`;
				decode = [
					"\t\tmatch data {",
					"\t\t\tNone | Some(Value::Null) => Ok(None),",
					`\t\t\tSome(value) => serde_json::from_value::<${command.result}>(value)${project}.map(Some),`,
					"\t\t}",
				].join("\n");
			} else {
				// Servers omit `data` for results whose fields are all optional (e.g. the `prompt` ack).
				decode = `\t\tserde_json::from_value::<${command.result}>(data.unwrap_or_else(|| Value::Object(Map::new())))${project}`;
			}
		}
		const timeout = command.timeoutMs === null ? "None" : `Some(${command.timeoutMs})`;
		return [
			struct,
			`impl Command for ${name} {`,
			`\tconst NAME: &'static str = ${str(command.name)};`,
			`\tconst TIMEOUT_MS: Option<u64> = ${timeout};`,
			`\ttype Output = ${output};`,
			"",
			"\tfn decode(data: Option<Value>) -> Result<Self::Output, serde_json::Error> {",
			decode,
			"\t}",
			"}",
			"",
		].join("\n");
	}

	emit(): string {
		const defs = [...this.#model.defs.values()].map(def => this.def(def));
		const commands = this.#model.commands.map(command => this.command(command));
		return [
			"// Code generated by `bun run gen:rpc` from packages/coding-agent/src/modes/rpc/wire. Do not edit.",
			"#![allow(dead_code, clippy::all, rustdoc::all)]",
			"",
			"use std::collections::BTreeMap;",
			"",
			"use serde::de::{DeserializeOwned, Error as _};",
			"use serde::ser::SerializeMap as _;",
			"use serde::{Deserialize, Deserializer, Serialize, Serializer};",
			"use serde_json::{Map, Value};",
			"",
			"/// A command: its parameters serialize to the frame body next to `id` and `type`.",
			"pub trait Command: Serialize {",
			"\t/// Wire `type` of the command frame.",
			"\tconst NAME: &'static str;",
			"\t/// Deadline overriding the client default, in milliseconds.",
			"\tconst TIMEOUT_MS: Option<u64>;",
			"\t/// Value returned on success.",
			"\ttype Output;",
			"\t/// Decodes the successful response's `data`.",
			"\tfn decode(data: Option<Value>) -> Result<Self::Output, serde_json::Error>;",
			"}",
			"",
			"/// Removes `key` and decodes it; a value that does not fit is put back.",
			"fn take<T: DeserializeOwned>(map: &mut Map<String, Value>, key: &str) -> Option<T> {",
			"\tlet value = map.remove(key)?;",
			"\tmatch T::deserialize(&value) {",
			"\t\tOk(decoded) => Some(decoded),",
			"\t\tErr(_) => {",
			"\t\t\tmap.insert(key.to_owned(), value);",
			"\t\t\tNone",
			"\t\t}",
			"\t}",
			"}",
			"",
			"/// Serializes `member` with constant keys inserted.",
			"fn serialize_tagged<T: Serialize, S: Serializer>(member: &T, tags: &[(&str, &str)], serializer: S) -> Result<S::Ok, S::Error> {",
			"\tlet mut value = serde_json::to_value(member).map_err(serde::ser::Error::custom)?;",
			"\tif let Value::Object(map) = &mut value {",
			"\t\tfor (key, tag) in tags {",
			"\t\t\tmap.insert((*key).to_owned(), Value::String((*tag).to_owned()));",
			"\t\t}",
			"\t}",
			"\tvalue.serialize(serializer)",
			"}",
			"",
			...(this.#helpers.has("orUnknown") ? OR_UNKNOWN : []),
			...(this.#helpers.has("scalarOrArray") ? SCALAR_OR_ARRAY : []),
			...defs,
			...this.#extra.values(),
			...this.#defaults,
			...commands,
		]
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/\n*$/, "\n");
	}
}

/** Field type for `x-unknown-fallback`: a value that fails to decode keeps its raw JSON. */
const OR_UNKNOWN = [
	"/// A value that decoded, or the raw JSON and decode error when it did not.",
	"#[derive(Debug, Clone, PartialEq)]",
	"pub enum OrUnknown<T> {",
	"\tKnown(T),",
	"\t/// The value failed to decode; `raw` is the JSON as received.",
	"\tUnknown { raw: Value, error: String },",
	"}",
	"",
	"impl<T: Serialize> Serialize for OrUnknown<T> {",
	"\tfn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
	"\t\tmatch self {",
	"\t\t\tSelf::Known(value) => value.serialize(serializer),",
	"\t\t\tSelf::Unknown { raw, .. } => raw.serialize(serializer),",
	"\t\t}",
	"\t}",
	"}",
	"",
	"impl<'de, T: DeserializeOwned> Deserialize<'de> for OrUnknown<T> {",
	"\tfn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
	"\t\tlet raw = Value::deserialize(deserializer)?;",
	"\t\tOk(match T::deserialize(&raw) {",
	"\t\t\tOk(value) => Self::Known(value),",
	"\t\t\tErr(error) => Self::Unknown { raw, error: error.to_string() },",
	"\t\t})",
	"\t}",
	"}",
	"",
];

/** Decoders for `x-scalar-or-array` fields: a bare scalar decodes as a one-element list. */
const SCALAR_OR_ARRAY = [
	"fn vec_from_scalar_or_array<T: DeserializeOwned>(value: Value) -> Result<Vec<T>, serde_json::Error> {",
	"\tmatch value {",
	"\t\tValue::Array(_) => serde_json::from_value(value),",
	"\t\tscalar => serde_json::from_value(scalar).map(|item| vec![item]),",
	"\t}",
	"}",
	"",
	"fn scalar_or_array<'de, D: Deserializer<'de>, T: DeserializeOwned>(deserializer: D) -> Result<Vec<T>, D::Error> {",
	"\tvec_from_scalar_or_array(Value::deserialize(deserializer)?).map_err(D::Error::custom)",
	"}",
	"",
	"fn scalar_or_array_option<'de, D: Deserializer<'de>, T: DeserializeOwned>(deserializer: D) -> Result<Option<Vec<T>>, D::Error> {",
	"\tmatch Value::deserialize(deserializer)? {",
	"\t\tValue::Null => Ok(None),",
	"\t\tvalue => vec_from_scalar_or_array(value).map(Some).map_err(D::Error::custom),",
	"\t}",
	"}",
	"",
];
/** Renders the generated Rust module. */
export function emitRust(model: WireModel): string {
	return new RustEmitter(model).emit();
}
