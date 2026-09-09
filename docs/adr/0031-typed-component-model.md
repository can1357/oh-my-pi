# 0031. Typed `(Element, Props, Children)` markup for every surface

Status: accepted
Date: 2026-09-02
Area: interface

## Context

With `render(width): string[]` (0030) the only thing a tool author can hand the UI is text that
already commits to one layout. That has three costs the post documents:

- Structure is unrecoverable. Once a tool card is a `string[]`, the web client, a snapshot test,
  and a remote inspector cannot lay it out differently; they can only display the terminal's
  rendering or re-parse it.
- Errors surface as mangled frames. Nothing checks that a component was composed legally; a
  nested text-in-text or a data tag under the wrong parent is discovered when the frame looks
  wrong at run time.
- Every renderer is a fresh style. pi extensions have no shared design language: "99% of the time
  the bare minimum (truncate/line-wrap text), and all your tools are indistinguishable gray
  rectangles; 1% of the time it tries so hard to look fancy it looks out of context."

The DOM chapter (0003) promised that a tool element can be rendered by any actor. That promise
needs a shape the actors can share.

## Decision

1. Components are `(Element, Props, Children)` plus a layout engine. Tool and extension authors
   describe structure and semantics; the surface (TUI, web client, snapshot test, remote
   inspector) decides layout for its own medium.
2. Markup is typed and linted at edit time. Composition errors are compile/lint errors, not
   run-time frames: nesting an element inside `<text>` is rejected where it is written; a
   parent-owned data tag (`<option>`, `<td>`, `<tab>`, `<node>`, ...) under the wrong parent is
   rejected the same way.
3. The canonical construction path is the typed macro (`dom!`; `layout!` in the post): typed
   props, interpolation, `for`/`if`/`match`, and `IntoComponent` for `&str`/`String`/`Str`/`()`/
   `Vec`. `format!` → `String` → reparse is the discouraged path.
4. Runtime markup (TML) degrades like HTML. An unknown tag becomes a `CustomElement`: a registered
   renderer if one exists, otherwise its children render and it layers like a `div`. A bad tag
   NEVER fails the document into raw-text fallback.
5. Props inherit like CSS: `<col fg=blue>` colors descendant text without an explicit `<text>`;
   well-known props are typed and non-allocating, arbitrary key/values ride beside them for custom
   elements.

The `Read` tool card in the post is the reference shape for a tool author's obligations: what the
card says, not how wide it is.

```html
<box bc=muted>
   <row kind=title gap=1>
      <text>•</text>
      <text bold>Read</text>
      <a href={input.path}>{input.label}</a>
      {#if status=error}<badge tone=error>exit {code}</badge>{/if}
   </row>
   {#if result.head}<pre lang={result.lang} wrap=word start={result.start}>{result.head}</pre>{/if}
   {#if @expanded}
      {#if result.blob}<pre lang={result.lang} numbers start={result.start} blob={result.blob}></pre>{/if}
   {/if}
   {#each diag as d}<callout tone={d.severity}>{d.msg}</callout>{/each}
   {#if result.src}
      <hr title="Output"/>
      <row gap=1 fg=muted>
         <text>⟨Resolved path:</text>
         <text>{result.src}⟩</text>
      </row>
   {/if}
   {@render usage}
</box>
```

Nothing in it is a width, a color literal, or a glyph. `tone=error`, `bc=muted`, `wrap=word`,
and `{@render usage}` are semantic; the renderer resolves them (0032).

## Consequences

- One description, many surfaces: the same tool card drives the TUI, a headless snapshot, and a
  remote inspector without a second renderer per tool.
- The LSP does the reviewing. An agent writing a tool card gets its composition errors before it
  runs anything; the "make tool UI pls" failure mode (0030) is caught at the editor.
- Extension markup from untrusted or stale sources cannot take the document down: unknown tags
  degrade, they do not abort.
- Prohibited: tool code that returns pre-rendered rows; example-local visual features (a new
  effect becomes a reusable prop or component in core first); string-building a tree and
  re-parsing it.
- Cost accepted: a layout engine, a typed vocabulary shared between macro and runtime parser, and
  a lint layer are engine complexity that a `string[]` contract did not need. That is the point
  (0002).

## Status in omp

**Partial.** Primary implementation: `crates/chat/src/cards/mod.rs`. Typed `dom!` cards consume real tool contracts. Extension custom-message renderer identities and replacement TML are journaled through `crates/session/src/custom_message.rs`, sealed by `crates/envd/src/exthost`, and projected with Markdown fallback by `crates/chat/src/notices/custom.rs`. Gap: runtime-markup control flow, `layout!`, and equivalent web projection are not proved.

## References

- The Harness Playbook, "The interface": "A typed component model"
- `crates/macros/src/dom.rs`, `crates/vocab`, `crates/tui/src/markup.rs`,
  `crates/tui/src/components/custom.rs`, `crates/tui/README.md` "`dom!` syntax", "Custom elements
  and components"
- `AGENTS.md` "TUI Rendering Doctrine"
- 0003 (a tool element renderable by any actor), 0008 (the tool state the card projects), 0030,
  0032, 0033
