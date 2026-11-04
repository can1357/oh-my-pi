# @oh-my-pi/omptype

Fast, ArkType-compatible schema validation for JavaScript and TypeScript.
Schemas start with a small interpreter and lazily compile after repeated use,
keeping construction cheap without giving up hot-path validation speed.

## Installation

```sh
npm install @oh-my-pi/omptype
# or
bun add @oh-my-pi/omptype
```

Runs on Node 20+ (published as compiled ESM with bundled type declarations)
and Bun 1.4.4+ (which resolves the TypeScript source directly via the `bun`
export condition). No runtime dependencies.

## Usage

```ts
import { type } from "@oh-my-pi/omptype";

const Config = type({
	name: "string",
	"retries?": "number.integer >= 0",
	enabled: "boolean = true",
});

const config = Config.assert({ name: "worker" });
// { name: "worker", enabled: true }

const result = Config({ name: 42 });
if (result instanceof type.errors) {
	console.error(result.summary);
}
```

Schemas are callable and expose composition (`.or()`, `.and()`, `.array()`,
`.pipe()`, `.narrow()`), object transforms (`.pick()`, `.omit()`, `.partial()`,
`.required()`, `.merge()`, `.map()`), refinements, semantic comparison, error
configuration, and JSON Schema emission.

Built-in keyword modules include `type.string.email`, `type.string.uuid.v4`,
`type.string.date.iso.parse`, `type.string.normalize.NFKC`,
`type.number.integer`, and the parsers under `type.parse`.

## Named and recursive schemas

```ts
const models = type
	.scope({
		User: { name: "string", "manager?": "User" },
		Users: "User[]",
		PublicUser: "Pick<User, 'name'>",
	})
	.export();

models.User.assert({ name: "Ada", manager: { name: "Grace" } });
```

Scopes resolve aliases lazily, including cycles. `type.module()` exports a
scope directly, `type.define()` preserves literal definitions, and
`type.generic("<value>", definition)` builds parameterized runtime schemas.

Failed validation returns `OmpErrors`; each entry exposes `code`, `path`,
`expected`, `actual`, `problem`, and `message`, while the aggregate exposes
`summary` and `byPath`. `.configure()` accepts string or callback overrides for
error text. `.toJsonSchema()` accepts `target`, `dialect`, and `fallback`
options.

## Compatibility adapters

TypeBox-style and Zod-style builders produce native omptype schemas:

```ts
import { Type, type Static } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";

const TypeBoxUser = Type.Object({ name: Type.String() });
type TypeBoxUser = Static<typeof TypeBoxUser>;

const ZodUser = z.object({ name: z.string() });
const user = ZodUser.parse({ name: "Ada" });
```

`@oh-my-pi/omptype/ark` provides the repository's ArkType compatibility facade
and re-exports the same `type` and `scope` implementations.

## JSON Schema import

`fromJsonSchema` turns any JSON Schema document into an omptype schema that
validates exactly as drafts 2020-12 and 7 specify, including `$dynamicRef`,
`unevaluatedProperties`/`unevaluatedItems`, `$id`/`$anchor` resolution, and
meta-schema vocabularies:

```ts
import { fromJsonSchema } from "@oh-my-pi/omptype";

const read = fromJsonSchema(mcpTool.inputSchema, {
	draft: "2020-12", // semantics where a resource declares no `$schema` ("7" for draft 7)
	schemas: { "https://example.com/defs.json": defs }, // documents `$ref`s may name
	formats: { email: value => value.includes("@") }, // `format` only asserts with a check
});
read.allows(args); // boolean
read(args); // args with absent `default`s filled in, or OmpErrors with paths
```

The first calls are interpreted from a compiled plan; hot schemas switch to
generated code (tagged unions become a `switch`, simple patterns char-code
checks). It passes all 1,298 draft 2020-12 and 925 draft 7 core tests of the
JSON-Schema-Test-Suite. Hot checks from the
[pi-schema benchmark](https://github.com/earendil-works/pi/tree/main/packages/schema)
(Node 26, Apple M4 Max, ns per valid check):

| Case                             | omptype | ata | Ajv | TypeBox | pi-schema |
| -------------------------------- | ------: | --: | --: | ------: | --------: |
| nested object with tagged unions |  **85** | 131 | 337 |     341 |       305 |
| union of 5 messages              |  **11** |  24 |  48 |      75 |        60 |
| MCP tool schema with `$ref`      |  **35** |  40 |  85 |      66 |       113 |
| recursive `$ref` schema          | **158** | 196 | 246 |     776 |       570 |

## Performance

Run the benchmark from the repository root:

```sh
bun packages/omptype/bench/bench.ts
```

The harness first requires every candidate to accept, reject, and transform the
same fixtures correctly. Compile and cold-start results use 400 unique object
schemas and report the fastest of five repetitions. Hot validation mixes valid
and invalid inputs after 2,000 warmup calls. The valid-only row uses each
library's public boolean path after 20,000 warmup calls.

Representative result on an Apple M4 Max with Darwin 25.6.0 and Bun 1.3.14:

| Phase                   |    omptype |           ArkType |         TypeBox |
| ----------------------- | ---------: | ----------------: | --------------: |
| Compile `type()`        |  **509ns** | 271.08µs (532.3×) | 27.36µs (53.7×) |
| Compile + 2 validations | **2.18µs** | 526.46µs (241.5×) | 46.90µs (21.5×) |

| Hot workload               |  omptype |         ArkType |         TypeBox |
| -------------------------- | -------: | --------------: | --------------: |
| `flat-small`               | **25ns** | 5.10µs (203.7×) |  1.23µs (49.2×) |
| `enum-union`               | **27ns** | 4.92µs (185.0×) |  2.20µs (83.0×) |
| `nested-arrays`            | **29ns** | 4.80µs (163.0×) | 3.01µs (102.2×) |
| `strict-defaults`          | **40ns** | 4.85µs (122.1×) | 4.92µs (123.9×) |
| `delete-extras`            | **22ns** | 4.12µs (191.6×) |  2.07µs (96.0×) |
| `record-mixed`             | **43ns** | 4.32µs (100.4×) |  3.35µs (77.9×) |
| `deep-message`             | **31ns** | 6.32µs (202.5×) | 5.13µs (164.5×) |
| `nested-arrays` valid-only | **15ns** |     28ns (1.8×) |     45ns (2.9×) |

Lower times are better. Parenthetical values show how many times slower each
candidate was than omptype in this run. Results vary with hardware, runtime,
thermal state, and dependency versions; use the command above for local
measurements.

## License

MIT
