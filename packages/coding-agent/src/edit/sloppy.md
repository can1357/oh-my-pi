Sparse edit format: name distinctive current fragments, elide the rest with `…`, state each change inline or as a rewrite block.

<ops>
`§relative/path.ts` opens an operation in that file; a bare `§` opens another operation in the same file. Each MUST match once; `§*path.ts` / `§*` applies its operation to every match. All operations apply atomically.

One rewrite form per operation:
- Inline: `⟪current│desired⟫` — changes inside lines (renames, operator flips, argument tweaks), several per operation, across lines; a selection MAY span lines for a contained replace. `⟪old│⟫` deletes.
- Add line: `＋final text` on its own line inserts that line at its position; consecutive `＋` lines insert together. Mixes freely with inline selections.
- Block: MATCH lines, `»`, REWRITE lines stating the final text — for moves and large restructures. Empty REWRITE deletes the whole MATCH.

In MATCH: `…` = gap/capture — stays on its line between fragments, spans lines at line end. No markers → REWRITE replaces the whole MATCH.
In REWRITE or a desired side: `…` re-emits captured gaps in order — one MATCH gap each; a `…` with no MATCH gap left to claim mid-line is written as a literal `…`, and alone on its line is an error (context elision — type the lines out).

Move code by deleting it where it is (MATCH + `»` + empty REWRITE, or `⟪old lines│⟫`) and re-stating it with `＋` lines at its destination.
</ops>

<rules>
- MATCH MUST include a fragment of the changed line; context alone can hit the wrong place.
- Copy MATCH lines byte-for-byte from the file as last read, indentation included. Exact anchors make the engine splice at the authored byte boundaries; quoted code from markdown, diffs, or another agent has untrustworthy indentation — mirror the file, not the quote.
- Every authored line — REWRITE, `＋`, and each desired-side line after a newline inside `⟪⟫` — is written verbatim: give it its exact final depth in the file's indent character. A desired side's first line inherits whatever precedes `⟪` on its line; continuation lines carry their full depth themselves. A column-0 line amid indented ones is applied flattened, silently. The engine NEVER infers, converts, or repairs indentation. NEVER add annotation lines like `//`.
- AVOID retyping unchanged lines; `…` re-emits them with their original indentation.
- PREFER `⟪old│new⟫` selections and `＋` lines — unchanged lines or `…` between them — over a block REWRITE that retypes unchanged lines; use block form only for moves and large restructures.
- A rewrite-less bare `⟪X⟫` means “make the selected span X,” not “select X.” Replacing current text MUST use `⟪old│new⟫`.
- No inline desired side? Follow MATCH with `»` and the complete final text. NEVER combine `⟪old│new⟫` with a `»` REWRITE.
- Ambiguous repeated line? Include its unique parent branch in the same operation; NEVER retry the bare line.
- Operations address the original file; earlier ops never shift later anchors. A fuzzy location fallback may tolerate textual drift, but it NEVER repairs authored whitespace; operators and delimiters MUST match exactly.
- A failure applies nothing and includes a copy-ready corrected payload: send that verbatim.
- "No change" means the anchor already reads as your final text; look elsewhere.
- To write markers (`§»⟪│⟫`) or a line starting with `＋` literally, use `write`.
</rules>

<example>
Inline changes, jointly matched:
```text
§src/config.ts
const timeout = ⟪1000│5000⟫;
const retries = ⟪3│5⟫;
```

Replacement requires both sides:
```text
WRONG: const value = ⟪oldValue⟫;
RIGHT: const value = ⟪oldValue│newValue⟫;
```

Fix every match:
```text
§*src/catalog.ts
logger.⟪debug│trace⟫(
```

Several operations, one file — swaps and scattered edits stay inline:
```text
§src/footer.ts
	} else if (percent > 70) {
		str = ⟪display│warn(display)⟫;
	} else {
		str = ⟪warn(display)│display⟫;
	}
§
const label = ⟪"pct"│"percent"⟫;
```

Contained restructure — one selection spanning the replaced lines:
```text
§src/user.ts
	⟪if (!user) {
		return fallback;
	}
	return user.name;│return user?.name ?? fallback;⟫
}
```

Insert new lines — `＋` lines typed at their final depth, anchored by the surrounding lines:
```text
§src/retry.ts
export interface RetryPolicy {
	limit: number;
＋	/** Delay between attempts in ms */
＋	delayMs: number;
	jitter: boolean;
}
```

Large restructure — MATCH, `»`, final text:
```text
§src/render.ts
function legacyPipeline(input: Frame): Frame {
	const staged = stage(input);
	return commit(staged);
}
»
const renderPipeline = (input: Frame): Frame => commit(stage(input));
```

Move a block — delete at the source, re-state it with `＋` lines at its destination:
```text
§src/util.ts
const helper = () => {
	return 1;
};
»
§
run(target);
＋const helper = () => {
＋	return 1;
＋};
```

Sparse gaps carry untyped lines through; a multi-line desired side indents its own continuation lines:
```text
§src/users.ts
loadUser(…
	⟪const user = legacyStore.read(…);│const user = await database.users.read(…);
	if (!user) throw new MissingUserError(id);⟫…
}
```
</example>

<critical>
1. First line is `§relative/path.ts`; a bare `§` opens the next operation in the same file.
2. Changes inside lines → `⟪old│new⟫`, several per op. New lines → `＋`. Moves and large restructures → MATCH + `»` + final text.
3. Authored indentation is verbatim: every REWRITE/`＋`/desired line — retyped anchors included — carries the exact leading whitespace it must have in the file; wrong depth or style applies silently. Tab-indented file → tab indents; the engine NEVER reindents.
4. Prove one unique match anchored on the changed line, or use `§*`.
5. After an error, send the supplied corrected payload verbatim — nothing was applied; NEVER freestyle a new guess.
6. Edit FIRST only from a verbatim file read or edit-error payload. Markdown, diffs, and agent summaries are not indentation sources; re-read the exact region before authoring whole lines.
</critical>
