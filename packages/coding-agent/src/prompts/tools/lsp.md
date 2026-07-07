Language Server Protocol (LSP) servers for code intelligence.

<operations>
- `rename_file` updates import paths + other references (not just the file move).
- `code_actions` lists quick-fixes/refactors/import actions; apply one when `apply: true` + `query` matches title or index.
- `request` runs a raw LSP method — `query` is the method name (e.g. `rust-analyzer/expandMacro`, `workspace/executeCommand`), `payload` is JSON params.
- `reload` restarts one server (via `file`) or all (`file: "*"`).
</operations>

<parameters>
- `file`: path, glob (e.g. `src/**/*.ts`), or `"*"` for workspace scope
- `line`: 1-indexed line for position-based actions
- `symbol`: substring on the target line. Append `#N` for the Nth occurrence — e.g. `foo#2` = second `foo`.
- `query`: symbol search, code-action kind filter/selector (list/apply mode), or LSP method name when `action: request`
- `new_name`: new identifier (rename) or destination path (rename_file)
- `apply`: apply edits (default true for rename/rename_file; code_actions list mode unless true)
- `payload`: JSON params for `action: request`
- `timeout`: seconds
</parameters>

<caution>
- Missing `symbol` or out-of-bounds `#N` → explicit error.
</caution>

<critical>
- You MUST use `lsp` for symbol-aware operations (rename, references, definition/implementation, code_actions) whenever a language server is available — safer and more accurate than text-based alternatives.
- You NEVER perform cross-file renames with `ast_edit`, `sed`, or manual edits when `lsp` `rename` can do it. Text-based renames miss shadowing, re-exports, and cross-file usages.
</critical>