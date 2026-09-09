# 0036. Embedded Python for extensions, `@remote`, and `Eval`

Status: accepted
Date: 2026-09-02
Area: stack

## Context

Once the engine is Rust (0035), the open question is whether to invite TypeScript back for
extensibility, as pi did. The answer is no, for five reasons the post gives:

1. Agents output decent Python. By extension, they output decent extensions.
2. A spec-compliant JavaScript *runtime* is effectively impossible at a small footprint (the
   `Intl`/Locale surface alone), and a JS engine without the npm ecosystem has no advantage over
   embedding Lua.
3. Extensions do not account for even 1% of a session's run time. A fast JIT buys nothing.
4. A full Python runtime embedded in the binary guarantees the `Eval` tool works out of the box.
   Otherwise the harness must ask the user to please install python3 and can never rely on it in
   the flows it ships.
5. Python code can inspect itself by default (`inspect`, `ast`, code objects) and has an excellent
   attribute system. That is why Modal's SDK can offer remote function execution with a decorator,
   and it is what makes the runtime chapter's `@remote` design possible.

The `@remote` need comes from 0006: a deliberately dumb sandbox stub means extension authors see
two filesystems. Without help, a custom edit function has to read a file on one side, transfer it
in full, and write it back on the other. Python's introspection lets the SDK inspect a function,
package the source it needs, and submit it to the sandbox runtime, so a local-looking function
becomes an RPC without every extension author hand-writing one.

The runtime chapter also fixes the cancellation requirement (0011): extensions sharing the
engine's isolate cannot be killed once they escape cooperative cancellation, and hot reload
becomes nearly impossible. The extension runtime therefore has to be an execution unit the host
can actually terminate.

## Decision

1. Extensions, `Eval`, and `@remote` bodies run on ONE embedded runtime: statically linked,
   free-threaded CPython, with the standard library and repository-provided modules frozen into
   the binary. The harness NEVER depends on a host-installed interpreter.
2. There is NO JavaScript/TypeScript plugin runtime and NO multi-language `Eval`. Adding a second
   extension language requires superseding this record.
3. Remote execution is a decorator, not an RPC the author writes:

   ```python
   import omp_remote

   @omp_remote.remote
   def double(a):
       return a * 2

   omp_remote.connect("/tmp/worker.sock")
   assert double.remote(21) == 42
   ```

   Function bodies ship once, content-addressed by hash; subsequent calls carry only arguments.
   Arguments and results cross the socket with out-of-band buffers so bulk data is not copied
   through intermediate strings. Placement of a device body (`place="host" | "env" |
   "worker:<name>"`) MUST be declared on the device; bulk bytes never traverse the host to reach a
   place they were never needed.
4. Native wheels are the only filesystem exception: the user installs them with any free-threaded
   3.14 interpreter into `$OMP_PY_SITE` (default `~/.local/share/omp-py/site-packages`), which is
   the single authorized search path. Pure-Python dependencies the harness itself needs are pinned
   with hashes and frozen, never fetched at runtime.
5. Every extension host and every eval session is a killable child process (0011). The engine
   process NEVER executes extension Python on its own thread.

## Consequences

- `Eval` is a dependable builtin in every operating mode of 0001, including autonomous jobs on
  hosts with no Python installed.
- Extension authors write one function and choose where it runs; the two-filesystem problem of
  0006 is absorbed by the SDK rather than by each edit tool.
- Free-threaded CPython lets workers execute concurrent calls on real threads, so a warm named
  worker can serve parallel invocations without a process per call.
- Prohibited: `require()`/`import` of npm packages in extensions, a JS sandbox for "just this
  one" plugin, `Eval` dispatching on a language tag, runtime `pip install` by the harness.
- Cost accepted: the binary carries an interpreter and a frozen stdlib. Shipped code executes as
  the worker's user — `@remote` is arbitrary code execution by design, so peers MUST be mutually
  trusted and the socket authenticated (HMAC handshake) or tunneled; that trust boundary is
  documented, not papered over.
- Cost accepted: pi's TypeScript extensions are not portable; the ecosystem restarts in Python.

## Status in omp

**Partial.** Primary implementation: `crates/py/src/lib.rs`. Embedded free-threaded CPython, Eval,
Directors, Components, and manifest-sealed custom-message renderer callbacks are implemented.
`crates/ext` and `crates/app/src/ext_cli` implement signed-index resolution, target-evaluated
dependency markers, reproducible lock identity, TOFU/operator key decisions, exact capability
grants, offline admission, integrity doctor checks, and kill-on-drop resolver/installer children;
renderer results retain their exact extension/declaration/generation identity in the session tree.
The supervised Eval child retains one owner-scoped namespace and asyncio runner, supports top-level
await and typed MIME/display bundles, and resolves `output()` through authenticated
journal-derived `agent://`/job projections plus the shared `artifact://sha256/` CAS; no session
sidecar path enters the Python environment.
`crates/driver/src/discovery/native.rs` admits only Python manifests and contained entry modules,
contains package-local discovery/load errors, and projects manifest-sealed generated skills into
the ordinary skill resolver. Portable Agent Plugins 1.0 packages are admitted only as contained,
data-only skill/MCP resources by `crates/driver/src/discovery/skills.rs` and
`crates/envd/src/mcp/discovery.rs`; their JavaScript/TypeScript hooks and tools are never executed.
`crates/envd/src/exthost/{lifecycle.rs,extensions.rs}` and
`crates/envd/src/worker.rs` own declaration freeze, activation, command/tool/hook/convar/
Director/Component registration, and atomically retarget retained Python callbacks when a
supervised child advances generation during crash recovery or hot reload. The authenticated eval bridge in
`crates/envd/src/eval/bridge.rs` capability-gates `__workpool__`; the Python prelude exposes
`workpool()`/`WorkPool` only while a live parent scheduler is bound, and binding retirement cancels
its process-local pools. Eval cells can define typed, revisioned `@tool` handlers; an authenticated
workpool creation seals their schema, opaque handler identity, namespace generation, and reset
epoch, then worker calls execute in the owning retained eval process through the ordinary registry
and cancellation/CAS path. No process-global tool roster exists. Gap: complete `@remote` placement,
scoped env handles, and spill diversion remain unproved.

## References

- The Harness Playbook, "The stack" — "Python for extensions"; "The runtime" — "Cancellation
  requires a kill boundary", "Make the mandatory boundary pleasant"
- 0006 (dumb sandbox stub that creates the two-filesystem problem), 0011 (kill boundary), 0007
  (subagent filesystem views), 0035 (why TypeScript is not the engine language), 0025 (code
  surfaces carry the long tail)
- `crates/py/README.md`, `crates/py/python/omp_remote.py`, `crates/envd/src/worker.rs`,
  `crates/tools/src/eval.rs`, `docs/py/00-overview.md`, `docs/py/04-placement.md`,
  `docs/architecture/extensions.md`, `AGENTS.md` "Locked Deviations from pi", "Embedded Python"
- Prior art named by the post: Modal's Python SDK (`@remote`-style functions), Lua as the
  no-ecosystem alternative, ECMA-402 `Intl`/Locale as the JS runtime footprint problem
- python-build-standalone (astral-sh) as the vendored interpreter source
