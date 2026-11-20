/**
 * JSON Schema → omptype importer.
 *
 * Validates exactly as JSON Schema drafts 2020-12 and 7 specify: every
 * keyword including `$dynamicRef`, `unevaluatedProperties`/`unevaluatedItems`,
 * `$id`/`$anchor` resolution, remote references, and vocabularies declared by
 * meta-schemas. Validation runs on an eval-free closure engine and moves to
 * generated code once a schema is hot (see `jsonschema/`).
 *
 * The result is a regular omptype schema: callable, composable, emitting the
 * source document from `toJsonSchema()`, and filling absent properties from
 * their `default` when called (never in `allows`).
 *
 * # Example
 * ```ts
 * const read = fromJsonSchema({
 * 	type: "object",
 * 	properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 } },
 * 	required: ["path"],
 * });
 * read.allows({ path: "a.ts" }); // true
 * read({ offset: -1 }); // OmpErrors: path missing, offset below 0
 * ```
 */
import { OmpErrors } from "./errors";
import { type EmbeddableSchema, type IR, IR_BRAND } from "./ir";
import type { Issue } from "./jsonschema/interpret";
import { Validator, type ValidatorOptions } from "./jsonschema/validator";
import { type BaseType, type } from "./type";

/** Options for {@link fromJsonSchema}. */
export type FromJsonSchemaOptions = ValidatorOptions;

/**
 * Build a callable omptype schema from a JSON Schema document.
 *
 * # Errors
 * Throws `OmpTypeError` when a `$ref` is malformed or names a document or
 * location that neither `schema` nor `options.schemas` contains, when a
 * `pattern` is not a regular expression, or when a schema node is neither a
 * boolean nor an object.
 */
export function fromJsonSchema(schema: unknown, options?: FromJsonSchemaOptions): BaseType {
	// Runs after 64 checks, long after `imported` below exists.
	const validator = new Validator(schema, options, compiled => {
		imported.allows = compiled;
	});
	const check = validator.check;
	const node = typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : undefined;
	const refine: IR = {
		k: "refine",
		base: { k: "unknown" },
		check,
		pred: value => check(value) || toErrors(validator.explain(value), value),
		expected: "a value matching the JSON Schema",
		json: node ?? (schema === false ? { not: {} } : {}),
	};
	if (typeof node?.description === "string") refine.desc = node.description;
	const ir: IR = validator.hasDefaults
		? { k: "morph", input: refine, fn: value => validator.fillDefaults(value) }
		: refine;
	const embedded: EmbeddableSchema = {
		[IR_BRAND]: true,
		ir,
		hasSteps: false,
		hasDefault: false,
		run: value => value,
	};
	const imported = type.raw(embedded);
	// The engine's check is the whole boolean path; skip the generic dispatcher.
	// Once generated code exists, `onCompile` above rebinds `allows` to it.
	Object.defineProperty(imported, "allows", { value: check, writable: true, configurable: true });
	return imported;
}

function toErrors(issues: readonly Issue[], value: unknown): OmpErrors {
	if (issues.length === 0) return new OmpErrors([], "a value matching the JSON Schema", value);
	const errors = new OmpErrors(issues[0].path, issues[0].expected, issues[0].data);
	for (let index = 1; index < issues.length; index++) {
		const issue = issues[index];
		errors.append(new OmpErrors(issue.path, issue.expected, issue.data));
	}
	return errors;
}
