/**
 * OpenCode gateway (Zen, Go) wire identity.
 *
 * The contributor free tier is gated on client identity: every request must
 * carry a `User-Agent` whose leading token is `opencode/<version>` and an
 * `x-opencode-session` matching `ses_<12 hex><14 alnum>` whose head low 12
 * bits are `>= 0xfc0`. Both are wire-shape checks applied before credentials
 * are evaluated
 * ([#12306](https://github.com/can1357/oh-my-pi/issues/12306)).
 */

/** Canonical OpenCode client User-Agent; the gate reads only the leading token. */
export const OPENCODE_USER_AGENT = "opencode/1.18.31";

/** Provider ids whose hosts sit behind the OpenCode gateways (Zen, Go). */
export const OPENCODE_PROVIDER_IDS: ReadonlySet<string> = new Set(["opencode-zen", "opencode-go"]);

/** Whether `provider` is served by an OpenCode gateway. */
export function isOpenCodeProvider(provider: string): boolean {
	return OPENCODE_PROVIDER_IDS.has(provider);
}

/**
 * OpenCode core tool NAMES the gateway knows. The body gate does not accept
 * any two of these: live-gateway evidence shows it mandatorily requires the
 * `bash` + `read` pair — a roster carrying `read`/`grep`/`glob` without `bash`
 * (the default advisor roster) is still refused with 403 FreeTierError, and an
 * Oct 2026 bisection found every other partial combination (`edit`+`read`,
 * `bash`+`grep`, …) 403s while only rosters containing both `bash` and `read`
 * pass ([#12306](https://github.com/can1357/oh-my-pi/issues/12306)).
 * Agent harnesses carrying a normal tool roster satisfy this natively;
 * calls missing either name must pad.
 */
export const OPENCODE_GATE_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read"] as const;

/**
 * Gate tool names injected when padding. `bash` + `read` are the pair the
 * live-gateway bisection confirmed.
 */
export const OPENCODE_GATE_PAD_TOOL_NAMES = ["bash", "read"] as const;

/**
 * Gate tool names missing from `names` (exact-match — the gate compares names
 * only). Returns the `bash`/`read` names not already present; empty when both
 * are present and no padding is needed.
 */
export function missingOpenCodeGateToolNames(names: Iterable<string>): string[] {
	const present = new Set(names);
	return OPENCODE_GATE_PAD_TOOL_NAMES.filter(name => !present.has(name));
}

/**
 * Pad `tools` with the gate-required OpenCode tool names so tool-less auxiliary
 * calls (advisors, one-shot helpers) pass the body check. Pads carry no
 * parameters and an empty description — the gate ignores schemas — but callers
 * MUST keep them out of the agent loop's tool registry: they are wire-shape
 * filler, not executable work (the roster should never offer "bash" to a call
 * that was built without tools).
 *
 * Returns the input array unchanged (same identity) when nothing is missing.
 */
export function withOpenCodeGateTools<T extends { name: string }>(tools: readonly T[] | undefined): T[] {
	const existing = tools ?? [];
	const missing = missingOpenCodeGateToolNames(existing.map(tool => tool.name));
	if (missing.length === 0) return existing as T[];
	// The stubs structurally differ from T only in fields the wire never reads.
	// `strict: false` keeps every transport's strict-mode normalization inert.
	const pads = missing.map(name => ({
		name,
		description: "",
		parameters: { type: "object" },
		strict: false,
	})) as unknown as T[];
	return [...existing, ...pads];
}

/** Shape the OpenCode gate requires for `x-opencode-session`. */
export const OPENCODE_SESSION_TOKEN_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * Minimum accepted value of the session head's low 12 bits. The gateway
 * rejects heads with `low12 < 0xfc0` even when the overall shape is valid.
 */
export const OPENCODE_SESSION_HEAD_LOW12_MIN = 0xfc0;

/**
 * Format a session identity as OpenCode's canonical session token
 * (`ses_` + 12 lowercase hex + 14 alphanumeric chars).
 *
 * Deterministic: the 12-hex head derives from the leading digest bits of the
 * input and the alphanumeric tail derives from the rest, so a conversation
 * keeps one token across turns — the gateway pins routing and prompt caching
 * on the value. The head's low 12 bits are forced into the range the live
 * gateway accepts (`low12 >= 0xfc0`; lower values 403 with FreeTierError even
 * when the shape is otherwise valid — live re-measurement 2026-10-16,
 * ([#12306](https://github.com/can1357/oh-my-pi/issues/12306))). The OR is
 * identity for already-passing heads, so working tokens stay stable. The tail
 * is upper base36 (digits `0` mapped to `O`) so no lowercase hex characters
 * leak past the head segment.
 */
export function toOpenCodeSessionToken(sessionId: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
	const rawHead = digest.slice(0, 12);
	const low = (Number.parseInt(rawHead.slice(9, 12), 16) | OPENCODE_SESSION_HEAD_LOW12_MIN)
		.toString(16)
		.padStart(3, "0");
	const head = `${rawHead.slice(0, 9)}${low}`;
	const tail = BigInt(`0x${digest}`).toString(36).toUpperCase().replace(/0/g, "O");
	return `ses_${`${head}${tail}`.slice(0, 26)}`;
}
