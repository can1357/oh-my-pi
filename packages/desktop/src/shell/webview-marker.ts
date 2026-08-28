/**
 * The line the page prints once it is running, and the host's stderr carries.
 *
 * A leaf on purpose: `scripts/smoke.ts` imports it to know what to look for, and
 * a shared constant is the only thing that keeps the harness and the app from
 * drifting apart silently — a smoke test grepping for a string the app stopped
 * printing would pass forever.
 */
export const WEBVIEW_READY = "webview ready";
