/**
 * OpenCode client identity for the Zen free tier. Free (`*-free`) Zen models
 * answer `FreeUsageLimitError` (HTTP 429) to anything that does not look like
 * the OpenCode client, so those lanes pose as it: its `User-Agent`, a
 * `ses_`-shaped session id, and its title-generator prompt.
 *
 * The gateway compares the whole `User-Agent`, so every segment is pinned and
 * drifts independently. `check-spoofed-versions` tracks the client release;
 * `PI_AI_OPENCODE_VERSION` overrides it without a release. The other two
 * segments follow the client's own pinned `ai-sdk/provider-utils` and Bun
 * runtime, which only move when the client rebuilds.
 */

/** OpenCode CLI release the identity is pinned to. */
export const OPENCODE_CLIENT_VERSION = "1.19.5";

/** `ai-sdk/provider-utils` version the pinned client bundles. */
export const OPENCODE_AI_SDK_VERSION = "4.0.23";

/** Bun runtime version the pinned client bundles. */
export const OPENCODE_RUNTIME_VERSION = "1.4.4";

/**
 * The `User-Agent` the gateway accepts. Overrides: `PI_AI_OPENCODE_VERSION`,
 * `_AI_SDK_VERSION`, `_RUNTIME_VERSION`.
 */
export function getOpenCodeUserAgent(): string {
	const version = process.env.PI_AI_OPENCODE_VERSION || OPENCODE_CLIENT_VERSION;
	const sdk = process.env.PI_AI_OPENCODE_AI_SDK_VERSION || OPENCODE_AI_SDK_VERSION;
	const runtime = process.env.PI_AI_OPENCODE_RUNTIME_VERSION || OPENCODE_RUNTIME_VERSION;
	return `opencode/${version} ai-sdk/provider-utils/${sdk} runtime/bun/${runtime}`;
}

/**
 * Accepted shape of `x-opencode-session`: `ses_`, 12 lowercase hex, 14
 * alphanumerics.
 */
export const OPENCODE_SESSION_TOKEN_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * Lowest accepted value of the session head's low 12 bits. The gateway rejects
 * lower heads even when the shape is otherwise valid (live bisection on
 * [#12306](https://github.com/can1357/oh-my-pi/issues/12306)).
 */
const SESSION_HEAD_LOW12_MIN = 0xfc0;

/** Whether a well-shaped token's head also clears {@link SESSION_HEAD_LOW12_MIN}. */
function hasAcceptedSessionHead(token: string): boolean {
	return (Number.parseInt(token.slice(4, 16), 16) & 0xfff) >= SESSION_HEAD_LOW12_MIN;
}

/**
 * Derive a session token from a conversation id. Deterministic, so turns, retries
 * and forks keep one token, which is what the gateway's routing and prompt cache
 * key on. The head's low 12 bits are ORed into the accepted range; the OR is
 * identity for an already-passing head.
 */
export function toOpenCodeSessionToken(sessionId: string): string {
	// A token-shaped id must still clear the floor: a hand-written
	// `ses_0123456789ab…` is well shaped and still rejected.
	if (OPENCODE_SESSION_TOKEN_PATTERN.test(sessionId) && hasAcceptedSessionHead(sessionId)) return sessionId;
	const digest = new Bun.CryptoHasher("sha256").update(sessionId).digest("hex");
	const rawHead = digest.slice(0, 12);
	const low = (Number.parseInt(rawHead.slice(9, 12), 16) | SESSION_HEAD_LOW12_MIN).toString(16).padStart(3, "0");
	// Upper base36 tail keeps every character after the hex head out of the
	// lowercase-hex alphabet the head owns.
	const tail = BigInt(`0x${digest}`).toString(36).toUpperCase().replace(/0/g, "O");
	return `ses_${`${rawHead.slice(0, 9)}${low}${tail}`.slice(0, 26)}`;
}
