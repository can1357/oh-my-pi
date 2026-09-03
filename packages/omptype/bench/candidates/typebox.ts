/**
 * Pipeline: Type.Object builds each schema and TypeCompiler.Compile compiles
 * its hot `Check` path. Failures materialize TypeBox's native first error.
 * Default/delete fixtures clone first, then use the sanctioned
 * Value.Default/Value.Clean transforms before Check, preserving input.
 */
import { type TSchema, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { ValueError } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

class TypeBoxErrors {
	readonly first: ValueError;

	constructor(first: ValueError) {
		this.first = first;
	}
}

function errorResult(first: ValueError | undefined): TypeBoxErrors {
	if (first === undefined) throw new Error("TypeBox Check failed without an error");
	return new TypeBoxErrors(first);
}

type Morph = "none" | "default" | "clean";
interface BuiltSchema {
	schema: TSchema;
	morph: Morph;
}

const flatSmall = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer()),
});
const enumUnion = Type.Object({
	op: Type.Union([
		Type.Literal("start"),
		Type.Literal("stop"),
		Type.Literal("restart"),
		Type.Literal("send"),
		Type.Literal("wait"),
		Type.Literal("logs"),
	]),
	timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 3600 })),
	pty: Type.Optional(Type.Boolean()),
});
const nestedArrays = Type.Object({
	context: Type.String(),
	tasks: Type.Array(
		Type.Object({
			name: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
			agent: Type.Optional(Type.String()),
			task: Type.String(),
			schemaMode: Type.Optional(Type.Union([Type.Literal("permissive"), Type.Literal("strict")])),
		}),
	),
});
const strictDefaults = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("put")]),
		key: Type.String(),
		count: Type.Integer({ default: 10 }),
		tags: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
const deleteExtras = Type.Object(
	{
		name: Type.String(),
		level: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high")])),
	},
	{ additionalProperties: false },
);
const recordMixed = Type.Object({
	env: Type.Record(Type.String(), Type.String()),
	args: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]))),
	mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")])),
	verbose: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
});
const deepMessage = Type.Object({
	role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]),
	content: Type.Array(
		Type.Object({
			type: Type.Union([Type.Literal("text"), Type.Literal("image")]),
			text: Type.Optional(Type.String()),
			data: Type.Optional(Type.String()),
			cache: Type.Optional(Type.Boolean()),
		}),
	),
	stop: Type.Optional(Type.Union([Type.Literal("end"), Type.Literal("tool"), Type.Literal("length"), Type.Null()])),
	usage: Type.Optional(Type.Object({ input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }) })),
});

function buildGenerated(definition: Record<string, Def>): TSchema {
	let alpha = "";
	let beta = "";
	let gamma = "";
	for (const key in definition) {
		if (key.startsWith("alpha")) alpha = key;
		else if (key.startsWith("beta")) beta = key;
		else if (key.startsWith("gamma")) gamma = key;
	}
	if (!alpha || !beta || !gamma) throw new Error("unknown benchmark definition");
	const betaDefinition = definition[beta];
	const gammaDefinition = definition[gamma];
	if (typeof betaDefinition !== "string" || typeof gammaDefinition !== "string") {
		throw new Error("malformed generated definition");
	}
	const minimum = Number(betaDefinition.match(/>= (\d+)/)?.[1]);
	const literals = [...gammaDefinition.matchAll(/'([^']+)'/g)].map(match => match[1]);
	if (!Number.isFinite(minimum) || literals.length !== 2) throw new Error("malformed generated definition");
	return Type.Object({
		[alpha]: Type.String(),
		[beta.slice(0, -1)]: Type.Optional(Type.Integer({ minimum })),
		[gamma]: Type.Union([Type.Literal(literals[0]), Type.Literal(literals[1])]),
		nested: Type.Object({ flag: Type.Boolean(), items: Type.Array(Type.String()) }),
	});
}

function buildSchema(definition: Def): BuiltSchema {
	if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
		throw new Error("benchmark candidates require object definitions");
	}
	const objectDefinition = definition as Record<string, Def>;
	if ("path" in objectDefinition) return { schema: flatSmall, morph: "none" };
	if ("op" in objectDefinition) return { schema: enumUnion, morph: "none" };
	if ("context" in objectDefinition) return { schema: nestedArrays, morph: "none" };
	if ("action" in objectDefinition) return { schema: strictDefaults, morph: "default" };
	if ("name" in objectDefinition) return { schema: deleteExtras, morph: "clean" };
	if ("env" in objectDefinition) return { schema: recordMixed, morph: "none" };
	if ("role" in objectDefinition) return { schema: deepMessage, morph: "none" };
	return { schema: buildGenerated(objectDefinition), morph: "none" };
}

export const typeboxCandidate: Candidate = {
	name: "typebox",
	type(definition) {
		const { schema, morph } = buildSchema(definition);
		const compiled = TypeCompiler.Compile(schema);
		if (morph === "default") {
			return (value: unknown) => {
				const defaulted = Value.Default(schema, structuredClone(value));
				// Reject extras before Clean; otherwise strict semantics would be weakened.
				if (!compiled.Check(defaulted)) return errorResult(compiled.Errors(defaulted).First());
				const output = Value.Clean(schema, defaulted);
				return compiled.Check(output) ? output : errorResult(compiled.Errors(output).First());
			};
		}
		if (morph === "clean") {
			return (value: unknown) => {
				const defaulted = Value.Default(schema, structuredClone(value));
				const output = Value.Clean(schema, defaulted);
				return compiled.Check(output) ? output : errorResult(compiled.Errors(output).First());
			};
		}
		return (value: unknown) => (compiled.Check(value) ? value : errorResult(compiled.Errors(value).First()));
	},
	allows(definition) {
		const { schema, morph } = buildSchema(definition);
		if (morph === "none") {
			const compiled = TypeCompiler.Compile(schema);
			return (value: unknown) => compiled.Check(value);
		}
		const run = typeboxCandidate.type(definition);
		return (value: unknown) => !typeboxCandidate.isErrors(run(value));
	},
	isErrors: result => result instanceof TypeBoxErrors,
	summary: result => (result instanceof TypeBoxErrors ? result.first.message : ""),
};
