/**
 * Type-only: an extension tool's `execute` receives `params` typed from its
 * `parameters` schema when the schema is written inline, as the extension docs
 * write it (`parameters: z.object({...})` beside an `execute` whose parameters
 * carry no annotation). Checked by `bun check`; nothing here runs.
 */
import type { ZodLikeSchema } from "@oh-my-pi/omptype/zod";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ToolDefinition, ToolParamsSchema } from "@oh-my-pi/pi-coding-agent";
import type { ConcreteExtensionAPI } from "../../src/extensibility/extensions/loader";

declare const pi: ExtensionAPI;
const z = pi.zod;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** `true` only when `actual` has exactly the `Expected` type; `unknown` and `any` never match an object type. */
declare function exactly<Expected>(): <Actual>(actual: Actual) => Equal<Actual, Expected>;

// Helpers and direct callers of the loader API must have the same schema inference as ExtensionAPI.
function defineTool<T extends ToolParamsSchema>(tool: ToolDefinition<T>): ToolDefinition<T> {
	return tool;
}
defineTool({
	name: "helper",
	label: "Helper",
	description: "Helper parameters",
	parameters: z.object({ name: z.string() }),
	async execute(_id, params) {
		const typed: true = exactly<{ name: string }>()(params);
		// @ts-expect-error a helper must not erase the schema's fields
		params.missing;
		return { content: [{ type: "text", text: `${params.name}${typed}` }] };
	},
});
declare const concrete: ConcreteExtensionAPI;
concrete.registerTool({
	name: "concrete",
	label: "Concrete",
	description: "Concrete API parameters",
	parameters: z.object({ name: z.string() }),
	async execute(_id, params) {
		const typed: true = exactly<{ name: string }>()(params);
		// @ts-expect-error direct loader API callers must not lose parameter types
		params.missing;
		return { content: [{ type: "text", text: `${params.name}${typed}` }] };
	},
});
// The documented form: inline schema, `execute` as a method with unannotated parameters.
pi.registerTool({
	name: "greet",
	label: "Greet",
	description: "Greet someone",
	parameters: z.object({ name: z.string().describe("Name to greet") }),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const typed: true = exactly<{ name: string }>()(params);
		// @ts-expect-error `missing` is not a parameter
		params.missing;
		return { content: [{ type: "text", text: `Hello, ${params.name}!${typed}` }] };
	},
});

// `execute` as an arrow-function property, with defaulted, optional and nested fields.
pi.registerTool({
	name: "log",
	label: "Log",
	description: "Log a message",
	parameters: z.object({
		message: z.string(),
		level: z.enum(["error", "warn", "debug"]).default("debug"),
		count: z.number().optional(),
		where: z.object({ file: z.string(), line: z.number() }),
	}),
	execute: async (_toolCallId, params) => {
		const level: "error" | "warn" | "debug" = params.level;
		const count: number | undefined = params.count;
		const line: number = params.where.line;
		return { content: [{ type: "text", text: `${params.message} ${level} ${count} ${params.where.file}:${line}` }] };
	},
});

// A schema method chained onto the inline object.
pi.registerTool({
	name: "described",
	label: "Described",
	description: "Described parameters",
	parameters: z.object({ query: z.string() }).describe("Search parameters"),
	async execute(_toolCallId, params) {
		const typed: true = exactly<{ query: string }>()(params);
		return { content: [{ type: "text", text: `${params.query}${typed}` }] };
	},
});

// A schema built before the call keeps working.
const hoisted = z.object({ path: z.string() });
pi.registerTool({
	name: "hoisted",
	label: "Hoisted",
	description: "Hoisted parameters",
	parameters: hoisted,
	async execute(_toolCallId, params) {
		const typed: true = exactly<{ path: string }>()(params);
		return { content: [{ type: "text", text: `${params.path}${typed}` }] };
	},
});

// JSON Schema parameters (TypeBox and other compat) give `unknown`, never `any`.
pi.registerTool({
	name: "json",
	label: "JSON",
	description: "JSON Schema parameters",
	parameters: { type: "object", properties: { q: { type: "string" } } },
	async execute(_toolCallId, params) {
		const typed: true = exactly<unknown>()(params);
		return { content: [{ type: "text", text: String(typed) }] };
	},
});

// Every omptype schema satisfies the `TSchema` constraint, and `Static` reads its output type.
const asConstraint: TSchema = z.object({ id: z.number() });
type StaticOfInline = Static<typeof hoisted>;
const staticOfInline: true = exactly<{ path: string }>()(null as unknown as StaticOfInline);
// The bare constraint resolves to `unknown`, never `any`.
const staticOfConstraint: true = exactly<unknown>()(null as unknown as Static<TSchema>);

// A union of shapes gives one schema whose output is the union, so `.default()` takes either member.
declare const eitherShape: { name: ZodLikeSchema<string> } | { count: ZodLikeSchema<number> };
const eitherDefault = z.object(eitherShape).default({ name: "Ada" });

// A caller generic in the shape can assign a fluent method's result back to the schema it built.
function configuredObject<S extends Readonly<Record<string, ZodLikeSchema<unknown>>>>(shape: S, strict: boolean) {
	let schema = z.object(shape);
	schema = schema.describe("Configured object");
	if (strict) schema = schema.strict();
	return schema;
}

// An object schema composes as on main: arrays, records, generic consumers and `infer` keep
// required fields required.
const user = z.object({ name: z.string(), age: z.number().optional() });
type User = { name: string; age?: number | undefined };
declare function consume<T>(schema: ZodLikeSchema<T>): T;
type OutputOf<S> = S extends ZodLikeSchema<infer T> ? T : never;
const composed: true[] = [
	exactly<User>()(user.parse({})),
	exactly<User[]>()(z.array(user).parse([])),
	exactly<Record<string, User>>()(z.record(user).parse({})),
	exactly<User>()(consume(user)),
	exactly<User>()(null as unknown as OutputOf<typeof user>),
	exactly<User | undefined>()(user.optional().parse({})),
];
const asSchema: ZodLikeSchema<User> = user;
// @ts-expect-error `name` is required in an array element
const missingName: User[] = z.array(user).parse([]).concat([{}]);

// An inline object holding an array of objects types every level.
pi.registerTool({
	name: "users",
	label: "Users",
	description: "Nested parameters",
	parameters: z.object({ users: z.array(z.object({ name: z.string() })) }),
	async execute(_toolCallId, params) {
		const typed: true = exactly<{ users: { name: string }[] }>()(params);
		return { content: [{ type: "text", text: `${params.users[0]?.name}${typed}` }] };
	},
});

// A caller generic in the shape can pass the object schema on to another builder.
function arrayOf<S extends Readonly<Record<string, ZodLikeSchema<unknown>>>>(shape: S) {
	return z.array(z.object(shape));
}

// An expected type cannot make `z.object` claim fields, narrower values or methods it does not have.
type Person = { name: string; age: number };
// @ts-expect-error the schema has no `age`
const missingAge: ZodLikeSchema<Person> = z.object({ name: z.string() });
// @ts-expect-error a string field is not the literal "Ada"
const literalName: ZodLikeSchema<{ name: "Ada" }> = z.object({ name: z.string() });
// @ts-expect-error the schema has no `extra` method
const extraMethod: ZodLikeSchema<{ name: string }> & { extra(): string } = z.object({ name: z.string() });
function anySubtype<T extends ZodLikeSchema<{ name: string }>>(): T {
	// @ts-expect-error the caller's `T` may be any subtype
	return z.object({ name: z.string() });
}
// @ts-expect-error the second type argument admits only `never`
const explicitSubtype = z.object<{ name: ZodLikeSchema<string> }, ZodLikeSchema<{ name: "Ada" }>>({ name: z.string() });
// A wider expected type is still fine.
const wider: ZodLikeSchema<{ name: string }> = z.object({ name: z.string(), age: z.number() });
export {
	anySubtype,
	arrayOf,
	asConstraint,
	asSchema,
	composed,
	configuredObject,
	eitherDefault,
	explicitSubtype,
	extraMethod,
	literalName,
	missingAge,
	missingName,
	staticOfConstraint,
	staticOfInline,
	wider,
};
