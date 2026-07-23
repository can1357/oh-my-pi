# GraphTree

`/graphtree` is a slash command for orchestrating multi-agent worktree execution and managing recursive agent lifecycles within an oh-my-pi session. It leverages oh-my-pi's core primitives (`AgentRegistry`, `AgentLifecycleManager`, settings bounds, and isolated task worktrees) alongside a static task-planning prompt.

`/graphtree run` is prompt-driven: it shapes how the model decomposes objectives, respects configured bounds, and dispatches subagent work. It does not replace the underlying task execution engine with an autonomous background daemon.

## Concepts

- **Root node** — your current checkout, on whatever branch is checked out.
- **Worktree node** — a `git worktree` created under the shared worktrees directory on its own branch (default `graphtree/<name>`, or an explicit branch passed to `init`). Worktrees are repository-scoped.
- **Agent Registry Node** — an agent entry tracked in `AgentRegistry` (Main agent or subagents). Holds status (`running`, `idle`, `parked`, `aborted`), activity, working directory, and attention flags.
- **Lifecycle Manager** — manages idle TTL, parking (session disposal with ref retention), and cold revival of parked agents (`AgentLifecycleManager`).

## Commands

| Command | Effect |
| --- | --- |
| `/graphtree` / `/graphtree status` / `/graphtree tree` | Print active worktree node hierarchy as an ASCII tree (root branch plus worktree nodes). |
| `/graphtree list` | Print active worktree nodes as a flat list with kind, branch, and path. |
| `/graphtree agents` | Render a bounded recursive `AgentRegistry` parent/child tree with sanitized status, attention, activity, and CWD context. |
| `/graphtree init <name> [branch]` | Create a new worktree node under the worktrees directory. |
| `/graphtree run <objective>` | Inject configured hard bounds (`task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs`, `task.isolation.mode`) into a static prompt template for multi-agent tree planning. |
| `/graphtree stop <agent-id>` | Abort and release a non-main, non-advisor subagent via `AgentLifecycleManager`. |
| `/graphtree steer <agent-id> <guidance>` | Send steering guidance to a subagent (revives the session via `AgentLifecycleManager` if parked). |
| `/graphtree revive <agent-id>` | Revive a parked subagent session via `AgentLifecycleManager`; live agents report their current state without claiming a transition. |
| `/graphtree merge <name>` | Squash-merge a completed worktree node's branch into `HEAD` as staged changes. |
| `/graphtree prune <name>` / `/graphtree cleanup <name>` | Remove a clean, named worktree node (refuses dirty worktrees). |
| `/graphtree help` | Show command usage guide. |

## External Fractal Parity Matrix

The table below maps capability concepts from external recursive agent architectures (`plasma-ai/fractal`, `TinyAGI/fractals`) to local oh-my-pi implementation primitives:

| Feature / Capability | External Systems (`plasma-ai/fractal`, `TinyAGI/fractals`) | Local oh-my-pi Primitive | Parity Implementation Details |
| --- | --- | --- | --- |
| **Recursive Dynamic Decomposition** | Dynamic runtime sub-tree spawning | `AgentRegistry` & nested task execution | Subagents spawn child subagents tracked in `AgentRegistry` with parent/child links. |
| **Isolated Worktrees & Workspaces** | Worktree clones & isolated folders | `task.isolation.mode` & `git worktree` | `/graphtree init` creates isolated worktrees; task isolation mode (`auto`, `apfs`, `overlayfs`, `reflink`) handles CoW / worktree execution. |
| **Bounded Execution & Guardrails** | Max depth, max parallel tasks, timeout limits | `task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs` | Configured settings are enforced by task execution gates and injected into the `/graphtree run` prompt template. |
| **Lifecycle Control & Intervention** | Pause, stop, steer, resume sub-tasks | `/graphtree stop`, `/graphtree steer`, `/graphtree revive` | Operates on `AgentRegistry` and `AgentLifecycleManager`. Prevents modification of `Main` or `advisor` refs. |
| **Session Persistence & Cold Revival** | Disk-backed agent state & resume | Parked session files (`sessionFile`) | `AgentLifecycleManager` disposes active sessions on idle TTL while retaining `sessionFile` for cold revival. |
| **Tree Visualizer** | Graph / tree TUI output | `/graphtree status` & `/graphtree agents` | Bounded ASCII tree rendering with complete-line truncation (`truncateToWidth`) and tab replacement (`replaceTabs`). |

## Residual Gaps & Architectural Boundaries

1. **Prompt-Driven Scheduling**: `/graphtree run` shapes model prompt context; subagent spawning relies on the model calling task tools rather than a standalone background daemon process.
2. **Turn-Based Steering**: Steering via `/graphtree steer` queues guidance for the target agent's next streaming turn or prompt cycle.
3. **Repository Scoping**: Worktree nodes are strictly bound to the active Git repository root.

## Lifecycle

1. `/graphtree init <name>` creates an isolated worktree node on its own branch.
2. `/graphtree run <objective>` generates a prompt for the model to plan and dispatch subagents within configured bounds.
3. `/graphtree agents` monitors live subagents, their parentage, activities, and attention requests.
4. `/graphtree stop`, `/graphtree steer`, or `/graphtree revive` provide operator controls for active or parked subagents.
5. `/graphtree merge <name>` squash-merges completed changes into `HEAD` as staged changes for review.
6. `/graphtree prune <name>` removes clean worktrees when finished.
