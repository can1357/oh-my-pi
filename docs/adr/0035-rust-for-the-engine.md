# 0035. Language choice is architecture; Rust for the engine

Status: accepted
Date: 2026-09-02
Area: stack

## Context

A large share of the implementation is produced by agents trained on the defaults and pathologies
of each ecosystem. Language choice therefore decides how much friction the codebase puts between
the architecture in 0001–0034 and the next "helpful" local exception.

The evidence is an experiment anyone can repeat: give Claude the same widget prompt targeting macOS
(Swift) and Linux (Qt/JS). The first returns a glassmorphic widget that looks native; the second
returns a rectangle with overlapping elements. Better prompting narrows the gap but never closes
it. The cause is not that Swift contains taste. Defaults, standard libraries, canonical project
shapes, compiler feedback, and ecosystem conventions act as a prior for generated code. A language
that permits twenty equally normal local styles asks the model to make twenty decisions before it
reaches the product problem.

TypeScript is the extreme case: it always ends up becoming *your* language. The unforced choices a
project has to make before writing anything include:

- `camelCase` or `snake_case`; `Buffer` or `Uint8Array`; `Array<T>` or `T[]`
- Zod or Typebox; TypeScript or JSDoc; ESM or CJS (`.js`, `.mjs`, `.cjs`, `.ejs`)
- classes, plain objects, or `new function()`; `private foo` or `#foo`
- default exports or named; star re-exports or enumerated
- `module/index.ts` or `module.ts`; `const x = () =>` or `function x()`
- `function x(args)` or `function x(...args)`, and then `any[]` or `unknown[]`
- `const X = 1`, `enum E { X = 1 }`, or `const enum E { X = 1 }`
- 200-line generics or none at all

Faced with these, a junior — or an agent — takes the shortest path: roll an `isRecord` instead
of choosing a schema library, union the types instead of writing a generic, specialize with a
`typeof` branch instead of making one path correct for both types, skip classes because "it's just
objects and prototypes". The same agent can find Linux 0-days; the problem is the prior, not the
capability, so waiting for *the right model* or *the right code-quality tool* is not a plan.

The author's general expectation is that Go wins this argument for most software (compile speed,
cross-compilation ease, and the WASM GC proposal), for the same reasons Swift wins at design. A
harness engine has systems requirements — in-process bash interpreter, embedded CPython, one-pass
renderer, journal replication — that demand a lower-level language, so the choice is Rust.

Rust has known steering costs with agents: they allocate copies rather than deal with intricate
borrows, and they pass errors as strings instead of using `thiserror`. Against that, `std` plus
the `serde` ecosystem covers most of what the engine needs, and the compiler provides a substantial
amount of safety for free.

## Decision

1. The engine — every crate under `crates/` — MUST be Rust. TypeScript is permitted only where
   frontend interop forces it (a browser or editor host that cannot be reached otherwise), and
   never as an engine, plugin, or extension runtime.
2. The known agent shortcuts MUST be codified as mechanical discipline, not left to model quality:
   - errors are `thiserror` enums with typed `#[source]`/`#[from]` inner errors; string-payload
     variants and formatted error messages inside libraries are rejected;
   - borrowing is the default; owned `String`/`Vec` on a hot path needs the workspace's
     small/shared replacements or a justification;
   - enum/string tables derive from `strum`, never hand-written `match`;
   - every public symbol is documented; `#[allow]` carries a reason.
   These rules live in `AGENTS.md` (loaded into every agent's context) and in
   `[workspace.lints]`, so a violation is a compiler warning or a reviewer-reject, not a hope.
3. Style choices the language leaves open (formatting, import order, module layout) MUST be fixed
   once at the workspace level. A second convention beside an existing one is prohibited (0002).
4. The toolchain is pinned. Nightly-dependent APIs are used deliberately and NEVER redesigned
   around stable.

## Consequences

- Agent-generated code lands with the same shape as human-written code: the prior is the
  compiler and the lint set, not the model's training distribution.
- Every crate inherits the same `deny` on `correctness`/`suspicious`, `warn` on
  `pedantic`/`nursery`/`perf`, and the synchronization `disallowed_*` policy; a crate cannot opt
  into a looser dialect.
- Prohibited: a JS/TS plugin runtime inside the engine (0036), stringly-typed errors, hand-rolled
  `Display` tables, ad-hoc copies where a borrow lifetime already permits.
- Cost accepted: Rust's borrow discipline makes agents slower on first attempt and requires
  steering; clippy `pedantic` produces warnings that must be addressed or explicitly allowed.
  Compile times are worse than Go's would be. Cross-compilation for sandboxes and remote workers
  is more work than a Go toolchain would need.
- Cost accepted: the small set of project-local agent tooling that must drive PTYs or WASM
  terminal emulators from a scripting runtime stays in TypeScript under Bun, outside `crates/`.

## Status in omp

**Partial.** Primary implementation: `Cargo.toml`. All engine crates are Rust and workspace lints encode the baseline. Gap: allocation and typed-error-string discipline still relies partly on review.

## References

- The Harness Playbook, "The stack" — "Language choice is architecture", "TypeScript becomes your
  language"
- 0002 (one owner per hard problem; no second convention), 0036 (why the extension language is
  Python, not TypeScript), 0028 (in-process bash interpreter as a systems requirement)
- `Cargo.toml` `[workspace.lints]`, `rust-toolchain.toml`, `AGENTS.md` "Composition/errors/state",
  "Allocation Discipline"
- Prior art named by the post: Swift/macOS design consistency, EffectJS, Go and the WASM GC
  proposal, `thiserror`, `serde`
