Submit compressed source draft + every drop.

- `text`: complete, verbatim, ready-to-ship compressed output; NEVER diff, summary, or edit description.
- `losses`: one entry per omitted claim, qualifier, default, bound, example, or exact string; quote/name it and why omission remains correct. Empty array: no losses.

Each call: review turn → reply with draft, measured size, declared losses; ask verdict. `rewrite` replaces draft; `approve` accepts.

<critical>
- Declare losses honestly: declared losses auditable; undeclared loss: silent regression.
- `text` MUST stand alone: reader without source can execute it.
- New draft supersedes earlier approval.
</critical>
