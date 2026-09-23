Anchored edit format: quote current text under `*** SM:FIND`, then replace it under `*** SM:PUT` or insert lines under `*** SM:AFTER`. Elide unchanged runs with `…`.

<ops>
`*** SM:EDIT relative/path.ts` opens edits in that file; bare `*** SM:EDIT` continues the same file. Each edit is `*** SM:FIND` followed by `*** SM:PUT` or `*** SM:AFTER`. All edits apply atomically.

- `*** SM:FIND` quotes current file lines. Each body MUST match once; append ` all` to the edit header to apply every match: `*** SM:EDIT src/x.ts all` or `*** SM:EDIT all`.
- `*** SM:PUT` states the complete final text replacing the whole FIND match. An empty PUT body deletes the match; omitting the action does not.
- `*** SM:AFTER` keeps the FIND match and inserts its body after the last matched line. Write only the new lines; blank lines and `…` are literal.
- Every header MUST stand alone. Its body is raw text through the next recognized header or EOF; no closing delimiter exists.
- Ambiguous path? Use a JSON-quoted path: `*** SM:EDIT "path ending in all" all`.
- In FIND: `…` = gap/capture. Mid-line gaps stay line-bounded; a gap at line end spans lines.
- In PUT: each `…` re-emits the next FIND capture. A whole `…` line with no capture is an error; type the lines out.

Anchor unchanged? Use AFTER. Anchor also changes? Use PUT with the changed anchor and new lines. Move code with two edits: delete the block with empty PUT, then insert it with AFTER at the destination.
</ops>

<rules>
- Replacements MUST include a fragment of the changed line; insertions MUST quote the anchor ending just before the new lines.
- Copy FIND lines byte-for-byte from the last file read, including indentation. Markdown, diffs, and agent summaries are not reliable sources.
- PUT and AFTER indentation is written verbatim. The engine NEVER infers, converts, or repairs indentation.
- AVOID retyping unchanged lines; use AFTER or `…` captures.
- Keep edits minimal: the smallest unique anchor plus changed lines.
- Ambiguous match? Add unique parent context; NEVER retry the bare line.
- Edits address the original file; earlier edits never shift later anchors.
- Fuzzy matching NEVER repairs authored whitespace, operators, or delimiters.
- Failure applies nothing and returns a copy-ready corrected payload; resend it verbatim.
- "No change" means the file already equals the PUT body; look elsewhere.
- File contains a standalone `*** SM:EDIT`, `*** SM:FIND`, `*** SM:PUT`, or `*** SM:AFTER` line? Use `write` instead.
</rules>

<example>
Small change:
```text
*** SM:EDIT src/config.ts
*** SM:FIND
const timeout = 1000;
*** SM:PUT
const timeout = 5000;
```

Fix every match:
```text
*** SM:EDIT src/catalog.ts all
*** SM:FIND
logger.debug(
*** SM:PUT
logger.trace(
```

Several edits in one file:
```text
*** SM:EDIT src/footer.ts
*** SM:FIND
	} else if (percent > 70) {
		str = display;
	} else {
		str = warn(display);
	}
*** SM:PUT
	} else if (percent > 70) {
		str = warn(display);
	} else {
		str = display;
	}
*** SM:EDIT
*** SM:FIND
const label = "pct";
*** SM:PUT
const label = "percent";
```

Insert new lines — keep the anchor, write only the addition:
```text
*** SM:EDIT src/retry.ts
*** SM:FIND
	limit: number;
*** SM:AFTER
	/** Delay between attempts in ms */
	delayMs: number;
```

Edit two files in one atomic payload:
```text
*** SM:EDIT src/client.ts
*** SM:FIND
const endpoint = "/v1";
*** SM:PUT
const endpoint = "/v2";
*** SM:EDIT src/server.ts
*** SM:FIND
router.use("/v1", api);
*** SM:PUT
router.use("/v2", api);
```

Large restructure — a gap skips unchanged body text:
```text
*** SM:EDIT src/render.ts
*** SM:FIND
function legacyPipeline(input: Frame): Frame {
…
}
*** SM:PUT
const renderPipeline = (input: Frame): Frame => commit(stage(input));
```

Move a block; the final empty PUT deletes at EOF:
```text
*** SM:EDIT src/util.ts
*** SM:FIND
run(target);
*** SM:AFTER
const helper = () => {
	return 1;
};
*** SM:FIND
const helper = () => {
	return 1;
};
*** SM:PUT
```

Sparse gaps carry captured lines through PUT:
```text
*** SM:EDIT src/users.ts
*** SM:FIND
loadUser(…
	const user = legacyStore.read(…);
…
}
*** SM:PUT
loadUser(…
	const user = await database.users.read(…);
	if (!user) throw new MissingUserError(id);
…
}
```
</example>

<critical>
1. First line MUST be `*** SM:EDIT relative/path.ts`; bare `*** SM:EDIT` continues that file.
2. FIND MUST be followed by PUT or AFTER. Empty PUT deletes.
3. Preserve exact indentation in every authored PUT or AFTER line.
4. Prove one unique match or append ` all` to the edit header.
5. After an error, resend the complete copy-ready payload verbatim.
6. Edit only from verbatim file reads or edit-error payloads.
</critical>
