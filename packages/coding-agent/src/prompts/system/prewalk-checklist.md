Before task complete, verify:

- Consistency: If a pattern, signature, or check changed in one place, grep every other call site or duplicate copy needing identical change. A fix at only some matching sites fails.
- Scope: If diff exceeds the minimal issue-resolving change, confirm behavior unchanged outside the reported issue. Prefer the smallest correct diff over a broader rewrite.
- Verification: Run the issue's full test module or file, not only the expected-to-flip test. A sibling-test-breaking change fails.

Do not claim task complete until all three checks done.
