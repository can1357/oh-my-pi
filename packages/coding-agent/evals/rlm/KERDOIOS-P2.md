# Kerdoios P2 notes (Groq coprocessor)

Do **not** redesign Kerdoios in P0. Before P2 dynamic allocation, update:

## Deprecated Groq free-tier model IDs

Kerdoios static allowlists may still reference models Groq shut down in Jul/Aug 2026:

- `llama-3.1-*` / `llama-3.3-*` (replaced by GPT-OSS)
- older `qwen-3-32b` lines (replaced by GPT-OSS / Qwen 3.8)

Verify against live Groq deprecations docs and OMP model registry discovery.

## P2 allocation contract

RLM should emit capability requests, not hard-coded provider strings:

```text
capability = context.extract
privacy = public
deadline_ms = 400
max_input_tokens = 3000
max_output_tokens = 300
```

Kerdoios chooses among local / Groq 20B / Groq 120B / frontier using:

- live quota headers (already parsed)
- observed p50/p95 latency
- tokens per verified task
- capability success rate

## Flex tier (prepare only, post-P0)

When on a paid plan, speculative prepare may use Groq Flex (`service_tier=flex`); critical path stays on-demand.
