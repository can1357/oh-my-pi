/**
 * Absolute lifetime of an Anthropic OAuth grant family, anchored at the
 * interactive login. Refresh-token rotation does NOT extend it: ~30 days
 * after authorization the token endpoint returns
 * `invalid_grant: "Refresh token expired"` for the latest rotated token and
 * only a fresh interactive login recovers the account. Observed against
 * production (grants authorized 2026-06-20/06-25 died 30d later to the hour
 * despite healthy 8h rotations); matches Claude Code's documented monthly
 * re-login. Consumers use this to warn before the deadline — it is a display
 * heuristic, not a wire contract.
 */
export const ANTHROPIC_OAUTH_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
