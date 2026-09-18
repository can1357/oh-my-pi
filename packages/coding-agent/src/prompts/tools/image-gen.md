Generates/edits images.

<instructions>
- One detailed `subject` prompt: generation or editing.
- Multiple `input`: describe each image's role in `subject` (e.g. `Image 1` for composition, `Image 2` for lighting).
- Text: add "sharp, legible, correctly spelled"; keep short.
- `model` selects OpenRouter independently of the chat model. Omit `provider` or use `auto`/`openrouter`.
- `providers.imageOpenRouterModel` applies when provider ordering reaches OpenRouter.
- Explicit model selections fail without replacement. Unsupported request? Deliberately change the options or selected model before retrying.
</instructions>
