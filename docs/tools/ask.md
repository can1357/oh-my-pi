# ask

> Prompts the interactive user for one or more option-picker or free-form answers.

## Source
- Entry: `packages/coding-agent/src/tools/ask.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ask.md`
- Key collaborators:
  - `packages/coding-agent/src/modes/settings.ts` — `ask.timeout` / `ask.notify` defaults
  - `packages/tui/src/theme/theme.ts` — checkbox and radio glyphs for TUI rendering
  - `packages/tui/src/tools/ask.ts` — call/result normalization and rendering

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `questions` | `Question[]` | Yes | One or more questions. Empty arrays are rejected by schema and also guarded at runtime. |

### `Question`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Stable identifier used in multi-question results. IDs must be unique across the call after carriage-return normalization. |
| `question` | `string` | Yes | Prompt text shown to the user. |
| `options` | `{ label: string; description?: string; preview?: string }[]` | Yes | Picker choices. `description` is explanatory text; `preview` supplies optional rich preview content to a rich ask dialog. No minimum/maximum is enforced. Labels must be unique within a question after carriage-return normalization and must not collide with runtime controls. |
| `header` | `string` | No | Optional short display chip used by rich ask dialogs. Ignored by the selector fallback. |
| `multi` | `boolean` | No | Enables multi-select mode. Default: `false`. |
| `recommended` | `number` | No | Zero-based recommended/default option index. Supply an integer; the schema does not enforce integrality. Out-of-range indexes do not receive a recommendation badge or timeout preference. The fallback selector marks a valid single-select option with ` (Recommended)`. |

## Outputs
- Single-shot result.
- `content[0].text` is plain text:
  - single question: selected/custom answer plus an optional `User added note: ...`
  - multiple questions: `User answers:` followed by one line per `id`
  - rich-dialog chat redirect: `User chose to chat about this instead of answering...`
- Images pasted into rich-dialog custom answers and notes follow the text block, each with the source-path notice a main-editor attachment gets. `[Image #N]` markers are numbered across the whole result, in text order within each answer, and `attachment://N` resolves to them until a newer message attaches images; image data stays out of `details`.
- For a text-only active model with `images.describeForTextModels` on (the default), each answer image is followed by the vision-model description a pasted prompt image gets.
- `details`:
  - single question: `{ question, options, multi, selectedOptions, customInput?, note?, timedOut? }`
  - multiple questions: `{ results: QuestionResult[] }`; each item includes `id`, `question`, `options`, `multi`, `selectedOptions`, and optional `customInput`, `note`, and `timedOut`
  - chat redirect: `{ chatRedirect: true, questions: string[] }`
- Cancellation and headless cases throw instead of returning a structured success result. The tool does not stream updates.

## Flow
1. Registration requires `ask.enabled` and `AskTool.createIf()` requires `session.canPromptUser ?? session.hasUI`. A protocol session with a prompt-capable tool UI can receive it even without a local terminal UI; a session with no prompt surface cannot.
2. `execute()` also requires `context.hasUI` and `context.ui`; if missing it aborts the context and throws `ToolAbortError("Ask tool requires interactive mode")`.
3. It normalizes carriage-return runs in all supplied strings and rejects duplicate question IDs, duplicate option labels within a question, and reserved runtime-label collisions. It reads `ask.timeout`, converts seconds to milliseconds (`0` disables timeout), and disables timeout entirely while plan mode is enabled.
4. If the session has a local UI and `ask.notify` is not `off`, it sends a terminal notification: `Waiting for input`. When `speech.enabled` is true, it also sends all question text to the vocalizer before opening the dialog.
5. When the UI supplies `askDialog`, the tool opens one rich multi-question form. Rich options receive `header`, `description`, and `preview`; results may contain custom answers and notes with pasted images, or choose the dialog's `Chat about this` redirect.
6. Otherwise it uses the selector/editor fallback for each question:
   - single-select list plus `Other (type your own)`
   - multi-select checkbox loop plus `Done selecting` when applicable and `Other (type your own)`
7. In fallback multi-question mode, left/right arrow handlers move backward/forward and preserve prior answers. Single-select answers advance automatically; multi-select options toggle until the user moves forward or submits custom input.
8. If a timeout fires before an answer, the fallback auto-selects the valid recommended option, or the first option otherwise; result text gets ` (auto-selected after timeout)` and `details.timedOut` is set. The rich dialog reports its own `timedOut` answers.
9. If the user cancels without timeout, `execute()` aborts the tool context and throws `ToolAbortError("Ask tool was cancelled by the user")`.
10. On success it formats human-readable text plus structured `details`; the TUI renderer uses `details` for rich result display.

## Modes / Variants
- Single question: returns flattened `details` fields.
- Multiple questions: returns `details.results[]`; the fallback permits arrow-key back/forward navigation, while a rich UI presents the complete form.
- Single-select: one option or custom input.
- Multi-select: toggled choices and/or custom input. The rich dialog permits an empty multi-select answer (`User did not select any options` for one question, `id: []` for multiple questions). In the fallback, `Done selecting` appears only when forward navigation is not active and at least one choice is selected.
- Rich ask dialog: supports per-question headers, option previews, answer notes, pasted images in custom answers and notes, and a `Chat about this` redirect. Submitting a nonempty custom answer advances to the next question, or to review for a single multi-select question; existing checkbox selections are preserved. A single-select question still submits immediately when it is the only question.
- Pasted images: the custom-answer and note prompts take images the same ways the main editor does and mark them `[Image #N, WxH]`; deleting a marker drops its image. Extensions calling `ui.askDialog` get this only with `acceptImages: true`; collab guests, RPC, and ACP stay text-only.
- Custom editor: paste followed by Enter submits the pasted text, including when they arrive together. Submission waits for an in-flight clipboard read; cancellation discards pending clipboard delivery.
- Selector/editor fallback: supports labels/descriptions but not headers, previews, notes, images, or chat redirect.

## Side Effects
- User-visible prompts / interactive UI
  - Uses `context.ui.askDialog(...)` when the UI offers the rich form API; otherwise uses the selector/editor fallback.
  - Opens a selection dialog via `context.ui.select(...)`.
  - Opens a text editor dialog via `context.ui.editor(...)` for `Other`.
  - Sends a terminal notification when the session has a local UI, unless `ask.notify=off`.
  - Speaks the question text through the vocalizer when `speech.enabled=true`.
- Session state
  - Reads plan-mode state to disable timeouts.
  - Calls `context.abort()` on headless use or user cancellation.
- Background work / cancellation
  - Wraps UI waits in `untilAborted(...)` so abort signals interrupt pending dialogs.

## Limits & Caps
- `questions` must contain at least 1 item. Unknown fields are rejected because `AskTool.strict=true`.
- `ask.timeout` defaults to `0` seconds (disabled); configured non-zero values are seconds. Plan mode always disables it.
- Prompt guidance says provide 2–5 options, but code only requires the `options` array field and does not enforce a minimum or maximum length.
- Option labels must not equal the reserved runtime labels `Other (type your own)`, `Chat about this`, or `Next →`. Multi-select labels also cannot equal the theme-prefixed `Done selecting` control.
- IDs must be unique across questions, and option labels unique within each question; these guards run after carriage-return normalization.
- Fallback timeout only applies to the option picker; once the user chooses `Other`, the editor has no timeout. Prompt surfaces that report presentation/reset events start or re-arm the picker deadline at those events; otherwise the timer starts when selection is requested.
- `AskTool.concurrency = "exclusive"`: the tool runs alone in its tool batch because the selector/editor UI surface is shared.
- The call renderer normalizes incomplete or malformed streamed arguments for display: bare string options become labels and unusable question/option entries are omitted. Execution still receives schema-validated input.

## Errors
- Missing interactive UI: throws `ToolAbortError("Ask tool requires interactive mode")`.
- User cancels picker/editor without timeout: throws `ToolAbortError("Ask tool was cancelled by the user")`.
- Abort signal during input: converted to `ToolAbortError("Ask input was cancelled")`.
- Empty `questions` at runtime returns a text error payload instead of throwing: `Error: questions must not be empty`.
- Duplicate IDs, duplicate labels, and reserved-label collisions at runtime return a text error payload with empty `details` rather than throwing.
- Rich-dialog contract violations (wrong result count, id, or order) throw `Error`.

## Notes
- `recommended` is only a UI/default hint. Timeout fallback uses the first option if no in-range recommendation exists.
- Fallback single-select maps the displayed row back to the original offered label, preserving an intrinsic ` (Recommended)` suffix. Display-only disambiguation prevents recommendation badges from making two choices identical.
- Fallback multi-select results use `Set` insertion order after toggles. Rich-dialog results use original option order.
- Option labels and prompt text in `details` use the carriage-return-normalized input. Descriptions/previews/header guide presentation but are not copied into result details.
- `/tree` can recover the schema-valid original `questions` from a persisted `ask` call and re-open it to create a sibling answer branch; malformed legacy arguments fail closed.
