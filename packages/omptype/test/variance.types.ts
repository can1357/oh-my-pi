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

// Detached key methods retain the independent keys of concrete schemas.
const boundPick = user.pick.bind(user);
const boundPicked: true = exactly<{ id: number }>()(boundPick("id").infer);
const boundOmit = user.omit.bind(user);
const boundOmitted: true = exactly<{ id: number; nick?: string }>()(boundOmit("name").infer);
const boundKeys: true = exactly<"id" | "name" | "nick">()(user.keyof.bind(user)().infer);
const calledKeys: true = exactly<"id" | "name" | "nick">()(user.keyof.call(user).infer);
const detachedKeyof = user.keyof;
const detachedKeys: true = exactly<"id" | "name" | "nick">()(detachedKeyof().infer);
// @ts-expect-error an exact bound key validator rejects unknown typed keys
user.keyof.bind(user)().from("email");
// Called on a union of schemas, `keyof()` gives each member's own keys, as on main.
const left = type({ a: "number" });
const right = type({ b: "string" });
const overlapping = type({ a: "number", c: "boolean" });
declare const either: typeof left | typeof right;
declare const overlap: typeof left | typeof overlapping;
const eitherKey: "a" | "b" = either.keyof().assert("a");
const eitherKeys: true = exactly<"a" | "b">()(either.keyof().infer);
const overlapKeys: true = exactly<"a" | "c">()(overlap.keyof().infer);

// Rebinding a method uses the new receiver's keys, not the original method's keys.
const reboundCalledKeys: true = exactly<"b">()(user.keyof.call(right).infer);
const reboundBoundKeys: true = exactly<"b">()(user.keyof.bind(right)().infer);
const reboundAppliedKeys: true = exactly<"b">()(user.keyof.apply(right, []).infer);
export { reboundCalledKeys, reboundBoundKeys, reboundAppliedKeys };

// Attached views retain their output keys even when inference metadata is omitted.
const withoutOutput: Omit<typeof user, "infer"> = user;
const withoutInput: Omit<typeof user, "inferIn"> = user;
const minimalView: Pick<typeof user, "ir" | "keyof"> = user;
const withoutOutputKeys: true = exactly<"id" | "name" | "nick">()(withoutOutput.keyof().infer);
const withoutInputKeys: true = exactly<"id" | "name" | "nick">()(withoutInput.keyof().infer);
const minimalViewKeys: true = exactly<"id" | "name" | "nick">()(minimalView.keyof().infer);

// A widened schema must still describe every value its runtime methods can return.
const broad: FluentType<unknown> = type("string");
const extractedString = broad.extract("string");
const extractedStringValue: typeof extractedString.infer = "ok";
const extractedSchema = broad.extract(type("string"));
const extractedSchemaValue: typeof extractedSchema.infer = "ok";
const extractedExact: true = exactly<true | 0>()(type("true | 0 | 'foo'").extract("boolean | number").infer);

const objectView: FluentType<{ id: number }> = type({ id: "number", name: "string" });
const widenedKeys = objectView.keyof();
const hiddenKey: typeof widenedKeys.infer = "name";
const widenedBoundKeys = objectView.keyof.bind(objectView)();
const widenedCalledKeys = objectView.keyof.call(objectView);
const widenedDetachedKeyof = objectView.keyof;
const widenedDetachedKeys = widenedDetachedKeyof();
const widenedBoundExact: true = exactly<PropertyKey>()(widenedBoundKeys.infer);
const widenedCalledExact: true = exactly<PropertyKey>()(widenedCalledKeys.infer);
const widenedDetachedExact: true = exactly<PropertyKey>()(widenedDetachedKeys.infer);
const widenedBoundValue: typeof widenedBoundKeys.infer = "name";
const widenedCalledValue: typeof widenedCalledKeys.infer = "name";
const widenedDetachedValue: typeof widenedDetachedKeys.infer = "name";
export {
	widenedBoundExact,
	widenedCalledExact,
	widenedDetachedExact,
	widenedBoundValue,
	widenedCalledValue,
	widenedDetachedValue,
};
const describedKeys = objectView.describe("user").keyof();
const describedHiddenKey: typeof describedKeys.infer = "name";
const partialKeys = objectView.partial().keyof();
const partialHiddenKey: typeof partialKeys.infer = "name";
const requiredKeys = objectView.required().keyof();
const requiredHiddenKey: typeof requiredKeys.infer = "name";
const omittedKeys = objectView.omit("id").keyof();
const omittedHiddenKey: typeof omittedKeys.infer = "name";
const pickedView = objectView.pick("id");
const pickedViewValue: typeof pickedView.infer = { id: 1 };
const omittedView = objectView.omit("id");
const omittedViewValue: typeof omittedView.infer = { name: "Ada" };
const partialView = objectView.partial();
const partialViewValue: typeof partialView.infer = { id: 1 };
const requiredView = objectView.required();
const requiredViewValue: typeof requiredView.infer = { id: 1 };

const optionalView: FluentType<{ value?: string }> = type({ value: "undefined" });
const requiredOptionalView = optionalView.required();
const requiredUndefined: typeof requiredOptionalView.infer = { value: undefined };

// Schema operands can also hide a stricter runtime schema behind a widened type.
const excludedSchema = type("string | number").exclude(broad);
const excludedSchemaValue: typeof excludedSchema.infer = 1;
const excludedString = broad.exclude("number");
const excludedStringValue: typeof excludedString.infer = "ok";
const excludedExact: true = exactly<true | 0>()(type("true | 0 | 'foo'").exclude("string").infer);
const replacementView: FluentType<{}> = type({ id: "string" });
const mergedView = objectView.merge(replacementView);
const mergedViewValue: typeof mergedView.infer = { id: "replacement", name: "Ada" };
const mergedExact = user.merge(type({ id: "string" }));
const mergedExactValue: typeof mergedExact.infer = { id: "replacement", name: "Ada" };

// Refinement callbacks enforce the new bound, rather than deriving it from hidden keys.
const narrowedView = broad.narrow((value): value is string => typeof value === "string");
const narrowedViewValue: typeof narrowedView.infer = "ok";
const filteredView = broad.filter((value): value is string => typeof value === "string");
const filteredViewInput: typeof filteredView.inferIn = "ok";

declare function admits<output>(schema: { readonly infer: output }, value: NoInfer<output>): void;

// These operations preserve the runtime object's declared keys, including hidden ones.
admits(objectView.configure({ description: "user" }).keyof(), "name");
admits(objectView.default(() => ({ id: 1, name: "Ada" })).keyof(), "name");
admits(objectView.ifEquals({ id: "number", name: "string" })!.keyof(), "name");
admits(objectView.ifExtends({ id: "number" })!.keyof(), "name");
admits(objectView.in.keyof(), "name");
admits(objectView.out.keyof(), "name");
admits(objectView.narrow(value => value.id > 0).keyof(), "name");
admits(objectView.filter(value => value.id > 0).keyof(), "name");
admits(objectView.brand("user").keyof(), "name");
admits(objectView.readonly().keyof(), "name");
admits(objectView.as<{ id: number }>().keyof(), "name");
admits(objectView.onUndeclaredKey("delete").keyof(), "name");
admits(objectView.onDeepUndeclaredKey("reject").keyof(), "name");
admits(objectView.pipe(value => value).keyof(), "name");
admits(objectView.pipe.try(value => value).keyof(), "name");
admits(objectView.to({ id: "number" }).keyof(), "name");
admits(objectView.or({ id: "number", name: "string" }).keyof(), "name");
admits(objectView.and({ active: "boolean" }).keyof(), "name");
admits(objectView.merge({ active: "boolean" }).keyof(), "name");
admits(pickedView.keyof(), "id");
admits(type(objectView).keyof(), "name");
admits(type([objectView, "|", objectView]).keyof(), "name");
admits(type({ "...": objectView, active: "boolean" }).keyof(), "name");
admits(type.keywords.Required(optionalView), { value: undefined });
admits(type.keywords.Merge(user, replacementView), { id: "x", name: "Ada" });
admits(type.merge(user, replacementView), { id: "x", name: "Ada" });

// Unwidened schemas retain provable exact key sets through composition and projection.
const exactPickedKeys: true = exactly<"id">()(user.pick("id").keyof().infer);
const exactOmittedKeys: true = exactly<"name" | "nick">()(user.omit("id").keyof().infer);
const exactPartialKeys: true = exactly<"id" | "name" | "nick">()(user.partial().keyof().infer);
const exactRequiredKeys: true = exactly<"id" | "name" | "nick">()(user.required().keyof().infer);
const exactNarrowedKeys: true = exactly<"id" | "name" | "nick">()(user.narrow(value => value.id > 0).keyof().infer);
const exactInputKeys: true = exactly<"id" | "name" | "nick">()(user.in.keyof().infer);
const exactUnionKeys: true = exactly<"id">()(user.or({ id: "number" }).keyof().infer);
const exactIntersectionKeys: true = exactly<"id" | "name" | "nick" | "active">()(
	user.and({ active: "boolean" }).keyof().infer,
);
const exactMergedKeys: true = exactly<"id" | "name" | "nick">()(mergedExact.keyof().infer);
const exactStaticUnionKeys: true = exactly<"id">()(type.or(user, { id: "number" }).keyof().infer);
const exactStaticIntersectionKeys: true = exactly<"id" | "name" | "nick" | "active">()(
	type.and(user, { active: "boolean" }).keyof().infer,
);
const exactStaticMergedKeys: true = exactly<"id" | "name" | "nick">()(type.merge(user, { id: "string" }).keyof().infer);

export {
	exactPickedKeys,
	exactOmittedKeys,
	exactPartialKeys,
	exactRequiredKeys,
	exactNarrowedKeys,
	exactInputKeys,
	exactUnionKeys,
	exactIntersectionKeys,
	exactMergedKeys,
	exactStaticUnionKeys,
	exactStaticIntersectionKeys,
	exactStaticMergedKeys,
};

export {
	extractedStringValue,
	extractedSchemaValue,
	extractedExact,
	hiddenKey,
	describedHiddenKey,
	partialHiddenKey,
	requiredHiddenKey,
	omittedHiddenKey,
	pickedViewValue,
	omittedViewValue,
	partialViewValue,
	requiredViewValue,
	requiredUndefined,
	excludedSchemaValue,
	excludedStringValue,
	excludedExact,
	mergedViewValue,
	mergedExactValue,
	narrowedViewValue,
	filteredViewInput,
};

export {
	boundKeys,
	boundOmitted,
	boundPicked,
	calledKeys,
	detachedKeys,
	eitherKey,
	eitherKeys,
	fluentObject,
	fluentPrimitive,
	keys,
	narrower,
	omitted,
	overlapKeys,
	picked,
	minimalViewKeys,
	plainPrimitive,
	sameInput,
	unknownInput,
	unrelated,
	wider,
	zodLike,
	withoutInputKeys,
	withoutOutputKeys,
};
