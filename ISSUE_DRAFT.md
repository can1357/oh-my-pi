## Summary
When the standard GPT usage limit is reached, the app errors instead of falling back to the "gpt-reserve" usage tier recently added by OpenAI, which allows continued usage at a different rate (5.6 luna) even after standard limits are exhausted.

## Steps to reproduce
1. Exhaust the standard GPT usage allocation (e.g., via heavy agent use).
2. Attempt another GPT-powered operation (e.g., agent prompt, completion).
3. Observe error: `Codex error event: The usage limit has been reached (code=usage_limit_reached)` followed by retry failure due to excessive wait time.

## Expected behavior
The client should detect the `usage_limit_reached` error and transparently switch to using the `gpt-reserve` tier (if available in the user's plan) to continue servicing requests without user-facing errors.

## Actual behavior
The client treats `usage_limit_reached` as a fatal error, triggering a retry with an excessively long wait time (>30s) that exceeds the client's `retry.maxDelayMs` limit, causing the operation to fail.

## Proposed fix
- Add logic to interpret `usage_limit_reached` as a signal to attempt the request under an alternate model/provider tag such as `gpt-reserve`.
- Update provider/model routing configuration to include a reserve tier fallback.
- Surface reserve-usage metrics in `omp stats` or similar diagnostics for transparency.

## Additional context
This matches behavior seen in other OpenAI-integrated clients that support priority/reserve access tiers. The reserve tier is intended precisely for scenarios like agent-based automation where intermittent bursts exceed standard rate limits but total consumption remains within licensed bounds.