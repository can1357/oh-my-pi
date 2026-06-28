Performs string replacements in files with fuzzy whitespace matching.

<instruction>
- You MUST use the smallest `old_text` that uniquely identifies the change
- If `old_text` is not unique, you MUST expand it with more context or use `all: true` to replace all occurrences
- You SHOULD prefer editing existing files over creating new ones
</instruction>

<output>
Returns success/failure status. On success, file modified in place with replacement applied. On failure (e.g., `old_text` not found or matches multiple locations without `all: true`), returns error describing issue.
</output>

<critical>
- You MUST read the file at least once in the conversation before editing. Tool errors if you attempt edit without reading file first.
</critical>

<bash-alternatives>
Replace is content-addressed — you identify *what* to change by its text.

For pattern-addressed bulk changes, bash is more efficient:

|Operation|Command|
|---|---|
|Regex replace|`sd 'pattern' 'replacement' file`|
|Bulk replace across files|`sd 'pattern' 'replacement' **/*.ts`|

Use Replace when _content itself_ identifies location; use `ast_edit` for structure-aware codemods.
For in-place edits prefer this tool or `write` — you get a diff preview and fuzzy matching.
</bash-alternatives>
