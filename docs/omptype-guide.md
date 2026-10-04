# omptype Guide (schema authoring in this repo)

Internal schemas use **`@oh-my-pi/omptype`** — an ArkType-compatible validator
with a lazy JIT runtime (`packages/omptype`). Author types with
`import { type } from "@oh-my-pi/omptype"`.


## Why omptype (runtime contract)

- `type()` does not eagerly generate a validator. The benchmark measurements in
  `packages/omptype/README.md` are hardware/runtime-dependent, not API guarantees.
- The first two calls run an interpreter; the third call JIT-compiles a specialized
  validator via `new Function`. Error messages are built lazily.
- There is no functional `jitless` mode — lazy JIT removed the startup tax it
  existed to dodge. Import `type` directly. (`ScopeOptions` accepts a `jitless`
  flag for ArkType compatibility, but the runtime never reads it.)

## The detection contract (don't break it)

`packages/ai/src/utils/schema/wire.ts` distinguishes two schema kinds:

- **omptype** = a callable function with `.toJsonSchema` and `.assert` methods (`isArkSchema`).
- **JSON Schema** = a plain object.

At the provider boundary, `toolWireSchema()` requests draft-2020-12 JSON Schema,
prunes unconstrained `T | undefined` branches without changing required keys,
and closes declared objects with `additionalProperties: false` only when they
have no explicit additional/pattern-property policy. Predicates (`.narrow`)
and opaque morphs (`.pipe`) validate locally but expose their structural input
schema on the wire.

## Definition language (arktype-compatible subset)

| Construct                  | Form                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| Primitives                 | `"string"`, `"number"`, `"boolean"`, `"null"`, `"undefined"`, `"unknown"`, `"object"`, `"bigint"` |
| Integer                    | `"number.integer"`                                                |
| URL string                 | `"string.url"`                                                    |
| Literals                   | `"'x'"`, `"5"`, `"true"`                                          |
| Unions                     | `"'a' \| 'b'"`, `"string \| null"`                                |
| Intersections              | `"string & string.url"`, `[left, "&", right]`                    |
| Arrays                     | `"string[]"`, `"(string \| number)[]"`, `[def, "[]"]`             |
| Bounds                     | `"number >= 0"`, `"0 < number <= 3600"`, `"1 <= string <= 10"`    |
| Optional key               | `{ "limit?": "number" }` or value-suffix `{ limit: "number?" }`   |
| Defaults                   | `{ count: "number = 10" }`, `type("string[]").default(() => [])`  |
| Undeclared keys            | `"+": "reject"` (fail) / `"+": "delete"` (strip) / default keep   |
| Records                    | `{ "[string]": "number" }` or `"Record<string, number>"`          |
| Tuples                     | `["string", "number"]`, `["string", "...", "number[]"]`          |
| Runtime enums              | `type.enumerated(...RUNTIME_ARRAY)`                               |
| Runtime-built object defs  | `type.raw({...})` (returns `BaseType`)                            |
| Keyword statics            | `type.number.atLeast(5).atMost(300)`, `type.string`               |

## Validating (same as arktype)

```ts
import { type } from "@oh-my-pi/omptype";
const out = schema(value);
if (out instanceof type.errors) {
  // out.summary → human message; entries have .path (array) and .problem
  throw new Error(out.summary);
}
// `out` is the validated/morphed value (defaults filled, extras stripped)
```

- Failure returns an `OmpErrors` (array of `OmpError`); `type.errors === OmpErrors`.
- Structural validation is fast-fail; predicates/morphs may return custom `OmpErrors`.
- Built-in defaults and `"+": "delete"` produce transformed copies by default.
  User `.pipe()` callbacks are not automatically cloned; do not mutate their
  input. A scope's `clone` option can supply a cloning function, while
  `clone: false` explicitly writes object/array transformations back to the input.
- NEVER use `.allows()` for tool validation — it skips morphs/defaults/pipes.
- `.infer` / `.inferIn` are inference-only properties.
- Definition mistakes (bad DSL, illegal composition) throw `OmpTypeError` at
  `type()` time.

## Methods

`.describe(d)`, `.default(v | () => v)`, `.or(TypeOrStringDef)`, `.and(Type)`,
`.array()`, `.atLeastLength(n)` / `.atMostLength(n)` (string/array),
`.atLeast(n)` / `.atMost(n)` (number), `.pipe(fn)`, `.narrow(fn)` (with
`ctx.mustBe("...")`), `.allows(v)`, `.assert(v)`, `.toJsonSchema()`.

Schema, string, and object-literal operands of `.or()` and `.and()` have typed
overloads. Object schemas also support `.pick()`, `.omit()`, `.partial()`,
`.required()`, `.merge()`, and undeclared-key policies. `.in` and `.out` expose
standalone schemas for accepted input and known output; output after an opaque
morph is `unknown`. `.pipe.try()` converts thrown callback errors to validation
errors; ordinary `.pipe()` propagates them.

## Scopes, modules, and generics

Recursive or mutually-referencing schemas go through named scopes
(`packages/omptype/src/type.ts`, `scope()` / `type.scope()`):

```ts
import { type } from "@oh-my-pi/omptype";

const types = type.module({
	tree: { value: "number", "children?": "tree[]" },
});
```

- `type.scope(aliases)` (also exported top-level as `scope()`) returns a
  `TypeScope` with `.type`, `.define`, `.resolve`, `.import`, and `.export`;
  aliases may reference each other recursively, and `#private` names stay
  internal.
- `type.module({...})` compiles a named module — `scope(...).export()` — into
  a map of ready schemas.
- `type.generic("<T>", def)` builds runtime generics that other definitions
  can instantiate inside a scope.

## JSON Schema interop

- `.toJsonSchema()` uses draft-2020-12-style structural keywords by default,
  without a `$schema` declaration unless `target` or `dialect` requests one.
  `target: "draft-07"` converts tuples and references to that dialect.
  Recursive aliases emit `$defs`/`$ref` (draft-07 uses `definitions`).
- `io: "input"` describes accepted payloads; `io: "output"` describes produced
  values and makes filled default properties required. Opaque morph output is
  unconstrained. Unset `io` keeps the legacy hybrid behavior for nested morphs.
- `fromJsonSchema(schema)` imports supported structural keywords, string formats,
  local `$defs`/`definitions` recursion, enums, and composition. It is not a
  complete JSON Schema validator: unknown keywords are ignored, `oneOf` is
  treated as a union, and external references are rejected.
- `type.withJsonSchema(schema, json)` wraps a validation-only schema so
  `.toJsonSchema()` emits `json` verbatim even when nested in objects, arrays,
  or unions; schemas with defaults or output-changing morphs are rejected.
- Every schema exposes Standard Schema V1 via `~standard` (synchronous
  `validate`), enabling direct use with `@t3-oss/env`, tRPC, and other
  Standard Schema consumers.
  Its JSON Schema interop exposes input/output converters through `~standard`
  as well.

## Adapters

TypeBox-style and Zod-style authoring are backed by the omptype runtime:

```ts
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";

const User = z.object({ name: z.string() });
type User = z.infer<typeof User>;
```

These produce real omptype schemas with JIT validation and `toJsonSchema`.
Internal code authors the string DSL directly.
