# ask

> Asks the interactive user to fill in one HTML form and returns the submitted form data.

## Source

- Entry: `packages/coding-agent/src/tools/ask.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ask.md`
- Key collaborators:
   - `packages/tui/src/html-form/parse.ts` — `parseHtmlForm`: sections, fields, hidden inputs
   - `packages/tui/src/html-form/data.ts` — form data shape, defaults, field questions, validation
   - `packages/tui/src/html-form/dialog.ts` — `HtmlFormDialog`, the interactive form
   - `packages/coding-agent/src/modes/settings.ts` — `ask.timeout` / `ask.notify` defaults
   - `packages/tui/src/tools/ask.ts` — call/result rendering

## Inputs

| Field  | Type     | Required | Description                                                                    |
| ------ | -------- | -------- | ------------------------------------------------------------------------------ |
| `html` | `string` | Yes      | One HTML `<form>`. Content outside the first `<form>` is ignored when present. |

The form is plain semantic HTML. Controls: `<input type="radio">` (one-of), `type="checkbox"` (many-of when several share a name, a yes/no flag alone), `<select>` / `<select multiple>`, text-like inputs (`text`, `number`, `range`, `date`, `email`, `url`, …), `<textarea>`, and `type="hidden"`. `checked`, `selected` and `value` preselect answers; `required`, `min`/`max`, `minlength`/`maxlength` and `pattern` are enforced. Context renders from `<p>`, headings, lists, `<pre>`, `<table>`, and `<fieldset>`/`<legend>` groups. Pictures render from `<img src>` (an http(s) URL, a `data:` URI, a `file:` URL, or a path resolved against the session's working directory) and inline `<svg>`; an image inside a `<label>` contributes only its `alt` text. `<script>`, `<style>` and buttons are dropped.

## Outputs

- Single-shot result.
- `content[0].text`:
   - submit: `User answers:` followed by the form data as indented JSON
   - timeout: `No answer before the timeout; submitted the form's current values:` followed by the JSON
- Form data (`HtmlFormData`): keyed by control `name`. A radio group or single `<select>` gives the chosen `value` (omitted when none); a checkbox group or `<select multiple>` gives an array; a lone checkbox gives its `value` when checked, else is omitted; `number`/`range` inputs give a number when the text parses; other text fields give their text; hidden inputs pass through. Disabled options and unnamed controls never appear.
- "Other" answers: every radio group and checkbox group of two or more options (not `<select>`) whose options include none labelled "Other…" gets a UI-supplied free-text "Other" answer (`ChoiceField.other`). The trimmed text is a radio group's value (`"db": "MySQL 8"`) or is appended to a checkbox group's array (`["ci", "terraform"]`); blank text is no answer. The fallback adds an `Other (type your own)` row that opens `input`; collab guests get the same row with an editor; ACP adds an optional `<name>_other` string property.
- `details: AskToolDetails`: `{ answers: { name, question, answer }[]; timedOut? }`, one entry per named field in form order. `question` is the field's label, else the text block right before it, else its section legend, else its name; `answer` shows option labels instead of values.
- Cancellation and headless cases throw instead of returning a structured success result. The tool does not stream updates.

## Flow

1. Registration requires `ask.enabled` and `AskTool.createIf()` requires `session.canPromptUser ?? session.hasUI` (or a headless fork advertising `ask`).
2. `execute()` requires `context.hasUI` and `context.ui`. Without them a headless fork gets a `ToolError` telling its model to put open questions in its final answer; any other session aborts the context and throws `ToolAbortError("Ask tool requires interactive mode")`.
3. The form is parsed. A form without a named control returns an error text result rather than throwing.
4. It reads `ask.timeout` (seconds; `0` disables) and disables the timeout entirely while plan mode is enabled.
5. If the session has a local UI and `ask.notify` is not `off`, it sends a terminal notification: `Waiting for input`. When `speech.enabled` is true, it speaks the field questions.
6. When the UI supplies `formDialog`, the whole form opens at once: the interactive TUI shows `HtmlFormDialog` (it validates on submit; any key resets the countdown), ACP clients with form elicitation get one elicitation with a property per field. In Tern, a form with two or more top-level `<fieldset>`s shows one tab per fieldset plus a Review tab: question tabs end in a Hide/Cancel/Next bar and Submit lives only on Review. Each tab's content scrolls above that bar, which stays in view, and `app.ask.hide` (`Alt+H`) or Hide collapses the form to one row.
7. Otherwise (RPC hosts, extension UIs without `formDialog`) it walks named fields in order:
   - radio group / single select: one `select`, opening on the preselected option
   - checkbox group / lone checkbox / multi-select: a checkbox `select` loop with a `Done selecting` row (hidden while a required group has nothing checked)
   - empty single-line input: `input` with the placeholder
   - textarea or prefilled input: `editor` with the current text
   - text answers are re-asked with the validation error until valid
8. A timeout submits the form's current values: in the fallback the unanswered fields keep their defaults and a checkbox group keeps what was checked so far. `details.timedOut` is set.
9. A user cancel aborts the tool context and throws `ToolAbortError("Ask tool was cancelled by the user")`.

## Side Effects

- User-visible prompts / interactive UI
   - Uses `context.ui.formDialog(...)` when available; otherwise `context.ui.select(...)`, `input(...)` and `editor(...)`.
   - Sends a terminal notification when the session has a local UI, unless `ask.notify=off`.
   - Speaks the field questions through the vocalizer when `speech.enabled=true`.
- Session state
   - Reads plan-mode state to disable timeouts.
   - Calls `context.abort()` on headless use or user cancellation.
- Background work / cancellation
   - Wraps UI waits in `untilAborted(...)` so abort signals interrupt pending dialogs. A message the user queues closes the dialog with `ToolAbortError("Ask interrupted by message")` without aborting the turn.

## Limits & Caps

- Unknown parameters are rejected because `AskTool.strict=true`.
- `ask.timeout` defaults to `0` seconds (disabled). Plan mode always disables it.
- In the fallback, `editor` prompts (textareas, prefilled inputs) have no timeout; `select` and `input` prompts do. Prompt surfaces that report presentation/reset events start or re-arm the deadline at those events; otherwise the timer starts when the prompt is requested.
- `AskTool.concurrency = "exclusive"`: the tool runs alone in its tool batch because the dialog surface is shared.
- Pictures load in the background while the form is open: at most 10 MiB each, remote ones within 10 s; PNG, JPEG, GIF, WebP and SVG. One that fails shows its `alt` and the reason. Only the interactive TUI/Tern form draws them; the fallback prompts and ACP show none.

## Errors

- Missing interactive UI: throws `ToolAbortError("Ask tool requires interactive mode")`.
- User cancels: throws `ToolAbortError("Ask tool was cancelled by the user")`.
- Abort signal during input: converted to `ToolAbortError("Ask input was cancelled")`.
- No named control: text error result, `details.answers` empty.

## Notes

- `/tree` re-answer recovers the original `html` from the persisted `ask` call and reopens the form to create a sibling answer branch; calls without an `html` string (legacy `questions` sessions) fall back to a plain leaf move.
- Extensions keep `ui.askDialog` (questions-based) for their own prompts; only the tool uses forms.
