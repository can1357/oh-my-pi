Hashline patches. Use only lines visible in latest `read`/`search`; elisions are unseen.

```text
*** Begin Patch
[PATH#TAG]
PUT 3.=3:
+replacement
*** End Patch
```
`TAG`: required 4-hex snapshot; `N,M`: original line numbers. Repeat the header per file.

Ops:
- `PUT N.=M:` replaces inclusive N–M with `+` body; `PUT N*:` replaces the syntax block at N.
- `PUT <N:` inserts before N; `PUT >N:` after N; `PUT >$:` appends. `PUT >N*:` inserts after block N at sibling depth; insert inside with `PUT >M:` at its closing line.
- `CUT N.=M`/`CUT N*` deletes and captures, optionally as `@name`.
- `PUT <N @name`, `PUT >N @name`, `PUT N.=M @name`, or `PUT N* @name` pastes. Range/block paste requires a named register; gap paste may be anonymous. Register pastes have no body.
- `REM` deletes the file; `MV DEST` moves/renames after prior section edits.

Rules:
- Body rows start `+`; lone `+` writes blank. Rest is verbatim, including indent. Never send removed `-` lines, bare context, or unchanged lines. Range/body lengths are independent. Literal leading `-`/`+`: `+- text`/`++ text`.
- Re-read after each edit: tag/numbers change. Touch only changed lines; split nonadjacent changes. Additions use gaps. Ranges never start/end mid-expression/block.
- Block ops target the opener of one multi-line node, never its closer/last/inner line; use range/gap for one statement. Anchor decorators/attributes/doc-comments at the first decorator; standalone line comments stay separate.
- Markdown heading blocks include deeper headings until the next same/higher heading; inserted sections end blank.
- Move via `CUT` then `PUT`; registers persist across sections. Do not restyle unrelated code.
