# Changelog

## [Unreleased]

## [17.3.1] - 2026-08-13

### Fixed

- Fixed TypeBox adapter omitting pattern, non-URL format, and multipleOf constraints from the emitted JSON Schema.

## [17.3.0] - 2026-08-13

### Added

- Added `type.withJsonSchema(schema, json)` to wrap a validation-only schema, ensuring JSON Schema emission yields the provided `json` verbatim even when nested inside objects, arrays, or unions. Schemas with defaults or output-changing morphs are rejected to prevent transformed outputs from being discarded.

## [17.2.10] - 2026-08-06

### Changed

- Reimplemented the Zod compatibility facade (`@oh-my-pi/omptype/zod`) to run purely on internal mechanics, removing the dependency on `zod`.

## [17.2.9] - 2026-08-05

### Fixed

- Fixed the TypeBox adapter emitting an invalid left-bound-only DSL for min-only numeric schemas (e.g. `Type.Integer({ minimum: 1 })`), which threw `left bound requires a corresponding right bound` and broke extension tool loading ([#7648](https://github.com/can1357/oh-my-pi/issues/7648)).

## [17.2.8] - 2026-08-04

### Added

- Added `io: 'input'` and `io: 'output'` options to `toJsonSchema()`, supporting input validation shapes and piped `.to()` target types
- Added Standard Schema V1 interop: every schema exposes `~standard` with synchronous validation, enabling direct use with `@t3-oss/env`, tRPC, and other Standard Schema consumers.
- Added `fromJsonSchema()`, rebuilding callable schemas from JSON Schema documents (draft-07 / draft-2020-12 structural keywords, string formats, `$defs` recursion, enums, and `anyOf`/`oneOf`/`allOf` composition) — the inverse of `Type.toJsonSchema()`.
- Added `$defs`/`$ref` emission for recursive alias schemas in `toJsonSchema()` (draft-07 converts to `definitions`), preventing unbounded recursion on cyclic scopes.
- Added `AnyType`, a minimal structural constraint for generic functions accepting any schema without descending the recursive fluent surface.
- Root `.default()` values now materialize for `undefined` input in direct calls and at the Standard Schema boundary (factories run per call).
- `.narrow()`/`.filter()` boolean overloads accept `OmpErrors` returns, so `cond || ctx.reject(...)` recipes typecheck.

### Changed

- Restored low-overhead schema construction by lazily activating advanced normalization and compatibility machinery.
- `.default()` is typed input-side (`i | (() => i)`) and marks the schema's input as optional (`i | undefined`).
- Parse keywords (`string.integer.parse`, `parse.number`, ...) now infer their morph output inside union strings, and input-side inference is union-aware.
- Object-literal inference for `.merge()`/`.or()`/`.and()` unwraps embedded schema values (output and input sides).

### Fixed

- Alias intersections defer through memoized lazy nodes, so cyclic scope schemas no longer overflow the stack in `.and()` or morph-union determinism checks.

## [17.2.7] - 2026-08-03

### Added

- Introduced omptype, an ArkType-compatible schema validation library featuring a lazy JIT runtime that compiles specialized validators on the third call for ultra-fast hot-path validation and low construction overhead.
- Added support for a rich string definition DSL (primitives, literals, unions, arrays, bounds, inline defaults, and optional keys), object definitions (including index signatures and strict key rejection/deletion), and comprehensive composition methods (.or, .and, .array, .pipe, .narrow, .describe, .default, .allows, .assert).
- Added TypeBox-style (@oh-my-pi/omptype/typebox) and Zod-style (@oh-my-pi/omptype/zod) authoring adapters that produce native omptype schemas.
- Added support for recursive named scopes, modules, runtime generics, fixed/optional/variadic tuples, Date literals/bounds, disjointness-aware intersections, separate input/output inference, and draft-2020-12 JSON Schema emission.
- Shipped transpiled ESM and TypeScript declarations in the npm package to support plain Node.js environments, while preserving TS source resolution for Bun consumers.

### Changed

- Optimized the lazy JIT compiler to support tuples, refinements, morphs, intersections, instances, and recursive aliases, while reducing schema construction overhead.

### Fixed

- Fixed a TypeScript compiler error (TS2589: "type instantiation is excessively deep") when using generic fluent composition methods on nested schemas.
- Fixed type.raw() results (BaseType) to correctly expose fluent composition methods like .array(), .or(), and .pipe().
- Fixed an issue in the TypeBox adapter where keyword-carrying schemas (e.g., uniqueItems arrays) would throw an error during JSON Schema emission.
