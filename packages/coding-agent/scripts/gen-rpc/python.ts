/**
 * Emits `omp_rpc/_wire.py`: Python types, decoders, and client methods for the
 * RPC wire bundle.
 *
 * Mapping:
 * - closed object definitions → frozen keyword-only dataclasses (snake_case
 *   fields) with strict `parse_<name>` decoders; unknown keys are dropped
 * - open records (`x-open`) → `TypedDict`s decoded by discriminator only
 * - string enums → `Literal` aliases with value sets
 * - discriminated unions → aliases with dispatching decoders
 * - commands → methods on `WireClient`, unsolicited frames → `on_<type>` listeners
 *
 * `PYTHON_BINDING` holds the Python-only API decisions (names kept for
 * compatibility, flattened unions, commands with hand-written semantics).
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

interface PythonBinding {
	/** `Def.key` → Python attribute name, where snake_case would break the public API. */
	fieldNames: Record<string, string>;
	/** Union definitions emitted as one record (all variant fields optional) with a mixin base. */
	flatten: Record<string, { discriminator: string; methodAlias: string; base: string; baseModule: string }>;
	/** Commands `RpcClient` implements by hand (prompt correlation, registries, paging). */
	handwrittenCommands: string[];
	/** `command.key` string params that accept `pathlib.Path`. */
	pathParams: string[];
	/** Commands whose unwrapped string result is returned as `pathlib.Path`. */
	pathResults: string[];
	/** Frame `type` → listener method name, where `on_<type>` would break the public API. */
	listenerNames: Record<string, string>;
	/** Definitions emitted although no command or frame reaches them. */
	extraDefs: string[];
}

const PYTHON_BINDING: PythonBinding = {
	fieldNames: {
		"RetryFallbackAppliedEvent.from": "from_model",
		"RetryFallbackAppliedEvent.to": "to_model",
		"ModelInfo.input": "input_modalities",
	},
	flatten: {
		ExtensionUiRequest: {
			discriminator: "method",
			methodAlias: "ExtensionUiMethod",
			base: "ExtensionUiRequestMixin",
			baseModule: "._extension_ui",
		},
	},
	handwrittenCommands: [
		"negotiate_protocol",
		"prompt",
		"abort_and_prompt",
		"set_todos",
		"set_host_tools",
		"set_host_uri_schemes",
		"get_messages",
	],
	pathParams: ["open_session.sessionDir", "switch_session.sessionPath", "export_html.outputPath"],
	pathResults: ["export_html"],
	listenerNames: { extension_ui_request: "on_ui_request" },
	extraDefs: ["AskAnswer"],
};

const PYTHON_KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

function snake(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.toLowerCase();
}

function pyString(value: string): string {
	return JSON.stringify(value);
}

/** Python literal for a JSON default value. */
function pyLiteral(value: unknown): string {
	if (value === null) return "None";
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return pyString(value);
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(pyLiteral).join(", ")}]`;
	if (typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.map(([key, item]) => `${pyString(key)}: ${pyLiteral(item)}`)
			.join(", ")}}`;
	}
	throw new Error(`Unsupported default ${String(value)}`);
}

function docstring(text: string | undefined, indent: string): string {
	if (!text) return "";
	const escaped = text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"');
	return `${indent}"""${escaped}"""\n`;
}

class PythonEmitter {
	readonly #model: WireModel;
	readonly #binding: PythonBinding;
	/** Runtime helper names the output uses; drives the import list. */
	readonly #runtime = new Set<string>();
	readonly #typing = new Set<string>(["Final", "TypeAlias", "cast"]);
	readonly #exports: string[] = [];
	readonly #emitted: Set<string>;
	readonly #flattenMethods = new Map<string, string[]>();
	/** Python-only definitions (method aliases of flattened unions). */
	readonly #synthetic = new Map<string, WireDef>();
	#usesPath = false;
	#usesField = false;

	constructor(model: WireModel, binding: PythonBinding) {
		this.#model = model;
		this.#binding = binding;
		this.#emitted = this.#reachableDefs();
	}

	#def(name: string): WireDef {
		const def = this.#model.defs.get(name) ?? this.#synthetic.get(name);
		if (!def) throw new Error(`Unknown definition ${name}`);
		return def;
	}

	#isEnum(def: WireDef): def is Extract<WireDef, { kind: "alias" }> & { type: { kind: "enum" } } {
		return def.kind === "alias" && def.type.kind === "enum";
	}

	#isOpen(name: string): boolean {
		const def = this.#def(name);
		if (def.kind === "object") return def.open;
		const members = unionMembers(def);
		return members !== undefined && unionLeaves(this.#model, name).every(leaf => this.#isOpen(leaf));
	}

	/** Definitions with a Python counterpart: reachable from frames, results, and param field types. */
	#reachableDefs(): Set<string> {
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
		const visitFields = (name: string): void => {
			const def = this.#def(name);
			if (def.kind === "object") for (const field of def.fields) visitType(field.type);
			else visitType(def.type);
		};
		const visitDef = (name: string): void => {
			if (reached.has(name)) return;
			reached.add(name);
			visitFields(name);
		};
		visitDef(this.#model.notification);
		for (const name of this.#binding.extraDefs) visitDef(name);
		for (const command of this.#model.commands) {
			if (command.params) visitFields(command.params);
			if (!command.result) continue;
			if (command.unwrap) visitFields(command.result);
			else visitDef(command.result);
		}
		return reached;
	}

	#fieldName(owner: string, key: string): string {
		const override = this.#binding.fieldNames[`${owner}.${key}`];
		if (override) return override;
		const name = snake(key);
		return PYTHON_KEYWORDS.has(name) ? `${name}_` : name;
	}

	#annotation(type: WireType, mode: "record" | "dict"): string {
		switch (type.kind) {
			case "string":
				return "str";
			case "integer":
				return "int";
			case "number":
				return "float";
			case "boolean":
				return "bool";
			case "null":
				return "None";
			case "unknown":
				this.#runtime.add("JsonValue");
				return "JsonValue";
			case "literal":
				this.#typing.add("Literal");
				return `Literal[${typeof type.value === "string" ? pyString(type.value) : pyLiteral(type.value)}]`;
			case "enum":
				this.#typing.add("Literal");
				return `Literal[${type.values.map(pyString).join(", ")}]`;
			case "ref":
				return type.name;
			case "array": {
				const items = this.#annotation(type.items, mode);
				return mode === "record" ? `tuple[${items}, ...]` : `list[${items}]`;
			}
			case "record":
				if (type.values.kind === "unknown") {
					this.#runtime.add("JsonObject");
					return "JsonObject";
				}
				return `dict[str, ${this.#annotation(type.values, mode)}]`;
			case "union":
				return type.members.map(member => this.#annotation(member, mode)).join(" | ");
		}
	}

	/** Python expression for a decoder of `type`. */
	#decoder(type: WireType, where: string): string {
		switch (type.kind) {
			case "string":
				this.#runtime.add("decode_str");
				return "decode_str";
			case "integer":
				this.#runtime.add("decode_int");
				return "decode_int";
			case "number":
				this.#runtime.add("decode_float");
				return "decode_float";
			case "boolean":
				this.#runtime.add("decode_bool");
				return "decode_bool";
			case "unknown":
				this.#runtime.add("decode_json");
				return "decode_json";
			case "literal":
			case "enum": {
				this.#runtime.add("literal");
				this.#runtime.add("Decoder");
				const values = type.kind === "literal" ? [String(type.value)] : type.values;
				return `cast('Decoder[${this.#annotation(type, "record")}]', literal(frozenset({${values.map(pyString).join(", ")}})))`;
			}
			case "ref": {
				const def = this.#def(type.name);
				return this.#isEnum(def) ? `_decode_${snake(type.name)}` : `parse_${snake(type.name)}`;
			}
			case "array":
				this.#runtime.add("array");
				return `array(${this.#decoder(type.items, where)})`;
			case "record":
				if (type.values.kind === "unknown") {
					this.#runtime.add("decode_json_object");
					return "decode_json_object";
				}
				this.#runtime.add("record");
				return `record(${this.#decoder(type.values, where)})`;
			case "union": {
				const inner = nonNull(type);
				if (inner) {
					this.#runtime.add("nullable");
					return `nullable(${this.#decoder(inner, where)})`;
				}
				throw new Error(`${where}: Python decoders support only nullable unions inline`);
			}
			case "null":
				throw new Error(`${where}: bare null type`);
		}
	}

	#fieldDecoder(owner: string, field: WireField): { decoder: string; annotation: string } {
		const id = `${owner}.${field.key}`;
		if (field.unknownFallback) {
			this.#runtime.add("or_unknown");
			this.#runtime.add("UnknownNotification");
			return {
				decoder: `or_unknown(${this.#decoder(field.type, id)})`,
				annotation: `${this.#annotation(field.type, "record")} | UnknownNotification`,
			};
		}
		if (field.scalarOrArray) {
			if (field.type.kind !== "array") throw new Error(`${id}: scalar-or-array needs an array type`);
			this.#runtime.add("scalar_or_array");
			return {
				decoder: `scalar_or_array(${this.#decoder(field.type.items, id)})`,
				annotation: this.#annotation(field.type, "record"),
			};
		}
		return { decoder: this.#decoder(field.type, id), annotation: this.#annotation(field.type, "record") };
	}

	#discriminatorField(def: Extract<WireDef, { kind: "object" }>): WireField | undefined {
		return def.fields.find(
			field => ["type", "role", "method"].includes(field.key) && field.required && field.type.kind === "literal",
		);
	}

	// --- Definitions -------------------------------------------------------------

	#emitEnum(def: Extract<WireDef, { kind: "alias" }>, values: string[]): string {
		this.#runtime.add("literal");
		this.#runtime.add("Decoder");
		this.#typing.add("Literal");
		const constant = `_${snake(def.name).toUpperCase()}_VALUES`;
		this.#exports.push(def.name);
		return [
			`${def.name}: TypeAlias = Literal[${values.map(pyString).join(", ")}]`,
			docstring(def.doc, "").trimEnd(),
			`${constant}: Final[frozenset[str]] = frozenset({${values.map(pyString).join(", ")}})`,
			`_decode_${snake(def.name)} = cast("Decoder[${def.name}]", literal(${constant}))`,
		]
			.filter(Boolean)
			.join("\n");
	}

	#emitTypedDict(def: Extract<WireDef, { kind: "object" }>): string {
		this.#typing.add("TypedDict");
		this.#exports.push(def.name);
		const usesKeyword = def.fields.some(field => PYTHON_KEYWORDS.has(field.key));
		const entry = (field: WireField): string => {
			const annotation = this.#annotation(field.type, "dict");
			if (field.required) return annotation;
			this.#typing.add("NotRequired");
			return `NotRequired[${annotation}]`;
		};
		if (usesKeyword) {
			const entries = def.fields.map(field => `${pyString(field.key)}: ${pyString(entry(field))}`).join(", ");
			return `${def.name} = TypedDict(${pyString(def.name)}, {${entries}})\n${docstring(def.doc, "").trimEnd()}`;
		}
		const body = def.fields
			.map(field => `    ${field.key}: ${entry(field)}\n${docstring(field.doc, "    ")}`)
			.join("");
		return `class ${def.name}(TypedDict):\n${docstring(def.doc, "    ")}${body}`;
	}

	#openDecoder(name: string): string {
		this.#runtime.add("open_record");
		this.#runtime.add("Decoder");
		const def = this.#def(name);
		let discriminator: string | undefined;
		let values: string[] = [];
		if (def.kind === "object") {
			const field = this.#discriminatorField(def);
			if (field && field.type.kind === "literal") {
				discriminator = field.key;
				values = [String(field.type.value)];
			}
		} else {
			const dispatch = unionDispatch(this.#model, name);
			if (dispatch) {
				discriminator = dispatch.property;
				values = [...dispatch.cases.keys()];
			}
		}
		const args = discriminator
			? `${pyString(discriminator)}, frozenset({${values.map(pyString).join(", ")}})`
			: "None, None";
		this.#exports.push(`parse_${snake(name)}`);
		return `parse_${snake(name)} = cast("Decoder[${name}]", open_record(${args}))\n${docstring(`Decodes a \`${name}\` open record: checks the discriminator and keeps every key.`, "").trimEnd()}`;
	}

	#emitDataclass(def: Extract<WireDef, { kind: "object" }>, base?: string): string {
		this.#exports.push(def.name);
		const lines: string[] = [];
		for (const field of def.fields) {
			const name = this.#fieldName(def.name, field.key);
			const { annotation } = this.#fieldDecoder(def.name, field);
			const fieldDoc = docstring(field.doc, "    ");
			if (field.required && field.type.kind === "literal") {
				lines.push(`    ${name}: ${annotation} = ${pyLiteral(field.type.value)}\n${fieldDoc}`);
			} else if (field.required) {
				lines.push(`    ${name}: ${annotation}\n${fieldDoc}`);
			} else if (field.hasDefault) {
				lines.push(`    ${name}: ${annotation} = ${this.#defaultExpression(field)}\n${fieldDoc}`);
			} else {
				const optional = annotation.split(" | ").includes("None") ? annotation : `${annotation} | None`;
				lines.push(`    ${name}: ${optional} = None\n${fieldDoc}`);
			}
		}
		// Required fields come first in omptype's emission, so defaults never precede them; kw_only keeps
		// construction independent of declaration order anyway.
		return `@dataclass(slots=True, frozen=True, kw_only=True)\nclass ${def.name}${base ? `(${base})` : ""}:\n${docstring(def.doc, "    ")}${lines.join("")}`;
	}

	#defaultExpression(field: WireField): string {
		const value = field.default;
		if (Array.isArray(value)) {
			if (value.length > 0) throw new Error(`${field.key}: non-empty array defaults are not supported`);
			return "()";
		}
		if (value !== null && typeof value === "object") {
			if (field.type.kind !== "ref") throw new Error(`${field.key}: object default needs a named type`);
			this.#usesField = true;
			return `field(default_factory=lambda: ${this.#decoder(field.type, field.key)}(${pyLiteral(value)}, ${pyString(field.key)}))`;
		}
		return pyLiteral(value);
	}

	#parseFunction(def: Extract<WireDef, { kind: "object" }>): string {
		this.#runtime.add("expect_object");
		this.#exports.push(`parse_${snake(def.name)}`);
		const checks: string[] = [];
		const args: string[] = [];
		for (const field of def.fields) {
			const name = this.#fieldName(def.name, field.key);
			const { decoder } = this.#fieldDecoder(def.name, field);
			if (field.required && field.type.kind === "literal") {
				this.#runtime.add("required");
				checks.push(`    required(payload, ${pyString(field.key)}, ${decoder}, path)\n`);
			} else if (field.required) {
				this.#runtime.add("required");
				args.push(`        ${name}=required(payload, ${pyString(field.key)}, ${decoder}, path),\n`);
			} else if (field.hasDefault) {
				this.#runtime.add("defaulted");
				args.push(
					`        ${name}=defaulted(payload, ${pyString(field.key)}, ${decoder}, path, ${this.#defaultValue(field)}),\n`,
				);
			} else {
				this.#runtime.add("optional");
				args.push(`        ${name}=optional(payload, ${pyString(field.key)}, ${decoder}, path),\n`);
			}
		}
		return `def parse_${snake(def.name)}(value: object, path: str = ${pyString(def.name)}) -> ${def.name}:\n    payload = expect_object(value, path)\n${checks.join("")}    return ${def.name}(\n${args.join("")}    )\n`;
	}

	#defaultValue(field: WireField): string {
		const value = field.default;
		if (Array.isArray(value)) return "()";
		if (value !== null && typeof value === "object") {
			return `${this.#decoder(field.type, field.key)}(${pyLiteral(value)}, path)`;
		}
		return pyLiteral(value);
	}

	/** Merges a union's variants into one record whose variant-specific fields are optional. */
	#flattenedDef(name: string): Extract<WireDef, { kind: "object" }> {
		const leaves = unionLeaves(this.#model, name).map(leaf => this.#def(leaf));
		const merged = new Map<string, WireField>();
		const presence = new Map<string, number>();
		const discriminator = this.#binding.flatten[name].discriminator;
		for (const leaf of leaves) {
			if (leaf.kind !== "object") throw new Error(`${name}: flattened member ${leaf.name} is not an object`);
			for (const field of leaf.fields) {
				presence.set(field.key, (presence.get(field.key) ?? 0) + (field.required ? 1 : 0));
				const known = merged.get(field.key);
				if (field.key === discriminator) continue;
				if (known && JSON.stringify(known.type) !== JSON.stringify(field.type)) {
					throw new Error(`${name}.${field.key}: variants disagree on the type`);
				}
				if (!known) merged.set(field.key, { ...field, required: false, hasDefault: false });
			}
		}
		const methods = leaves.map(leaf => constantOf(leaf, discriminator) ?? "");
		this.#flattenMethods.set(name, methods);
		const alias = this.#binding.flatten[name].methodAlias;
		this.#synthetic.set(alias, { name: alias, kind: "alias", type: { kind: "enum", values: methods } });
		const fields: WireField[] = [
			{ key: discriminator, type: { kind: "ref", name: alias }, required: true, hasDefault: false },
		];
		for (const [key, field] of merged) {
			fields.push({ ...field, required: presence.get(key) === leaves.length });
		}
		const def = this.#def(name);
		return { name, doc: def.doc, kind: "object", fields, open: false };
	}

	// --- Client ---------------------------------------------------------------------

	#commandMethod(command: RpcWireCommand): string {
		const params = command.params ? this.#def(command.params) : undefined;
		if (params && params.kind !== "object") throw new Error(`${command.name}: params must be an object`);
		const fields = (params?.fields ?? []).filter(field => !command.clientOmit.includes(field.key));
		const signature: string[] = ["self"];
		let keywordOnly = false;
		const body: string[] = [];
		const ordered = [...fields.filter(field => field.required), ...fields.filter(field => !field.required)];
		for (const field of ordered) {
			const name = this.#fieldName(command.params ?? "", field.key);
			const isPath = this.#binding.pathParams.includes(`${command.name}.${field.key}`);
			let annotation = this.#paramAnnotation(field.type, `${command.name}.${field.key}`);
			let value = this.#paramValue(field.type, name);
			if (isPath) {
				this.#usesPath = true;
				annotation = "str | Path";
				value = `str(${name})`;
			}
			const kwOnly = ordered.length > 1 && (!field.required || field.type.kind === "boolean");
			if (kwOnly && !keywordOnly) {
				signature.push("*");
				keywordOnly = true;
			}
			if (field.required) {
				signature.push(`${name}: ${annotation}`);
				body.push(`        params[${pyString(field.key)}] = ${value}\n`);
			} else {
				signature.push(`${name}: ${annotation} | None = None`);
				body.push(`        if ${name} is not None:\n            params[${pyString(field.key)}] = ${value}\n`);
			}
		}
		const timeout = command.timeoutMs === null ? "" : `, timeout=${command.timeoutMs / 1000}`;
		const call = `self._command(${pyString(command.name)}, params${timeout})`;
		const { returns, statement } = this.#commandResult(command, call);
		const lines = [
			`    def ${command.name}(${signature.join(", ")}) -> ${returns}:\n`,
			docstring(command.doc, "        "),
			"        params: dict[str, object] = {}\n",
			...body,
			`        ${statement}\n`,
		];
		return lines.join("");
	}

	#paramAnnotation(type: WireType, where: string): string {
		if (type.kind === "array") {
			this.#typing.add("Sequence");
			return `Sequence[${this.#paramAnnotation(type.items, where)}]`;
		}
		if (type.kind === "ref" && this.#def(type.name).kind === "object" && !this.#isOpen(type.name)) {
			throw new Error(`${where}: record-typed parameters need a hand-written command`);
		}
		const inner = nonNull(type);
		if (inner) return `${this.#paramAnnotation(inner, where)} | None`;
		return this.#annotation(type, "record");
	}

	#paramValue(type: WireType, name: string): string {
		const inner = nonNull(type);
		if (inner?.kind === "array") return `list(${name}) if ${name} is not None else None`;
		return type.kind === "array" ? `list(${name})` : name;
	}

	#commandResult(command: RpcWireCommand, call: string): { returns: string; statement: string } {
		if (!command.result) return { returns: "None", statement: call };
		if (command.unwrap) {
			const envelope = this.#def(command.result);
			const field = envelope.kind === "object" ? envelope.fields.find(f => f.key === command.unwrap) : undefined;
			if (!field) throw new Error(`${command.name}: unwrap field ${command.unwrap} not in ${command.result}`);
			this.#runtime.add("required");
			this.#runtime.add("expect_object");
			const decoder = this.#decoder(field.type, `${command.result}.${field.key}`);
			const value = `required(expect_object(${call}, ${pyString(command.name)}), ${pyString(field.key)}, ${decoder}, ${pyString(command.name)})`;
			if (this.#binding.pathResults.includes(command.name)) {
				this.#usesPath = true;
				return { returns: "Path", statement: `return Path(${value})` };
			}
			return { returns: this.#annotation(field.type, "record"), statement: `return ${value}` };
		}
		const decoder = this.#decoder({ kind: "ref", name: command.result }, command.name);
		if (command.nullable) {
			return {
				returns: `${command.result} | None`,
				statement: `data = ${call}\n        return None if data is None else ${decoder}(data, ${pyString(command.name)})`,
			};
		}
		return { returns: command.result, statement: `return ${decoder}(${call}, ${pyString(command.name)})` };
	}

	#listenerMethod(frameType: string, className: string, doc: string | undefined): string {
		const name = this.#binding.listenerNames[frameType] ?? `on_${frameType}`;
		this.#typing.add("Callable");
		const summary = doc?.split("\n")[0];
		return `    def ${name}(self, listener: Callable[[${className}], None]) -> Callable[[], None]:\n${docstring(summary ? `Subscribe to \`${frameType}\`: ${summary}` : `Subscribe to \`${frameType}\` frames.`, "        ")}        return self._listen(${pyString(frameType)}, listener)\n`;
	}

	// --- Module ---------------------------------------------------------------------

	emit(): string {
		const enums: string[] = [];
		const dicts: string[] = [];
		const classes: string[] = [];
		const openDecoders: string[] = [];
		const parsers: string[] = [];
		const unionAliases: string[] = [];
		const unionDecoders: string[] = [];
		/** Plain aliases reference union aliases at runtime, so they follow them. */
		const plainAliases: string[] = [];
		const extraImports: string[] = [];

		const unionOrder: string[] = [];
		const visitUnion = (name: string): void => {
			if (unionOrder.includes(name)) return;
			for (const member of unionMembers(this.#def(name)) ?? []) {
				if (unionMembers(this.#def(member)) && !(member in this.#binding.flatten)) visitUnion(member);
			}
			unionOrder.push(name);
		};

		for (const name of this.#model.defs.keys()) {
			if (!this.#emitted.has(name)) continue;
			const def = this.#def(name);
			if (name in this.#binding.flatten) {
				const binding = this.#binding.flatten[name];
				const flat = this.#flattenedDef(name);
				extraImports.push(`from ${binding.baseModule} import ${binding.base}`);
				enums.push(
					this.#emitEnum(
						{ name: binding.methodAlias, kind: "alias", type: { kind: "enum", values: [] } },
						this.#flattenMethods.get(name) ?? [],
					),
				);
				classes.push(this.#emitDataclass(flat, binding.base));
				parsers.push(this.#parseFunction(flat));
				continue;
			}
			if (this.#isEnum(def)) {
				enums.push(this.#emitEnum(def, def.type.kind === "enum" ? def.type.values : []));
				continue;
			}
			if (def.kind === "object" && def.open) {
				dicts.push(this.#emitTypedDict(def));
				openDecoders.push(this.#openDecoder(name));
				continue;
			}
			if (def.kind === "object") {
				classes.push(this.#emitDataclass(def));
				parsers.push(this.#parseFunction(def));
				continue;
			}
			if (unionMembers(def)) {
				visitUnion(name);
				continue;
			}
			// A plain JSON-shaped alias (e.g. `MessageContent`) only types open records, which are
			// never decoded field by field, so it needs an annotation but no decoder.
			plainAliases.push(
				`${name}: TypeAlias = ${this.#annotation(def.type, "dict")}\n${docstring(def.doc, "").trimEnd()}`,
			);
			this.#exports.push(name);
		}

		for (const name of unionOrder) {
			const def = this.#def(name);
			const members = unionMembers(def) ?? [];
			const isNotification = name === this.#model.notification;
			const aliasMembers = isNotification ? [...members, "UnknownNotification"] : members;
			if (isNotification) this.#runtime.add("UnknownNotification");
			unionAliases.push(`${name}: TypeAlias = ${aliasMembers.join(" | ")}\n${docstring(def.doc, "").trimEnd()}`);
			this.#exports.push(name);
			if (this.#isOpen(name)) {
				openDecoders.push(this.#openDecoder(name));
				continue;
			}
			const dispatch = unionDispatch(this.#model, name);
			if (!dispatch) throw new Error(`${name}: union has no discriminator`);
			const cases = [...dispatch.cases.entries()]
				.map(
					([value, member]) =>
						`        ${pyString(value)}: ${this.#decoder({ kind: "ref", name: member }, name)},\n`,
				)
				.join("");
			const constant = `_${snake(name).toUpperCase()}_CASES`;
			unionDecoders.push(`${constant}: Final[dict[str, Decoder[${name}]]] = {\n${cases}}\n`);
			this.#runtime.add("Decoder");
			if (isNotification) {
				this.#runtime.add("expect_object");
				this.#runtime.add("decode_json_object");
				this.#exports.push("parse_notification");
				parsers.push(
					`def parse_notification(value: object, path: str = "notification") -> ${name}:\n` +
						docstring(
							"Decodes one unsolicited frame; a `type` this client does not model yields `UnknownNotification`.",
							"    ",
						) +
						`    payload = expect_object(value, path)\n` +
						`    tag = payload.get(${pyString(dispatch.property)})\n` +
						`    if not isinstance(tag, str) or tag not in ${constant}:\n        return UnknownNotification(decode_json_object(payload, path))\n` +
						`    return ${constant}[tag](payload, tag)\n`,
				);
			} else {
				this.#runtime.add("dispatch");
				this.#exports.push(`parse_${snake(name)}`);
				parsers.push(
					`def parse_${snake(name)}(value: object, path: str = ${pyString(name)}) -> ${name}:\n    return dispatch(${pyString(dispatch.property)}, ${constant})(value, path)\n`,
				);
			}
		}

		const client = this.#emitClient();
		const typingImports = [...this.#typing].sort();
		const runtimeImports = [...this.#runtime].sort((a, b) => a.localeCompare(b, "en", { caseFirst: "upper" }));
		const header = [
			"# Generated by `bun run gen:rpc` from packages/coding-agent/src/modes/rpc/wire. Do not edit.",
			'"""Types, decoders, and client methods generated from the omp RPC wire schema."""',
			"",
			"from __future__ import annotations",
			"",
			this.#usesField ? "from dataclasses import dataclass, field" : "from dataclasses import dataclass",
			...(this.#usesPath ? ["from pathlib import Path"] : []),
			`from typing import ${typingImports.join(", ")}`,
			"",
			...new Set(extraImports),
			`from ._wire_runtime import (\n${runtimeImports.map(name => `    ${name},\n`).join("")})`,
		].join("\n");
		const exportsList = `__all__ = [\n${[...new Set(this.#exports)]
			.sort()
			.map(name => `    ${pyString(name)},\n`)
			.join("")}]\n`;
		return [
			header,
			...enums,
			...dicts,
			...classes,
			...unionAliases,
			...plainAliases,
			...openDecoders,
			...parsers,
			...unionDecoders,
			client,
			exportsList,
		]
			.map(part => part.trimEnd())
			.join("\n\n\n")
			.concat("\n");
	}

	#emitClient(): string {
		this.#typing.add("Callable");
		this.#typing.add("Mapping");
		this.#runtime.add("JsonObject");
		const methods: string[] = [];
		for (const command of this.#model.commands) {
			if (this.#binding.handwrittenCommands.includes(command.name)) continue;
			methods.push(this.#commandMethod(command));
		}
		const frames = new Map<string, { className: string; doc?: string }>();
		for (const member of unionLeavesForListeners(this.#model, this.#model.notification, this.#binding)) {
			const def = this.#def(member);
			const frameType =
				member in this.#binding.flatten
					? constantOf(this.#def(unionLeaves(this.#model, member)[0]), "type")
					: constantOf(def, "type");
			if (!frameType) throw new Error(`${member}: frame without a constant type`);
			frames.set(frameType, { className: member, doc: def.doc });
		}
		for (const [frameType, { className, doc }] of frames)
			methods.push(this.#listenerMethod(frameType, className, doc));
		return [
			"class WireClient:",
			docstring(
				"Command methods and typed frame listeners; `RpcClient` supplies `_command` and `_listen`.",
				"    ",
			).trimEnd(),
			"",
			"    def _command(\n        self, command: str, params: Mapping[str, object], *, timeout: float | None = None\n    ) -> JsonObject | None:\n        raise NotImplementedError\n",
			"    def _listen(self, frame_type: str, listener: Callable[..., None]) -> Callable[[], None]:\n        raise NotImplementedError\n",
			...methods,
		].join("\n");
	}
}

/** Notification members with listeners: union leaves, keeping flattened unions whole. */
function unionLeavesForListeners(model: WireModel, name: string, binding: PythonBinding): string[] {
	if (name in binding.flatten) return [name];
	const members = unionMembers(model.defs.get(name));
	if (!members) return [name];
	return members.flatMap(member => unionLeavesForListeners(model, member, binding));
}

/** Renders `omp_rpc/_wire.py`. */
export function emitPython(model: WireModel): string {
	return new PythonEmitter(model, PYTHON_BINDING).emit();
}
