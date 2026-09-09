# omp-scribe

Jinja-flavored prompt template engine and layered props bag for OMP's nested
markdown/XML prompting.

## What it is

`omp-scribe` renders every prompt omp composes: the system head sections,
markdown prompt assets, recovery/steering fills, subagent composition, and
user command templates. It replaces per-prompt hand-threaded Rust string
builders with declarative templates over one [`Props`] bag, and it owns the
post-render canonicalization pass (`canon`) that normalizes prompt text
before hashing and journaling.

## Structural philosophy

- **Deterministic by construction.** Rendering is pure: no clock, no env, no
  randomness. Registered helpers MUST be deterministic; the caller's
  double-render check stays the runtime enforcement.
- **Values are cheap to layer.** [`Value`] collections and [`Props`] use
  persistent structures (`im`), so a subagent bag is `parent.overlay(&patch)`
  — an O(1)-clone, child-wins, *shallow* merge. `Props::with_dom` additionally
  creates a render-scoped borrowed view of the authoritative session tree;
  it never snapshots or serializes the DOM.
- **Markdown-first whitespace.** A line holding only a `{% %}` statement or
  `{# #}` comment disappears with its newline (mustache "standalone line"
  semantics), so control flow never leaves blank scars in prompt markdown.
- **Cold, rich errors.** Compile and render errors carry template name,
  line/column, and an underlined source snippet, built once at construction.

## Grammar

Delimiters are fixed: `{{ expr }}`, `{% statement %}`, `{# comment #}`.
Literal `{{` in prompt text goes through `{% raw %}…{% endraw %}`.

| Form | Notes |
|---|---|
| `{% if e %} … {% elif e %} … {% else %} … {% endif %}` | conditions treat missing keys as falsy |
| `{% for x in e %} … {% endfor %}` | binds `loop.index0`, `loop.first`, `loop.last`; maps iterate `[key, value]` pairs in key order |
| `{% set x = e %}` | render-scoped assignment |
| `{% raw %} … {% endraw %}` | verbatim text |
| `{% xml "tag" %} … {% endxml %}` | `<tag>…</tag>` wrapper, elided when the trimmed body is empty |
| `{% codeblock "lang" %} … {% endcodeblock %}` | trimmed body in a fenced code block |

Expressions: literals (`"s"`, ints, floats, `true`/`false`/`none`), paths
`a.b.c`, indexing `a[0]` / `a["k"]`, optional chaining `a?.b` (missing →
`none`), comparisons `== != < <= > >=` (int/float coerce), `and or not`,
membership `x in coll` (list contains / map has key / substring), string
concat `~`, `+ -` on numbers, ternary `a if cond else b`, filter pipes
`e | f(args)`, and function calls `f(args)`.

Undefined semantics are fixed (minijinja-SemiStrict-like): a missing lookup
is *falsy* inside `if`/ternary conditions and `in`; it is an **error** with a
span when emitted by `{{ }}`, concatenated with `~`, iterated, ordered
(`< <= > >=`), or passed to any filter other than `default`. `?.` makes the
rest of the access chain lenient. Whitespace control: standalone statement
lines are always stripped; `{{- -}}` / `{%- -%}` trim all adjacent
whitespace including newlines; one trailing template newline is dropped.

Display: `none` renders empty, floats use Rust `Display`, and lists/maps
render as compact JSON.

## Builtins

- Filters: `join(sep=", ")`, `length`, `default(fallback)` (replaces missing
  *and* `none`), `pluralize(singular, plural?)` → `"3 items"`, `json`,
  `escape_xml`, `trim`, `indent(n, first=true)` (`first=false` skips the
  first line, for embedding after a label), `bullets(marker="- ")`.
- Functions: `table(rows, headers?)` → GFM table (first row is the header
  when `headers` is omitted); with `Template::render_scoped`,
  `select("todo item[status!=completed]")` returns iterable node values with
  `handle`, `tag`, `content`, and `props`, while `count("<selector>")` and
  `count(select("<selector>"))` count matches.
- Blocks: `xml`, `codeblock`.

## Canonicalization

`canon::canonicalize_prompt` strips HTML comments outside code fences,
collapses blank runs, compacts GFM table separators, and aliases RFC 2119
phrasing (`MUST NOT` → `NEVER`, arrows/operators → Unicode) outside inline
code. It is opt-in: `render` never applies it implicitly — system prompts
canonicalize, command templates do not.
