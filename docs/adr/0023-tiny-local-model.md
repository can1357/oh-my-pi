# 0023. An embedded tiny model handles harness chores

Status: accepted
Date: 2026-09-02
Area: inference

## Context

A harness generates a steady stream of small language tasks that have nothing to do with the user's
problem: classify this prompt's difficulty, title this session, translate this notice, judge whether
the user is getting frustrated, transcribe this microphone buffer, speak this reply. Sending each of
these to the frontier model pays frontier latency and frontier cost for a 300-token job, and does so
on every turn.

Sub-billion-parameter models (the playbook names LiquidAI's LFM2 line) answer these tasks well
enough when their output is constrained to a small ladder, and local speech models already reach
state-of-the-art quality for TTS and STT. Even a harness that only ever talks to frontier models
benefits from carrying one.

## Decision

The harness MUST embed a tiny local model as an internal capability, and route classification,
title generation, translation, sentiment, and local TTS/STT through it by default.

1. The tiny model is NEVER a second agent. It has no tools, no session, and no place in the
   transcript. It is a bounded internal operation with a fixed output ladder and earliest-match
   parsing, never free prose that a downstream parser has to trust.
2. It runs in-process under the same admission, memory, cancellation, and idle-unload lifecycle as
   any other local inference, with verified, root-confined model artifacts.
3. A pinned tiny model is NEVER silently promoted to a hosted one (cost leak, privacy incident);
   fallback is an explicit caller policy.
4. Local ML runs on Rust-native runtimes (candle); C/C++ binding graphs (whisper-rs, llama-cpp) are
   prohibited (`AGENTS.md`, Runtime).

## Consequences

- Session titles, auto-thinking difficulty, memory classification, and voice cost no frontier
  tokens and add no round trip.
- A chore that would otherwise need a hosted call still works offline and in the Factorio mode
  (0001) where no interactive user is waiting.
- Cost accepted: model artifacts are downloaded and verified once; the harness carries a local
  inference runtime and its memory reservation.

## Status in omp

**Partial.** Primary implementation: `crates/inference/src/lib.rs`. Gap: no embedded tiny local model is present for harness chores.

## References

- The Harness Playbook, "The inference" — "Use small local models for harness work"
- LiquidAI LFM2 (`huggingface.co/LiquidAI`)
- 0001, 0018
- `crates/inference/src/local/`, `crates/inference/Cargo.toml`, `AGENTS.md` (Runtime),
  `docs/py/13-inference.md`
