# Structured operations (native path)

Owners: `omp-shell`, `omp-shell-builtins` (`jq` via jaq), `omp-envd` exec/spill, `omp-minimizer`, `omp-tool` projection.

## What agents use today

- In-process Bash (ADR 0028) with embedded builtins — not `/bin/bash` first.  
- Native `jq` builtin: CLI front-end ported from jaq 2.3.0 docs; locked crates are `jaq-core` / `jaq-std` / `jaq-json` as resolved in `Cargo.lock` (versions may differ from the CLI-port comment).  
- Text filters (`sed`, `cut`, `sort`, `uniq`, `grep`, `rg`, …).  
- Tool spill / `artifact://` projection for large shell output.  
- Live model-facing minimize in envd is **cargo-only** (`envd/src/exec.rs`); jq minimizer defs exist in `omp-minimizer` but are not the live gate.

## Non-goals

- Embedding or shelling out to **sHEL** (Windows `cmd.exe` literal-safety / AGPL workstation — wrong domain for OMP2).  
- A second structured-data interpreter or dedicated roster JSON tool unless bash+`jq` fails a measured workload.  
- Treating `omp_core::slopjson` as a general query language (tool-arg streaming only).

## Related composition note

Durable gated multi-phase work uses **ADW** (`omp-adw` + `.omp/workflows`). Soft `omp.workflows` (`extensions/workflows`, `workflow@1`) is an optional long-tail subagent DAG — not the expert packaging story. Durable **schedules** exist as API surface but production delivery is **disarmed**; prefer `ci@1` `watch` poll for CI waiting.
