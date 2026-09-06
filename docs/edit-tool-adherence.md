# Edit-tool adherence by model

Some models do not use `edit`. They read a source file inside an `eval` cell, run
`.replace(old, new)` in Python or JavaScript, and write the whole file back. The
change lands, so nothing looks broken — but you lose the hashline snapshot check,
the edit preview card, and the token savings, and the model spends part of every
turn debugging its own escaping.

This page shows how to measure the behaviour in your own sessions, why it is a
model habit rather than a harness fault, and the three ways to stop it.

## The shape of the problem

A model that avoids `edit` produces cells like this:

```python
p = Path("orders.go")
s = p.read_text(encoding="utf-8")
old = '''func (a *application) ordersPage(w http.ResponseWriter, r *http.Request) {
	data := a.basePage(r, "orders", "Orders")
	...'''            # 40 lines of exactly-quoted old source
assert s.count(old) == 1
p.write_text(s.replace(old, new), encoding="utf-8")
```

The equivalent `edit` call names the line range and supplies only the new body.
The JavaScript form is the same move with `Bun.file` / `replaceAll` / `Bun.write`,
and the shell form is `sed -i`.

## Measure it

`scripts/session-stats/edit_adherence.py` walks your session logs and counts, per
model, the edit-tool calls against the read-replace-write cells. It reads the
JSONL directly, so it needs no `stats:sync` and no tiktoken:

```
$ bun run stats:adherence
201 session files under ~/.omp/agent/sessions

model                           edit  surgery  fail%  bypass%
gpt-5.6-sol                     6122       87   2.7%       1%
claude-opus-5                   1896      458   3.9%      19%
claude-fable-5                  2031      126   4.0%       6%
claude-fable-5-1                 269       76   1.1%      22%
z-ai/glm-5.3-flash               195       27  14.4%      12%
gpt-5.6-luna                      68       27   5.9%      28%
```

`bypass%` is the share of source changes that skipped the edit tool. `fail%` is
the share of that model's `edit` calls that returned an error. Numbers above are
one user's 201 sessions on omp 18.x; run it on yours before drawing conclusions.

Narrow the same scan to a single project and the split gets sharper. In one
25k-record session, `gpt-5.6-sol` made 372 Go edits through `edit` and 2 through
Python; `claude-opus-5` made 162 through `edit` and 173 through Python.

## It is not the edit tool failing

Three checks, all against the same logs:

1. **Failure rates do not track avoidance.** In the table above the model with
   the highest bypass share does not have the highest `edit` failure rate. In the
   session measured most closely, `claude-opus-5` failed 5 of 219 `edit` calls
   (2.3%) while routing 39% of its edits through Python; `gpt-5.6-sol` failed 14
   of 564 (2.5%) and routed 3%.
2. **Avoidance does not follow a failure.** Only 16 of 202 surgery cells in that
   session occurred within 60 records after a failed `edit`. The rest started
   cold: the model never tried `edit` for that change.
3. **The causation runs the other way.** 13 of 27 `edit` failures in that session
   were snapshot rejections — `hash #XXXX is not from this session` or `file
   changed between read and edit`. An external write is exactly what produces
   them: the cell rewrites the file, the hashline anchor the model still holds
   goes stale, and the next `edit` is refused. Surgery manufactures the failures
   that appear to justify surgery.

A model that writes source from `eval` on its first attempt is expressing a
prior, not reacting to your setup.

## What it costs

- No snapshot check. `edit` rejects a patch when the file moved under the model;
  `write_text` overwrites whatever is there now.
- No preview card and no diff in the TUI. The change is invisible until you read
  the file or the commit.
- The old block must be re-quoted verbatim, so a multi-line change pays for the
  old text and the new text, and one wrong space turns into a failed assertion or
  a wrong replacement.
- The payload is a string inside another language. Every `\n`, quote, and
  backslash in the target file becomes an escaping problem in the cell.
- Whole-file rewrite touches encoding and line endings on files the change never
  intended to reach.

## Three fixes, cheapest first

### 1. A rule that fires only when it happens

Rules cost nothing until the pattern appears in the stream. Put this in
`~/.omp/agent/rules/edit-tool-only.md` (user-wide) or `.omp/rules/edit-tool-only.md`
(one project):

```markdown
---
description: Source edits go through edit/ast_edit/lsp, never through a rewritten file
condition:
  - "write_text\\s*\\(|open\\s*\\([^)]*['\\\"][wa]"
  - "Bun\\.write\\s*\\(|writeFileSync\\s*\\("
  - "\\bsed\\b\\s+-[a-z]*i|\\bperl\\b\\s+-[a-z]*i"
---

Do not rewrite a source file from a code cell or the shell.

- one hunk -> `edit`
- a pattern across files -> `ast_edit`
- a symbol -> `lsp` rename
- a brand new or fully replaced file -> `write`

`assert count == 1` does not make string surgery safe: it bypasses the hashline
snapshot, hides the diff from the user, and invalidates the anchors the next
`edit` needs.
```

`condition` entries are regexes matched against the streamed turn; the default
scope covers text and tool-call arguments, so the surgery cell matches while the
model is still writing it. Under the default interrupt mode the stream aborts and
the turn retries with the rule attached; with `interruptMode: never` the rule is
folded into that tool call's result as a `<system-reminder>` instead. See
[rulebook-matching-pipeline.md](rulebook-matching-pipeline.md) for the matching
pipeline and [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.md) for the
interrupt-and-retry lifecycle.

### 2. Pin the tool set for edit-heavy work

If a run is meant to change code and not to compute anything, do not offer the
kernel at all:

```bash
omp --tools read,grep,glob,edit,ast_edit,lsp,write,bash
```

The model cannot reach for `eval` if `eval` is not in the session.

### 3. Block it outright with a pre-tool hook

A rule persuades; a hook enforces. `.omp/hooks/pre/eval.ts` (project) or
`~/.omp/agent/hooks/pre/eval.ts` (user-wide) runs before every `eval` call and can
refuse it:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const SURGERY = [
	/\bwrite_text\s*\(/, // python: Path(...).write_text(...)
	/\bopen\s*\([^)]*['"][wa]/, // python: open(path, "w")
	/\bBun\.write\s*\(/, // bun
	/\bwriteFileSync\s*\(/, // node
	/\bfs\.promises\.writeFile\s*\(/,
];

export default function (api: HookAPI) {
	api.on("tool_call", async (event) => {
		if (event.toolName !== "eval") return;
		const input = event.input;
		const raw = input && typeof input === "object" && "code" in input ? input.code : undefined;
		const code = typeof raw === "string" ? raw : "";
		if (!SURGERY.some((re) => re.test(code))) return;
		return {
			block: true,
			reason:
				"eval must not write source files. Use edit for a hunk, ast_edit for a codemod, " +
				"lsp rename for a symbol, or write for a whole new file.",
		};
	});
}
```

The returned `reason` becomes the tool error the model reads, so it retries with
`edit` instead of guessing why the cell failed. Add a sibling
`.omp/hooks/pre/bash.ts` with the `sed -i` pattern if your models reach for the
shell. Hook discovery, event names, and blocking semantics are in
[hooks.md](hooks.md).

## Which fix to use

| Situation | Fix |
| --- | --- |
| Model mostly behaves, occasional relapse | rule (1) |
| Long unattended run, edits only | pinned tool set (2) |
| Model with a high bypass share, or a repo where a bad rewrite is expensive | hook (3) |
| Choosing a model for an edit-heavy job | measure first, then pick a low-bypass one |

Generated files and a genuine bulk mechanical pass are the honest exceptions.
Keep those in a committed script and run the project formatter afterwards, rather
than as an ad-hoc cell in the middle of a turn.
