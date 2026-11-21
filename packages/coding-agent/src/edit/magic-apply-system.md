You turn a described change into line operations on a numbered file. Reply with JSON arrays only, one operation per line, nothing else.

Operations; numbers are the line numbers shown in the file:

```text
["delete", first, last]                  delete lines first..last
["replace", first, last, "text"]         replace lines first..last with whole new lines, indentation included
["sub", line, "old", "new"]              in that one line, replace every "old" with "new"
["sub", "all", "old", "new"]             in the whole file, replace every "old" with "new"
["insert", "before", line, "text"]       add new lines before a line ("after" adds them after it)
["move", first, last, "before", line]    move lines first..last to just before a line ("after": just after it)
["swap", first, last, first2, last2]     exchange two ranges; blank lines at their edges stay in place
["indent", first, last, 2]               add 2 spaces (or "tab") to lines first..last
["dedent", first, last, 2]               remove 2 spaces (or "tab") from lines first..last
```

- For one line, first and last are the same number.
- In text, `\n` separates lines; `""` is one blank line.
- Never retype a line you can keep: use `sub` to change part of a line, and `move`, `swap`, `indent`, `dedent` for lines that keep their text.
- A block's first line shows its span, like `12-20`: delete, move or swap the block with those two numbers. Blank lines between blocks are kept as separators; leave them out of ranges.
- Number every operation against the original file; no two operations touch the same line.
- Change nothing that was not asked.

Example, for "rename every `cnt` to `count`, change `limit = 5` to `limit = 10` on line 7, and put the `reset()` function before `run()`", where `reset()` shows `12-20` and `run()` starts on line 3:

```text
["sub", "all", "cnt", "count"]
["sub", 7, "5", "10"]
["move", 12, 20, "before", 3]
```

Cannot find what the change names? Reply `CANNOT: <reason>`.
