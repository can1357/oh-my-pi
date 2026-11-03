import { $flag } from "@oh-my-pi/pi-utils";
import type { Model, ProviderSessionState } from "../types";
import type {
	OpenAIResponsesChainState,
	OpenAIResponsesOptions,
	OpenAIResponsesProviderSessionState,
} from "./openai-responses";

/** Prefix shared by Responses request state and credential-reset hooks. */
export const OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX = "openai-responses:";
/**
 * Whether the next request for `model` replays native Responses history items
 * (encrypted reasoning, item ids), matching request construction. A session
 * is cold, rebuilding turns from message content, from the first request on a
 * connection-bound host (`compat.connectionBoundNativeHistory`, GitHub Copilot)
 * and after `close()` on any host, until a response succeeds. Without session
 * state every request replays.
 */
export function openAIResponsesReplaysNativeHistory(
	model: Pick<Model, "api" | "provider" | "compat"> | null | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): boolean {
	if (model?.api !== "openai-responses" || !providerSessionState) return true;
	const state = providerSessionState.get(`${OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX}${model.provider}`) as
		| OpenAIResponsesProviderSessionState
		| undefined;
	if (state) return state.nativeHistoryReplayWarmed;
	const compat = model.compat;
	return !(compat && "connectionBoundNativeHistory" in compat && compat.connectionBoundNativeHistory);
}

/** Host per-provider storage defaults; see {@link configureProviderStoreResponses}. */
let configuredProviderStoreResponses: Readonly<Record<string, boolean>> = {};

/**
 * Set the process-wide storage default per provider id, used when a request
 * leaves `storeResponses` unset. Hosts call this from their settings so every
 * request follows the setting, including direct `streamSimple`/`completeSimple`
 * side calls that do not pass per-request options. `PI_MUSE_STORE_RESPONSES`
 * still overrides it.
 */
export function configureProviderStoreResponses(byProvider: Readonly<Record<string, boolean>> | undefined): void {
	configuredProviderStoreResponses = byProvider ?? {};
}

/**
 * Whether this request stores its result server-side. Only hosts whose rule
 * sets `store-responses` (they finish runs after a client disconnect, so a
 * dropped stream can be resumed) are eligible, and storage is opt-in:
 * `options.storeResponses`, then `PI_MUSE_STORE_RESPONSES`, then the host
 * default ({@link configureProviderStoreResponses}), else off. Privacy: stored
 * runs retain prompts and outputs on the provider. Off also disables resume and
 * the `previous_response_id` chaining that needs storage.
 */
export function storesResponsesServerSide(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
): boolean {
	if (model.compat.storeResponses !== true) return false;
	return (
		options?.storeResponses ??
		$flag("PI_MUSE_STORE_RESPONSES", configuredProviderStoreResponses[model.provider] ?? false)
	);
}

/** Forget server-side append baselines while preserving the chain's failure history. */
export function resetOpenAIResponsesChainState(state: OpenAIResponsesChainState): void {
	state.canAppend = false;
	state.lastParams = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
	state.lastPromptCacheBreakpointPolicy = undefined;
}

/**
 * Drop the account-bound half of every retained `openai-responses` record in
 * `states`: the stateful `previous_response_id` chain baselines.
 *
 * Chaining stores the turn server-side under the account that created it, so a
 * baseline minted by one credential is dead weight the moment the session is
 * switched to a sibling account — the next delta request answers
 * `Previous response not found` and burns a turn re-learning that. Everything
 * else this record holds describes the *deployment*, not the account
 * (strict-tools demotion, reasoning-effort fallback, native-history-replay
 * warmup, the chaining circuit breaker), and is deliberately preserved:
 * re-learning an endpoint's limits on every credential switch is the cost this
 * state exists to avoid.
 */
export function resetOpenAIResponsesAccountScopedState(states: Map<string, ProviderSessionState>): void {
	for (const [key, value] of states) {
		if (!key.startsWith(OPENAI_RESPONSES_PROVIDER_SESSION_STATE_PREFIX)) continue;
		const state = value as OpenAIResponsesProviderSessionState;
		for (const chain of state.chains.values()) {
			resetOpenAIResponsesChainState(chain);
			// The stale-failure counter tallies the previous account's 404s; a
			// fresh account must not inherit a tripped circuit breaker.
			chain.staleFailures = 0;
		}
	}
}
