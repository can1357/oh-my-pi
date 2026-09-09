# `omp.ui`

Use `omp.ui` to describe terminal markup, project recorded values into transcript UI, mount retained surfaces, register commands and shortcuts, and send presentation effects. UI output stays data-only: Python constructs `Tml` and typed payloads, while the attached host decides how to lay them out and display them.

```python
from omp import ui

content = ui.tml(
    "<row gap=1>{icon}<text fg=accent>{label}</text></row>",
    icon=ui.icon("check"),
    label="Ready",
)
ui.mount(ui.Slot.ABOVE_EDITOR, content, key="ready")
```

The declaration helpers `renderer`, `message_renderer`, `markdown_transformer`, `command`, and `shortcut` are also exported from top-level `omp`. So are `DuplicateRenderer` and `MessageView`. This page uses `omp.ui` spellings consistently. See [Build terminal UI](../guides/ui.md) for a worked introduction.

## Errors

### `omp.ui.TmlError`

```python
TmlError(message: str, at: int, source: str)
```

Reports structurally invalid TML before an effect reaches the renderer.

| Attribute | Type | Meaning |
| --- | --- | --- |
| `message` | `str` | Validation diagnostic. |
| `at` | `int` | UTF-8 byte offset associated with the error. |
| `source` | `str` | Rejected source document. |

This exception subclasses both `ValueError` and `omp.OmpError`.

### `omp.ui.SlotDenied`

```python
class SlotDenied(PermissionError, OmpError):
    ...
```

Indicates that the extension cannot mount into the requested slot.

### `omp.ui.CommandDenied`

```python
class CommandDenied(PermissionError, OmpError):
    ...
```

Indicates that a command registration or dispatch is not allowed. The local dispatcher also uses it for an unknown command name.

### `omp.ui.ShortcutError`

```python
class ShortcutError(ValueError, OmpError):
    ...
```

Reports an invalid or unavailable key chord. Shortcut syntax is checked when the decorator is evaluated.

### `omp.ui.TerminalInputDenied`

```python
class TerminalInputDenied(PermissionError, OmpError):
    ...
```

Reports a raw-input subscription without the required grant, interactive host, or exclusive focus lease.

### `omp.ui.DialogUnavailable`

```python
class DialogUnavailable(RuntimeError, OmpError):
    ...
```

Raised by [`overlay`](#ompuioverlay) when no presentation client returns an overlay identity.

### `omp.ui.DuplicateRenderer`

```python
DuplicateRenderer(name: str, holder: str, claimant: str | None = None)
```

Reports a second renderer for the same device identity.

| Attribute | Type | Meaning |
| --- | --- | --- |
| `name` | `str` | Conflicting renderer key, passed to the base registration error. |
| `holder` | `str` | Existing renderer's qualified name when available. |
| `claimant` | `str | None` | New renderer's qualified name when available. |

Top-level `omp.DuplicateRenderer` is the same class.

## Markup

### `omp.ui.Tml`

```python
Tml(_source: str)
```

Stores an immutable, already validated TML source document. Prefer the construction helpers below; use `Tml.raw` when you intentionally have markup source.

| Member | Signature | Meaning |
| --- | --- | --- |
| `source` | `@property def source(self) -> str` | Returns the validated wire-format string. |
| `raw` | `@classmethod def raw(cls, source: str) -> Tml` | Validates a string and constructs `Tml`. |

**Raises**

`Tml.raw` raises `TypeError` unless `source` is a string, and [`TmlError`](#ompuitmlerror) when size, depth, or tag structure is invalid.

```python
node = ui.Tml.raw("<text fg=info>Connected</text>")
```

### `omp.ui.text`

```python
def text(value: object) -> Tml:
    ...
```

Creates a literal `<text>` leaf. The helper stringifies `value`, removes control characters other than tab, escapes backslashes, and prevents `<` from starting a tag.

**Parameters**

`value` (`object`) is the value to display literally.

**Returns**

A validated [`Tml`](#ompuitml) document.

```python
safe_name = ui.text(remote_record.name)
```

### `omp.ui.md`

```python
def md(source: object) -> Tml:
    ...
```

Creates an `<md>` leaf while retaining Markdown syntax. Control characters are removed and `<` is escaped.

**Parameters**

`source` (`object`) is stringified as Markdown source.

**Returns**

A validated [`Tml`](#ompuitml) document.

### `omp.ui.tml`

```python
def tml(template: str, /, **fields: object) -> Tml:
    ...
```

Builds TML from a format template with safe field substitution.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `template` | `str` | Positional-only TML template using `{name}` fields. |
| `**fields` | `object` | Values inserted into named fields. |

A `Tml` value is inserted as markup. A sequence of `Tml` values is concatenated. Strings are escaped; a sequence containing only strings is escaped and joined with spaces. Other values are stringified and escaped. Format conversions and format specifications are not supported.

**Returns**

The assembled, validated document.

**Raises**

| Exception | Condition |
| --- | --- |
| `ValueError` | A field uses a conversion or format specification. |
| `KeyError` | A named field is missing. |
| [`TmlError`](#ompuitmlerror) | The assembled document fails validation. |

```python
row = ui.tml("<row>{icon}<text>{name}</text></row>", icon=ui.icon("user"), name=user_name)
```

### `omp.ui.join`

```python
def join(parts: Iterable[Tml], sep: Tml | str = "") -> Tml:
    ...
```

Joins validated documents. A string separator is converted with [`text`](#ompuitext); a `Tml` separator is inserted as markup.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `parts` | `Iterable[Tml]` | Documents to combine. |
| `sep` | `Tml | str` | Markup or literal-text separator. |

**Returns**

One validated `Tml` document.

### `omp.ui.icon`

```python
def icon(name: str, *, fg: str | None = None) -> Tml:
    ...
```

Builds an icon node without selecting a terminal glyph.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `name` | `str` | Catalog icon name. |
| `fg` | `str | None` | Optional foreground token or color. |

**Returns**

`<ico:name/>` when `fg` is omitted, otherwise an `<icon>` node carrying `icon` and `fg` properties.

## Presentation enums

### `omp.ui.Token`

```python
class Token(StrEnum):
    ...
```

Names semantic theme colors.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `FG` | `"fg"` | Default foreground. |
| `ACCENT` | `"accent"` | Accent emphasis. |
| `INFO` | `"info"` | Informational content. |
| `OK` | `"ok"` | Successful content. |
| `WARN` | `"warn"` | Warning content. |
| `ERR` | `"err"` | Error content. |
| `MUTED` | `"muted"` | De-emphasized text. |
| `BORDER` | `"border"` | Standard edge color. |
| `SURFACE` | `"surface"` | Base surface. |
| `HOVER` | `"hover"` | Hover state. |
| `SELECTION` | `"selection"` | Selection state. |
| `SHADOW` | `"shadow"` | Shadow treatment. |
| `PANEL` | `"panel"` | Panel surface. |
| `SECONDARY` | `"secondary"` | Secondary content. |
| `CONTRAST` | `"contrast"` | High-contrast content. |

### `omp.ui.Charset`

```python
class Charset(StrEnum):
    ...
```

Identifies the glyph tier chosen by the presentation.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `UNICODE` | `"unicode"` | Standard Unicode glyphs. |
| `NERD_FONT` | `"nerd"` | Nerd Font glyph catalog. |
| `ASCII` | `"ascii"` | ASCII-only fallback. |

### `omp.ui.Appearance`

```python
class Appearance(StrEnum):
    ...
```

Describes terminal background appearance.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `DARK` | `"dark"` | Dark background. |
| `LIGHT` | `"light"` | Light background. |

### `omp.ui.Graphics`

```python
class Graphics(StrEnum):
    ...
```

Identifies the image protocol available to the client.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `CELLS` | `"cells"` | Cell-rendered fallback. |
| `SIXEL` | `"sixel"` | Sixel graphics. |
| `KITTY_PLACEHOLDERS` | `"kitty_placeholders"` | Kitty placeholder transport. |
| `KITTY_DIRECT` | `"kitty_direct"` | Direct Kitty graphics. |
| `ITERM2` | `"iterm2"` | iTerm2 image protocol. |

### `omp.ui.Slot`

```python
class Slot(StrEnum):
    ...
```

Names layout-owned mount locations.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `STATUS_LEFT` | `"status_left"` | Left status band. |
| `STATUS_RIGHT` | `"status_right"` | Right status band. |
| `HEADER` | `"header"` | Header band. |
| `FOOTER` | `"footer"` | Footer band. |
| `ABOVE_EDITOR` | `"above_editor"` | Composer content above the editor. |
| `BELOW_EDITOR` | `"below_editor"` | Composer content below the editor. |
| `SIDEBAR_LEFT` | `"sidebar_left"` | Left rail. |
| `SIDEBAR_RIGHT` | `"sidebar_right"` | Right rail. |

### `omp.ui.Collapse`

```python
class Collapse(StrEnum):
    ...
```

Selects a mount's response to insufficient viewport space.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `HIDE` | `"hide"` | Remove the mount. |
| `TRUNCATE` | `"truncate"` | Clip its content. |
| `SHRINK` | `"shrink"` | Reduce its allocation. |

### `omp.ui.Phase`

```python
class Phase(StrEnum):
    ...
```

Represents the user-visible agent phase used by slots, shortcuts, and actions.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `IDLE` | `"idle"` | No active work. |
| `WORKING` | `"working"` | Work is running. |
| `WAITING` | `"waiting"` | Waiting for an external decision or result. |
| `ERROR` | `"error"` | Error presentation. |

### `omp.ui.Level`

```python
class Level(StrEnum):
    ...
```

Classifies notification severity.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `DEBUG` | `"debug"` | Diagnostic detail. |
| `INFO` | `"info"` | Informational notice. |
| `WARN` | `"warn"` | Warning notice. |
| `WARNING` | `"warn"` | Alias of `WARN`. |
| `ERROR` | `"error"` | Error notice. |

Constructing `Level("warning")` also resolves to `WARN`.

### `omp.ui.Urgency`

```python
class Urgency(StrEnum):
    ...
```

Sets desktop-notification urgency.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `LOW` | `"low"` | Low urgency. |
| `NORMAL` | `"normal"` | Default urgency. |
| `CRITICAL` | `"critical"` | Critical urgency. |

### `omp.ui.Sound`

```python
class Sound(StrEnum):
    ...
```

Selects a client notification sound category.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `SILENT` | `"silent"` | No sound. |
| `SYSTEM` | `"system"` | Client system default. |
| `INFO` | `"info"` | Informational cue. |
| `WARNING` | `"warning"` | Warning cue. |
| `ERROR` | `"error"` | Error cue. |
| `QUESTION` | `"question"` | Question cue. |

### `omp.ui.Anchor`

```python
class Anchor(StrEnum):
    ...
```

Selects the point used to place an overlay.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `CENTER` | `"center"` | Center. |
| `TOP_LEFT` | `"top_left"` | Upper-left corner. |
| `TOP` | `"top"` | Top edge. |
| `TOP_RIGHT` | `"top_right"` | Upper-right corner. |
| `RIGHT` | `"right"` | Right edge. |
| `BOTTOM_RIGHT` | `"bottom_right"` | Lower-right corner. |
| `BOTTOM` | `"bottom"` | Bottom edge. |
| `BOTTOM_LEFT` | `"bottom_left"` | Lower-left corner. |
| `LEFT` | `"left"` | Left edge. |

### `omp.ui.ActivationSource`

```python
class ActivationSource(StrEnum):
    ...
```

Identifies how an id-bearing transcript element was activated.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `KEY` | `"key"` | Keyboard activation. |
| `MOUSE` | `"mouse"` | Pointer activation. |

### `omp.ui.EventKind`

```python
class EventKind(StrEnum):
    ...
```

Classifies watched retained-overlay interactions.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `HIGHLIGHTED` | `"highlighted"` | Highlight moved. |
| `CHANGED` | `"changed"` | Value changed. |
| `FILTERED` | `"filtered"` | Filter query changed. |
| `PRESSED` | `"pressed"` | Control was pressed. |
| `SUBMIT` | `"submit"` | Overlay submitted. |
| `CANCEL` | `"cancel"` | Overlay cancelled. |

### `omp.ui.DialogCancel`

```python
class DialogCancel(StrEnum):
    ...
```

Explains why a dialog outcome was cancelled.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `DISMISSED` | `"dismissed"` | User dismissed the dialog. |
| `TIMED_OUT` | `"timed_out"` | Deadline elapsed. |
| `UNAVAILABLE` | `"unavailable"` | No valid dialog response was available. |
| `SUPERSEDED` | `"superseded"` | Another presentation replaced it. |

### `omp.ui.InvocationMode`

```python
class InvocationMode(StrEnum):
    ...
```

Identifies the client mode that invoked a command.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `INTERACTIVE` | `"interactive"` | Interactive presentation. |
| `HEADLESS` | `"headless"` | No interactive TUI. |
| `RPC` | `"rpc"` | External RPC client. |

### `omp.ui.RenderPlace`

```python
class RenderPlace(StrEnum):
    ...
```

Names the surface requesting a renderer fold.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `TRANSCRIPT` | `"transcript"` | Transcript entry. |
| `OVERLAY` | `"overlay"` | Retained overlay. |
| `SLOT` | `"slot"` | Mounted slot. |
| `EXPORT` | `"export"` | Export projection. |

### `omp.ui.Marker`

```python
class Marker(StrEnum):
    ...
```

Selects native choice-dialog markers.

| Member | Wire value | Meaning |
| --- | --- | --- |
| `RADIO` | `"radio"` | Single-choice marker. |
| `CHECKBOX` | `"checkbox"` | Multi-choice marker. |

## Data models

All dataclasses in this section are frozen and use slots unless stated otherwise.

### `omp.ui.StatusFacts`

```python
StatusFacts(
    model: str,
    context_tokens: int,
    context_window: int,
    cost_usd: float,
    total_tokens: int,
    tokens_per_second: float,
    dropped: int = 0,
)
```

Carries session facts used by retained status chrome.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | `str` | required | Active model. |
| `context_tokens` | `int` | required | Current context usage. |
| `context_window` | `int` | required | Context capacity. |
| `cost_usd` | `float` | required | Accumulated cost in USD. |
| `total_tokens` | `int` | required | Total tokens. |
| `tokens_per_second` | `float` | required | Current throughput. |
| `dropped` | `int` | `0` | Dropped-item count. |

### `omp.ui.Margin`

```python
Margin(top: int = 0, right: int = 0, bottom: int = 0, left: int = 0)
```

Specifies viewport-edge insets.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `top` | `int` | `0` | Top inset. |
| `right` | `int` | `0` | Right inset. |
| `bottom` | `int` | `0` | Bottom inset. |
| `left` | `int` | `0` | Left inset. |

### `omp.ui.Pct`

```python
Pct(value: int)
```

Represents a percentage viewport dimension.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `value` | `int` | required | Percentage value. |

### `omp.ui.Progress`

```python
Progress(kind: str, pct: int | None = None)
```

Represents terminal taskbar progress.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | `str` | required | Progress state name. |
| `pct` | `int | None` | `None` | Associated percentage, when the state uses one. |

| Constructor | Signature | Result |
| --- | --- | --- |
| `clear` | `Progress.clear() -> Progress` | `kind="clear"`. |
| `value` | `Progress.value(pct: int) -> Progress` | Normal percentage. |
| `error` | `Progress.error(pct: int) -> Progress` | Error percentage. |
| `indeterminate` | `Progress.indeterminate() -> Progress` | Unknown completion. |
| `paused` | `Progress.paused(pct: int) -> Progress` | Paused percentage. |

### `omp.ui.Presentation`

```python
Presentation(
    charset: Charset = Charset.UNICODE,
    appearance: Appearance = Appearance.DARK,
    width: int = 0,
    height: int = 0,
    graphics: Graphics = Graphics.CELLS,
    hyperlinks: bool = False,
    has_ui: bool = False,
)
```

Describes the current client presentation. The defaults are the no-UI fallback.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `charset` | `Charset` | `Charset.UNICODE` | Glyph tier. |
| `appearance` | `Appearance` | `Appearance.DARK` | Background appearance. |
| `width` | `int` | `0` | Width in cells. |
| `height` | `int` | `0` | Height in cells. |
| `graphics` | `Graphics` | `Graphics.CELLS` | Image protocol. |
| `hyperlinks` | `bool` | `False` | Whether hyperlinks can be presented. |
| `has_ui` | `bool` | `False` | Whether an interactive UI is attached. |

### `omp.ui.RenderCtx`

```python
RenderCtx(
    width: int,
    charset: Charset,
    appearance: Appearance,
    graphics: Graphics,
    hyperlinks: bool,
    focused: bool,
    collapsed: bool,
    place: RenderPlace,
    presentation: Mapping[str, object] = field(default_factory=lambda: _EMPTY_PRESENTATION),
)
```

Supplies read-only presentation inputs to renderer folds.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `width` | `int` | required | Available width in cells. |
| `charset` | `Charset` | required | Active glyph tier. |
| `appearance` | `Appearance` | required | Dark or light appearance. |
| `graphics` | `Graphics` | required | Image protocol. |
| `hyperlinks` | `bool` | required | Hyperlink support. |
| `focused` | `bool` | required | Whether this subtree is focused. |
| `collapsed` | `bool` | required | Whether this item is collapsed. |
| `place` | `RenderPlace` | required | Requesting surface. |
| `presentation` | `Mapping[str, object]` | empty mapping | Host-provided presentation snapshot. |

The constructor copies `presentation` into a read-only mapping.

### `omp.ui.MessageView`

```python
MessageView(
    id: str,
    kind: str,
    role: str | None,
    text: str,
    presentation: Mapping[str, object] = field(default_factory=lambda: _EMPTY_PRESENTATION),
)
```

Carries one transcript message into a message-renderer fold.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | `str` | required | Stable message identity. |
| `kind` | `str` | required | Message kind used for renderer dispatch. |
| `role` | `str | None` | required | Conversational role when present. |
| `text` | `str` | required | Original display text. |
| `presentation` | `Mapping[str, object]` | empty mapping | Read-only host presentation snapshot. |

The constructor freezes a copy of `presentation`. Top-level `omp.MessageView` is the same class.

### `omp.ui.SlotOptions`

```python
SlotOptions(
    order: int = 100,
    width: int | None = None,
    min_width: int = 0,
    min_height: int = 0,
    max_height: int | None = None,
    visible_in: frozenset[Phase] = frozenset(Phase),
    focusable: bool = False,
    collapse: Collapse = Collapse.HIDE,
    title: str | None = None,
)
```

Configures responsive placement of a slot mount.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `order` | `int` | `100` | Ordering among contributions. |
| `width` | `int | None` | `None` | Preferred width. |
| `min_width` | `int` | `0` | Minimum width. |
| `min_height` | `int` | `0` | Minimum height. |
| `max_height` | `int | None` | `None` | Maximum height. |
| `visible_in` | `frozenset[Phase]` | all phases | Phases in which the mount is visible. |
| `focusable` | `bool` | `False` | Whether the slot can accept focus. |
| `collapse` | `Collapse` | `Collapse.HIDE` | Small-viewport behavior. |
| `title` | `str | None` | `None` | Host-visible title. |

### `omp.ui.OverlayOptions`

```python
OverlayOptions(
    width: int | Pct | None = None,
    min_width: int | None = None,
    max_height: int | Pct | None = None,
    anchor: Anchor = Anchor.CENTER,
    offset_x: int = 0,
    offset_y: int = 0,
    row: int | Pct | None = None,
    col: int | Pct | None = None,
    margin: Margin = Margin(),
    z: int = 0,
    min_viewport: tuple[int, int] = (0, 0),
    modal: bool = True,
    fill_height: bool = False,
)
```

Configures viewport-relative overlay placement.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `width` | `int | Pct | None` | `None` | Width in cells or percent. |
| `min_width` | `int | None` | `None` | Minimum width. |
| `max_height` | `int | Pct | None` | `None` | Height ceiling. |
| `anchor` | `Anchor` | `Anchor.CENTER` | Placement anchor. |
| `offset_x` | `int` | `0` | Horizontal offset. |
| `offset_y` | `int` | `0` | Vertical offset. |
| `row` | `int | Pct | None` | `None` | Explicit row. |
| `col` | `int | Pct | None` | `None` | Explicit column. |
| `margin` | `Margin` | `Margin()` | Viewport insets. |
| `z` | `int` | `0` | Relative layer. |
| `min_viewport` | `tuple[int, int]` | `(0, 0)` | Minimum viewport dimensions. |
| `modal` | `bool` | `True` | Whether the overlay is modal. |
| `fill_height` | `bool` | `False` | Whether to fill available height. |

### `omp.ui.DialogOptions`

```python
DialogOptions(
    timeout: Any | None = None,
    timeout_starts_on_present: bool = True,
    countdown: bool = True,
    initial: int = 0,
    marker: Marker | None = None,
    help: str | None = None,
    overlay: OverlayOptions | None = None,
    context: Tml | None = None,
)
```

Supplies options shared by native dialog helpers.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `timeout` | `Any | None` | `None` | Host-understood timeout value. |
| `timeout_starts_on_present` | `bool` | `True` | Start timing after presentation. |
| `countdown` | `bool` | `True` | Show timeout countdown. |
| `initial` | `int` | `0` | Initial selected index. |
| `marker` | `Marker | None` | `None` | Choice marker style. |
| `help` | `str | None` | `None` | Help text. |
| `overlay` | `OverlayOptions | None` | `None` | Overlay placement override. |
| `context` | `Tml | None` | `None` | Additional markup context. |

### `omp.ui.SelectItem`

```python
SelectItem(
    value: str,
    label: str | None = None,
    desc: str | None = None,
    preview: Tml | None = None,
    cells: tuple[str, ...] = (),
    recommended: bool = False,
    group: str | None = None,
)
```

Describes one typed choice in a dialog or picker.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `value` | `str` | required | Returned value. |
| `label` | `str | None` | `None` | Display label. |
| `desc` | `str | None` | `None` | Supporting description. |
| `preview` | `Tml | None` | `None` | Preview markup. |
| `cells` | `tuple[str, ...]` | `()` | Additional display cells. |
| `recommended` | `bool` | `False` | Preferred choice hint. |
| `group` | `str | None` | `None` | Group label. |

### `omp.ui.Field`

```python
Field(
    id: str,
    kind: str,
    label: str,
    desc: str | None = None,
    value: object | None = None,
    options: tuple[SelectItem, ...] = (),
    min: int | None = None,
    max: int | None = None,
    step: int | None = None,
    required: bool = False,
    match: str | None = None,
)
```

Declares one native form field.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | `str` | required | Result-map key. |
| `kind` | `str` | required | Host field kind. |
| `label` | `str` | required | Display label. |
| `desc` | `str | None` | `None` | Supporting description. |
| `value` | `object | None` | `None` | Initial value. |
| `options` | `tuple[SelectItem, ...]` | `()` | Choice rows. |
| `min` | `int | None` | `None` | Minimum numeric value. |
| `max` | `int | None` | `None` | Maximum numeric value. |
| `step` | `int | None` | `None` | Numeric increment. |
| `required` | `bool` | `False` | Whether a value is required. |
| `match` | `str | None` | `None` | Host validation pattern. |

### `omp.ui.OverlayEvent`

```python
OverlayEvent(
    kind: EventKind,
    id: str | None = None,
    value: str | None = None,
    query: str | None = None,
    values: dict[str, object] = field(default_factory=dict),
)
```

Carries one watched overlay interaction.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | `EventKind` | required | Interaction kind. |
| `id` | `str | None` | `None` | Element identity. |
| `value` | `str | None` | `None` | Element value. |
| `query` | `str | None` | `None` | Filter query. |
| `values` | `dict[str, object]` | new empty dict | Current value snapshot. |

### `omp.ui.DialogOutcome`

```python
DialogOutcome(
    cancelled: bool,
    reason: DialogCancel | None = None,
    confirmed: bool = False,
    value: str | None = None,
    values: tuple[str, ...] = (),
    fields: dict[str, object] = field(default_factory=dict),
    answers: tuple[AskAnswer, ...] = (),
    elapsed: Any | None = None,
)
```

Represents every decoded dialog result, including cancellation and unavailability.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cancelled` | `bool` | required | Whether no accepted result exists. |
| `reason` | `DialogCancel | None` | `None` | Cancellation cause. |
| `confirmed` | `bool` | `False` | Confirmation result. |
| `value` | `str | None` | `None` | Single returned value. |
| `values` | `tuple[str, ...]` | `()` | Multiple returned values. |
| `fields` | `dict[str, object]` | new empty dict | Form values. |
| `answers` | `tuple[AskAnswer, ...]` | `()` | Ask-user answers. |
| `elapsed` | `Any | None` | `None` | Elapsed value when supplied directly; the dialog decoder currently leaves it as `None`. |

`bool(outcome)` is true only when the outcome is not cancelled and is confirmed.

### `omp.ui.AskQuestion`

```python
AskQuestion(
    id: str,
    question: str,
    header: str | None = None,
    context: Tml | None = None,
    options: tuple[SelectItem, ...] = (),
    multi: bool = False,
    allow_freeform: bool = True,
    allow_note: bool = False,
    recommended: str | None = None,
)
```

Describes one question in an ask-user dialog.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | `str` | required | Stable question identity. |
| `question` | `str` | required | Prompt text. |
| `header` | `str | None` | `None` | Short heading. |
| `context` | `Tml | None` | `None` | Supporting markup. |
| `options` | `tuple[SelectItem, ...]` | `()` | Suggested choices. |
| `multi` | `bool` | `False` | Permit multiple choices. |
| `allow_freeform` | `bool` | `True` | Permit free-form text. |
| `allow_note` | `bool` | `False` | Permit an attached note. |
| `recommended` | `str | None` | `None` | Recommended option value. |

### `omp.ui.AskAnswer`

```python
AskAnswer(
    question_id: str,
    selected: tuple[str, ...] = (),
    freeform: str | None = None,
    note: str | None = None,
    timed_out: bool = False,
)
```

Carries one durable answer from an ask-user dialog.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `question_id` | `str` | required | Matching question identity. |
| `selected` | `tuple[str, ...]` | `()` | Selected values. |
| `freeform` | `str | None` | `None` | Free-form response. |
| `note` | `str | None` | `None` | Optional note. |
| `timed_out` | `bool` | `False` | Whether this question timed out. |

### `omp.ui.Ghost`

```python
Ghost(
    text: str,
    id: str | None = None,
    only_when_empty: bool = True,
    expires: Any | None = None,
)
```

Describes a push-only composer suggestion.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `text` | `str` | required | Suggested text. |
| `id` | `str | None` | `None` | Stable suggestion identity. |
| `only_when_empty` | `bool` | `True` | Restrict display to an empty composer. |
| `expires` | `Any | None` | `None` | Host-understood expiry. |

### `omp.ui.Trigger`

```python
Trigger(
    prefix: str,
    at_line_start: bool = False,
    min_chars: int = 0,
    debounce: Any = "90ms",
    max_results: int = 20,
    cache: Any = "2s",
    refine_locally: bool = True,
)
```

Declares when a completion provider should run.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `prefix` | `str` | required | Literal trigger prefix. |
| `at_line_start` | `bool` | `False` | Require the prefix at line start. |
| `min_chars` | `int` | `0` | Minimum query length. |
| `debounce` | `Any` | `"90ms"` | Host debounce duration. |
| `max_results` | `int` | `20` | Maximum decoded candidates. |
| `cache` | `Any` | `"2s"` | Host cache duration. |
| `refine_locally` | `bool` | `True` | Permit local refinement. |

### `omp.ui.CompletionItem`

```python
CompletionItem(
    insert: str,
    label: str | None = None,
    desc: str | None = None,
    hint: str | None = None,
    group: str | None = None,
    icon: str | None = None,
    sort: int = 0,
)
```

Describes one completion candidate.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `insert` | `str` | required | Accepted insertion. |
| `label` | `str | None` | `None` | Display label. |
| `desc` | `str | None` | `None` | Description. |
| `hint` | `str | None` | `None` | Inline hint. |
| `group` | `str | None` | `None` | Candidate group. |
| `icon` | `str | None` | `None` | Catalog icon name. |
| `sort` | `int` | `0` | Sort tie-breaker. |

### `omp.ui.Action`

```python
Action(action_id: str, chord: str, phase: Phase)
```

Carries one shortcut activation.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `action_id` | `str` | required | Registered action identity. |
| `chord` | `str` | required | Normalized matched chord. |
| `phase` | `Phase` | required | Agent phase at activation. |

### `omp.ui.Activation`

```python
Activation(element_id: str, source: ActivationSource)
```

Carries activation of an id-bearing transcript element.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `element_id` | `str` | required | Activated element identity. |
| `source` | `ActivationSource` | required | Keyboard or mouse source. |

### `omp.ui.Invocation`

```python
Invocation(name: str, argv: tuple[str, ...], raw: str, mode: InvocationMode)
```

Carries a parsed slash-command invocation.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `str` | required | Invoked name or alias. |
| `argv` | `tuple[str, ...]` | required | Tokenized arguments. |
| `raw` | `str` | required | Untokenized argument text. |
| `mode` | `InvocationMode` | required | Invoking client mode. |

### `omp.ui.Arg`

```python
Arg(name: str, description: str = "", usage: str | None = None)
```

Declares one static command argument row.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `str` | required | Argument candidate. |
| `description` | `str` | `""` | Candidate description. |
| `usage` | `str | None` | `None` | Usage hint. |

### `omp.ui.ArgQuery`

```python
ArgQuery(prefix: str, argv: tuple[str, ...])
```

Carries a dynamic command-argument completion request.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `prefix` | `str` | required | Current token prefix. |
| `argv` | `tuple[str, ...]` | required | Earlier parsed arguments. |

### `omp.ui.CommandMountSpec`

```python
CommandMountSpec(
    name: str,
    handler: Callable[..., object],
    aliases: tuple[str, ...] = (),
    description: str = "",
    args: tuple[Arg, ...] = (),
    hint: str | None = None,
    arg_completions: Callable[..., object] | None = None,
)
```

Describes a command discovered after the static declaration table was frozen.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | `str` | required | Non-empty command name. |
| `handler` | `Callable[..., object]` | required | Dispatch callback. |
| `aliases` | `tuple[str, ...]` | `()` | Non-empty alias strings. |
| `description` | `str` | `""` | Command description. |
| `args` | `tuple[Arg, ...]` | `()` | Static argument rows. |
| `hint` | `str | None` | `None` | Usage hint. |
| `arg_completions` | `Callable[..., object] | None` | `None` | Dynamic completion callback. |

**Raises**

The constructor raises `ValueError` for empty names or aliases, and `TypeError` for invalid handlers, description, arguments, hint, or completer.

### `omp.ui.Consumed`

```python
Consumed(notice: Tml | None = None)
```

Marks a slash command as consumed locally.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `notice` | `Tml | None` | `None` | Optional durable notice. |

### `omp.ui.Prompt`

```python
Prompt(text: str, submit: bool = True)
```

Returns text from a slash command for the composer or model.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `text` | `str` | required | Prompt text. |
| `submit` | `bool` | `True` | Submit immediately when true; otherwise leave for editing. |

### `omp.ui.CommandResult`

```python
CommandResult = Consumed | Prompt
```

Defines the closed typed return vocabulary for command handlers. A handler may additionally return `None` for silent consumption.

### `omp.ui.TerminalInputFrame`

```python
TerminalInputFrame(sequence: int, data: bytes, focus_token: str)
```

Carries one bounded raw terminal-input frame.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sequence` | `int` | required | Host sequence number. |
| `data` | `bytes` | required | Raw input bytes, limited by dispatch to 4096 bytes. |
| `focus_token` | `str` | required | Token binding the frame to the active focus lease. |

### `omp.ui.limits`

```python
limits
```

Exposes read-only protocol ceilings.

| Attribute | Value | Meaning |
| --- | --- | --- |
| `TML_MAX_BYTES` | `262_144` | Maximum UTF-8 TML document size. |
| `TML_MAX_DEPTH` | `64` | Maximum nested TML depth. |
| `SLOT_MAX_PER_EXTENSION` | `16` | Slot mount ceiling per extension. |
| `NOTIFY_PER_TURN` | `10` | Notification ceiling per turn. |
| `COMPLETION_DEADLINE` | `"250ms"` | Completion deadline. |
| `RENDER_DEADLINE` | `"50ms"` | Renderer deadline. |
| `OVERLAY_MAX_CONCURRENT` | `2` | Concurrent overlay ceiling. |
| `WATCH_DEBOUNCE` | `"60ms"` | Overlay watch debounce. |

## Retained handles

### `omp.ui.OverlayHandle`

```python
OverlayHandle(overlay_id: str)
```

Owns one retained overlay. Obtain it from [`overlay`](#ompuioverlay) rather than constructing it directly.

| Member | Signature | Behavior |
| --- | --- | --- |
| `id` | `str` | Host overlay identity. |
| `set` | `set(content: Tml) -> None` | Replaces overlay content while open. |
| `patch` | `patch(id: str, *, text: Tml | str | None = None, **props: object) -> None` | Patches one retained element. |
| `hidden` | `bool` property | Gets or sets hidden state and emits the change. |
| `focus` | `focus() -> None` | Requests overlay focus. |
| `blur` | `blur() -> None` | Releases overlay focus. |
| `values` | `async values() -> dict[str, object]` | Reads the current value map; returns `{}` after close or on an invalid response. |
| `close` | `async close() -> None` | Closes once; later calls do nothing. |
| `wait` | `async wait() -> DialogOutcome` | Waits for a terminal outcome and marks the handle closed. |
| `events` | `async events() -> _AsyncIterator[OverlayEvent]` | Yields decoded watched events. |

The handle is an async context manager; leaving the context calls `close`.

```python
async with await ui.overlay(ui.tml("<button id=done submit>Done</button>"), watch=("done",)) as panel:
    async for event in panel.events():
        if event.kind is ui.EventKind.SUBMIT:
            break
```

### `omp.ui.SlotHandle`

```python
SlotHandle(key: str, placement: Slot)
```

Represents one extension-owned slot mount. Obtain it from [`mount`](#ompuimount).

| Member | Signature | Behavior |
| --- | --- | --- |
| `key` | `str` | Local mount key. |
| `placement` | `Slot` | Mount location. |
| `set` | `set(content: Tml) -> None` | Replaces mounted content. |
| `patch` | `patch(id: str, *, text: Tml | str | None = None, **props: object) -> None` | Patches a retained child. |
| `visible` | `bool` property | Gets or sets local visibility and queues the update. |
| `unmount` | `unmount() -> None` | Removes the local handle and queues unmount. |

## Mounts and effects

Effects are synchronous calls that enqueue data in the installed effect sink. When no sink is installed, they return without presenting anything; a configured CONTROL host without a UI sink produces a runtime warning.

### `omp.ui.mount`

```python
def mount(
    placement: Slot,
    content: Tml,
    options: SlotOptions | None = None,
    *,
    key: str | None = None,
) -> SlotHandle:
    ...
```

Queues a slot mount or replacement and returns its local handle.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `placement` | `Slot` | Layout location. |
| `content` | `Tml` | Validated document. |
| `options` | `SlotOptions | None` | Responsive options; `None` uses `SlotOptions()`. |
| `key` | `str | None` | Extension-local key; `None` resolves to `"default"`. |

**Returns**

The existing handle for the key, if present, otherwise a new [`SlotHandle`](#ompuislothandle).

**Raises**

`TypeError` when `content` is not `Tml`.

### `omp.ui.handle`

```python
def handle(key: str) -> SlotHandle:
    ...
```

Returns the local handle for a mounted key.

**Parameters**

`key` (`str`) identifies the local mount.

**Returns**

The corresponding [`SlotHandle`](#ompuislothandle).

**Raises**

`KeyError` when the key is unknown.

### `omp.ui.unmount`

```python
def unmount(key: str) -> None:
    ...
```

Removes one local mount and queues its unmount effect.

**Parameters**

`key` (`str`) identifies the local mount.

**Raises**

`KeyError` when the key is unknown.

### `omp.ui.unmount_all`

```python
def unmount_all() -> None:
    ...
```

Unmounts a snapshot of all locally tracked slot handles.

### `omp.ui.focus_slot`

```python
def focus_slot(key: str) -> None:
    ...
```

Queues a focus request for an eligible mounted rail.

**Parameters**

`key` (`str`) identifies the mounted rail.

### `omp.ui.blur_slot`

```python
def blur_slot() -> None:
    ...
```

Queues focus return to the composer.

### `omp.ui.set_status`

```python
def set_status(
    key: str,
    content: Tml | None,
    *,
    order: int = 100,
    side: Slot = Slot.STATUS_RIGHT,
) -> None:
    ...
```

Updates or clears a keyed status contribution.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `key` | `str` | Contribution identity. |
| `content` | `Tml | None` | Status markup, or `None` to clear. |
| `order` | `int` | Ordering value. |
| `side` | `Slot` | Status side, defaulting to `STATUS_RIGHT`. |

### `omp.ui.notify`

```python
def notify(
    message: str | Tml,
    *,
    level: Level | str = Level.INFO,
    title: str | None = None,
    desktop: bool = False,
    sound: Sound | None = None,
    urgency: Urgency | None = None,
) -> None:
    ...
```

Queues a fail-open notice.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `message` | `str | Tml` | Notice content. |
| `level` | `Level | str` | Severity converted through `Level`. |
| `title` | `str | None` | Optional title. |
| `desktop` | `bool` | Request desktop presentation. |
| `sound` | `Sound | None` | Optional sound class. |
| `urgency` | `Urgency | None` | Optional desktop urgency. |

**Raises**

`ValueError` if `level` is not a recognized `Level` value.

### `omp.ui.set_working_message`

```python
def set_working_message(content: Tml | None) -> None:
    ...
```

Replaces or clears the working-message banner.

**Parameters**

`content` (`Tml | None`) is the new banner, or `None` to clear it.

### `omp.ui.set_working_indicator`

```python
def set_working_indicator(
    frames: tuple[str, ...],
    interval_ms: int | None = None,
) -> None:
    ...
```

Replaces the core-timed working indicator; an empty tuple hides it.

**Parameters**

`frames` contains at most eight strings. `interval_ms` is a positive integer or `None`.

**Raises**

`ValueError` for too many frames, a non-string frame, or a non-positive/non-integer interval.

### `omp.ui.set_title`

```python
def set_title(title: str | None) -> None:
    ...
```

Updates or clears the terminal title.

**Parameters**

`title` (`str | None`) is the new title, or `None` to clear it.

### `omp.ui.bell`

```python
def bell() -> None:
    ...
```

Queues one attention bell.

### `omp.ui.set_progress`

```python
def set_progress(state: Progress) -> None:
    ...
```

Queues terminal taskbar progress state.

**Parameters**

`state` is a [`Progress`](#ompuiprogress) value.

### `omp.ui.image`

```python
def image(
    source: object,
    *,
    w: int | None = None,
    h: int | None = None,
    trim: bool = False,
) -> Tml:
    ...
```

Queues client-side image materialization and returns a stable `<img>` placeholder.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `source` | `object` | Host-understood image source. |
| `w` | `int | None` | Optional width. |
| `h` | `int | None` | Optional height. |
| `trim` | `bool` | Request trimming. |

**Returns**

TML referring to a newly generated resource identity.

### `omp.ui.set_ghost`

```python
def set_ghost(ghost: Ghost | None) -> None:
    ...
```

Replaces or clears the inline composer suggestion.

**Parameters**

`ghost` is a [`Ghost`](#ompuighost) value or `None`.

### `omp.ui.clear_ghost`

```python
def clear_ghost() -> None:
    ...
```

Clears the inline composer suggestion by calling `set_ghost(None)`.

### `omp.ui.set_editor_text`

```python
def set_editor_text(text: str) -> None:
    ...
```

Queues complete replacement of composer text.

**Parameters**

`text` (`str`) becomes the composer content.

### `omp.ui.set_clipboard`

```python
def set_clipboard(text: str) -> None:
    ...
```

Queues a client-owned clipboard write.

**Parameters**

`text` (`str`) is the clipboard content.

### `omp.ui.paste_to_editor`

```python
def paste_to_editor(content: object) -> None:
    ...
```

Routes content through the composer's paste pipeline.

**Parameters**

`content` (`object`) is the value passed to the host pipeline.

### `omp.ui.submit`

```python
def submit(text: str | None = None) -> None:
    ...
```

Queues composer submission.

**Parameters**

`text` (`str | None`) optionally replaces composer text before submission.

### `omp.ui.open_url`

```python
def open_url(url: str) -> None:
    ...
```

Queues a validated client-side URL-open request.

**Parameters**

`url` (`str`) is passed to the client for validation and opening.

## Requests and dialogs

### `omp.ui.terminal_input`

```python
async def terminal_input() -> _AsyncIterator[TerminalInputFrame]:
    ...
```

Yields raw input frames while this extension owns the installed focus lease.

**Returns**

An async iterator of [`TerminalInputFrame`](#ompuiterminalinputframe) values. Frames with a mismatched focus token or more than 4096 bytes are discarded. Exiting iteration releases the subscription, including exceptional exits.

**Raises**

[`TerminalInputDenied`](#ompuiterminalinputdenied) when raw input is not granted, the host is headless, or this extension already has an active subscription.

### `omp.ui.presentation`

```python
async def presentation() -> Presentation:
    ...
```

Reads current presentation facts.

**Returns**

A decoded [`Presentation`](#ompuipresentation). Missing, malformed, or failed host responses return `Presentation()`.

### `omp.ui.commands`

```python
async def commands() -> tuple[dict[str, object], ...]:
    ...
```

Reads the current invokable command roster.

**Returns**

A tuple of dictionaries with `name`, tuple-valued `aliases`, `description`, and `source`. Any malformed response produces `()`.

### `omp.ui.icons`

```python
async def icons(prefix: str = "") -> tuple[str, ...]:
    ...
```

Reads catalog icon names matching an optional prefix.

**Parameters**

`prefix` (`str`) filters names and defaults to the empty prefix.

**Returns**

A tuple when the host returns a list or tuple; otherwise `()`.

### `omp.ui.editor_text`

```python
async def editor_text() -> str:
    ...
```

Reads composer text.

**Returns**

The composer string, or `""` after a failed or non-string response.

### `omp.ui.themes`

```python
async def themes() -> tuple[str, ...]:
    ...
```

Reads installed theme names from the interactive host.

**Returns**

A tuple of names converted with `str` when the host supplies a list or tuple; otherwise `()`.

### `omp.ui.set_appearance`

```python
async def set_appearance(theme: str, *, persist: bool = False) -> None:
    ...
```

Requests a live theme change while preserving host refusal errors.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `theme` | `str` | Non-empty installed theme name. |
| `persist` | `bool` | Whether the host should persist the selection. |

**Raises**

`ValueError` when `theme` is not a non-empty string; CONTROL errors propagate.

### `omp.ui.tools_expanded`

```python
async def tools_expanded() -> bool:
    ...
```

Reads the transcript's tool-card expansion state.

**Returns**

The host result converted with `bool`.

### `omp.ui.set_tools_expanded`

```python
async def set_tools_expanded(expanded: bool) -> None:
    ...
```

Requests tool-card expansion state.

**Parameters**

`expanded` (`bool`) is converted with `bool` before the strict CONTROL request. CONTROL errors propagate.

### `omp.ui.set_hidden_thinking_label`

```python
async def set_hidden_thinking_label(label: str | None) -> None:
    ...
```

Requests the label displayed for hidden reasoning blocks.

**Parameters**

`label` (`str | None`) sets the replacement label or clears it.

**Raises**

`TypeError` unless `label` is a string or `None`; CONTROL errors propagate.

### `omp.ui.overlay`

```python
async def overlay(
    content: Tml,
    options: OverlayOptions | None = None,
    *,
    watch: Sequence[str] = (),
) -> OverlayHandle:
    ...
```

Shows a retained overlay and returns its owner handle.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `content` | `Tml` | Initial document. |
| `options` | `OverlayOptions | None` | Placement options; `None` uses defaults. |
| `watch` | `Sequence[str]` | Element/event identities to observe. |

**Returns**

The new [`OverlayHandle`](#ompuioverlayhandle).

**Raises**

`TypeError` when `content` is not `Tml`; [`DialogUnavailable`](#ompuidialogunavailable) when the host does not return an overlay id.

### `omp.ui.confirm`

```python
async def confirm(
    title: str,
    message: str | Tml = "",
    *,
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests confirmation.

**Parameters**

`title` (`str`) is the dialog title; `message` (`str | Tml`) is its body; `options` supplies shared dialog settings.

**Returns**

A [`DialogOutcome`](#ompuidialogoutcome); `confirmed` contains acceptance, and malformed or unavailable responses become a cancelled `UNAVAILABLE` outcome.

### `omp.ui.select`

```python
async def select(
    title: str,
    items: Sequence[SelectItem | str],
    *,
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests one choice.

**Parameters**

`title` (`str`) labels the dialog, `items` supplies string or `SelectItem` choices, and `options` supplies shared settings.

**Returns**

A `DialogOutcome`; read an accepted choice from `outcome.value`.

### `omp.ui.multi_select`

```python
async def multi_select(
    title: str,
    items: Sequence[SelectItem | str],
    *,
    checked: Sequence[str] = (),
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests multiple choices.

**Parameters**

`title` (`str`) labels the dialog, `items` supplies choices, `checked` supplies initial values, and `options` supplies shared settings.

**Returns**

A `DialogOutcome`; read accepted choices from `outcome.values`.

### `omp.ui.input`

```python
async def input(
    title: str,
    *,
    placeholder: str = "",
    prefill: str = "",
    mask: bool = False,
    match: str | None = None,
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests one text value.

**Parameters**

`title` (`str`) labels the dialog. `placeholder`, `prefill`, `mask`, and `match` configure input; `options` supplies shared settings.

**Returns**

A `DialogOutcome`; read accepted text from `outcome.value`.

### `omp.ui.editor`

```python
async def editor(
    title: str,
    *,
    prefill: str = "",
    syntax: str | None = None,
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests multi-line edited text.

**Parameters**

`title` (`str`) labels the dialog, `prefill` supplies initial content, `syntax` is an optional host syntax name, and `options` supplies shared settings.

**Returns**

A `DialogOutcome`; read accepted text from `outcome.value`.

### `omp.ui.form`

```python
async def form(
    title: str,
    fields: Sequence[object],
    *,
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests a native form.

**Parameters**

`title` (`str`) labels the form, `fields` supplies its field declarations, and `options` supplies shared settings. The sequence is frozen to a tuple for transport.

**Returns**

A `DialogOutcome`; decoded values appear in `outcome.fields`.

### `omp.ui.ask_user`

```python
async def ask_user(
    questions: AskQuestion | Sequence[AskQuestion],
    *,
    options: DialogOptions | None = None,
) -> DialogOutcome:
    ...
```

Requests one or more structured answers.

**Parameters**

`questions` is one `AskQuestion` or a sequence of them; `options` supplies shared settings.

**Returns**

A `DialogOutcome`; decoded answers appear in `outcome.answers`.

## Rendering and interaction declarations

### `omp.ui.message_renderer`

```python
def message_renderer(
    kind: str,
) -> Callable[
    [Callable[[MessageView, RenderCtx], Tml | None]],
    Callable[[MessageView, RenderCtx], Tml | None],
]:
    ...
```

Registers one synchronous transcript-message fold for `kind`.

**Parameters**

`kind` (`str`) is the exact host message kind.

**Returns**

A decorator for `def fold(message: MessageView, ctx: RenderCtx) -> Tml | None`. It returns the function unchanged.

**Raises**

`TypeError` when the decorated object is not callable or is an async function. Registry conflicts may raise a registration error.

A fold exception, `None`, or a non-`Tml` return selects native rendering during dispatch.

### `omp.ui.markdown_transformer`

```python
def markdown_transformer(
    name: str,
) -> Callable[[Callable[[str], str]], Callable[[str], str]]:
    ...
```

Registers one synchronous Markdown preprocessing fold.

**Parameters**

`name` (`str`) is a non-empty static transformer identity.

**Returns**

A decorator for `def transform(markdown: str) -> str`.

**Raises**

`ValueError` for an empty/non-string name; `TypeError` for a non-callable or async callback.

During dispatch, errors and non-string results fail open to the input Markdown.

### `omp.ui.renderer`

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

Registers an exact-revision device rendering fold.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `name` | `str` | Device name. |
| `family` | `str | None` | Revision family. |
| `rev` | `int | None` | Revision number. |
| `reduce` | `Callable[[object, object], object] | None` | Optional `(state, update) -> state` reducer. |
| `decorates` | `bool` | Register an augmentation rather than a base fold. |

When one declared device has `name`, omitted `family` and `rev` are inferred from that definition. Otherwise the unresolved key uses `""` for family and `0` for revision.

**Returns**

A decorator for a synchronous callable receiving `(view, RenderCtx)` and returning `Tml | None`. The callback receives `__omp_renderer_reduce__` and `__omp_renderer_decorates__` attributes.

**Raises**

| Exception | Condition |
| --- | --- |
| `ValueError` | `name` is empty. |
| `TypeError` | `decorates` is not `bool`, or the callback is an async function. |
| [`DuplicateRenderer`](#ompuiduplicaterenderer) | The exact key is already registered. |

Dispatch applies `reduce` to updates before the fold, validates `Tml | None`, and returns `None` on any fold error.

### `omp.ui.completion`

```python
def completion(
    trigger: Trigger,
) -> Callable[[Callable[..., object]], Callable[..., object]]:
    ...
```

Registers a completion provider under a static trigger prefix.

**Parameters**

`trigger` must be a [`Trigger`](#ompuitrigger).

**Returns**

A decorator for a sync or async callable. The dispatcher calls it with `(query, ctx)`, awaits an awaitable result, converts mapping rows or `CompletionItem` objects, and caps results at `trigger.max_results`.

**Raises**

`TypeError` when `trigger` is not `Trigger` or the decorated object is not callable. Provider errors fail open to `()`.

### `omp.ui.on_activate`

```python
def on_activate(
    prefix: str,
) -> Callable[[Callable[..., object]], Callable[..., object]]:
    ...
```

Registers a callback for a transcript element id equal to `prefix` or beginning with `prefix + "."`.

**Parameters**

`prefix` (`str`) is the non-empty id prefix.

**Returns**

A decorator for a sync or async `(Activation, ctx)` callback. When prefixes overlap, dispatch chooses the longest match.

**Raises**

`ValueError` for an empty/non-string prefix; `TypeError` for a non-callable callback.

### `omp.ui.shortcut`

```python
def shortcut(
    chord: str,
    *,
    action_id: str | None = None,
    description: str = "",
    when: frozenset[Phase] | None = None,
) -> Callable[[Callable[..., object]], Callable[..., object]]:
    ...
```

Declares a normalized shortcut and its dispatch callback.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `chord` | `str` | Case-insensitive key chord. |
| `action_id` | `str | None` | Static action id; defaults to the function name. |
| `description` | `str` | User-facing description. |
| `when` | `frozenset[Phase] | None` | Optional allowed phases. |

Modifiers are `ctrl`, `alt`, `shift`, and `super`; the key is a printable non-space character, `space`, a navigation/editing key, or `f1` through `f24`. Modifier order is normalized.

**Returns**

A decorator for a sync or async `(Action, ctx)` callback.

**Raises**

[`ShortcutError`](#ompuishortcuterror) for malformed chord syntax. Registration conflicts may also surface from the declaration registry.

### `omp.ui.dynamic_mount`

```python
async def dynamic_mount(*specs: CommandMountSpec) -> tuple[str, ...]:
    ...
```

Mounts commands discovered after declaration freeze through CONTROL.

**Parameters**

`*specs` contains only [`CommandMountSpec`](#ompuicommandmountspec) values with distinct names not already present in the local command registry.

**Returns**

The mounted names, in the same order as `specs`.

**Raises**

| Exception | Condition |
| --- | --- |
| `TypeError` | A spec has the wrong type or the host response is malformed. |
| `ValueError` | Names repeat in the call or collide with a locally registered command. |
| `omp.NotWiredError` | No CONTROL backend is installed. |

Handlers are installed locally only after the host confirms the exact requested names.

### `omp.ui.command`

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
```

Declares one slash command with static and optional dynamic completion metadata.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `name` | `str` | Canonical command name. |
| `aliases` | `Sequence[str]` | Alternate names; captured as a tuple. |
| `description` | `str` | Command description. |
| `args` | `Sequence[Arg]` | Static argument rows; captured as a tuple. |
| `hint` | `str | None` | Usage hint. |
| `arg_completions` | `Callable[..., object] | None` | Sync or async `(ArgQuery, ctx)` completer. |

**Returns**

A decorator for a sync or async `(Invocation, ctx)` handler returning [`Consumed`](#ompuiconsumed), [`Prompt`](#ompuiprompt), or `None`.

**Raises**

`TypeError` when any entry in `args` is not `Arg`. Declaration-registry errors may reject conflicting metadata. Dispatch raises [`CommandDenied`](#ompuicommanddenied) for an unknown name and `TypeError` for a result outside the closed vocabulary. Completion errors fail open to no dynamic candidates.
