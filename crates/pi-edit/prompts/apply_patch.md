Edit files: `apply_patch` shell command.

`apply_patch`: stripped-down, file-oriented diff; easy to parse, safe to apply.

Envelope:
```
*** Begin Patch
[ one or more file sections ]
*** End Patch
```
Contains file operations. Each MUST have an action header:

`*** Add File: <path>`: create file; every following line `+` (initial contents).

`*** Delete File: <path>`: remove existing file; nothing follows.

`*** Update File: <path>`: patch existing file in place; optional immediate `*** Move to: <new path>` renames it; then one or more `@@` hunks (optional hunk header). Hunk lines start with space, `-`, or `+`.

Context: default 3 code lines immediately before and after each change. Changes within 3 lines: do NOT duplicate first change's context-after lines as second change's context-before lines. If 3 lines do not uniquely identify code in the file, use `@@` with its class/function; if one `@@` plus 3 context lines still cannot uniquely identify repeated code in a class/function, use multiple `@@` lines to reach it:
```
@@ class BaseClass
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]
```
```
@@ class BaseClass
@@ 	 def method():
[3 lines of pre-context]
- [old_code]
+ [new_code]
[3 lines of post-context]
```

Grammar:
```
Patch := Begin { FileOp } End
Begin := "*** Begin Patch" NEWLINE
End := "*** End Patch" NEWLINE
FileOp := AddFile | DeleteFile | UpdateFile
AddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }
DeleteFile := "*** Delete File: " path NEWLINE
UpdateFile := "*** Update File: " path NEWLINE [ MoveTo ] { Hunk }
MoveTo := "*** Move to: " newPath NEWLINE
Hunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]
HunkLine := (" " | "-" | "+") text NEWLINE
```

Full patches may combine operations:
```
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
```

MUST use Add/Delete/Update header; new-file lines MUST start `+`; file references relative, NEVER absolute.
