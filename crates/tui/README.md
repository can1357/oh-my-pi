# `omp-tui`

`omp-tui` builds retained terminal interfaces from declarative component trees. You describe a screen once, route terminal events into `Ui`, and let `Ui` update and repaint the smallest safe region. `Renderer` then writes only the changed viewport cells without scrolling terminal history.

Most applications use `dom!` for their initial tree, stable `id` attributes for later updates, and `Ui::values()` to read interactive state.

## Structure

- `components` and the `dom!` macro define retained layout, text, navigation, data, and input trees; runtime `markup` and typed builders provide alternate construction paths.
- `Ui`, `App`, and the event/input modules retain widget state and route keyboard, mouse, paste, resize, and application events.
- `Frame` and `Renderer` turn component output into differential terminal updates, while `terminal`, `graphics`, `notify`, and protocol-specific modules manage lifecycle and terminal capabilities.
- `slots` owns transcript block lifecycle, logical history, viewport allocation, resize replay, and the staged delivery transaction. `Renderer::present_plan` is the only slots-to-terminal seam: it acknowledges `Delivered::All` or returns a `DeliveryError` carrying the exact complete-row prefix.
- `editcore`, `rich`, `markdown`, `latex`, `syntax`, `scene`, and `shader` provide editing and richer content pipelines. `build.rs` validates `icons.tsv` and generates the icon lookup catalog.

## Philosophy

Build the component tree once, preserve interaction state, and repaint only the smallest safe terminal region. Keep terminal-specific negotiation and escape handling inside the crate so applications can focus on declarative structure and explicit event-driven updates.

## Mental model

An `omp-tui` application has four layers:

1. **Components** describe layout, content, and interaction. Build them with `dom!`, runtime markup, or Rust builders.
2. **`Ui`** owns the retained component tree, focus, widget state, dom, hit regions, and the current `Frame`.
3. **Events** mutate that retained tree through `handle_key`, `handle_paste`, `handle_mouse`, `set_text`, and related methods.
4. **`Renderer`** differentially paints the resulting frame to a terminal writer.

Build the `Ui` once and keep it. Rebuilding after every key press discards editor contents, selection, focus, tab state, and scroll offsets.

## Add the crate

Inside this repository, declare internal crates at the workspace root and inherit them from the application crate:

```toml
# Cargo.toml
[workspace.dependencies]
omp-tui = { path = "crates/tui" }
```

```toml
# crates/my-app/Cargo.toml
[dependencies]
omp-tui = { workspace = true }
```

The application uses `omp_tui`; Cargo converts the package hyphen to an underscore in Rust paths.

`omp-tui` owns terminal lifecycle and input decoding; applications do not need a separate terminal-backend dependency.

## Build a first screen

`dom!` is the usual starting point. It expands to ordinary component builders and can interpolate Rust values without parsing a string at runtime.

```rust
use omp_tui::{Ui, UiContext, dom};

#[derive(Clone, Copy)]
enum RunState {
    Ready,
    Running,
    Failed,
}

fn build_ui(width: u16, state: RunState, show_help: bool) -> Ui {
    let jobs = ["index workspace", "run checks", "publish report"];

    Ui::from_root(
        dom! {
            <col gap=1 pad="1 2">
                <box border=round title="Build">
                    <col gap=1>
                        <text bold fg=accent>{"Pipeline"}</text>
                        for job in jobs {
                            <row gap=1>
                                <i:check/>
                                <text>{job}</text>
                            </row>
                        }
                        match state {
                            RunState::Ready => <text fg=muted>{"Ready"}</text>,
                            RunState::Running => <text fg=info>{"Running"}</text>,
                            RunState::Failed => <text fg=err>{"Failed"}</text>,
                        }
                    </col>
                </box>
                if show_help {
                    <text dim>{"Tab moves focus; Enter activates; Esc cancels."}</text>
                }
            </col>
        },
        width,
        UiContext::default(),
    )
}

let ui = build_ui(80, RunState::Running, true);
assert!(ui.height() > 0);
```

The macro requires one root element. Use `<col>` or `<row>` when the screen has several top-level regions.

## Choose a construction style

The library supports three ways to build the same retained component model.

| Style | Use it when | Entry point |
| --- | --- | --- |
| `dom!` | The structure lives in Rust and needs interpolation or control flow | `Ui::from_root(dom! { ... }, width, context)` |
| Runtime markup | Layout arrives as configuration, generated text, or editable source | `Ui::from_markup(source, width, context)` |
| Rust builders | A custom component or abstraction is clearer as typed Rust | `Ui::from_root(Col::new().child(...), width, context)` |

Runtime markup is parsed when `Ui` is constructed and returns `ParseError` on malformed input. It supports implicit Markdown text between tags, but it cannot execute Rust expressions or Rust control flow.

`dom!` is checked by the Rust compiler. It accepts arbitrary Rust expressions in braces and child-level `for`, `if`, and `match` constructs. Text in macro markup must be a string literal or a braced expression; unlike runtime markup, a bare word is not text.

Builders are useful for reusable functions and custom `Component` implementations. Builder children implement `IntoChildren`, so a child can be one component, `Option<T>`, an array, a `SmallVec`, or a `Vec`.

## `dom!` syntax

### Elements and attributes

Tags map to built-in component builders:

```rust
# use omp_tui::dom;
# let initial = "hello";
let tree = dom! {
    <box border=round pad="1 2" w=60% bg="#20242c">
        <input id=query value={initial} placeholder="Filter"/>
    </box>
};
# let _ = tree;
```

Attribute forms:

- `bold`, `grow`, `mask`, and similar flags mean `true`.
- `fg=accent`, `border=round`, and `align=center` are string values. A bare identifier is not a Rust variable.
- `title="Results"` and `pad="1 2"` preserve spaces.
- `w=50%` is a percentage.
- `value={initial}`, `h={rows}`, and `bold={enabled}` evaluate Rust expressions.
- Dashed names such as `pad-x` and custom names such as `data-kind` are accepted.

Known attributes become typed `Prop` entries. Unknown attributes are retained as custom properties for custom elements.

### Text and expression children

Use a string literal or expression inside text-like tags:

```rust
# use omp_tui::dom;
# let name = "Ada";
let tree = dom! {
    <col>
        <text>{"literal text"}</text>
        <text>{name}</text>
        <md>{"**Markdown** with `code`"}</md>
        <latex>{r"\frac{1}{2}"}</latex>
        <pre>{"┌──┐\n└──┘"}</pre>
    </col>
};
# let _ = tree;
```

A braced expression in a container is a component child rather than text:

```rust
# use omp_tui::{components::TextLeaf, dom};
let extra = TextLeaf::new().text("built in Rust");
let tree = dom! { <row>{extra}</row> };
# let _ = tree;
```

### Icons

`<i:name/>` is shorthand for a semantic icon. Dashed names such as `<i:log-in/>` are accepted. The active `Charset` chooses a Unicode, Nerd Font, or ASCII glyph:

```rust
# use omp_tui::dom;
let tree = dom! {
    <row gap=1>
        <i:info/>
        <text>{"Details"}</text>
    </row>
};
# let _ = tree;
```

`<icon name={name}/>` is useful when the icon name is dynamic.

### `for`, `if`, and `match`

Control flow appears wherever the owning component accepts children. Bodies may contain multiple elements and may nest other controls.

```rust
# use omp_tui::dom;
# let rows = [("alpha", true), ("beta", false)];
# let selected = Some("alpha");
let tree = dom! {
    <col>
        for (name, healthy) in rows {
            <row gap=1>
                if healthy {
                    <i:check/>
                } else {
                    <i:warning/>
                }
                <text>{name}</text>
            </row>
        }
        match selected {
            Some(name) => {
                <hr/>
                <text bold>{name}</text>
            },
            None => <text dim>{"Nothing selected"}</text>,
        }
    </col>
};
# let _ = tree;
```

These controls run when the component tree is built. They do not automatically re-run when widget state changes. For retained visibility driven by an input value, use `when=`; rebuild only when the application genuinely needs a different tree.

An `<editor>` is deliberately stricter: it accepts at most one editable input child and one `<status>`. Mutually exclusive `if` or `match` branches may choose those children, but a `for` loop cannot generate editor slots because it could produce duplicates.

### Parent-owned data tags

Some tags describe data owned by their parent rather than standalone components:

| Parent | Allowed data child | Purpose |
| --- | --- | --- |
| `<select>` | `<option>` | Choice value, label, description, preview, and `<td>` cells |
| `<option>` or `<tr>` | `<td>` | One aligned grid cell |
| `<table>` | `<tr>` | One table row of cells |
| `<status>` | `<segment>` | Status-band segment |
| `<tabs>` | `<tab>` | Named pane |
| `<tree>` or `<node>` | `<node>` | Tree item and nested items |
| `<todo>` or `<task>` | `<task>` | Todo row with status, blocker note, and nested rows |
| `<form>` | `<field>` | Form field metadata |
| `<wizard>` | `<step>` | Named wizard step |

The macro rejects a data tag under the wrong parent. Control flow may produce these data children under their correct owner.

## Element reference

Every catalog element is listed below. “Shared” means the element also accepts the shared sizing, identity, visibility, padding, border, and background properties documented in the [property reference](#property-reference). The **Props** column names behavior specific to that element; setting an unrelated known property is accepted and stored but has no effect unless a custom component reads it.

### Construction-mode availability

| Syntax | `dom!` | Runtime markup | Notes |
| --- | --- | --- | --- |
| Catalog tags below | Yes, except `<spinner>` | Yes | Both produce the same retained component types where available |
| `<i:name/>` | Yes | No | Macro shorthand for `Icon::named("name")` |
| `<ico:name/>` | No | Yes, inside text and attribute values | Resolved through the active `Charset` |
| Rust `{expr}`, `for`, `if`, `match` | Yes | No | Evaluated while the tree is built |
| Bare Markdown text | No | Yes | Runtime markup turns text between tags into Markdown leaves |
| Unknown tags | Yes | Yes | Become `CustomElement` and resolve through `UiContext::elements` |

### Layout elements

#### `<col>`

A vertical child stack. It measures children at the available width and places them from top to bottom.

- **Children:** Any component children.
- **Props:** Shared; `gap`; `align`; `valign`. Child `grow` shares extra height when the column has a fixed `h`.
- **Typical use:** The root of a screen, a form section, or the body inside a box.

```rust
# use omp_tui::dom;
let tree = dom! {
    <col h=12 gap=1 align=center>
        <text>{"Header"}</text>
        <spacer grow/>
        <text>{"Footer"}</text>
    </col>
};
# let _ = tree;
```

#### `<row>`

A horizontal child layout. It resolves child `w`, `min`, `max`, and `grow`, then distributes remaining width.

- **Children:** Any component children.
- **Props:** Shared; `gap`; `align`; `valign`; `justify`; `wrap`.
- **Special behavior:** A `<hr/>` child becomes vertical automatically. With `wrap`, children stack vertically when their minimum widths do not fit.

#### `<box>`

A bordered vertical stack. `Boxed::new()` supplies a square border by default.

- **Children:** Any component children.
- **Props:** Shared; `gap`; `align`; `valign`; `title`; `footer`; `title-align`/`footer-align`; `border`; `bc`/`edge`; `bleed`.
- **Mode detail:** Runtime markup also defaults `pad-x=1`; `dom!` does not, so set padding explicitly when the distinction matters.

#### `<scroll>`

A vertically scrollable stack. Arrow keys, Page Up/Down, and the mouse wheel move its viewport; focus movement chases focused descendants into view.

- **Children:** Any component children, stacked without an implicit gap. Wrap them in `<col gap=...>` when spacing is needed.
- **Props:** Shared; especially `h`, which fixes the viewport height.
- **Default:** Eight rows when no `h` is supplied.

#### `<hr/>`

A horizontal divider, or a vertical divider inside a row.

- **Children:** None.
- **Props:** Shared sizing; `border` chooses the glyph family; `title`; `fg`; `bc`/`edge`; `vertical`.
- **Special behavior:** `<row>` sets `vertical` on rule children automatically.

#### `<table>`, `<tr>`, and `<td>`

A columnar layout whose cells align vertically: every column is solved once
across all rows (widest cell wins), surplus width goes to `grow` cells'
columns, and a deficit shrinks the widest flexible column first.

- **`<table>` children:** `<tr>` only; each `<tr>` holds `<td>` cells.
- **`<table>` props:** Shared; `gap` (column spacing, default 2).
- **`<tr>` props:** `bg` paints a full-width row band.
- **`<td>` content:** Any children, laid out side by side; `<td>` props include `align`, `w`, `min`, `max`, `grow`, and `truncate`.
- **Truncation:** A `truncate` cell flattens `<pre>`/`<text>` children — keeping each child's own style — into one line clipped by a single ellipsis at the cell edge, so multi-toned labels collapse as a unit. `truncate=start` clips the head instead, keeping the distinctive tail of ids and paths visible.
- **Interaction:** None. Tables are layout-only; for a clickable, filterable list put the same `<td>` cells inside `<select>` options.

#### `<spacer/>`

Blank flexible space used to separate or push siblings.

- **Children:** None.
- **Props:** Shared sizing; normally `grow`, `w`, or `h`.
- **Mode detail:** Runtime markup defaults to `grow=1`. In `dom!`, write `<spacer grow/>` explicitly for flexible space.

### Text, rich content, and media

#### `<text>`

Verbatim text. It does not parse Markdown.

- **Content:** String literals or expressions in `dom!`; raw body text in runtime markup.
- **Props:** Shared; `fg`; `bold`; `dim`; `italic`; `underline`; `reverse`; `strike`; `align`; `truncate`; `wrap`; `shimmer`; `reveal`.
- **Wrapping:** Word-wraps by default. `wrap=char` flows grapheme-exact to the width like a bare terminal, and full-width rows flag their break as a soft wrap — the renderer joins such boundaries through terminal autowrap (mid-word overflow breaks join under word wrap too), so native selection copies the on-screen line unbroken.
- **Updates:** `Ui::set_text(id, value)` replaces its content. With `reveal`, a replacement that extends the current text continues the reveal from the shown prefix; any other replacement restarts it from nothing.

#### `<md>`

Markdown with tables, links, code highlighting, math, Mermaid, and Graphviz rendering.

- **Content:** Markdown source.
- **Diagram fences:** `mermaid`, plus `dot`/`graphviz`/`gv`; Graphviz rendering is pure Rust and never shells out to `dot`.
- **Props:** Shared; text-style props; `align`; `truncate`.
- **Runtime detail:** Noninteractive catalog or custom blocks can be embedded at line starts. Interactive tags are rejected inside Markdown.
- **Macro detail:** `dom!` accepts only string/expression content inside `<md>`; build embedded components with `Markdown`’s Rust builder.
- **Updates:** `Ui::set_text` reparses and relays out the document.

#### `<latex>`

LaTeX-style math rendered into terminal cells.

- **Content:** A string literal or expression.
- **Props:** Shared; text-style props; `align`; `truncate`.
- **Updates:** Supports `Ui::set_text`.

#### `<pre>`

Verbatim preformatted terminal art. Newlines and spacing are preserved.

- **Content:** A string literal or expression; runtime body text is trimmed only at outer line breaks.
- **Props:** Shared; text-style props; `align`.
- **Updates:** Supports `Ui::set_text`.

#### `<callout>`

A highlighted Markdown callout with an optional header, icon, and badge. The Rust builder type is `Callout`.

- **Content:** Markdown source.
- **Props:** Shared; text-style props; `title`; `icon`; `badge`; `truncate`.
- **Defaults:** Without `icon`, the active charset supplies an informational icon.
- **Updates:** Supports `Ui::set_text`.

```rust
# use omp_tui::dom;
let tree = dom! {
    <callout title="Build warning" badge=1 icon=warning fg=warn>
        {"The cache is stale; the next build will be slower."}
    </callout>
};
# let _ = tree;
```

#### `<icon>` and icon shorthand

A semantic icon resolved by `Charset`.

- **Content/name:** In `dom!`, use `<icon name={name}/>` or `<i:name/>`. Runtime markup uses `<icon>name</icon>`, `<icon icon=name/>`, or inline `<ico:name/>`.
- **Props:** Shared; `fg`; text-style props.
- **Fallback:** Unknown names render as their bare name rather than disappearing.

#### `<spinner>` — runtime markup and Rust builder

An animated indeterminate activity glyph driven by the [`App`](crate::App) loop. Tests and custom hosts can advance it directly with `Ui::tick`.

- **Availability:** Runtime markup and `components::Spinner`; `dom!` currently treats `<spinner>` as a custom tag.
- **Props:** Shared; `fg`; text-style props; an `id` allows `set_text` when constructed with the Rust builder.
- **Label:** Runtime `<spinner>` is currently glyph-only. Use `Spinner::new().label(...)` for trailing text.

#### `<img/>`

A terminal image with a cell-rendered fallback.

- **Children:** None.
- **Props:** Shared; `src`; `w`; `h`; `trim`.
- **Source:** `src` is a filesystem path to PNG or binary P6 PPM data. `trim` crops fully transparent margins before cell sampling, keeping padded logos visible as tiny thumbnails.
- **Graphics:** `UiContext::graphics` selects cells, sixel, Kitty placeholders, Kitty direct placements, or iTerm2. For protocol images, pair `Img::kitty(id, rows, cols)` with `Renderer::register_image`.

#### `<diff>`

A unified diff painted for tool edits.

- **Content:** Diff source, one row per line. `+`/`-`/space markers may carry a canonical `123|` or legacy `123 ` line-number gutter (`DiffLine::parse`); `!` rows are diagnostics; hunk headers and other unmarked rows stay verbatim; blank or `...` rows become a gap marker.
- **Props:** Shared; `path`; `context`; `max-rows`; `overflow`.
- **Gutter:** Numbered rows reserve at least three digits (`  -88│`), so a streaming diff never reflows rows it already painted; a number repeated by the next row is blanked. Unnumbered rows keep the bare marker.
- **Emphasis:** A single removed row followed by a single added row is word-diffed and the changed tokens paint in reverse video; leading indentation is never emphasized. Leading tabs and spaces render as dim `→`/`·` glyphs (`diff-indent-tab`, `diff-indent-space`); interior tabs expand to three cells.
- **Highlighting:** `path` infers a language from the extension (or bare file name) and syntax-highlights context rows; added and removed rows keep their semantic color.

#### `DiffPane` — Rust-built interactive source diff

`components::DiffPane` presents a `DiffDocument::build(old, new, path, options)` as split,
inline, tight-hunk, or new-file views. It owns navigation, wrapping, selection, scrolling,
the density minimap, and optional hunk buttons while leaving stage/unstage/discard semantics
to the host through `UiEvent::DiffAction`. Drive retained panes through
`Ui::with_component_mut`; application shortcuts such as mode cycling and hunk navigation remain
host policy.

#### `Scene` — Rust-built 3D viewport

A deterministic CPU ray tracer rasterized into braille cells and animated on the shared presentation clock.

- **Availability:** Rust only — the shader is code. Mount `components::Scene` as a `dom!` expression child, or register a `<scene>` tag through `Elements::builder()` with a factory that captures your scene.
- **Props:** Shared; `bg` paints a backdrop behind unlit (transparent) cells.
- **Scene:** Build a physical scene from `scene::{World, Object, Primitive, Material, Light}` and pass its `PathTracer`, implement `scene::Trace` for custom animated shading, or pass a plain `Fn(Ray) -> (Vec3, f32)` closure for a still procedural view. `Scene::size(cols, rows)` fixes the cell viewport; `Scene::still()` paints once instead of waking every frame.
- **Transport:** Finite spheres, quads, disks, and custom geometry are accelerated by an owning BVH. The bounded integrator traces direct shadows, GGX reflection, dielectric refraction, emissive and environment illumination, indirect bounces, and Russian-roulette termination without per-ray allocation.
- **Color:** `Vec3` colors are linear light; `Vec3::rgb` decodes sRGB literals and terminal output applies the sRGB transfer function after sampling.

#### `Shader` — Rust-built fullscreen effect

A CPU fragment shader rasterized into half-block pixels (`▀` foreground over background, two pixels per cell), animated on the shared presentation clock.

- **Availability:** Rust only — the shader is code. Mount `components::Shader` as a `dom!` expression child, or register a `<shader>` tag through `Elements::builder()` with a factory that captures your program.
- **Props:** Shared; `bg` paints a backdrop behind unlit (transparent) cells.
- **Program:** Implement `shader::Program` (`advance` sees the clock and pixel resolution, `fragment` shades one pixel, `particles` splats point sprites over the field), or pass a plain `Fn(f32, f32) -> (Vec3, f32)` closure for a still field. `Shader::size(cols, rows)` fixes the cell viewport; `Shader::still()` paints once instead of waking every frame.
- **Built-in:** `shader::Eclipse` is the reference program — the stippled-eclipse landing shader ported from WebGPU. `examples/eclipse.rs` mounts it fullscreen; the chat demo's welcome card paints it as a backdrop through `Surface::render`.

### Input and action elements

#### `<input/>`

A focusable, single-line text input.

- **Children:** None.
- **Props:** Shared; `id`; `value`; `placeholder`; `mask`; `required`; `match`.
- **Value:** With `id`, `Ui::values()` returns a JSON string.
- **Validation:** `required` and `match` are enforced when the input is inside an active wizard step.

#### `<editor>`

A multiline editor shell with a replaceable editable child and optional status band.

- **Children:** At most one non-status input component and one `<status>`. With no input child, it creates the default multiline `EditInput`.
- **Props:** Shared; `id`; `value`; border and sizing props.
- **Value:** `id` and `value` are forwarded to the editable child; `Ui::values()` returns the expanded editor text.
- **Control flow:** Mutually exclusive `if`/`match` branches may choose children. `for` cannot generate editor slots because it could create duplicates.

```rust
# use omp_tui::dom;
let tree = dom! {
    <editor id=body value="Initial text" border=round>
        <status>
            <segment fg=ok>{"ready"}</segment>
            <segment fg=muted>{"UTF-8"}</segment>
        </status>
    </editor>
};
# let _ = tree;
```

#### `<button>`

A focusable action with a text label.

- **Content:** Text only. `label=` is the fallback, followed by `id` when no body label exists.
- **Props:** Shared; `id`; `label`; `submit`; `cancel`; `confirm`; `accent`.
- **Events:** `cancel` emits `UiEvent::Cancel`; `submit` emits `Submit`; otherwise an ID-bearing button emits `Pressed(id)`.
- **Confirmation:** `confirm` requires a second activation.

#### `<radio/>`

A compact, single-choice row of chips.

- **Children:** None.
- **Props:** Shared; `id`; `options`; `value`.
- **Options:** `options` is whitespace-delimited; `value` selects the initial option.
- **Value:** With `id`, exports the selected option as a JSON string.

#### `<select>` and `<option>`

A focusable choice list with optional filtering, multiple selection, previews, cell-based rows, and free-form values.

- **`<select>` children:** `<option>` only.
- **`<select>` props:** Shared; `id`; `label`; `multi`; `filter`; `custom`; `h` fixes the window height (the list scrolls); `gap` spaces option cells (default 2).
- **`<option>` content:** Its visible label, optional component preview children, and optional `<td>` cells. Cell options render as one aligned grid across every option (the label remains the filter haystack), with the shared table solver and cell `truncate` semantics.
- **`<option>` props:** `value`; `label`; `desc`; `recommended`.
- **Defaults:** An option’s `value` defaults to its label. The first `recommended` option becomes the initial single selection, and focus enters a single select on its chosen option.
- **Filtering:** A filterable single select types-to-filter directly — no `/` mode: printable keys, paste, `Backspace`, `Ctrl+U`, and `Ctrl+W` edit the query (shown with the hardware caret), matches are fuzzy-ranked best-first, `↑`/`↓` wrap, and `Esc` clears the query before bubbling `Cancel`. Multi selects keep the `/`-armed search so `Space` still toggles. `filter="text"` seeds the initial query.
- **Events:** With an `id`, cursor motion surfaces `UiEvent::Highlighted`, activation (Enter or click) `UiEvent::Changed`, and query edits `UiEvent::Filtered` — hosts drive detail panes from these without touching the widget.
- **Value:** Single selects export a string or `null`; `multi` exports an array.

```rust
# use omp_tui::dom;
let tree = dom! {
    <select id=theme label="Theme" filter>
        <option value=dark recommended desc="Low glare">{"Dark"}</option>
        <option value=light desc="High contrast">{"Light"}</option>
    </select>
};
# let _ = tree;
```

Cell options build aligned browsers — stat columns survive narrow widths:

```rust
# use omp_tui::dom;
let tree = dom! {
    <select id=model filter h=6>
        <option value=fable label="anthropic/claude-fable-5">
            <td truncate grow><pre fg=muted>{"anthropic/"}</pre><pre>{"claude-fable-5"}</pre></td>
            <td align=end><pre fg=muted>{"1m"}</pre></td>
        </option>
    </select>
};
# let _ = tree;
```

### Structured input, navigation, and feedback

#### `<form>` and `<field>`

`<form>` renders a compact collection of typed field definitions.

- **`<form>` children:** `<field>` only.
- **`<form>` props:** Shared; `id`.
- **`<field>` props:** `id`; `kind`; `label`; `desc`; `value`; `options`; `min`; `max`; `step`; `required`; `match`.
- **Kinds:** `text` (default), `bool`, `enum`, `select`, `multi`, and `number`.
- **Value:** A form with `id` exports one JSON object keyed by field IDs. Boolean and number fields export JSON booleans and numbers; multi fields export arrays.

#### `<tabs>` and `<tab>`

A focusable tab bar with one active pane.

- **`<tabs>` children:** `<tab>` only.
- **`<tabs>` props:** Shared; `id`.
- **`<tab>` props:** `title`; `label` is a `dom!` alias for `title`.
- **Value:** An ID-bearing tab set exports the active tab title.
- **State:** Switching tabs preserves each pane’s retained subtree.

#### `<tree>` and `<node>`

A virtualized, focusable hierarchy with retained expansion, scrolling, selection, and rich rows.

- **`<tree>` children:** Root `<node>` records only.
- **`<tree>` props:** Shared; `id`; `guides` draws `├─`/`└─` connector gutters instead of plain indentation (bare flag for the square family, or `guides=round|heavy|double|dash`).
- **`<node>` children:** Nested `<node>` records.
- **`<node>` props:** `key` (defaults to its `/`-joined label path); `label`; `prefix` (dim and start-truncated); `open`; `icon` or literal `badge` plus `color`; `annotation` plus `annotation-color`; `action` plus `action-color`; `bold`; `dim`.
- **Rust annotations:** `TreeNode::annotate(TreeAnnotation::new(text).color(color))` is repeatable, so one row can carry independently colored counters; markup's singular `annotation` prop remains available.
- **Value:** An ID-bearing tree exports the selected node key, or `null`.
- **Events:** Activation emits `UiEvent::TreeActivated`; branch or application-leaf toggles emit `UiEvent::TreeToggled`; clicking an action chip emits `UiEvent::TreeAction`. Every event carries the tree id and node key.
- **Keys:** Up/Down or `k`/`j`, Home/End or `g`/`G`, and PageUp/PageDown move selection; Left/`h` collapses or selects the parent; Right/`l` expands, enters the first child, or activates a leaf; Enter activates and Space toggles.
- **Viewport:** The tree retains `scroll_top`, scrolls three rows per wheel tick, chases keyboard selection into view, and paints only the visible flattened window.

#### `<todo>` and `<task>`

A display-only task list in the coding agent's todo style: no focus, keys, or collapse state.

- **`<todo>` children:** Root `<task>` records only.
- **`<todo>` props:** Shared; `guides` selects the connector family (square by default).
- **`<task>` children:** Nested `<task>` records. A task with children renders as a bold group header with an automatic `done/total` count over its descendant leaves; leaves render a status checkbox and label.
- **`<task>` props:** `label`; `status=pending|active|done|dropped|blocked` (agent aliases `in_progress`, `completed`, and `abandoned` are accepted); `desc` carries the note shown as `(blocked: …)`.
- **Styling:** `done` paints ok with a struck label, `active` accent, `dropped` err struck, `blocked` warn with its note, and `pending` dim. Checkbox glyphs follow the active `Charset`.
- **Rust:** `components::Todo::counts()` returns leaf `(done, total)` for host-built headers like `3/14 tasks`.

```rust
# use omp_tui::dom;
let tree = dom! {
    <todo guides=round>
        <task label="Part A">
            <task status="done">{"write the parser"}</task>
            <task status="active">{"wire the renderer"}</task>
        </task>
    </todo>
};
# let _ = tree;
```

#### `<wizard>` and `<step>`

A multi-step flow with Back/Next navigation and validation.

- **`<wizard>` children:** `<step>` only.
- **`<wizard>` props:** Shared; `submit`.
- **`<step>` props:** `title`; `label` is a `dom!` alias for `title`.
- **Validation:** ID-bearing value components inside the active step can use `required` and `match`. Invalid input blocks Next and shows an error.
- **Completion:** `submit` makes the final Next action emit `UiEvent::Submit`.

#### `<status>` and `<segment>`

A compact status band composed of styled segments.

- **`<status>` children:** `<segment>` only.
- **`<status>` props:** Shared; `fg`; `bg`/`on`; text-style props; `align=end` mirrors the caps for a band docked against the right edge (opening cap points into the background, closing edge sits flat on the margin).
- **`<segment>` content:** Segment label text.
- **`<segment>` props:** `label`; `fg`; `bg`/`on`; text-style props.
- **Styling:** Segment style inherits the status style and may override it.

#### `<progress/>`

A determinate progress bar.

- **Children:** None.
- **Props:** Shared sizing; `value`; `max`; `label`.
- **Defaults:** `value=0`, `max=100`; values are clamped to the maximum.
- **Presentation:** The theme supplies filled, empty, label, and percentage colors.

#### `<qr>`

A scannable QR code encoding the tag body.

- **Content:** The payload text, whitespace-trimmed; URLs are the common case.
- **Props:** Shared sizing; `kind=l|m|q|h` selects the error-correction level (default `m`); `fg`/`bg` recolor the dark/light modules; `label` names the degraded row.
- **Presentation:** Unicode half-block cells (two module rows per terminal row) inside the spec-required four-module quiet zone, black on white by default — a scanner contract, not theming. URL-shaped payloads wrap the symbol in an OSC-8 hyperlink.
- **Degradation:** A viewport too narrow or short for the full symbol, or a payload beyond QR capacity, renders one hyperlinked text row (`label`, defaulting to the payload) instead of a clipped, unscannable code.

### Custom elements

Any unknown tag becomes a `CustomElement`.

- **Children:** Any component children.
- **Props:** Every known prop plus arbitrary custom attributes.
- **Resolution:** Register the tag through `Elements::builder()` in `UiContext::elements`.
- **Fallback:** Without a matching factory, the custom element retains and paints its fallback children.

## Property reference

Known properties are parsed and type-checked in both construction modes. A property may still be ignored by a built-in that does not consume it; the element reference above names each built-in’s behavior-specific props.

### Shared sizing, identity, and chrome

These properties apply to standalone retained components. Parent-owned records such as `<option>` and `<field>` use only the props listed in their own sections.

| Prop | Accepted values | Effect |
| --- | --- | --- |
| `id` | String | Stable lookup key for updates, values, conditions, and button events |
| `when` | `"source=value"` or `"source!=value"` | Removes the component from layout, paint, focus, and values while false |
| `w` | Cell count or percentage such as `40%` | Preferred width; row parents resolve it, and images use it for sampling |
| `min` | Integer | Minimum row-child width; also the lower bound of number fields |
| `max` | Integer | Maximum row-child width; number-field upper bound; progress maximum |
| `h` | Integer rows | Fixed outer height; especially useful for scroll regions and flex columns |
| `grow` | Flag or numeric weight | Claims remaining width in a row or remaining height in a fixed-height vertical stack |
| `pad` | `N` or `"Y X"` | Vertical and horizontal inner padding |
| `pad-x` | Integer cells | Horizontal inner padding |
| `pad-y` | Integer rows | Vertical inner padding |
| `border` | `square`, `round`, `heavy`, `double`, `dash` | Adds border chrome; on `<hr>`, selects the stroke glyph family |
| `bc`, `edge` | Color or `start..end` gradient | Border color aliases; a gradient tints the border ring |
| `bleed` | Flag | Extends a background behind border cells |
| `title` | String | Border title, callout heading, tab title, or wizard-step title where applicable |
| `footer` | String | Label woven into the bottom border line of a framed container |
| `title-align`, `footer-align` | `start`/`left`, `center`/`middle`, `end`/`right` | Placement of the border title or footer along its frame line |

### Layout and text props

| Prop | Accepted values | Consumers |
| --- | --- | --- |
| `gap` | Integer | `<col>`, `<row>`, and `<box>` spacing |
| `align` | `start`/`left`, `center`/`middle`, `end`/`right` | Horizontal text placement and stack main-axis placement |
| `valign` | `start`/`top`, `center`/`middle`, `end`/`bottom`, `stretch`/`fill` | Box, column, and row cross-axis placement |
| `justify` | `start`, `center`, `end`, `between` | Row distribution of leftover width |
| `wrap` | Flag, `word`, `char`, or `pre` | Flag/`word`: word flow. `char`: terminal-exact grapheme flow whose width breaks re-join in native copy. `pre`: preserves whitespace and newlines verbatim without soft wrapping |
| `truncate` | Flag or `start`/`end` | Clips text, Markdown, LaTeX, or callout content to one line with an ellipsis; `start` keeps the tail behind a leading ellipsis |
| `vertical` | Flag | Forces vertical rendering where supported; currently used by `<hr>` and set automatically by `<row>` |
| `guides` | Bare flag or `square`/`round`/`heavy`/`double`/`dash` | `<tree>` and `<todo>` connector gutters; the flag means square |

### Color and style props

| Prop | Accepted values | Effect |
| --- | --- | --- |
| `fg` | Theme token, CSS color, or `start..end` gradient | Foreground/style color on rendering elements; a gradient recolors painted cells |
| `color` | Theme token or CSS color | Foreground alias honored by every textual node (`<icon color=err/>`, `<spinner color=accent/>`); `fg` wins when both are present. Controls with a richer semantic base color (`<button>`, tree nodes) keep their own meaning |
| `bg`, `on` | Theme token, CSS color, or gradient | Background aliases; `bg` wins when both are present |
| `angle` | Degrees, optionally with `deg` | Gradient direction, normalized into `0..359` |
| `bold` | Flag | Bold text/style |
| `dim` | Flag | Dim text/style |
| `italic` | Flag | Italic text/style |
| `underline` | Flag | Underlined text/style |
| `reverse` | Flag | Swaps foreground and background |
| `strike` | Flag | Struck-through text/style |
| `anim` | Duration (`180`, `180ms`, `0.4s`; bare flag = 200ms) | Tweens `fg`/`bg`/`on`/`bc` colors, gradient endpoints, `w`, and `h` from the on-screen value whenever their target changes |
| `ease` | `linear`, `in`, `out`, `in-out` | Easing curve for `anim` transitions; defaults to `out` |
| `spin` | Duration (bare flag = 3s) | Continuously rotates any `fg`/`bg` gradient by one revolution per period, on top of `angle` |
| `shimmer` | Duration (bare flag = 2s) | Sweeps a brightness crest across `<text>` content once per period on the shared clock. Additive: resting cells keep the authored style, the crest's shoulders lift an RGB foreground one-fifth toward white, and its peak lifts two-fifths and paints bold (foregrounds without channel data brighten via bold alone) |
| `reveal` | Duration (bare flag = 250ms) | Types streamed `<text>` content out progressively by grapheme cluster instead of popping whole chunks in: the reveal drains its backlog exponentially over the given horizon (bursts catch up smoothly), never slower than 90 clusters/s, and settles once even with the text. Appends via `Ui::set_text` resume from the shown prefix; non-extending replacements restart from nothing; `reveal=0` shows text immediately |
| `hover` | Theme token, CSS color, or gradient | Border chrome while the pointer or focus rests on the component or a descendant: a solid recolors the ring, a gradient renders as a pointer-tracking glow that shimmers on the shared clock (keyboard focus paints the full ring); eases with `anim`/`lift` |
| `lift` | Flag or integer rows (bare flag = 1) | Reserves headroom above the component and raises its chrome into it while hovered, leaving a `shadow`-token drop shadow in the vacated rows |

Theme tokens are `fg`, `accent`, `info`, `ok`, `warn`, `err`, `muted`, `border`, `surface`, `hover`, `shadow`, and `contrast`. An unstyled `<box>` frame or `<hr>` uses the `border` token; `bc=`/`edge=`/`fg=` override it. CSS forms include HTML color names, `#rgb`, `#rrggbb`, `rgb(...)`, and `rgba(...)`.

Runtime markup inherits `fg`, text-style flags, and `truncate` into descendants. `dom!` builds explicit Rust components and does not perform parser inheritance, so place these props on the rendering child when inheritance matters. Animation props are not inherited: `anim` transitions fire on the component that declares them, the first paint never animates, retargeting mid-flight resumes from the on-screen value, and kind changes (solid ↔ gradient, cells ↔ percent) snap. Hosts drive playback by sleeping until `Ui::next_wake` and calling `Ui::tick`.

### Data, input, and action props

| Prop | Accepted values | Consumers |
| --- | --- | --- |
| `value` | String, number, bool, or `{expr}` | Input/editor initial text, segment selection, option value, field value, progress amount |
| `options` | Whitespace-delimited string | Segment choices and enum/select/multi form fields |
| `label` | String | Buttons, selects, options, fields, nodes, progress; macro alias for tab/step title |
| `desc` | String | Supporting text for options and form fields |
| `kind` | `text`, `bool`, `enum`, `select`, `multi`, `number` | Form field control type |
| `step` | Integer | Number-field increment |
| `multi` | Flag | Makes a select export multiple choices |
| `filter` | Flag | Enables interactive filtering on a select |
| `custom` | Flag | Allows a select’s free-form custom value |
| `mask` | Flag | Obscures an input’s displayed text without changing its exported value |
| `recommended` | Flag | Marks the initial preferred option in a single select |
| `open` | Flag | Expands a tree node initially |
| `status` | `pending`, `active`, `done`, `dropped`, `blocked` | `<task>` lifecycle state; drives its checkbox glyph and styling |
| `required` | Flag | Wizard validation for an ID-bearing value component |
| `match` | Anchored simple pattern | Wizard validation after trimming nonempty text |
| `src` | Filesystem path | PNG or P6 PPM image source |
| `path` | Source file path | `<diff>` language inference for context-row syntax highlighting |
| `icon` | Icon name | Callout leading icon; runtime `<icon>` name |
| `badge` | String | Compact callout header badge |
| `submit` | Flag | Submit button or submitting wizard |
| `cancel` | Flag | Cancel button |
| `confirm` | Flag | Requires two button activations |
| `placeholder` | String | Empty, unfocused input hint |
| `accent` | Flag | Accent-filled button treatment |
| `focus` | Flag | Joins the keyboard focus ring; a focused component renders its `hover`/`lift` chrome, and a focusable `id`-carrying `<box>` emits `Pressed` on Enter or click |

`match` is intentionally smaller than regular expressions. It is anchored at both ends and supports literals, `.` for any character, classes such as `[a-z0-9]` and `[^x]`, escapes, and postfix `*`, `+`, or `?`.

### Animation metadata props

| Prop | Accepted values | Parsed value |
| --- | --- | --- |
| `anim` | Flag, milliseconds, `250ms`, or `0.4s` | Transition duration; a bare flag means 200ms |
| `ease` | `linear`, `in`, `out`, `in-out` | Easing curve; defaults to ease-out |
| `spin` | Flag, milliseconds, or seconds | Rotation period; a bare flag means 3s |
| `shimmer` | Flag, milliseconds, or seconds | Crest sweep period; a bare flag means 2s |
| `reveal` | Flag, milliseconds, or seconds | Streamed-text catch-up horizon; a bare flag means 250ms |

These are recognized `Props` metadata for animation-aware custom components. The current catalog does not universally animate merely because these props are present; use `Ui::tick`, `PaintCtx::wake`, and the `anim` module when implementing animated components.

## Layout and styling

### Layout primitives

- `<col>` stacks children vertically.
- `<row>` places children horizontally.
- `gap=N` inserts space between adjacent children.
- `pad=N` applies padding on both axes; `pad="Y X"`, `pad-x`, and `pad-y` control them separately.
- `w=N` and `h=N` request cell dimensions; `w=N%` requests a percentage width.
- `min` and `max` constrain width where supported.
- `grow` claims remaining space on the container axis. In a row that means width; in a fixed-height column it means height.
- `wrap` lets a row stack when its minimum widths no longer fit.
- `<spacer/>` is the clearest way to push siblings apart.

The layout engine owns final geometry. Prefer constraints and flex behavior over calculating absolute cell positions in application code.

### Alignment

- `align=start|center|end` positions content on the writing axis.
- `valign=start|center|end|stretch` positions a container's children on the cross axis.
- Rows stretch children by default; `valign=start` opts out.
- `justify=center|end|between` distributes leftover row width. `between` anchors the first and last child at opposite edges.

### Borders and backgrounds

`border=square|round|heavy|double|dash` frames a box, row, or column. `title=` writes into the top border. `bc=` and `edge=` set its color.

Components are transparent until `bg=` or its alias `on=` is present. A framed background normally stops inside the border; `bleed` extends it behind the frame.

### Color and text style

Prefer semantic colors so the same screen works under a custom theme:

- `fg=accent`, `info`, `ok`, `warn`, `err`, or `muted`
- `bg=accent` or `on=muted`
- `bold`, `dim`, `italic`, `underline`, `strike`, and `reverse`

CSS-style colors are also accepted: HTML names, `#rgb`, `#rrggbb`, `rgb(...)`, and `rgba(...)`. A two-stop value such as `fg="magenta..cyan"` creates a gradient; `angle=90` makes it vertical.

## Identity, state, and updates

### Assign IDs to anything the application addresses

`id=` connects a retained component to update methods, output values, button events, and `when=` conditions:

```rust
# use omp_tui::{Ui, UiContext, dom};
let mut ui = Ui::from_root(
    dom! {
        <col>
            <text id=summary>{"Waiting"}</text>
            <scroll id=results h=8><md id="result-copy">{"No results"}</md></scroll>
            <input id=query placeholder="Filter"/>
        </col>
    },
    80,
    UiContext::default(),
);

assert!(ui.set_text("summary", "Running"));
assert!(ui.set_text("result-copy", "- alpha\n- beta"));
assert!(ui.set_height("results", 12));
```

`set_text` and `set_height` return `false` for an unknown ID; `set_text` also returns `false` when the component cannot replace text or the value did not change.

Call `invalidate(id)` after changing externally shared state read by a custom component. It remeasures and repaints the smallest safe region without replacing the component.

### Read interactive values

`Ui::values()` returns a JSON object containing every visible, ID-bearing value component:

```rust
# use omp_tui::{Ui, UiContext, dom};
let ui = Ui::from_root(
    dom! {
        <form id=settings>
            <field id=name kind=text label="Name" value="Ada"/>
            <field id=theme kind=enum label="Theme" options="dark light" value=dark/>
            <field id=verbose kind=bool label="Verbose" value=true/>
        </form>
    },
    80,
    UiContext::default(),
);

let values = ui.values();
assert_eq!(values["settings"]["name"], "Ada");
assert_eq!(values["settings"]["theme"], "dark");
assert_eq!(values["settings"]["verbose"], true);
```

Standalone `<input>`, `<editor>`, `<radio>`, and `<select>` values appear at their own IDs. A `<form id=...>` groups its field IDs into a nested object.

### Retained conditional visibility

`when="source=value"` and `when="source!=value"` show a component according to another named value:

```rust
# use omp_tui::dom;
let tree = dom! {
    <col>
        <radio id=mode options="basic advanced" value=basic/>
        <box when="mode=advanced" border=round>
            <input id="advanced-path" placeholder="Custom path"/>
        </box>
    </col>
};
# let _ = tree;
```

Conditions update after input events and text updates. Hidden components leave layout, painting, focus, and `Ui::values()` until their condition matches again.

## Route application events

[`App`](crate::App) is the canonical retained-UI host. It resolves capabilities, owns the terminal and renderer, routes native input, schedules animations, coalesces resizes, and presents damage between application events:

```rust,no_run
use std::io;

use omp_tui::{AppEvent, AppOptions, Key, Ui};

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut app = AppOptions::new()
        .quit([Key::Ctrl('c'), Key::Ctrl('q')])
        .start(|env| {
            Ui::from_markup(
                r#"<scroll id="pane" h=12><text>Hello</text></scroll>"#,
                env.viewport.width,
                env.ctx,
            )
            .expect("static markup parses")
        })
        .await?;

    while let Some(event) = app.next().await? {
        if let AppEvent::Resized(viewport) = event {
            app.ui_mut()
                .set_height("pane", viewport.height.saturating_sub(2));
        }
        // Read submitted values or apply dependent updates here. App presents
        // those mutations when `next()` is called again.
    }
    Ok(())
}
```

`App::next` returns application-level outcomes after routing input into the tree:

- `Updated` means input changed or damaged the tree. Read `App::ui().values()` and apply dependent mutations before the next call presents it.
- `Submitted` means the focused widget submitted.
- `Pressed(id)` carries the ID of an activated button.
- `Resized(size)` means the resize storm settled. `Ui::resize` already applied the new width; update fixed-height components before the next viewport present.

Ctrl-C quits by default. `AppOptions::quit` replaces the quit chords, and `keep_on_cancel` prevents a top-level `UiEvent::Cancel` from stopping the host. Once stopped, `next` continues to return `None`.

### Mouse reporting

Inline sessions leave the mouse to the terminal, so native text selection and scrollback keep working. Pointer-driven screens opt in with `AppOptions::mouse()` (or `TerminalOptions::mouse(true)` for immediate-mode hosts), which enables click, drag, motion, and wheel reports for the whole session. The alternate screen always enables reporting while it is active and restores the inline policy on exit.

### Async host

`App::handle` returns a cloneable `UiHandle` for tasks and synchronous threads. `update` queues an arbitrary mutation; `set_text` and `invalidate` cover the common retained-tree updates; `shutdown` cancels the host. Sends never block and become no-ops after the `App` is gone.

The App-installed image loader reads and decodes `<img>` sources on Tokio's blocking pool. Layout first paints the themed box placeholder; delivery remeasures and repaints the image at the smallest safe retained-tree region.

Hosts that need raw key or mouse events can drop down to `Terminal` and multiplex `Terminal::next` — one async mailbox of `TerminalEvent`s (decoded input, resize, debug queries) — with their own timers using `tokio::select!`. Pass terminal response events through `Terminal::handle_input_event` and resolve `TerminalEvent::Resize` with `Terminal::take_resize`. The `chat` example is the immediate-mode reference.

### Custom keybindings

Every `Terminal` starts with the default `Keymap`. Edits ship to the event actor's live decoder and apply to the next decoded chord:

```rust
# fn configure(terminal: &mut omp_tui::Terminal) {
use omp_tui::{Chord, Key, Mods};

let alt_n = Chord::new(Key::Char('n'), Mods { alt: true, ..Mods::default() });
terminal.edit_keymap(|keymap| keymap.bind(alt_n, Key::PageDown));
# }
```

`Keymap::disable` masks a chord, including its identity fallback; `Keymap::unbind` removes a table entry and restores fallback handling. Exact bindings win before shift-folded spellings and identity fallbacks. `InputDecoder` exposes `keymap()` and `keymap_mut()` accessors for applications that decode their own byte streams.

### Elastic transcript slots and delivery

`slots::Slots` is the transcript protocol. `open` creates a block in commitment order. A
`Mode::Mutable` block may replace its retained component with `set`; none of those speculative
snapshots can enter `logical_history`. A `Mode::AppendOnly` block grows through `append`; it keeps
one retained reveal-enabled `TextLeaf`, updates it through `Ui::set_text`, and advances pacing
through `Slots::tick`. While it is the first uncommitted block, complete stable rows may be staged
under viewport pressure. `finalize` seals either mode but writes nothing.

`plan` returns a `WritePlan` containing ordered one-row history frames and the exact viewport that
must remain visible. Planning is side-effect free and idempotent until the presenter reports the
result:

```rust,no_run
# use omp_tui::{Renderer, TtyOut, slots::{Delivered, ResizePolicy, Slots}};
# fn paint(slots: &mut Slots, renderer: &mut Renderer<TtyOut>) -> Result<(), omp_tui::DeliveryError> {
let plan = slots.plan();
match renderer.present_plan(&plan, &[]) {
    Ok(delivered) => slots.commit(plan, delivered),
    Err(error) => {
        slots.commit(plan, error.delivered());
        return Err(error);
    }
}
# Ok(())
# }
```

`Delivered::Partial(n)` acknowledges only that complete prefix. The next `plan` stages precisely
the suffix, so a short write cannot silently drop a history row. A writer error still poisons the
terminal renderer because the current row may have been delivered only in bytes; production hosts
stop rather than risk duplicating that uncertain row.

Blocks move `Active → Finalized → Committed`; the frontier advances only across a contiguous,
fully acknowledged finalized prefix. Live viewport slots allocate one row first, then grow toward
three rows while capacity remains; finalized-but-waiting blocks consume no live rows. Resizing
never changes the logical ledger. Width changes use `ResizePolicy::Preserve`, `Append`, or
`Rebuild` (the default); Rebuild starts a new physical epoch and replays logical history at the new
width. The host reads `cl_resize_policy` and passes the parsed enum into `Slots::new`; `omp-tui`
does not depend on the control plane.

`Ui::present(&mut renderer, viewport_height)` remains the history-neutral path for non-transcript
surfaces. It never infers durable output from scene geometry and never scrolls terminal history.

### Resize without losing state

Call `ui.resize(new_width)` rather than rebuilding the `Ui`. Update fixed viewport components with `set_height`, then present the viewport. This preserves active tabs, editor text, selections, focus, and scroll positions.

## Paste and clipboard

Paste flows through one pipeline regardless of how the bytes arrive; components only ever see `Component::paste` text (or, one level up, `InputEvent::Paste`).

- **Bracketed paste** is enabled for every session. The decoder reassembles chunked payloads (64 MiB cap, 1 s inactivity recovery), decodes tmux's re-encoded control bytes, normalizes newlines, and strips C0 controls before `InputEvent::Paste` is emitted.
- **Enhanced paste (OSC 5522)** is probed via DECRQM and enabled when the terminal supports it (`TerminalCaps::paste_events`; kitty today). A terminal-level paste then arrives as an out-of-band clipboard offer instead of bracketed text, which is how an *image* paste reaches the app. `Terminal` answers the offer conversation internally — MIME listing, priority pick (`png > jpeg > webp > gif > text/plain`), chunked transfer — and the assembled `Pasted` payload surfaces through `Terminal::take_paste`, mirroring `take_resize`. `App` dispatches it automatically; immediate-mode hosts check `take_paste` after a consumed `handle_input_event` (see the `chat` example's `user_event`).
- **Ctrl+V / Ctrl+Shift+V** resolve to the semantic keys `Key::Paste` and `Key::PasteRaw` in the default `Keymap`. When the focused component leaves them unclaimed, `App` reads the system clipboard on a detached thread — image first, then file-manager file URLs, then text — and routes the result back through the paste pipeline. The raw spelling reads text only and inserts it **verbatim** via `Component::paste_raw`: no drop classification, no large-paste collapse, so bulk text stays inline and editable. An *empty* bracketed paste (macOS `Cmd+V` with an image-only pasteboard) triggers the smart read. Backends live in the `paste` module: arboard (with a process-lifetime Linux handle so the X11 selection owner survives) plus platform bridges — `pbpaste`/`osascript` file URLs, `wl-paste`/`xclip`/`xsel`, PowerShell for Windows and WSL interop, Termux. All block; see the module docs for the detached-thread contract.
- **Ordering**: input that arrives while a clipboard read is in flight is queued and replayed afterwards, so an Enter typed right after Ctrl+V submits *with* the paste instead of before it. Quit chords bypass the queue, and a read that outlives its 10 s ceiling is abandoned (its late result dropped by generation) so a hung backend can never wedge input. Reads run on detached threads — never tokio's blocking pool, which cannot abort a running task and would stall runtime shutdown behind a wedged native clipboard. The `chat` example gets the same guarantees by pausing its `terminal.next()` branch behind an absolute deadline.
- **Dropped paths**: `paste::dropped_paths` classifies pasted text that is really a drag-and-drop — quoted or backslash-escaped paths, `file://` URLs (percent-decoded), Windows drive/UNC anchors, multi-file drops, and the unescaped-space macOS screenshot form. An editor with a bound `Attachments` queue stages image paths (existing files only) as `<icon> #N` chips whose submit-time payload is the path; pasted images persist to a temp file first and route the same way.
- **Copy**: `Terminal::copy_to_clipboard` writes OSC 52 (works over SSH) and spawns a best-effort native write.

## Overlays

An overlay is a viewport layer — a model picker, a confirmation dialog, a persistent sidebar — composited above the document without disturbing it. Each overlay is its own retained `Ui` stacked on the presenting one:

```rust,no_run
# use omp_tui::{dom, OverlayAnchor, OverlayOptions, Ui, UiContext};
# let mut ui = Ui::from_markup("<text>base</text>", 80, UiContext::default()).unwrap();
let picker = ui.show_overlay(
    dom! {
        <box border=round title="Switch Model">
            <select id=model>
                <option value="fable">{"claude-fable-5"}</option>
                <option value="opus">{"claude-opus-5"}</option>
            </select>
        </box>
    },
    OverlayOptions::default().anchor(OverlayAnchor::Center).min_width(44),
);

// The overlay is a full retained Ui: address it through its id.
let choice = ui.overlay(picker).map(|overlay| overlay.values());
ui.close_overlay(picker);
```

Behavior:

- **Placement is declarative.** `OverlayOptions` resolves against the viewport at every present: `anchor` (nine positions, `Center` default), `width`/`max_height` as cells or percentages (`Dim::Cells`, `Dim::Pct`), `margin` insets, `offset_x`/`offset_y` nudges, explicit `row`/`col` overrides, and `min_viewport` to gate the layer on small terminals. The default width is `min(80, available)`.
- **Modal layers capture input (the default).** The topmost visible modal overlay receives every key and paste. A cancel from inside a layer (`Esc`, or a `<button cancel>`) dismisses it before anything else: the `App` runtime closes that layer and returns `AppEvent::OverlayClosed(id)` (quit-on-cancel only applies to the base tree), while manual hosts see `UiEvent::Cancel` and call `close_active_overlay`, which dismisses the layer that emitted it even when a higher-z non-modal pane sits above it in the stack (`close_top_overlay` pops the stack top regardless of modality). The base tree keeps its focus untouched, so closing an overlay restores the previous interaction exactly. Mouse input inside the overlay's bounds is routed to it and occluded from the document; clicks outside still reach the base tree.
- **Presentation stays history-neutral.** Overlays are composited as z-ordered viewport layers. Presenting or repainting a layer never scrolls terminal history; explicit retirement receives finalized base rows separately, so overlay cells are never part of the retired batch.
- **Stacking nests.** Later `show_overlay` calls stack on top; explicit `z` on `OverlayOptions` orders layers regardless of creation order, and ties stack newest-on-top. `set_overlay_hidden` parks a layer without losing its editor text, selection, or scroll state.

### Non-modal layers and sidebars

`OverlayOptions::non_modal()` turns a layer into a persistent pane instead of a dialog: keys and paste stay with the base tree, `Esc` never dismisses it, and the `App` runtime keeps presenting the history-neutral viewport instead of holding the alternate screen. The pane remains an overlay layer and is never included in an explicit finalized-row retirement.

```rust,no_run
# use omp_tui::{dom, Dim, OverlayAnchor, OverlayOptions, Size, Ui, UiContext};
# let mut ui = Ui::from_markup("<text>workspace</text>", 120, UiContext::default()).unwrap();
let sidebar = ui.show_overlay(
    dom! {
        <col pad="0 1" gap=1>
            <text bold>{"Session"}</text>
            <hr/>
            <spacer grow/>
            <text dim>{"ctrl+b toggles"}</text>
        </col>
    },
    OverlayOptions::default()
        .anchor(OverlayAnchor::Right)
        .width(Dim::Cells(28))
        .non_modal()
        .fill_height()
        .min_viewport(Size::new(100, 0)),
);

// Hand the keyboard to the pane and back; a click inside or outside
// the band does the same.
ui.focus_overlay(sidebar);
assert_eq!(ui.focused_overlay(), Some(sidebar));
ui.blur_overlay();
```

Keyboard hand-off:

- The topmost visible **modal** overlay always wins the keyboard; a focused non-modal pane resumes when it closes.
- `focus_overlay` activates the pane's focus ring so its chrome shows where typing lands. A click inside the band focuses it; a click outside, an unconsumed `Esc`, or a `<button cancel>` inside blurs it back to the base tree (nothing is dismissed).
- `focused_overlay()` reports the pane holding the keyboard; `top_overlay()` reports whichever layer currently receives keys, modal or focused. The hardware caret follows the same ownership: the active layer places it (or hides it when it has no caret of its own), while passive panes let the document's caret show through.
- Hiding (`set_overlay_hidden`) or closing the focused pane returns the keyboard to the base tree.

`fill_height()` stretches a retained overlay tree to the full available viewport height on every present (margins and `max_height` still apply), so `grow` and `valign` lay the rail out like a full-height column; without it the band follows content height. Raw-frame `Layer` hosts size their frame directly instead — see `examples/chat` for a full-height, click-to-focus sidebar over an immediate-mode document.

Teardown: a pane must not remain composited when terminal ownership returns to the shell. `App` clears renderer layer state automatically on drop; manual hosts call `Renderer::clear_layers()` after releasing any alternate-screen hold and before dropping the `Terminal`.

Limitations: direct-drawn images (sixel, iTerm2, Kitty direct) are not occluded by overlays — cell-based Kitty placeholder graphics are. Resizes relayout and repaint the complete composited viewport.

## Terminal lifecycle

`Terminal::enter` takes exclusive ownership of the controlling terminal, installs emergency restore hooks, enables raw input and the supported keyboard protocol, and starts the input pump. `Terminal::leave` is idempotent: it disables keyboard enhancement before draining late input, clears progress, restores the previous title and terminal modes, and finally restores raw mode. `Drop` performs normal teardown on early returns; panic and fatal-signal paths use an allocation-free blind restore. `Terminal::emergency_restore` exposes that crash-path restore when an application has its own fatal handler.

Entry resets ANSI insert mode (IRM 4) and new-line mode (LNM 20) so cell writes replace in place and Return decodes once; queried prior states are restored on normal and emergency teardown. Appearance (2031) and in-band resize (2048) notifications are enabled and disabled only when the session owns them.

`TerminalOptions::default()` lets `Terminal::enter` negotiate capabilities while feeding probe-window bytes into the same streaming decoder the live pump owns. `TerminalOptions::new(caps)` supplies capabilities resolved beforehand; add `.probe_results(probe)` when they came from `negotiate` so preserved bytes, partial escape sequences, and queried prior mode states reach entry without loss. Optional `CursorStyle`, probe timeout, and stderr-capture policy are also configured here. `Terminal::caps()` returns the resolved session capabilities. While the session is active, `Terminal::set_title` sets the window title safely and `Terminal::set_progress` reports `Progress::Value`, `Error`, `Indeterminate`, `Paused`, or `Clear`. Teardown clears both automatically.

## Detect terminal capabilities

`detect()` is the fast, environment-only path. `negotiate(timeout) -> (TerminalCaps, ProbeResults)` adds a bounded controlling-terminal probe; `ProbeResults::preserved_input` retains every non-probe byte in original order. `negotiate_async` performs the same work on Tokio's blocking pool. Prefer `Terminal::enter(TerminalOptions::default())` when capabilities are not needed beforehand: entry negotiates internally, completed key, mouse, paste, and focus events are ready on the first `read`, terminal responses remain internal, and partial sequences continue in the live pump's decoder.

When capabilities are needed before entry, pass both halves back with `TerminalOptions::new(caps).probe_results(probe)`. Keep the UI context and renderer aligned with `terminal.caps()` fields such as `graphics`, `sync_output`, `hyperlinks`, `cell_px`, and `inside_tmux`. `TerminalCaps` records terminal identity, selected graphics and notification protocols, keyboard support, pixel geometry, appearance, resize support, and multiplexer state; `TerminalCaps::resolve` applies probe results or an explicit graphics override.

The graphics detector recognizes these crate-specific overrides:

| Variable | Effect |
| --- | --- |
| `OMP_FORCE_IMAGE_PROTOCOL` | `kitty`, `iterm`/`iterm2`, or `sixel`; another nonempty value forces cell rendering |
| `OMP_TUI_CHARSET` | `ascii`, `unicode`, or `nerd` overrides the glyph tier inferred from the emulator |
| `OMP_NO_KITTY_PLACEHOLDERS` | A truthy value disables Kitty Unicode placeholders |
| `OMP_KITTY_PLACEHOLDERS` | A truthy or falsy value explicitly enables or disables placeholders |
| `OMP_NO_SYNC_OUTPUT` | Any nonempty value disables synchronized output |
| `OMP_SYNC_OUTPUT` | `1` enables and `0` disables synchronized output |
| `OMP_FORCE_SYNC_OUTPUT` | `1` enables synchronized output |
| `OMP_NO_HYPERLINKS` | `1` disables OSC 8 hyperlinks |
| `OMP_FORCE_HYPERLINKS` | `1` enables OSC 8 hyperlinks |

For placeholder overrides, truthy means `1`, `true`, `on`, `yes`, or `y`; falsy means `0`, `false`, `off`, `no`, or `n`, case-insensitively.

## Themes, glyphs, and appearance

Pass an explicit `UiContext` when the default theme or terminal capability tier is not appropriate:

```rust
# use omp_tui::{Charset, Color, Theme, Ui, UiContext, dom};
let context = UiContext {
    charset: Charset::Ascii,
    theme: Theme {
        accent: Color::Rgb(0x7c, 0x9c, 0xff),
        warn: Color::Rgb(0xff, 0xc8, 0x57),
        ..Theme::default()
    },
    ..UiContext::default()
};

let ui = Ui::from_root(dom! { <text fg=accent>{"portable"}</text> }, 40, context);
# let _ = ui;
```

`Charset::Unicode`, `NerdFont`, and `Ascii` change icons and structural glyphs without changing markup. When negotiation reports the background, `UiContext::with_terminal_caps` selects `Appearance::Dark` or `Appearance::Light` and the matching theme. `Terminal::appearance` returns the latest classification, and `Terminal::on_appearance_change` observes later terminal changes.

The context stays swappable after construction: `Ui::set_context` applies a new context to the retained tree and every stacked overlay, discarding cached themed output and relaying out — no rebuild, and widget state (scroll, selection, filter queries, animations) survives. `App` does this automatically when the terminal flips between dark and light: a stock palette follows the flip, a custom theme is preserved, and either way the host surfaces `AppEvent::Appearance` so the app can refresh colors it derived outside the theme. Structure parsed from markup is retained; swapping `elements` affects future parses only.

Named themes come from JSON files. `JsonTheme::parse` accepts omp's compact `dark`/`light` token patches or a rich `colors` palette (with `vars`), and `ThemeCatalog::load(explicit, dirs)` loads the files or directories an operator named (`--theme`; a broken one is an error) ahead of discovered theme directories (`<config root>/agent/themes`, `<project>/.omp/themes`; a broken one is a warning), keyed by file stem. `UiContext::with_palette(Some(theme))` selects the variant for the current appearance and remembers the theme, so a later `apply_appearance` re-selects its dark or light side instead of falling back to the stock palette; `with_palette(None)` returns to stock.

## Graphics protocols and images

`Graphics` selects one of five renderer paths:

- `Cells` decodes PNG or binary P6 PPM sources into colored half-block cells.
- `Sixel` materializes registered PNGs as DEC sixel images.
- `KittyPlaceholders` uses Kitty Unicode placeholder cells for registered images.
- `KittyDirect` uses cursor-positioned Kitty placements.
- `Iterm2` emits iTerm2 inline images.

`<img src=.../>` and `components::Img` always retain a cell fallback. For a protocol image, build `Img::kitty(id, rows, cols)` and register the same nonzero, 24-bit ID with `Renderer::register_image(id, png_bytes)`. Before first presentation, select `Renderer::set_graphics(caps.graphics)`, apply `caps.cell_px` with `set_cell_pixel_size`, and call `set_tmux_passthrough(caps.inside_tmux)`. The `companies` example shows the complete registration flow.

## Hyperlinks

Markdown links and autolinks carry hyperlink identity automatically. Rust-built rich text can attach a target with `Style::link(url)`. Hyperlink identities remain in the frame regardless of terminal support; `Renderer::set_hyperlinks(caps.hyperlinks)` controls whether they materialize as OSC 8 output. `OMP_NO_HYPERLINKS=1` and `OMP_FORCE_HYPERLINKS=1` override conservative detection.

## Notifications

Build a `Notification` and pass it with the detected capabilities to `notify`. Delivery selects Kitty OSC 99, OSC 9, or the terminal bell; the bell path can also use the Linux freedesktop notification service.

```rust,no_run
use std::io;

use omp_tui::{Notification, Urgency, detect, notify};

fn main() -> io::Result<()> {
    let caps = detect();
    let notification = Notification::builder()
        .title("Build complete")
        .body("All checks passed")
        .urgency(Urgency::Normal)
        .build();
    let mut out = io::stdout();
    notify(&mut out, &caps, &notification)
}
```

## Custom elements and components

Use a custom `Component` when a view needs behavior the built-ins do not provide. A component supplies properties, identity, measurement, height, painting, and optionally placement and input methods. Allocate its stable identity with `next_slot()`.

Unknown `dom!` tags become `CustomElement` instances. Register factories through `Elements::builder()` and place the resulting registry in `UiContext::elements`. This lets application markup use domain names such as `<build-summary>` while the factory returns an ordinary component tree.

Prefer composing built-ins before implementing `Component`; composition automatically inherits layout, focus routing, styling, conditional visibility, and incremental repaint behavior.

## Test without a terminal

`Ui` paints its initial `Frame` during construction, and input methods are terminal-independent. Most behavior tests need neither raw mode nor a real writer:

```rust
# use omp_tui::{Key, Ui, UiContext, UiEvent, dom};
let mut ui = Ui::from_root(
    dom! { <input id=query value="a"/> },
    20,
    UiContext::default(),
);

assert_eq!(ui.values()["query"], "a");
assert_eq!(ui.handle_key(Key::Char('b')), UiEvent::Changed {
    id:    "query".into(),
    value: "ab".into(),
});
assert_eq!(ui.values()["query"], "ab");
assert!(ui.frame().size().height > 0);
```

Test application outcomes and submitted values rather than builder plumbing. Use `Renderer<Vec<u8>>` only when the test specifically concerns emitted terminal bytes or differential painting.

## Debug a running app (`OMP_TTY` + `OMP_TUI_DEBUG`)

Two environment variables make a live application scriptable without a real
terminal:

- `OMP_TTY=<pty-slave-path>` reroutes every terminal open — input, rendered
  frames, capability probes — to that device. A harness holding the master
  side captures the exact byte stream a terminal would see. `SIGWINCH` does
  not reach an override device; set the window size with `TIOCSWINSZ` on the
  master and trigger the `resize` op below.
- `OMP_TUI_DEBUG=<unix-socket-path>` makes `Terminal::enter` start a server
  thread that binds a socket there and answers one JSON request per line.
  The wire speaks `TerminalEvent` directly: injected input rides the same
  mailbox as decoded terminal bytes, screen ops answer from the snapshot
  the renderer publishes on every paint, and retained-state ops ride the
  mailbox as `TerminalEvent::Debug` queries that an `App` answers from
  live retained state.

Each request is `{"op": ...}`; each response is one JSON line with `"ok"`:

| op | fields | effect |
| --- | --- | --- |
| `info` | | viewport, document height, window top, overlay summary |
| `text` | | the visible viewport as text — whatever was painted last, alternate screen included |
| `frame` | | the full document frame as text rows (`App` hosts) |
| `tree` | | component tree: kinds, `id`s, rectangles, visibility, focus, overlay bands (`App` hosts) |
| `values` | | `Ui::values()` of the base tree (`App` hosts) |
| `keys` | `keys` | inject decoded keys: `"tab C-a enter 'literal text'"` |
| `event` | `event` | inject serialized `TerminalEvent`s verbatim |
| `bytes` | `data` | feed raw bytes through the live input decoder |
| `paste` | `text` | inject a bracketed paste |
| `mouse` | `x`, `y`, `action` | inject a gesture (`click`, `drag`, `release`, `move`, `wheel-up`, ...) |
| `resize` | | re-read tty geometry, then run the normal resize/settle flow |
| `quit` | | inject `C-c`, the conventional quit chord |

Injected input lands in the ordinary event mailbox, so the host observes it
exactly like terminal input — quit chords, focus routing, and overlay
dismissal all apply. `frame`, `tree`, and `values` need a retained tree:
`App` hosts answer them through the same mailbox (`TerminalEvent::Debug` →
`omp_tui::respond_debug_query`), and the server times the request out for
hosts that ignore the query.

Inside this repository the `.omp/tools/tui.ts` agent tool wraps the whole
loop: it spawns an example or bin on a Bun-native PTY (a real controlling
terminal, so SIGWINCH resizes and immediate-mode hosts work) with
`OMP_TUI_DEBUG` set, then exposes screenshots, tree dumps, input injection,
resizes, and raw byte-stream statistics as one session-based tool.

## Common mistakes

- **Rebuilding after every event:** this resets retained widget state. Route events into the existing `Ui`.
- **Using bare text in `dom!`:** write `<text>{"hello"}</text>` or `<text>{value}</text>`. Bare implicit Markdown belongs to runtime markup.
- **Forgetting braces around Rust values:** `fg=color` means the literal string `"color"`; `fg={color}` evaluates the variable.
- **Using a data tag under the wrong owner:** `<option>` belongs under `<select>`, `<tab>` under `<tabs>`, and so on.
- **Treating construction-time `if` as reactive:** use `when=` for value-driven retained visibility.
- **Rebuilding on resize:** call `resize` and `set_height` so focus, selections, and scroll offsets survive.
- **Passing document rows to `handle_mouse`:** coordinates are viewport-local; pass terminal report rows directly.
- **Committing before delivery:** never mutate transcript history from geometry or after `plan` alone. Present the `WritePlan`, then pass the exact `Delivered` acknowledgement to `Slots::commit`.
- **Skipping terminal restoration:** enter through `Terminal`; its explicit `leave`, `Drop`, panic hook, and fatal-signal handlers restore the modes it owns.

## Run the bundled examples

```sh
cargo run -p omp-tui --example gallery
cargo run -p omp-tui --example chat
cargo run -p omp-tui --example companies
cargo run -p omp-tui --example footers
```

`gallery` is one tabbed application hosting every showcase pane: Markdown, Math, Mermaid, and Graphviz rendering, a `dom!`-built macro pane, a live editor-driven preview, the `Anim` prop-tween lab (autoplaying, with scene hotkeys), the `Overlay` modal demo (`Ctrl+K`/`Ctrl+G`), the fullscreen `Eclipse` shader, and the chat example's model `Picker` inline. It demonstrates `dom!`, retained updates, unclaimed-key routing (`AppEvent::Key`), mouse input, resize handling, and differential rendering in one compact application. `elastic-slots` is the inline transcript proof: it delivers finalized rows through `WritePlan`, keeps live assistant/composer blocks in the viewport, rebuilds on width resize, and exits cleanly on Ctrl-C.
