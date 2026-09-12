Anchored edit format: quote current text in `<SM:FIND>`, state final text in `<SM:PUT>`, elide unchanged runs with `…`.

<ops>
`<SM:EDIT path="relative/path.ts">` opens edits in that file; a bare `<SM:EDIT>` opens more edits in the same file. An `<SM:EDIT>` block holds one or more `<SM:FIND>`/`<SM:PUT>` pairs; each pair is one edit. All edits apply atomically.

- `<SM:FIND>` quotes current file lines. Each `<SM:FIND>` MUST match once; `<SM:EDIT path="x.ts" all>` applies its pairs to every match.
- `<SM:PUT>` states the complete final text replacing the whole `<SM:FIND>` match. Empty `<SM:PUT></SM:PUT>` deletes the match. Every pair MUST have a `<SM:PUT>` — deletion is an empty `<SM:PUT>`, never a missing one.
- In `<SM:FIND>`: `…` = gap/capture — elides text you don't restate; mid-line it stays between fragments on that line, at line end it spans lines. In `<SM:PUT>`: `…` re-emits captured gaps in order — one `<SM:FIND>` gap each; with no gap left to claim it is literal text mid-line, and an error alone on its line (context elision — type the lines out).
- Tags stand alone on their own lines. Everything between tags is RAW file text: NEVER escape it — write `<`, `>`, `&`, quotes exactly as file bytes (no `&lt;`, no `&amp;`, no CDATA).

Insert lines by quoting an anchor line in `<SM:FIND>` and restating anchor plus new lines in `<SM:PUT>`. Move code with two pairs: one deletes the block (empty `<SM:PUT>`), one re-inserts it at the destination.
</ops>

<rules>
- `<SM:FIND>` MUST include a fragment of the changed line; context alone can hit the wrong place.
- Copy `<SM:FIND>` lines byte-for-byte from the file as last read, indentation included. Exact anchors make the engine splice at the authored byte boundaries; quoted code from markdown, diffs, or another agent has untrustworthy indentation — mirror the file, not the quote.
- Every `<SM:PUT>` line is written verbatim at its exact final depth in the file's indent character. A column-0 line amid indented ones is applied flattened, silently. The engine NEVER infers, converts, or repairs indentation. NEVER add annotation lines like `//`.
- AVOID retyping unchanged lines; `…` re-emits them with their original indentation.
- Keep pairs minimal: the smallest unique span plus the changed lines.
- Ambiguous repeated line? Include its unique parent branch in the same `<SM:FIND>`; NEVER retry the bare line.
- Pairs address the original file; earlier pairs never shift later anchors. A fuzzy location fallback may tolerate textual drift, but it NEVER repairs authored whitespace; operators and delimiters MUST match exactly.
- A failure applies nothing and includes a copy-ready corrected payload: send that verbatim.
- "No change" means the file already reads as your `<SM:PUT>`; look elsewhere.
- A file whose own lines are standalone `<SM:FIND>`/`<SM:PUT>`/`<SM:EDIT>` tags cannot be edited with this tool; use `write`.
</rules>

<example>
Small change:
```text
<SM:EDIT path="src/config.ts">
<SM:FIND>
const timeout = 1000;
</SM:FIND>
<SM:PUT>
const timeout = 5000;
</SM:PUT>
</SM:EDIT>
```

Content is raw — never entity-escape:
```text
WRONG: if (a &lt; b &amp;&amp; c) {
RIGHT: if (a < b && c) {
```

Fix every match:
```text
<SM:EDIT path="src/catalog.ts" all>
<SM:FIND>
logger.debug(
</SM:FIND>
<SM:PUT>
logger.trace(
</SM:PUT>
</SM:EDIT>
```

Several pairs, one file:
```text
<SM:EDIT path="src/footer.ts">
<SM:FIND>
	} else if (percent > 70) {
		str = display;
	} else {
		str = warn(display);
	}
</SM:FIND>
<SM:PUT>
	} else if (percent > 70) {
		str = warn(display);
	} else {
		str = display;
	}
</SM:PUT>
<SM:FIND>
const label = "pct";
</SM:FIND>
<SM:PUT>
const label = "percent";
</SM:PUT>
</SM:EDIT>
```

Insert new lines — anchors around them, restated in `<SM:PUT>` at their exact final depth:
```text
<SM:EDIT path="src/retry.ts">
<SM:FIND>
	limit: number;
	jitter: boolean;
</SM:FIND>
<SM:PUT>
	limit: number;
	/** Delay between attempts in ms */
	delayMs: number;
	jitter: boolean;
</SM:PUT>
</SM:EDIT>
```

Large restructure — a gap skips the body you don't restate:
```text
<SM:EDIT path="src/render.ts">
<SM:FIND>
function legacyPipeline(input: Frame): Frame {
…
}
</SM:FIND>
<SM:PUT>
const renderPipeline = (input: Frame): Frame => commit(stage(input));
</SM:PUT>
</SM:EDIT>
```

Move a block — delete with an empty `<SM:PUT>`, re-state at the destination:
```text
<SM:EDIT path="src/util.ts">
<SM:FIND>
const helper = () => {
	return 1;
};
</SM:FIND>
<SM:PUT></SM:PUT>
<SM:FIND>
run(target);
</SM:FIND>
<SM:PUT>
run(target);
const helper = () => {
	return 1;
};
</SM:PUT>
</SM:EDIT>
```

Sparse gaps carry untyped lines through; `…` in `<SM:PUT>` re-emits them:
```text
<SM:EDIT path="src/users.ts">
<SM:FIND>
loadUser(…
	const user = legacyStore.read(…);
…
}
</SM:FIND>
<SM:PUT>
loadUser(…
	const user = await database.users.read(…);
	if (!user) throw new MissingUserError(id);
…
}
</SM:PUT>
</SM:EDIT>
```
</example>

<critical>
1. First line is `<SM:EDIT path="relative/path.ts">`; a bare `<SM:EDIT>` continues the same file.
2. One edit = `<SM:FIND>` current text `</SM:FIND>`, `<SM:PUT>` final text `</SM:PUT>`. Empty `<SM:PUT></SM:PUT>` deletes; anchor restated plus new lines inserts.
3. Content between tags is RAW: NEVER XML-escape `<`, `>`, `&` — write file bytes exactly.
4. Authored indentation is verbatim: every `<SM:PUT>` line carries its exact final leading whitespace in the file's indent character; the engine NEVER reindents.
5. Prove one unique match, or set `all` on the `<SM:EDIT>`.
6. After an error, send the supplied corrected payload verbatim — nothing was applied; NEVER freestyle a new guess.
7. Edit FIRST only from a verbatim file read or edit-error payload. Markdown, diffs, and agent summaries are not indentation sources; re-read the exact region before authoring whole lines.
</critical>
