Creates a context checkpoint before exploratory work so you can later rewind and keep only a concise report.

Use this when you need to investigate with many intermediate tool calls (read/grep/glob/lsp/etc.) and want to minimize context cost afterward.

Rules:
- You MUST call `rewind` before yielding after starting a checkpoint.
- You NEVER call `checkpoint` while another checkpoint is active.
- Not available in subagents.

Typical flow:
1. `checkpoint(goal: …)`
2. Perform exploratory work
3. `rewind(report: …)` with concise findings

After rewind, intermediate checkpoint messages are removed from active context and replaced by the report.
