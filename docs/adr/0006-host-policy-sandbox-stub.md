# 0006. Policy on the trusted host; an obedient bounded stub in the sandbox

Status: accepted
Date: 2026-09-02
Area: runtime

## Context

The Factorio row of the envelope (0001) forces the placement question: when the repository and
tool input are hostile and no human is present, which process runs the tools? Three placements were
tried on paper; two fail.

**Executor in the VM.** The harness on the host asks a VM-resident executor to run tools. This
breaks on two facts:

- Programmatic tool use (Code mode, `Eval`) needs every tool in one namespace. Tools that touch
  harness state (session tree, settings, subagent spawn) and tools that touch environment state
  (files, processes) cannot be split by side, so the VM would need to reach back to the host.
- That reach-back is a duplex gateway from untrusted code into the trusted process. Either the
  gateway is open — and the VM can DoS the host — or it is rate-limited, and the harness is now
  rate-limiting its own VM on certain actions. Both outcomes add a second protocol for no gain.

**Driver in the VM.** Move the whole harness inside. Now the app's prompts and internal source are
inside the untrusted boundary. Fixing that means moving the app out and connecting over network RPC,
and moving session storage out — which requires granting the VM write access to session storage.
That is the duplex gateway again, with the same DoS and rate-limit problems, plus the leak.

**Stub in the VM.** A single obedient stub executes environment requests and streams results back.
The remaining hazard is bandwidth: a misused `Read` can return 2 GB, and the host must not let an
untrusted stream exhaust its memory or the model's context.

## Decision

The trust boundary is fixed as follows.

- The **host** MUST own session state, inference, policy, tool routing, approval, limits, and
  journaling. None of these move into the sandbox under any deployment.
- The **sandbox** MUST own only environment execution, reached through a small, obedient protocol.
  The stub NEVER initiates calls into host authority; it answers requests.
- Every stream that crosses back from the sandbox MUST be bounded on the host side before the
  untrusted side can exhaust host memory or context (0009). Bounding is a property of the transport
  and the call-outcome path, not of the tool that happened to be invoked.
- The same host MUST be able to point the stub at a local process, a container, a VM, or a remote
  machine. Local use is the stub running in-process; it is not a different architecture.
- Extensions and custom tools are environment execution: they run on the stub side of the boundary
  or in a host-supervised unit the host can kill (0011), never inside the host's authority.

## Consequences

- Factorio is satisfied without making local use worse: the local path is the remote path with a
  cheaper transport.
- Duplex gateways from sandbox to host are prohibited. A tool that needs harness state is routed by
  the host; the sandbox never sees session storage.
- Code mode and `Eval` keep one tool namespace because routing is a host concern (0025, 0036).
- Cost accepted: extension authors see two filesystems — the host's and the sandbox's. Making that
  pleasant is the job of `@remote` (0036), not a reason to blur the boundary.
- Cost accepted: every effect crosses a framed protocol even locally. The frame is bounded and
  typed, which is the point.

## Status in omp

**Partial.** Primary implementation: `crates/envd/src/server.rs`. Host policy and bounded environment
transport are implemented. The live `web_search@2` path is session-local policy: `omp-driver`
binds the one production inference facade into `omp-envd`'s search bridge, while provider HTTP
execution remains in the bounded host transport. Lifecycle-hook approval descriptions are generation-fenced in
`crates/envd/src/tools.rs`, then merged with native admission into one Core-owned durable ticket by
`crates/agent/src/{hooks,approvals,dispatch}.rs`; extension hosts never own or await the human
decision. Project daemon lifecycle stays behind the same typed boundary:
`crates/envd/src/{server,exec,process_store}.rs` owns readiness, durable generation fencing,
persistent-process idle leases, no-replace owner listeners, crash recovery, and bounded process-tree
cleanup, while `crates/app/src/{cli,ps_cmd}.rs` only dispatches and presents public operations. Gap:
remote/container/VM targets still use the full envd binary rather than a separately minimized stub.

## References

- The Harness Playbook, "The runtime" — "The sandbox should execute, not decide"
- 0001 (Factorio row), 0007 (filesystem form of this boundary), 0009 (bounding), 0011 (kill
  boundary), 0036 (`@remote` makes the boundary pleasant)
- `docs/architecture/processes.md`, `docs/architecture/crates.md`
- `crates/envd/src/{server.rs,admission.rs,exec_sandbox.rs,sandbox_proxy.rs,worker.rs}`,
  `crates/env/src/client.rs`
