An automated edit just modified a region of a {{lang}} file and the file no longer parses. The BEFORE region parsed; the AFTER region contains the syntax error.

BEFORE (valid {{lang}}):
```
{{before}}
```

AFTER (broken):
```
{{after}}
```

Task: output the corrected AFTER region. Keep the intended change from BEFORE to AFTER; fix ONLY the syntax error (e.g. stray/missing braces, duplicated or truncated lines). Do not revert the intended change. Output only the corrected code, no commentary, no code fence.
{{#if previousAttempt}}

A previous attempt produced the following, and the file STILL did not parse after splicing it in place of the AFTER region. Produce a better correction. Reproduce the surrounding context lines of AFTER exactly (including leading whitespace); the output replaces the AFTER region line-for-line.

PREVIOUS ATTEMPT (rejected):
```
{{previousAttempt}}
```
{{/if}}
