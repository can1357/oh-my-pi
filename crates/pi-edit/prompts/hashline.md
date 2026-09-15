Line-anchored patch language: name original lines/gaps to replace, insert, cut, or paste; then give new content. `:` headers take `+` body rows; colonless paste `PUT`, `CUT`, `REM`, `MV` take none.

<headers>
Section: `[PATH#TAG]`; `TAG`: 4-hex snapshot from latest `read`/`search`, REQUIRED each section. New files: `write`; hashline edits existing files only.
</headers>

<ops>
`PUT N.=M:`: replace original inclusive lines N–M with body.
`PUT N*:`: replace syntactic block beginning N; closing line resolved.
`PUT <N:` insert body rows before line N (`PUT <1:` = file head).
`PUT >N:` insert body rows after line N (`PUT >$:` = file tail).
`PUT >N*:`: insert after block N's end, at sibling depth. Append inside block: `PUT >M:`.
`PUT <N @name` / `PUT >N @name` paste register `@name` at the gap before/after line N; omit `@name` for the anonymous register.
`PUT N.=M @name` / `PUT N* @name` paste `@name` over the range / resolved block; `@name` required here.
`CUT N.=M` / `CUT N*`: delete and capture inclusive lines N–M / block N; anonymous or given `@name`.
`REM`: delete section file. `MV DEST`: move/rename (quote paths with spaces); prior edits apply to source, final content to `DEST`.
Single line: `PUT N.=N:` / `CUT N.=N`. Ranges name original inclusive touched lines; body length irrelevant.
</ops>

<body-rows>
Only below `:` headers. Row: verbatim `+TEXT` (leading whitespace preserved); `+`: blank. NEVER `-old`, bare, or context rows: range deletes; body is final content. Keep line: exclude it from every range. Literal initial `-`/`+`: `- item` → `+- item`; `+ item` → `++ item`.
</body-rows>

<rules>
- Numbers and `#TAG`: latest `read`/`search` `LINE:TEXT`; numbers are original, never shifted by hunks.
- Each edit renumbers and changes `#TAG` → next numbers from edit response or fresh `read`.
- Touch displayed lines only; undisplayed hunks REJECTED. Far from read window: re-`read`; confirm construct.
- Elisions UNSEEN: `…`, `..`, collapsed `N-M:` rows. NEVER hunk in/across one; `read` first.
- NEVER start/end range mid-expression or mid-block.
- Ranges: changed lines only; NEVER widen over keepers. Non-adjacent changes: separate hunks.
- Whole construct: `PUT N*:`; internal lines: `PUT N.=M:`.
- `PUT N*:` resolves exactly node N. Leading decorators/attributes/doc-comments are separate nodes: point N at first decorator to include both. Standalone line-comments never swept: use `PUT N.=M:`.
- Block ops: opening line of multi-line construct, NEVER closer, last line, bare inner statement. One statement: plain `PUT N.=N:` / `CUT N.=N` / `PUT >N:`. At closer: `PUT >M:`.
- Markdown headings are block openers. Block op on `##`/`###`: whole section through deeper headings to next same/higher heading. After section `PUT >N*:`: end body with blank line to separate next heading.
- Pure addition: `PUT <N:` / `PUT >N:`, NEVER widened `PUT N.=M:`.
- Move: `CUT`+`PUT`; `CUT 5.=9 @fn` → `@fn`, `PUT >40 @fn` pastes. Single call-local move: unlabeled `CUT` + `PUT >40`. Named registers persist across edit calls.
- NEVER format/restyle with this tool; run project formatter.
</rules>

<example>
`read` output shape:
```
[greet.py#A1B2]
1:def greet(name):
2:    msg = "Hello, " + name
3:    print(msg)
4:greet("world")
```

Edit, then move:

```
[greet.py#A1B2]
PUT 1.=3:
+def greet(name):
+    print(f"Hi, {name}")
MV lib/greet.py
```

Markdown bullets — file receives `- task`:

```
[PLAN.md#A1B2]
PUT >2:
+- task
+  - nested task
```

Move `greet` to sibling file via named register; flows across sections:

```
[greet.py#A1B2]
CUT 1* @fn
[other.py#3C4D]
PUT <1 @fn
```

`PUT 1*:` resolves lines 1–3 (`def` through `print(msg)`); line 4 separate, remains:

```
[greet.py#A1B2]
PUT 1*:
+def greet(name):
+    print(f"Hello, {name}")
```

Decorator/doc-comment separate block: point N at decorator to include both; anchoring `def` line 2 orphans `@cache`:

```
[svc.py#C3D4]
PUT 1*:
+@cache
+def load(key):
+    return store[key]
```

</example>

<anti-patterns>
# WRONG — empty `PUT` to delete. RIGHT: `CUT 4.=4`
PUT 4.=4:

# WRONG — range sized to the post-edit content. RIGHT: `PUT 1.=1:` (body length irrelevant)

PUT 1.=2:
+def greet(name):

# WRONG — `-` rows / bare context lines do not exist; the range deletes, the body is only new content.

PUT 3.=3:
msg = "Hello, " + name

- print(msg)

* return msg

# RIGHT

PUT 3.=3:

- return msg

# WRONG — pure insertion as a widened `PUT`: retyped keepers get dropped (here line 4).

PUT 2.=4:

- msg = "Hello, " + name
- extra = compute(name)
- print(msg)

# RIGHT — touch nothing you keep.

PUT >2:

- extra = compute(name)

# WRONG — `PUT >N*:` anchored on the closing delimiter / last visible line. RIGHT: plain `PUT >M:`

PUT >3*:
+after()

# RIGHT

PUT >3:
+after()

# WRONG — body rows under register PUT; register pastes take no body. RIGHT: bodyless `PUT >20 @fn`.

PUT >20 @fn:
+function f() {}
</anti-patterns>

<critical>
1. RE-GROUND AFTER EVERY EDIT: edits renumber and change `#TAG`; take next numbers from edit response or fresh `read`. Stale tag/surprise: STOP; re-`read`.
2. RANGES TIGHT: changed lines only. Whole construct: `PUT N*:`.
3. BODY FINAL CONTENT: every row starts `+`; Markdown bullet: `+- item`, not `- item`.
</critical>
