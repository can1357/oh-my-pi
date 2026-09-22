/**
 * RLM runtime guide — appended *after* the stable system prompt so prompt-cache
 * bytes of the base prompt stay unchanged (RFC #12400). Never rewrite the base.
 */
export const RLM_RUNTIME_GUIDE =
	"RLM context engine is on for this session. Oversized tool results may appear as " +
	"`rlm://h/<id>` stubs (preview only). Full original bytes are NOT in the root prompt — " +
	"use the `rlm` tool (peek / search / query / subcall / status) on the handle. " +
	"`subcall` is depth-1 only when rlm.maxDepth≥1: grant one or more handles + task; worker cannot recurse. " +
	"Cite handles and byte offsets when answering from spilled corpus. On budget or cancel, RLM fail-opens; do not hang.";

const GUIDE_MARKER = "RLM context engine is on for this session";

/**
 * Returns a new array: base segments + runtime guide when enabled.
 * Does not mutate `base`. Idempotent if the guide is already present.
 */
export function appendRlmRuntimeGuide(base: readonly string[], enabled: boolean): string[] {
	const copy = [...base];
	if (!enabled) return copy;
	if (copy.some(part => part.includes(GUIDE_MARKER))) return copy;
	copy.push(RLM_RUNTIME_GUIDE);
	return copy;
}

/** True when `next` only appends the RLM guide (or is identical) relative to `base`. */
export function rlmGuideIsAppendOnly(base: readonly string[], next: readonly string[]): boolean {
	if (next.length < base.length) return false;
	for (let i = 0; i < base.length; i++) {
		if (next[i] !== base[i]) return false;
	}
	if (next.length === base.length) return true;
	return next.length === base.length + 1 && (next[base.length]?.includes(GUIDE_MARKER) ?? false);
}
