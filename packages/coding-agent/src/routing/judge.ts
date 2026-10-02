// src/routing/judge.ts
//
// Routing consumes a native System One judge — NEVER the `resolveJudge` chat fallback.
//
// Why: the `judge` role chain's online candidates answer via prompted chat models. For
// routing that is the wrong failure mode — a Jev outage would arrive as a SUCCESSFUL
// answer from a chat model, spending tokens and latency on the turn critical path to
// produce a routing decision the Layer-0 principle says shouldn't exist. The invariant
// is the opposite: Jev unavailable -> NO routing decision -> top tier (fail-expensive).
// Resolving the first NATIVE chain candidate (TypeSafe jev, directly or through
// OpenRouter) makes its rejections actual Jev failures, which `routeTurn` maps to
// `engine-unavailable`.

import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { type JudgeDeps, kindOf } from "../judgment";

/**
 * `JudgeDeps` as routing consumes it.
 *
 * Routing builds the native judge itself (see below) and never enters
 * `resolveJudge`, so `purpose` has no consumer on this path — but upstream
 * requires it on `JudgeDeps`, and a routing judgment is still a judgment.
 * Requiring it here would force every caller to pass a label the code drops,
 * so accept it, ignore it, and let the single callsite supply `"routing"`.
 */
export type RoutingJudgeDeps = Omit<JudgeDeps, "purpose"> & { purpose?: string };

/** Re-state a validated judgment api as its literal union (generic `Model<Api>` defeats narrowing). */
function judgmentApiOf(api: string): "typesafe" | "openrouter-decisions" | undefined {
	return api === "typesafe" ? "typesafe" : api === "openrouter-decisions" ? "openrouter-decisions" : undefined;
}

/**
 * The judge for routing decisions, or `undefined` when the `judge` role chain
 * has no native System One candidate (no TypeSafe/OpenRouter jev credential).
 * `undefined` means "no router" — callers route to the top tier without
 * calling `routeTurn` at all.
 *
 * Construction is wrapped because resolver/registry lookups can throw before
 * any judgment call is made; a construction failure is also "no router".
 */
export function resolveRoutingJudge(deps: RoutingJudgeDeps): TypeSafeJudge | undefined {
	try {
		const chain = resolveRoleChain("judge", deps.settings, roleCandidatePool("judge", deps.settings, deps.registry));
		const [primary] = chain;
		if (!primary || kindOf(primary) !== "native") return undefined;
		const model = primary.model;
		const api = judgmentApiOf(String(model.api));
		if (!api) return undefined;
		return new TypeSafeJudge({
			apiKey: deps.registry.resolver(model, deps.sessionId),
			api,
			provider: model.provider,
			model: model.id,
			baseUrl: model.baseUrl,
		});
	} catch (error) {
		logger.debug("routing: native judge unavailable; routing disabled for this turn", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
