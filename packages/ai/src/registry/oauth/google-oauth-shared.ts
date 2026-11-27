/**
 * Shared OAuth provisioning settings for Google-style providers.
 */

/**
 * Per-request timeout for the post-callback provisioning phase (token exchange,
 * user-info). These calls normally settle in well under this window; a longer
 * stall means a hung endpoint that must surface a login error instead of
 * hanging forever. The callback server's own 300s deadline covers only the
 * browser-callback wait ({@link OAuthCallbackFlow}) and does not gate this phase.
 */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
