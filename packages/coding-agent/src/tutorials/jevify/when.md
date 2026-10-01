Use `jevify` when you have about 20 or more similar items and the same question for each one: yes/no, a bucket, or a score.
Typical cases: file diffs in a large commit or PR, log lines, test names, search hits, issues, review findings.
Every item gets the same judgment, so nothing is skimmed. The model reads only the flagged items.
Skip it for fewer than about 20 items. Reading them directly is faster.
Skip it when the answer depends on several items together, such as a bug that spans two files or ordering between changes. The judge sees one item at a time.
Requires the eval tool.
