# P2 — GraphTree Fractal parity contract tests

Own only `packages/coding-agent/test/slash-commands/graphtree.test.ts`.

Add behavioral tests for the contracts in `.prd/graphtree-fractal-parity-orchestration.md`: recursive AgentRegistry rendering, configured bound values in the run prompt, stop abort/release, steer ensure-live/prompt, revive, and Main/advisor/unknown guardrails. Namespace-import dependencies and use per-test spies; reset AgentRegistry after each test. Avoid global environment mutation, `mock.module`, placeholder assertions, source grep, and bare `not.toThrow`. Preserve all existing lifecycle tests. Tests may initially fail against the base branch because P1 is parallel. Do not modify production. Commit as `test(graphtree): cover recursive agent lifecycle controls` and report expected integration assumptions.
