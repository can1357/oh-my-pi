Executes Python code in a persistent IPython kernel with optional timeout.

## When to use Python

**Use Python for user-facing operations:**
- Displaying, concatenating, or merging files → `cat(*paths)`
- Batch transformations across files → `batch(paths, fn)`, `rsed()`
- Formatted output, tables, summaries
- Any loop, conditional, or multi-step logic
- Anything you'd write a bash script for

**Use specialized tools for YOUR reconnaissance:**
- Reading to understand code → Read tool
- Searching to locate something → Grep tool
- Finding files to identify targets → Find tool

The distinction: Read/Grep/Find gather info for *your* decisions. Python executes *the user's* request.

**Prefer Python over bash for:**
- Loops and iteration → Python for-loops, not bash for/while
- Text processing → `sed()`, `cols()`, `sort_lines()`, not sed/awk/cut
- File operations → prelude helpers, not mv/cp/rm commands
- Conditionals → Python if/else, not bash [[ ]]

## Prelude helpers

All helpers auto-print results and return values for chaining.

{{#if categories.length}}
{{#each categories}}
### {{name}}
{{#each functions}}
- `{{name}}{{signature}}` — {{docstring}}
{{/each}}

{{/each}}
{{else}}
(Documentation unavailable — Python kernel failed to start)
{{/if}}

## Examples

```python
# Concatenate all markdown files in docs/
cat(*find("*.md", "docs"))

# Mass rename: foo -> bar across all .py files
rsed(r'\bfoo\b', 'bar', glob_pattern="*.py")

# Process files in batch
batch(find("*.json"), lambda p: json.loads(p.read_text()))

# Sort and deduplicate lines
sort_lines(read("data.txt"), unique=True)

# Extract columns 0 and 2 from TSV
cols(read("data.tsv"), 0, 2, sep="\t")
```

## Notes

- Code executes as IPython cells; users see the full cell output (including rendered figures, tables, etc.)
- Kernel persists for the session; use `reset: true` to clear state
- Use `workdir` parameter instead of `os.chdir()` in tool call
- Use `plt.show()` to display figures
- Output streams in real time, truncated after 50KB
