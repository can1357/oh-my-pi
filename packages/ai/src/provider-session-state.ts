/**
 * Credential-rotation handling for a retained `providerSessionState` map.
 *
 * A host that keeps one provider-session map per logical conversation (the
 * auth-gateway's server-owned store, an in-process omp session) can outlive the
 * credential that filled it: `AuthStorage.markUsageLimitReached` and the
 * auth-retry resolver both switch a session to a sibling account mid-flight.
 * Most of what a provider learns is a property of the *endpoint*, so rebuilding
 * the whole map on a switch would re-pay every rejected round-trip the map
 * exists to avoid. A minority is a property of the *account*, and keeping that
 * across a switch is a bug.
 *
 * Audit of what the retained records hold, per provider:
 *
 * - **Anthropic** — `fastModeDisabled` is account-scoped: the rejection reads
 *   "this model does not support fast mode for your account", i.e. a plan
 *   entitlement, so a switch to an entitled sibling must re-probe. Its
 *   siblings are endpoint-scoped and stay: `strictToolsDisabled`
 *   (grammar-too-large 400 for the model's tool schema),
 *   `replayUnsignedThinkingDisabled` / `thinkingReplayDisabled` (the endpoint
 *   is a signing proxy), `prefixDroppedThinkingBlocks` (blocks the API itself
 *   dropped), `controlStates` (per-conversation control baselines).
 * - **OpenAI Responses** — the `previous_response_id` chain baselines are
 *   account-scoped: a stored response belongs to the account that created it.
 *   Strict-tools / reasoning-effort fallbacks, replay warmup and the chaining
 *   circuit breaker are endpoint-scoped and stay.
 * - **OpenAI Completions** — strict-tools and reasoning-effort fallbacks only;
 *   both endpoint-scoped. Nothing to reset.
 * - **Codex** — already sub-keys its WebSocket sessions by account id AND
 *   bearer (`getCodexWebSocketSessionKey`), so a switch naturally lands on a
 *   fresh transport session while the old one stays reachable for teardown.
 *   Resetting from the outside would close a socket a retry may still be on.
 * - **Antigravity** — `lastGoodEndpoint` is endpoint-scoped; the agent /
 *   conversation ids are conversation-scoped. Neither depends on the account.
 * - **GitLab Duo** — the active workflow is account-bound, but it is a live
 *   server-side workflow plus socket, and the switch happens *inside* the
 *   request that may still be resuming it. Tearing it down here would abort the
 *   very turn that rotated; it stays on its existing session-close path.
 */

import { clearAnthropicFastModeFallback } from "./providers/anthropic-state";
import { resetOpenAIResponsesAccountScopedState } from "./providers/openai-responses";
import type { ProviderSessionState } from "./types";

/**
 * Reset the account-dependent lessons in `states`, keeping everything a
 * provider learned about the endpoint. Call when a retained map is about to be
 * reused for a session whose credential now resolves to a different account.
 */
export function resetAccountScopedProviderSessionState(states: Map<string, ProviderSessionState>): void {
	if (states.size === 0) return;
	// Fast mode is the account-scoped half of the Anthropic record; the helper
	// the `/fast on` re-arm path already uses clears exactly that flag.
	clearAnthropicFastModeFallback(states);
	resetOpenAIResponsesAccountScopedState(states);
}
