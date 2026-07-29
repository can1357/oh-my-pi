# Lane C — Tool and collaboration policy [parallel-builder+remediation]

## 1. Mission + read-first

You are the parallel-builder+remediation sub-agent for oh-my-pi-fork at `C:/dev/desktop-projects/oh-my-pi-fork`. Build hard, source-aware tool envelopes and persisted collaboration-policy primitives so constrained agents cannot widen themselves while independent swarms preserve current behavior.

**Read first** (each in full):
- `.prd/small-model-orchestration-overview.md`
- `.prd/small-model-orchestration-A-foundations.md`
- `.ompk/mapreduce/small-model-orchestration/implementation-inventory.md` — INV-03 and INV-06
- `packages/coding-agent/src/tools/index.ts` — read-only central wiring; do not edit
- `packages/coding-agent/src/irc/bus.ts` — read-only central wiring; do not edit
- `packages/coding-agent/src/registry/agent-registry.ts` — read-only central wiring; do not edit
- `packages/coding-agent/src/tools/bash-command-fixup.ts`

## 2. Owned files

You may ONLY edit these files:
- `packages/coding-agent/src/tools/tool-profiles.ts` (new)
- `packages/coding-agent/src/orchestration/collaboration-policy.ts` (new)
- `packages/coding-agent/src/tools/search-tool-bm25.ts` (existing)
- `packages/coding-agent/src/discovery/helpers.ts` (existing)
- `packages/coding-agent/src/tools/read.ts` (existing)
- `packages/coding-agent/src/edit/index.ts` (existing)
- `packages/coding-agent/src/tools/bash.ts` (existing)
- `packages/coding-agent/src/tools/bash-command-fixup.ts` (existing)
- `packages/coding-agent/src/prompts/tools/read.md` (existing)
- `packages/coding-agent/src/prompts/tools/replace.md` (existing)
- `packages/coding-agent/src/prompts/tools/apply-patch.md` (existing)
- `packages/coding-agent/src/prompts/tools/bash.md` (existing)
- `packages/coding-agent/test/tools/tool-profiles.test.ts` (new)
- `packages/coding-agent/test/orchestration/collaboration-policy.test.ts` (new)
- `packages/coding-agent/test/tools/bash-windows-heredoc.test.ts` (new)
- `packages/coding-agent/test/tools/tool-profile-grammar.test.ts` (new)
- `packages/coding-agent/test/tools/task-agent-capabilities.test.ts` (existing)

You may NOT edit `tools/index.ts`, AgentSession, AgentRegistry/lifecycle, IRC, persisted revive, task files, settings/config, extensions, eval, router package, package manifests, changelogs, or Lane B/D/E files.

## 3. Gap (verbatim from the table)

> C — Tool and collaboration policy: Convert agent tool lists from seeds into immutable source-aware ceilings, constrain model-facing grammar by tier/autonomy, and define report-only/message-peers/self-coordinate authorization for discovery/wake/reply (0% complete). [LARGE] depends on: A | files: tool/collaboration policy modules, discovery/BM25/read/edit/bash admission, prompt assets, focused tests

## 4. What to build

### Hard tool envelopes

Export pure policy types/functions from `tool-profiles.ts`:

```ts
export type ToolSource = "builtin" | "mcp" | "extension" | "custom" | "hidden";
export interface ToolCapability { source: ToolSource; name: string; }
export interface ResolvedToolProfile { maximum: readonly ToolCapability[]; editMode: AgentEditMode; allowDiscovery: boolean; }
export function resolveToolProfile(input: ToolProfileInput): ResolvedToolProfile;
export function isToolCapabilityAllowed(profile: ResolvedToolProfile, capability: ToolCapability): boolean;
export function filterToolCapabilities(profile: ResolvedToolProfile, candidates: readonly ToolCapability[]): ToolCapability[];
```

The effective maximum is model-tier maximum ∩ `AgentDefinition.tools` ∩ autonomy cap ∩ workflow policy. Source identity matters: an extension named `read` is not the built-in `read`. Rules:
- light: local read/find/search plus explicitly classified control tools; no arbitrary shell/eval/task/job/discovery/browser/MCP/extension activation;
- mid: guarded replace editing, declared procedure tools, bounded coordination;
- frontier: broad catalog, still subject to explicit bound/supervised policy;
- `tools: []` is explicit deny-all except policy-classified control tools (`yield` where required), never omission;
- automatic AST/memory/resolve/QA additions, restored/forced tools, and active-set mutation may only intersect this maximum;
- model tier never grants autonomy.

Lane E wires construction and extension/session activation. Your module and BM25 path must expose enough source-aware metadata for that gate.

### Agent discovery

Update frontmatter parsing so omitted tools and explicit empty tools remain distinguishable. Stop inferring unrestricted `spawns: "*"` solely because `task` is present; preserve compatibility only when no explicit execution policy exists, with an explicit legacy branch. Do not resolve settings in discovery helpers.

### BM25 discovery

Accept an injected capability predicate/profile filter. Search/ranking may include only eligible discoverable documents; activation must recheck the same `(source,name)` capability before calling generic or legacy callbacks. Do not silently return a forbidden name.

### Grammar profiles

Implement profile-aware runtime grammar selection in `tools/read.ts` and `edit/index.ts`, with optional frozen `ResolvedToolProfile` input and legacy behavior when absent. Lane E passes the profile through `ToolSession`/`createTools`; this lane owns the actual read description/schema and edit mode/schema selection.

Required mapping:
- light: simple local read selectors only and no existing-file mutation unless explicitly upgraded;
- mid: guarded replace editing;
- frontier: hashline/apply-patch only when resolved edit mode allows it.

Prompt text must describe exactly the schema/runtime mode selected. Do not implement a new read-lite/write-lite tool; enforce a narrowed schema/description on the existing tool.

### Collaboration policy

Export pure authorization and persistence data:

```ts
export type PeerScope = "parent" | "family" | "allowed" | "all";
export type WakePolicy = "deny" | "queue" | "allow";
export interface CollaborationPolicy { mode: CollaborationMode; peerScope: PeerScope; allowedPeers: readonly string[]; wakePolicy: WakePolicy; wakeBudget: number; allowBusyModelReply: boolean; }
export function canDiscoverPeer(...): boolean;
export function authorizeIrcDelivery(...): CollaborationDecision;
export function serializeCollaborationPolicy(...): PersistedCollaborationPolicy;
export function hydrateCollaborationPolicy(...): CollaborationPolicy;
```

Semantics:
- `report-only`: parent result/blocker only; no roster beyond parent, broadcast, peer wake, or autonomous busy-side reply;
- `message-peers`: declared peer group, bounded wake/message budget, parent controls topology expansion;
- `self-coordinate`: current flat independent-swarm behavior unless explicitly narrowed;
- no-policy legacy defaults preserve today's behavior;
- authorization occurs before any wake budget is consumed; decisions are deterministic and include a stable reason code;
- policy serializes losslessly for cold revival.

Lane E wires AgentRegistry visibility, IrcBus pre-wake checks, AgentSession side-channel behavior, and persisted revive.

### Windows heredoc discipline

Use a parser-backed predicate if the existing native shell surface exposes one; inspect installed API types before guessing. For a bound/procedural Windows profile, reject a confirmed heredoc before execution with `write script file -> execute file`. Do not reject unrestricted profiles or safe multiline commands.

If no safe parser predicate exists inside owned files, do **not** ship regex detection. Add exactly:

```ts
// SOFT-SPOT(WIN-HEREDOC-PARSER): native shell parser exposes fixup but no safe heredoc predicate; prompt guidance remains until the native API is extended.
```

and record the blocker. The acceptance lane must then mark this one criterion deferred rather than pretend it is enforced.

### Tests

Prove source shadowing, auto-addition filtering, deny-all distinction, tier/autonomy independence, BM25 double-check, collaboration decisions/persistence, and legacy independent-swarm behavior. `tool-profile-grammar.test.ts` must instantiate the profile-aware read/edit selectors and prove light/mid/frontier receive the enforced schemas and descriptions, not prompt text alone.

## 5. Hard constraints

1. No new dependencies; inspect existing native package types before using a parser API.
2. Post-merge coding-agent typecheck must pass; do not run it in a dependency-less worktree.
3. No edits outside the owned-files list. Verify via `git diff --name-only`.
4. Additive APIs only. Lane E owns all central construction, registry, IRC, session, and extension wiring.
5. Tests assert runtime authorization outcomes, not prompt text alone.
6. `[parallel-builder+remediation]`: add only the named policy modules and scoped discovery/BM25/read/edit/bash changes; no remote owner policy (INV-07), eval, assignment contract, router, or unrelated refactor.
7. No `any`, `ReturnType<>`, inline imports, regex heredoc detector, read-lite/write-lite runtime, or prompt-only capability claim.
8. Do NOT run npm/yarn/pnpm/Bun project commands, project-wide build/test/lint/format, or `tsc` in this worktree.

## 6. Verification

Run before declaring done:

```bash
git diff --check
git diff --name-only
git status --short
```

Expected:
- `git diff --check` exits 0.
- `git diff --name-only` may omit new files; the union of `git diff --name-only` and `git status --short` lists ONLY the seventeen owned files.
- Heredoc criterion has either parser-backed implementation/tests OR the exact `SOFT-SPOT(WIN-HEREDOC-PARSER)` comment and a blocker—never a regex approximation.
- Main later runs the five focused tests, prompt formatting, Biome, and coding-agent typecheck.

## 7. Commit message

`feat(orchestration): enforce tool and collaboration policies (Gap C)`

## 8. Final report

```text
### Lane C final report
- Worktree path / branch:
- Files modified / created:
- Public exports added (signatures):
- @ts-expect-error suppressors added (count + which imports): <or "none">
- Lines added / removed:
- Verification:
  - git diff --check: ___
  - heredoc implementation or SOFT-SPOT: ___
  - deferred Bun/type gates: listed for Main
  - git diff --name-only: ___
- Flags / blockers:
```
