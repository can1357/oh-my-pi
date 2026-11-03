/**
 * Type-only: a schema of a specific type is assignable to the schema of a
 * supertype by declared variance, not by TypeScript's depth-limited structural
 * shortcut. Before the fix these passed or failed depending on the order the
 * compiler met them: the first `FluentType` comparison below failed when it
 * came before the plain `Type` ones, and passed after them. The checks run in
 * that failing order. Checked by `bun check`; nothing here runs.
 */
import type { FluentType, Type } from "../src/type";
import { type } from "../src/type";
import type { ZodLikeSchema } from "../src/zod";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function exactly<Expected>(): <Actual>(actual: Actual) => Equal<Actual, Expected>;

type WithOutput<O> = { readonly _output: O } & Type<O, O>;
type WithUnknownInput<O> = { readonly _output: O } & Type<O, unknown>;

// Every schema relates to the schema of a supertype, in an order that used to fail.
const fluentPrimitive: FluentType<unknown, unknown> = null as unknown as FluentType<string, string>;
const plainPrimitive: Type<unknown, unknown> = null as unknown as Type<string, string>;
const narrower: FluentType<{ id: number }> = null as unknown as FluentType<{ id: number; name: string }>;
const zodLike: Type<unknown, unknown> = null as unknown as ZodLikeSchema<{ id: number }>;
const fluentObject: FluentType<unknown, unknown> = null as unknown as FluentType<{ id: number }, { id: number }>;
const sameInput: WithOutput<unknown> = null as unknown as WithOutput<{ id: number }>;
const unknownInput: WithUnknownInput<unknown> = null as unknown as WithUnknownInput<string>;

// A schema still does not pass for the schema of an unrelated or narrower type.
// @ts-expect-error a string schema is not a number schema
const unrelated: Type<number> = null as unknown as Type<string>;
// @ts-expect-error an `{ id }` schema is not an `{ id; name }` schema
const wider: FluentType<{ id: number; name: string }> = null as unknown as FluentType<{ id: number }>;

// The key methods still read the keys of the schema they are called on.
const user = type({ id: "number", name: "string", "nick?": "string" });
const keys: true = exactly<"id" | "name" | "nick">()(user.keyof().infer);
const picked: true = exactly<{ id: number }>()(user.pick("id").infer);
const omitted: true = exactly<{ name: string; nick?: string }>()(user.omit("id").infer);
// @ts-expect-error `email` is not a key of the schema
user.pick("email");
// @ts-expect-error a string schema has no object methods
type("string").partial();

// Detached key methods type-check as on main; `pick` and `omit` stay exact. A detached `keyof()`
// cannot see its receiver's type, so it gives any property key.
const boundPick = user.pick.bind(user);
const boundPicked: true = exactly<{ id: number }>()(boundPick("id").infer);
const boundOmit = user.omit.bind(user);
const boundOmitted: true = exactly<{ id: number; nick?: string }>()(boundOmit("name").infer);
const boundKeys: true = exactly<PropertyKey>()(user.keyof.bind(user)().infer);
const calledKeys: true = exactly<PropertyKey>()(user.keyof.call(user).infer);
// Called on a union of schemas, `keyof()` gives each member's own keys, as on main.
const left = type({ a: "number" });
const right = type({ b: "string" });
const overlapping = type({ a: "number", c: "boolean" });
declare const either: typeof left | typeof right;
declare const overlap: typeof left | typeof overlapping;
const eitherKey: "a" | "b" = either.keyof().assert("a");
const eitherKeys: true = exactly<"a" | "b">()(either.keyof().infer);
const overlapKeys: true = exactly<"a" | "c">()(overlap.keyof().infer);

export {
	boundKeys,
	boundOmitted,
	boundPicked,
	calledKeys,
	eitherKey,
	eitherKeys,
	fluentObject,
	fluentPrimitive,
	keys,
	narrower,
	omitted,
	overlapKeys,
	picked,
	plainPrimitive,
	sameInput,
	unknownInput,
	unrelated,
	wider,
	zodLike,
};
