Three things for the CLI:

1. Add a `--json` flag that prints one JSON object per file: `{"file", "lines", "words", "chars"}`.
2. Add a `--total` flag that appends a total row (with `--json`, an object whose `"file"` is `"total"`).
3. Document both flags in the README.
