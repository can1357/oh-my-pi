# P1 — GraphTree live orchestration adapter

Own only:
- `packages/coding-agent/src/slash-commands/builtin/graphtree.ts`
- `packages/coding-agent/src/slash-commands/builtin/graphtree-run.md`

Implement all P1 behavior from `.prd/graphtree-fractal-parity-orchestration.md` by reusing `AgentRegistry`, `AgentLifecycleManager`, `USER_INTERRUPT_LABEL`, runtime settings, and existing session methods. Do not add a second scheduler or persistence format. Keep the run prompt static Markdown with Handlebars values. Keep all existing worktree lifecycle behavior intact. Sanitize/truncate every displayed agent field. Handle cycles/orphans defensively. Do not control Main or advisor refs. Do not use console output. Run focused type/format checks, commit as `feat(graphtree): expose live recursive agent control`, and report changed files and caveats.
