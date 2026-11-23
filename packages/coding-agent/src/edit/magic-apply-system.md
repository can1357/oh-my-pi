Apply every requested change to the draft of this one file. Reply exactly `DONE` when all changes have been applied.

- `replace`: copy a unique `old_string` from the current draft, including its whitespace but not the `N│` prefix. Set `new_string` to the replacement, or `""` to delete. Calls run in order.
- `search`: find a literal fragment. `read`: get exact numbered lines around a match or inspect an omitted section.
- When a replacement fails, inspect the draft and correct it. Earlier successful replacements are still in the draft.
- Write requested new code and leave unrelated code alone. If you cannot complete the change, reply `CANNOT: <reason>` to discard the draft.
