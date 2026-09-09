# Build terminal UI

Extensions describe terminal UI with typed Python values and TML markup. You send a document or a small mutation to omp; the TUI owns layout, theme resolution, focus, and terminal output. Reach for `omp.ui` when you need to present device results, alter transcript rendering, add a command or key binding, mount persistent chrome, or ask the attached user for input.

```python
from omp import ui

card = ui.tml(
    "<box border=round title='Extension'><text fg=accent>{message}</text></box>",
    message="Ready",
)
ui.mount(ui.Slot.ABOVE_EDITOR, card, key="extension-ready")
ui.notify("Extension loaded", level=ui.Level.INFO)
```

For the complete API, see the [`omp.ui` reference](../reference/omp.ui.md).

## Think in retained documents

TML is a markup document, not a terminal frame. You declare rows, boxes, text, icons, and semantic colors instead of calculating cell coordinates or writing ANSI sequences. The TUI parses the document into its retained component tree and redraws it when its own state changes.

Build markup with the escaping helpers:

```python
from omp import ui

branch = "feature/<cleanup>"  # The angle brackets must remain text.
summary = ui.tml(
    "<row gap=1>{icon}<text bold>{branch}</text></row>",
    icon=ui.icon("git", fg=ui.Token.ACCENT),
    branch=branch,
)
```

A `Tml` field is inserted as markup. Strings and other ordinary field values are cleaned and escaped. Use `ui.text(value)` for literal content, `ui.md(source)` for authored Markdown, `ui.join(nodes, sep)` for composition, and `Tml.raw(source)` only when you intentionally generate the wire markup yourself.

> **Warning** Do not interpolate external strings into a raw TML source. Put them in `tml` fields or pass them through `text` so they cannot become tags.

TML construction checks document structure immediately. `TmlError` reports the message, byte offset, and rejected source. The protocol also bounds a document to `ui.limits.TML_MAX_BYTES` bytes and `ui.limits.TML_MAX_DEPTH` nested tags.

### Update retained content

Mounts and overlays have stable handles. Replace the complete document with `set`, or target an element's `id` with `patch`:

```python
panel = ui.mount(
    ui.Slot.SIDEBAR_RIGHT,
    ui.tml("<box title='Build'><text id=status>Starting</text></box>"),
    ui.SlotOptions(width=32, min_width=20, title="Build"),
    key="build-panel",
)

panel.patch("status", text="Running tests")
panel.visible = False
panel.visible = True
panel.unmount()
```

The handle sends mutations; it is not a local widget tree. Keep ids stable when you want to patch retained elements. Use distinct mount keys for independent contributions.

## Recipe: render a device result

A device renderer is a synchronous fold over the device's `View` and a `RenderCtx`. Declare it with the device's exact name, family, and revision. Return `Tml` to replace native rendering, or `None` to let the native renderer handle the view.

```python
import omp
from omp import ui


def fold_download(total: int | None, update: object) -> int:
    # This example's device emits update objects with a byte_count attribute.
    return (total or 0) + update.byte_count


@omp.renderer(
    "download",
    family="network",
    rev=1,
    reduce=fold_download,
)
def render_download(view: omp.View, ctx: ui.RenderCtx) -> ui.Tml | None:
    if view.state is None:
        return None
    return ui.tml(
        "<row gap=1><ico:download/><text>{bytes} bytes</text></row>",
        bytes=view.state,
    )
```

`reduce` is optional. When supplied, omp folds each update into `view.state` before calling your renderer and clears the update sequence presented to the renderer. Without it, inspect `view.updates` directly. Set `decorates=True` when your result should augment the winning base renderer rather than replace it.

The decorator's full signature is:

```python
def renderer(
    name: str,
    *,
    family: str | None = None,
    rev: int | None = None,
    reduce: Callable[[object, object], object] | None = None,
    decorates: bool = False,
) -> Callable[[Callable[..., Tml | None]], Callable[..., Tml | None]]:
    ...
```

If exactly one declared device has `name`, omitted `family` or `rev` is filled from that declaration. Prefer explicit identity in reusable packages. A second renderer for the same frozen identity raises `DuplicateRenderer`; it is also available as `omp.DuplicateRenderer`.

Renderer callbacks must be synchronous and deterministic. The host catches callback errors, invalid return values, and missing registrations, then uses its fallback presentation. `RenderCtx` gives you width, charset, appearance, graphics support, hyperlink support, focus and collapsed state, render place, and an immutable presentation snapshot. Use TML layout instead of turning `ctx.width` into manual padding.

See [Devices](devices.md) for declaring the device and [`omp.verdicts`](../reference/verdicts.md) for `View`, verdicts, and update folds.

## Customize transcript messages

A message renderer handles transcript entries that do not use a device `View`. The callback receives a read-only `MessageView` and `RenderCtx`:

```python
import omp
from omp import ui

@omp.message_renderer("notice")
def render_notice(message: ui.MessageView, ctx: ui.RenderCtx) -> ui.Tml | None:
    if not message.text:
        return None
    return ui.tml(
        "<callout icon=info fg=info>{body}</callout>",
        body=ui.md(message.text),
    )
```

`MessageView` contains the stable message `id`, its `kind`, an optional conversational `role`, original display `text`, and an immutable `presentation` mapping. The class and decorator are available both as `omp.MessageView` / `omp.message_renderer` and under `omp.ui`.

Returning `None`, raising, or returning a value other than `Tml` selects built-in rendering. Keep the fold synchronous: it runs as a rendering projection, not as an async request handler.

### Transform assistant Markdown

A Markdown transformer rewrites settled assistant Markdown before parsing. It must synchronously return a string:

```python
import omp

@omp.markdown_transformer("normalize-product-name")
def normalize_product_name(markdown: str) -> str:
    return markdown.replace("OhMyPi", "Oh My Pi")
```

Transformers fail open to the incoming Markdown when they raise or return a non-string. Use them for deterministic text transformations. Do not perform network, filesystem, clock, or mutable-global work inside the callback.

## Recipe: add a slash command and shortcut

Commands receive an `Invocation`; their return value says whether to consume the invocation or send text to the composer/model. Keep one slot handle so the command and shortcut share explicit extension state:

```python
import omp
from omp import ui

_help_panel: ui.SlotHandle | None = None


def set_help_panel(visible: bool) -> None:
    global _help_panel
    if visible and _help_panel is None:
        _help_panel = ui.mount(
            ui.Slot.SIDEBAR_RIGHT,
            ui.tml("<box title='Help'><md>Press `Ctrl+Alt+H` to close.</md></box>"),
            ui.SlotOptions(width=30, min_width=18),
            key="help-panel",
        )
    elif not visible and _help_panel is not None:
        _help_panel.unmount()
        _help_panel = None


@omp.command(
    "help-panel",
    aliases=("hp",),
    description="Toggle the extension help panel",
    hint="[show|hide]",
)
async def help_panel(inv: ui.Invocation, ctx: omp.Context) -> ui.CommandResult | None:
    requested = inv.argv[0] if inv.argv else "toggle"
    visible = requested == "show" or (requested == "toggle" and _help_panel is None)
    set_help_panel(visible)
    return ui.Consumed(ui.text("Help panel shown" if visible else "Help panel hidden"))


@omp.shortcut(
    "ctrl+alt+h",
    action_id="toggle-help-panel",
    description="Toggle the extension help panel",
    when=frozenset({ui.Phase.IDLE, ui.Phase.WORKING}),
)
async def toggle_help_panel(action: ui.Action, ctx: omp.Context) -> None:
    set_help_panel(_help_panel is None)
```

> **Note** Chords are normalized to modifier order and lowercase. A chord uses zero or more of `ctrl`, `alt`, `shift`, and `super`, followed by one printable character or a named key such as `enter`, `escape`, an arrow, or `f1` through `f24`.

`@omp.command` and `@omp.shortcut` are aliases of `omp.ui.command` and `omp.ui.shortcut`. Command handlers may return `None`, `Consumed`, or `Prompt`. `Prompt(text, submit=True)` submits text; `submit=False` places it in the composer. Shortcuts do not return a command result.

The exact declaration signatures are:

```python
def command(
    name: str,
    *,
    aliases: Sequence[str] = (),
    description: str = "",
    args: Sequence[Arg] = (),
    hint: str | None = None,
    arg_completions: Callable[..., object] | None = None,
) -> Callable[[Callable[..., object]], Callable[..., object]]:
    ...

def shortcut(
    chord: str,
    *,
    action_id: str | None = None,
    description: str = "",
    when: frozenset[Phase] | None = None,
) -> Callable[[Callable[..., object]], Callable[..., object]]:
    ...
```

Declare static argument rows with `Arg`. For dynamic candidates, pass an argument completer that accepts `ArgQuery` and the callback context, and returns `CompletionItem` values. Use `await ui.dynamic_mount(...)` only for commands discovered after the static declaration table was frozen.

## Status, work, and attention

Use the narrowest effect for the job:

```python
from omp import ui

ui.set_status(
    "sync",
    ui.tml("<segment fg=info>{label}</segment>", label="Syncing"),
    order=20,
    side=ui.Slot.STATUS_RIGHT,
)
ui.set_working_message(ui.text("Indexing workspace"))
ui.set_working_indicator((".", "..", "..."), interval_ms=180)
ui.set_progress(ui.Progress.value(35))
ui.notify("Index complete", level=ui.Level.INFO, title="Indexer")
ui.set_progress(ui.Progress.clear())
ui.set_working_indicator(())
ui.set_working_message(None)
```

`set_status` manages a keyed contribution in the left or right status area. Passing `None` clears that contribution. `set_working_message` changes the work banner. `set_working_indicator` accepts at most eight string frames; an empty tuple hides it. `Progress` provides `clear`, `value`, `error`, `indeterminate`, and `paused` constructors for the terminal taskbar state.

Notifications accept plain text or TML, a severity, optional title, and optional desktop sound and urgency settings. These calls enqueue fail-open effects synchronously: do not `await` them. Use `bell()` only when an attention signal is justified, and `set_title()` for terminal-window title state.

## Ask for input without owning the terminal

Dialog helpers return a `DialogOutcome` instead of a raw widget. Check `cancelled` and then read the result field appropriate to the request:

```python
from omp import ui

outcome = await ui.select(
    "Deployment target",
    (
        ui.SelectItem("staging", "Staging", desc="Shared test environment"),
        ui.SelectItem("production", "Production", recommended=True),
    ),
)
if not outcome.cancelled:
    ui.notify(f"Selected {outcome.value}", level=ui.Level.INFO)
```

Use `confirm`, `select`, `multi_select`, `input`, `editor`, `form`, or `ask_user` for native interactions. Use `overlay` when you need a retained custom TML surface, and close its `OverlayHandle` with `async with` when possible. A missing presentation client makes `overlay` raise `DialogUnavailable`; the native dialog helpers instead decode an unavailable outcome.

## Read presentation state only when necessary

`await ui.presentation()` reports the attached client's charset, appearance, dimensions, graphics mode, hyperlink support, and `has_ui`. If no valid host response exists, it returns the no-UI defaults. Most content should remain responsive through TML layout and semantic tokens without querying this object.

Use `ui.Token` names rather than hard-coded colors, and use `ui.icon(name)` rather than selecting a glyph. The same document can then adapt to Unicode, Nerd Font, or ASCII presentations and dark or light themes.
