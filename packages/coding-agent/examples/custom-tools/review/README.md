# Review Tools

Structured code review tools with findings accumulation and verdict rendering.

## Components

- **`report_finding`** - Report individual findings with priority (P0-P3), location, confidence
- **`submit_review`** - Submit final verdict with grouped findings summary
- **`/review`** - Interactive command to launch code review

Both tools have `hidden: true` - they only appear when explicitly listed in an agent's tools.

## Installation

From the repository root:

```bash
# Install review tools
mkdir -p ~/.pi/agent/tools/review
ln -sf "$(pwd)/packages/coding-agent/examples/custom-tools/review/index.ts" ~/.pi/agent/tools/review/index.ts

# Install /review command
mkdir -p ~/.pi/agent/commands/review
ln -sf "$(pwd)/packages/coding-agent/examples/custom-tools/review/commands/review/index.ts" ~/.pi/agent/commands/review/index.ts
```

## Usage with Subagent

The `reviewer` agent in the subagent example uses these tools. Make sure both subagent and review are installed:

```bash
# Also install subagent tools if not already done
# See: examples/custom-tools/subagent/README.md
```

Then use `/review`:

```
/review
```

This opens an interactive menu:
1. Review against a base branch (PR style)
2. Review uncommitted changes
3. Review a specific commit
4. Custom review instructions

## Tool Schemas

### report_finding

```typescript
{
  title: string;        // ≤80 chars, prefixed with [P0-P3]
  body: string;         // Markdown explanation
  priority: 0 | 1 | 2 | 3;
  confidence: number;   // 0.0-1.0
  file_path: string;
  line_start: number;
  line_end: number;
}
```

### submit_review

```typescript
{
  overall_correctness: "correct" | "incorrect";
  explanation: string;  // 1-3 sentences
  confidence: number;   // 0.0-1.0
}
```

## Priority Levels

- **P0**: Drop everything. Blocking release/operations.
- **P1**: Urgent. Address in next cycle.
- **P2**: Normal. Fix eventually.
- **P3**: Low. Nice to have.
