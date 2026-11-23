import * as fs from "node:fs";
import * as path from "node:path";

/** One invocation of a tool command in the embedded shell. */
export interface ToolCliRequest {
	/** Command name as invoked. */
	name: string;
	/** Arguments after the command name. */
	argv: string[];
	/** Shell working directory at invocation time. */
	cwd: string;
	/** UTF-8 stdin read to EOF, only when `argv` contains a bare `-`; empty otherwise. */
	stdin: string;
}

/** Shell-composable response of a tool command. */
export interface ToolCliResult {
	stdout: string;
	stderr: string;
	/** 0..=255 */
	exitCode: number;
}

/** Live definition of one tool command, including the JSON schema its command line is derived from. */
export interface ToolCliDefinition {
	name: string;
	description?: string;
	schema: unknown;
}

/** Host that supplies live tool definitions and executes parsed calls. */
export interface ToolCliHost {
	/** Live definition of `name`; throws for an unknown command. */
	definition(name: string): Promise<ToolCliDefinition>;
	/** Execute with parsed arguments. */
	call(name: string, args: Record<string, unknown>): Promise<ToolCliResult>;
}

/** Inputs for one schema-derived argument parse. */
export interface ToolCliParseOptions {
	cwd: string;
	stdin: string;
	signal?: AbortSignal;
	/** Test/embedding seam; implementations MUST honor signal cancellation. */
	readSource?: (absolutePath: string, signal?: AbortSignal) => Promise<string>;
}

/** Shared stdin/@file safety ceiling, matching the native shell bridge. */
export const TOOL_CLI_INPUT_LIMIT_BYTES = 16 * 1024 * 1024;

/** Usage error raised for command lines that do not match the tool's schema. */
export class ToolCliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolCliUsageError";
	}
}

type JsonObject = Record<string, unknown>;
type ScalarKind = "string" | "integer" | "number" | "boolean" | "object" | "fallback";

interface SchemaLeaf {
	path: string[];
	kind: ScalarKind;
	values?: unknown[];
	description?: string;
	required: boolean;
	repeatable: boolean;
	positional: boolean;
	schema: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createJsonObject(): JsonObject {
	return Object.create(null);
}

function cloneJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneJsonValue);
	if (!isObject(value)) return value;
	const clone = createJsonObject();
	for (const name in value) {
		if (Object.hasOwn(value, name)) clone[name] = cloneJsonValue(value[name]);
	}
	return clone;
}

/** Restore ordinary JSON object prototypes without invoking legacy __proto__ setters. */
function materializeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(materializeJsonValue);
	if (!isObject(value)) return value;
	const materialized: JsonObject = {};
	for (const name in value) {
		if (!Object.hasOwn(value, name)) continue;
		Object.defineProperty(materialized, name, {
			value: materializeJsonValue(value[name]),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return materialized;
}

function schemaType(schema: JsonObject): string | undefined {
	if (typeof schema.type === "string") return schema.type;
	if (Array.isArray(schema.type)) {
		return schema.type.find(type => typeof type === "string" && type !== "null");
	}
	return undefined;
}

function scalarKind(schema: JsonObject): ScalarKind {
	switch (schemaType(schema)) {
		case "string":
			return "string";
		case "integer":
			return "integer";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		case "array":
			return isObject(schema.items) ? scalarKind(schema.items) : "fallback";
		default:
			return "fallback";
	}
}

/** Protocol intent is harness-owned rather than a model-authored CLI argument. */
function hasProtocolIntent(schema: unknown): boolean {
	if (!isObject(schema) || !isObject(schema.properties) || !isObject(schema.properties.i)) return false;
	return schema.properties.i.description === "Short present-participle intent for this call.";
}

function resolvePointer(root: unknown, reference: string): unknown {
	if (reference === "#") return root;
	if (!reference.startsWith("#/")) return undefined;
	let value = root;
	for (const encoded of reference.slice(2).split("/")) {
		const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
		if (isObject(value)) {
			if (!Object.hasOwn(value, key)) return undefined;
			value = value[key];
		} else if (Array.isArray(value)) {
			if (!/^(?:0|[1-9]\d*)$/.test(key)) return undefined;
			value = value[Number(key)];
		} else return undefined;
	}
	return value;
}

function uniqueValues(values: unknown[]): unknown[] {
	const output: unknown[] = [];
	for (const value of values) {
		if (!output.some(existing => JSON.stringify(existing) === JSON.stringify(value))) output.push(value);
	}
	return output;
}

function mergeRequired(target: JsonObject, value: unknown, union: boolean): void {
	if (!Array.isArray(value)) return;
	const incoming = value.filter((name): name is string => typeof name === "string");
	if (!union) {
		target.required = incoming;
		return;
	}
	const existing = Array.isArray(target.required)
		? target.required.filter((name): name is string => typeof name === "string")
		: [];
	target.required = [...new Set([...existing, ...incoming])];
}

function mergeProperties(target: JsonObject, value: unknown): void {
	if (!isObject(value)) return;
	const properties = isObject(target.properties) ? target.properties : createJsonObject();
	for (const name in value) {
		if (Object.hasOwn(value, name)) properties[name] = value[name];
	}
	target.properties = properties;
}

function mergeSchema(target: JsonObject, source: JsonObject, unionRequired: boolean): void {
	for (const key in source) {
		if (!Object.hasOwn(source, key)) continue;
		const value = source[key];
		if (key === "required") mergeRequired(target, value, unionRequired);
		else if (key === "properties") mergeProperties(target, value);
		else target[key] = value;
	}
}

function isNullSchema(schema: unknown): boolean {
	if (!isObject(schema)) return false;
	if (schemaType(schema) === "null") return true;
	return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(value => value === null);
}

function combineAlternatives(alternatives: JsonObject[]): JsonObject {
	const combined = createJsonObject();
	const types = alternatives.map(schemaType).filter((type): type is string => type !== undefined);
	if (types.length > 0 && types.every(type => type === types[0])) combined.type = types[0];

	const enumValues = uniqueValues(
		alternatives.flatMap(alternative =>
			Array.isArray(alternative.enum)
				? alternative.enum
				: Object.hasOwn(alternative, "const")
					? [alternative.const]
					: [],
		),
	);
	if (enumValues.length > 0) combined.enum = enumValues;

	const properties = createJsonObject();
	for (const alternative of alternatives) {
		if (!isObject(alternative.properties)) continue;
		for (const name in alternative.properties) {
			if (!Object.hasOwn(alternative.properties, name)) continue;
			const child = alternative.properties[name];
			const existing = properties[name];
			properties[name] = isObject(existing) && isObject(child) ? combineAlternatives([existing, child]) : child;
		}
	}
	if (Object.keys(properties).length > 0) {
		combined.type = "object";
		combined.properties = properties;
		const requiredSets = alternatives.map(
			alternative =>
				new Set(
					Array.isArray(alternative.required)
						? alternative.required.filter((name): name is string => typeof name === "string")
						: [],
				),
		);
		const intersection = [...(requiredSets[0] ?? [])].filter(name =>
			requiredSets.slice(1).every(required => required.has(name)),
		);
		if (intersection.length > 0) combined.required = intersection;
	}
	return combined;
}

function normalizeNode(root: unknown, schema: unknown, resolving: Set<string>): unknown {
	if (!isObject(schema)) return schema;
	const result = createJsonObject();
	if (typeof schema.$ref === "string" && !resolving.has(schema.$ref)) {
		const target = resolvePointer(root, schema.$ref);
		if (target !== undefined) {
			resolving.add(schema.$ref);
			const normalized = normalizeNode(root, target, resolving);
			resolving.delete(schema.$ref);
			if (isObject(normalized)) mergeSchema(result, normalized, true);
		}
	}
	if (Array.isArray(schema.allOf)) {
		for (const part of schema.allOf) {
			const normalized = normalizeNode(root, part, resolving);
			if (isObject(normalized)) mergeSchema(result, normalized, true);
		}
	}
	for (const key of ["anyOf", "oneOf"]) {
		if (!Array.isArray(schema[key])) continue;
		const alternatives = schema[key]
			.map(part => normalizeNode(root, part, resolving))
			.filter(part => !isNullSchema(part))
			.filter(isObject);
		if (alternatives.length === 1) mergeSchema(result, alternatives[0]!, false);
		else if (alternatives.length > 1) mergeSchema(result, combineAlternatives(alternatives), false);
	}
	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const value = schema[key];
		if (
			key === "$ref" ||
			key === "allOf" ||
			key === "anyOf" ||
			key === "oneOf" ||
			key === "$defs" ||
			key === "definitions"
		) {
			continue;
		}
		let normalized = value;
		if (key === "properties" && isObject(value)) {
			const properties = createJsonObject();
			for (const name in value) {
				if (Object.hasOwn(value, name)) properties[name] = normalizeNode(root, value[name], resolving);
			}
			normalized = properties;
		} else if (key === "items") {
			normalized = normalizeNode(root, value, resolving);
		}
		if (key === "required") mergeRequired(result, normalized, true);
		else if (key === "properties") mergeProperties(result, normalized);
		else result[key] = normalized;
	}
	return result;
}

/** Resolve local refs and fold schema combinators into the effective CLI shape. */
export function normalizeToolCliSchema(schema: unknown): Record<string, unknown> {
	const normalized = normalizeNode(schema, schema, new Set());
	const output = isObject(normalized) ? normalized : createJsonObject();
	if (hasProtocolIntent(schema)) {
		if (isObject(output.properties)) {
			delete output.properties.i;
			delete output.properties.notrunc;
		}
		if (Array.isArray(output.required)) {
			output.required = output.required.filter(name => name !== "i" && name !== "notrunc");
		}
	}
	return output;
}

function collectLeaves(
	schema: JsonObject,
	parentRequired: boolean,
	propertyPath: string[],
	leaves: SchemaLeaf[],
): void {
	if (!isObject(schema.properties)) return;
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [],
	);
	for (const name in schema.properties) {
		if (!Object.hasOwn(schema.properties, name)) continue;
		if (propertyPath.length === 0 && (name === "help" || name === "json")) continue;
		const rawChild = schema.properties[name];
		if (!isObject(rawChild)) continue;
		const requiredHere = parentRequired && required.has(name);
		propertyPath.push(name);
		if (isObject(rawChild.properties)) {
			collectLeaves(rawChild, requiredHere, propertyPath, leaves);
		} else {
			const repeatable = schemaType(rawChild) === "array";
			const itemSchema = repeatable && isObject(rawChild.items) ? rawChild.items : rawChild;
			const values = Array.isArray(itemSchema.enum) ? itemSchema.enum : undefined;
			const kind = scalarKind(rawChild);
			leaves.push({
				path: [...propertyPath],
				kind,
				values,
				description: typeof rawChild.description === "string" ? rawChild.description : undefined,
				required: requiredHere,
				repeatable,
				positional:
					propertyPath.length === 1 &&
					requiredHere &&
					!repeatable &&
					(values !== undefined || kind === "string" || kind === "integer" || kind === "number"),
				schema: rawChild,
			});
		}
		propertyPath.pop();
	}
}

function schemaLeaves(schema: JsonObject): SchemaLeaf[] {
	const leaves: SchemaLeaf[] = [];
	collectLeaves(schema, true, [], leaves);
	const rootRequired = Array.isArray(schema.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: [];
	return leaves
		.map((leaf, index) => ({ leaf, index }))
		.sort((left, right) => {
			const leftIndex = left.leaf.positional ? rootRequired.indexOf(left.leaf.path[0]!) : Number.MAX_SAFE_INTEGER;
			const rightIndex = right.leaf.positional ? rootRequired.indexOf(right.leaf.path[0]!) : Number.MAX_SAFE_INTEGER;
			return leftIndex - rightIndex || left.index - right.index;
		})
		.map(entry => entry.leaf);
}

function unambiguousCliLeaves(leaves: SchemaLeaf[]): { leaves: SchemaLeaf[]; ambiguousFields: string[] } {
	const ownersBySpelling = new Map<string, Set<SchemaLeaf>>();
	const addOwner = (spelling: string, leaf: SchemaLeaf): void => {
		const owners = ownersBySpelling.get(spelling) ?? new Set<SchemaLeaf>();
		owners.add(leaf);
		ownersBySpelling.set(spelling, owners);
	};
	for (const leaf of leaves) {
		const flag = flagName(leaf.path);
		addOwner(flag, leaf);
		if (!leaf.repeatable && leaf.kind === "boolean" && !leaf.values) addOwner(`no-${flag}`, leaf);
	}
	const ambiguousLeaves = new Set<SchemaLeaf>();
	for (const owners of ownersBySpelling.values()) {
		if (owners.size > 1) {
			for (const leaf of owners) ambiguousLeaves.add(leaf);
		}
	}
	const ambiguousFields: string[] = [];
	const filtered = leaves.filter(leaf => {
		if (!ambiguousLeaves.has(leaf)) return true;
		ambiguousFields.push(leaf.path.map(field => JSON.stringify(field)).join("."));
		return false;
	});
	return { leaves: filtered, ambiguousFields };
}

function flagName(propertyPath: string[]): string {
	return propertyPath.map(segment => segment.replaceAll("_", "-")).join(".");
}

function formatEnum(values: unknown[]): string {
	return `{${values.map(value => (typeof value === "string" ? value : JSON.stringify(value))).join("|")}}`;
}

function valueUsage(leaf: SchemaLeaf): string {
	if (leaf.values) return `${formatEnum(leaf.values)}${leaf.repeatable ? "..." : ""}`;
	const usage: Record<ScalarKind, string> = {
		string: "<STRING>",
		integer: "<INTEGER>",
		number: "<NUMBER>",
		boolean: "<BOOLEAN>",
		object: "<JSON_OBJECT>",
		fallback: "<JSON>",
	};
	return `${usage[leaf.kind]}${leaf.repeatable ? "..." : ""}`;
}

/** Render complete command help directly from the live JSON schema. */
export function renderToolHelp(definition: ToolCliDefinition): string {
	const normalized = normalizeToolCliSchema(definition.schema);
	const cli = unambiguousCliLeaves(schemaLeaves(normalized));
	const leaves = cli.leaves;
	const flagNames = new Set(leaves.map(leaf => flagName(leaf.path)));
	const reservedFields = ["help", "json"].filter(
		name => isObject(normalized.properties) && Object.hasOwn(normalized.properties, name),
	);
	let rendered = `${definition.name} — ${definition.description ?? "session tool"}\n\nUsage:\n  ${definition.name}`;
	for (const leaf of leaves.filter(candidate => candidate.positional)) rendered += ` <${leaf.path[0]}>`;
	rendered += " [OPTIONS] [@FILE] [-]\n";
	const positionals = leaves.filter(candidate => candidate.positional);
	if (positionals.length > 0) {
		rendered += "\nArguments:\n";
		for (const leaf of positionals) {
			rendered += `  <${leaf.path[0]}> ${valueUsage(leaf)}`;
			if (leaf.description) rendered += `  ${leaf.description}`;
			rendered += "\n";
		}
	}
	if (leaves.length > 0) {
		rendered += "\nOptions:\n";
		for (const leaf of leaves) {
			const flag = flagName(leaf.path);
			rendered += `  --${flag}`;
			if (!leaf.repeatable && leaf.kind === "boolean" && !leaf.values) {
				rendered += flagNames.has(`no-${flag}`) ? ` / --${flag}=<BOOLEAN>` : ` / --no-${flag}`;
			} else rendered += ` ${valueUsage(leaf)}`;
			if (leaf.description) rendered += `  ${leaf.description}`;
			if (leaf.required) rendered += "  (required)";
			if (leaf.repeatable) rendered += "  (repeatable)";
			rendered += "\n";
		}
	}
	if (reservedFields.length > 0) {
		rendered += `\nReserved schema fields:\n  ${reservedFields.join(", ")}  Set through -j/--json; their flag names belong to the command line.\n`;
	}
	if (cli.ambiguousFields.length > 0) {
		rendered += `\nAmbiguous schema fields:\n  ${cli.ambiguousFields.join(", ")}  Set through -j/--json; their derived flag names collide.\n`;
	}
	return `${rendered}  -j, --json <JSON>  Merge one raw JSON object.\n  @FILE             Merge a JSON object from FILE, or bind its text to the next argument.\n  -                 Same as @FILE, read from stdin.\n  -h, --help        Show this help.\n`;
}

function valueAt(root: JsonObject, propertyPath: string[]): unknown {
	let value: unknown = root;
	for (const segment of propertyPath) {
		if (!isObject(value) || !Object.hasOwn(value, segment)) return undefined;
		value = value[segment];
	}
	return value;
}

function insertValue(root: JsonObject, propertyPath: string[], value: unknown, repeatable: boolean): void {
	let target = root;
	for (const parent of propertyPath.slice(0, -1)) {
		const child = target[parent];
		if (Object.hasOwn(target, parent) && isObject(child)) {
			target = child;
		} else {
			const nested = createJsonObject();
			target[parent] = nested;
			target = nested;
		}
	}
	const last = propertyPath.at(-1);
	if (!last) return;
	const cloned = cloneJsonValue(value);
	if (repeatable) {
		const values = target[last];
		if (Object.hasOwn(target, last) && Array.isArray(values)) values.push(cloned);
		else target[last] = [cloned];
	} else target[last] = cloned;
}

function deepMerge(target: JsonObject, source: JsonObject): void {
	for (const name in source) {
		if (!Object.hasOwn(source, name)) continue;
		const value = source[name];
		const existing = target[name];
		if (Object.hasOwn(target, name) && isObject(existing) && isObject(value)) deepMerge(existing, value);
		else target[name] = cloneJsonValue(value);
	}
}

function stripOneNewline(text: string): string {
	return text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
}

async function readBoundedSource(absolutePath: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const stream = fs.createReadStream(absolutePath, {
		highWaterMark: 64 * 1024,
		signal,
	});
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	try {
		for await (const chunk of stream) {
			signal?.throwIfAborted();
			const bytes = Buffer.from(chunk);
			totalBytes += bytes.byteLength;
			if (totalBytes > TOOL_CLI_INPUT_LIMIT_BYTES) {
				throw new ToolCliUsageError(`argument source exceeds ${TOOL_CLI_INPUT_LIMIT_BYTES}-byte limit`);
			}
			chunks.push(bytes);
		}
	} catch (error) {
		if (signal?.aborted) signal.throwIfAborted();
		throw error;
	} finally {
		stream.destroy();
	}
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readArgumentSource(
	argument: string,
	options: ToolCliParseOptions,
): Promise<{ origin: string; text: string } | undefined> {
	if (argument === "-") {
		if (Buffer.byteLength(options.stdin) > TOOL_CLI_INPUT_LIMIT_BYTES) {
			throw new ToolCliUsageError(`argument source exceeds ${TOOL_CLI_INPUT_LIMIT_BYTES}-byte limit`);
		}
		return { origin: "<stdin>", text: options.stdin };
	}
	if (!argument.startsWith("@") || argument.length === 1) return undefined;
	const rawPath = argument.slice(1);
	try {
		const readSource = options.readSource ?? readBoundedSource;
		return {
			origin: rawPath,
			text: await readSource(path.resolve(options.cwd, rawPath), options.signal),
		};
	} catch (error) {
		if (error instanceof ToolCliUsageError) throw error;
		options.signal?.throwIfAborted();
		throw new ToolCliUsageError(
			`failed to read argument source \`${rawPath}\`${error instanceof Error ? `: ${error.message}` : ""}`,
		);
	}
}

function coerce(leaf: SchemaLeaf, raw: string, source: string): unknown {
	if (leaf.values) {
		const match = leaf.values.find(value => (typeof value === "string" ? value : JSON.stringify(value)) === raw);
		if (match !== undefined) return match;
		throw new ToolCliUsageError(`invalid value for \`${source}\`; expected an enum member`);
	}
	const kindSchema = leaf.repeatable && isObject(leaf.schema.items) ? leaf.schema.items : leaf.schema;
	switch (scalarKind(kindSchema)) {
		case "string":
			return raw;
		case "integer": {
			const value = Number(raw);
			if (Number.isSafeInteger(value) && /^-?(?:0|[1-9]\d*)$/.test(raw)) return value;
			throw new ToolCliUsageError(`invalid value for \`${source}\`; expected an integer`);
		}
		case "number": {
			const value = Number(raw);
			if (Number.isFinite(value) && raw.trim() !== "") return value;
			throw new ToolCliUsageError(`invalid value for \`${source}\`; expected a number`);
		}
		case "boolean":
			if (raw === "true") return true;
			if (raw === "false") return false;
			throw new ToolCliUsageError(`invalid value for \`${source}\`; expected true or false`);
		case "object":
			try {
				const value: unknown = JSON.parse(raw);
				if (isObject(value)) return cloneJsonValue(value);
			} catch {
				// The common error below carries the schema-derived expected type.
			}
			throw new ToolCliUsageError(`invalid value for \`${source}\`; expected a JSON object`);
		case "fallback":
			try {
				return cloneJsonValue(JSON.parse(raw));
			} catch {
				return raw;
			}
	}
}

function nextPositional(leaves: SchemaLeaf[], output: JsonObject, overrides: JsonObject): SchemaLeaf | undefined {
	return leaves.find(
		leaf => leaf.positional && !Object.hasOwn(output, leaf.path[0]!) && !Object.hasOwn(overrides, leaf.path[0]!),
	);
}

function soleObjectTarget(leaves: SchemaLeaf[]): SchemaLeaf | undefined {
	const required = leaves.filter(leaf => leaf.required);
	return required.length === 1 && required[0]!.path.length === 1 && required[0]!.kind === "object"
		? required[0]
		: undefined;
}

function bindLiteral(
	leaves: SchemaLeaf[],
	output: JsonObject,
	overrides: JsonObject,
	raw: string,
	origin: string,
): void {
	const leaf = nextPositional(leaves, output, overrides);
	if (!leaf) throw new ToolCliUsageError(`unexpected argument \`${origin}\`; every positional is already set`);
	insertValue(output, leaf.path, coerce(leaf, raw, origin), leaf.repeatable);
}

function bindSource(
	leaves: SchemaLeaf[],
	output: JsonObject,
	overrides: JsonObject,
	text: string,
	origin: string,
): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (isObject(parsed)) {
		const target = soleObjectTarget(leaves);
		if (
			target &&
			!Object.hasOwn(output, target.path[0]!) &&
			!Object.hasOwn(overrides, target.path[0]!) &&
			!Object.hasOwn(parsed, target.path[0]!)
		) {
			insertValue(output, target.path, parsed, false);
		} else deepMerge(output, parsed);
		return;
	}
	if (!nextPositional(leaves, output, overrides)) {
		throw new ToolCliUsageError(`\`${origin}\` is not a JSON object and no positional remains for its text`);
	}
	bindLiteral(leaves, output, overrides, stripOneNewline(text), origin);
}

function validateRequired(schema: JsonObject, value: unknown, propertyPath: string[] = []): void {
	if (!isObject(value)) return;
	if (Array.isArray(schema.required)) {
		for (const name of schema.required) {
			if (typeof name === "string" && !Object.hasOwn(value, name)) {
				throw new ToolCliUsageError(`missing required argument \`${[...propertyPath, name].join(".")}\``);
			}
		}
	}
	if (!isObject(schema.properties)) return;
	for (const name in schema.properties) {
		if (!Object.hasOwn(schema.properties, name)) continue;
		const childSchema = schema.properties[name];
		if (Object.hasOwn(value, name) && isObject(childSchema)) {
			validateRequired(childSchema, value[name], [...propertyPath, name]);
		}
	}
}

/** Bind shell arguments entirely from a JSON schema; no tool-specific parser is involved. */
export async function parseToolArgs(
	schema: unknown,
	argv: string[],
	options: ToolCliParseOptions,
): Promise<Record<string, unknown>> {
	const normalized = normalizeToolCliSchema(schema);
	const leaves = unambiguousCliLeaves(schemaLeaves(normalized)).leaves;
	const output = createJsonObject();
	const overrides = createJsonObject();
	let optionsEnded = false;
	/**
	 * Repeatable flag whose values are still being filled: after
	 * `--paths a`, further bare words extend that array until the next
	 * flag (or `--`), matching the `--paths <STRING>...` usage line.
	 */
	let activeArrayLeaf: SchemaLeaf | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (optionsEnded) {
			bindLiteral(leaves, output, overrides, argument, argument);
			continue;
		}
		if (argument === "--") {
			optionsEnded = true;
			activeArrayLeaf = undefined;
			continue;
		}
		if (argument === "-" || (argument.startsWith("@") && argument.length > 1)) {
			activeArrayLeaf = undefined;
			const source = await readArgumentSource(argument, options);
			bindSource(leaves, output, overrides, source!.text, source!.origin);
			continue;
		}
		if (argument === "-j" || argument === "--json" || argument.startsWith("--json=")) {
			activeArrayLeaf = undefined;
			const raw = argument.startsWith("--json=") ? argument.slice("--json=".length) : argv[++index];
			if (raw === undefined) throw new ToolCliUsageError(`flag \`${argument}\` requires a value`);
			const source = await readArgumentSource(raw, options);
			let parsed: unknown;
			try {
				parsed = JSON.parse(source?.text ?? raw);
			} catch (error) {
				throw new ToolCliUsageError(
					`invalid JSON for \`--json\`${error instanceof Error ? `: ${error.message}` : ""}`,
				);
			}
			if (!isObject(parsed)) throw new ToolCliUsageError("`--json` must be a JSON object");
			deepMerge(output, parsed);
			continue;
		}
		if (!argument.startsWith("--")) {
			if (argument.startsWith("-")) throw new ToolCliUsageError(`unknown flag \`${argument}\``);
			if (activeArrayLeaf) {
				// Still filling the preceding array flag's values.
				insertValue(overrides, activeArrayLeaf.path, coerce(activeArrayLeaf, argument, argument), true);
				continue;
			}
			bindLiteral(leaves, output, overrides, argument, argument);
			continue;
		}
		const equals = argument.indexOf("=");
		let rawFlag = argument.slice(2, equals < 0 ? undefined : equals);
		const inline = equals < 0 ? undefined : argument.slice(equals + 1);
		let leaf = leaves.find(candidate => flagName(candidate.path) === rawFlag);
		let negative = false;
		if (!leaf && rawFlag.startsWith("no-")) {
			negative = true;
			rawFlag = rawFlag.slice(3);
			leaf = leaves.find(candidate => flagName(candidate.path) === rawFlag);
		}
		if (!leaf) throw new ToolCliUsageError(`unknown flag \`${argument}\``);
		// Every flag ends the previous array flag's value run.
		activeArrayLeaf = undefined;
		if (!leaf.repeatable && leaf.kind === "boolean" && !leaf.values) {
			if (negative && inline !== undefined) {
				throw new ToolCliUsageError(`invalid value for \`${argument}\`; expected a flag without a value`);
			}
			const value = inline === undefined ? !negative : coerce(leaf, inline, argument);
			insertValue(overrides, leaf.path, value, false);
			continue;
		}
		if (negative) throw new ToolCliUsageError(`unknown flag \`${argument}\``);
		const raw = inline ?? argv[++index];
		if (raw === undefined) throw new ToolCliUsageError(`flag \`${argument}\` requires a value`);
		const source = await readArgumentSource(raw, options);
		insertValue(
			overrides,
			leaf.path,
			coerce(leaf, source ? stripOneNewline(source.text) : raw, argument),
			leaf.repeatable,
		);
		if (leaf.repeatable && leaf.kind !== "boolean") activeArrayLeaf = leaf;
	}
	for (const leaf of leaves) {
		const value = valueAt(overrides, leaf.path);
		if (value !== undefined) insertValue(output, leaf.path, value, false);
	}
	validateRequired(normalized, output);
	const materialized = materializeJsonValue(output);
	if (!isObject(materialized)) throw new ToolCliUsageError("arguments must be a JSON object");
	return materialized;
}

function errorResult(name: string, message: string, exitCode: number): ToolCliResult {
	return { stdout: "", stderr: `${name}: ${message}\n`, exitCode };
}

/** Execute one tool command invocation against a live host. */
export async function runToolCli(
	request: ToolCliRequest,
	host: ToolCliHost,
	signal?: AbortSignal,
): Promise<ToolCliResult> {
	const name = request.name;
	const argv = request.argv;
	try {
		if (argv.some(argument => argument === "-h" || argument === "--help")) {
			if (argv.length !== 1) {
				return errorResult(name, "--help cannot be combined with invocation arguments", 2);
			}
			return { stdout: renderToolHelp(await host.definition(name)), stderr: "", exitCode: 0 };
		}
		const definition = await host.definition(name);
		const args = await parseToolArgs(definition.schema, argv, {
			cwd: request.cwd,
			stdin: request.stdin,
			signal,
		});
		if (hasProtocolIntent(definition.schema)) args.i = `Invoking ${name}`;
		return await host.call(name, args);
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "ToolAbortError")) throw error;
		if (error instanceof ToolCliUsageError) {
			return errorResult(name, `${error.message}\n${name}: run \`${name} --help\``, 2);
		}
		const message = error instanceof Error ? error.message : String(error);
		return errorResult(name, message, 1);
	}
}
