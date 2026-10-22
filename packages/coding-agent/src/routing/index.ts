// src/routing/index.ts — barrel for the Jev model-routing layer.
export {
	filterAvailable,
	isWithinWindow,
	localHour,
	needsRouting,
	type AvailabilityContext,
	type AvailabilityResult,
	type Excluded,
	type ConfiguredTier,
	type ExclusionReason,
	type Quota,
	toJevTiers,
	type TierAvailability,
	type TierCandidate,
	type Window,
} from "./availability";
export { resolveRoutingJudge } from "./judge";
export { buildRoutingQuestions, ROUTING_JUDGE_TIMEOUT_MS, routeTurn, verifyAndEscalate } from "./route";
export {
	DEFAULT_ROUTING_POLICY,
	type ModelTier,
	type RouteDecision,
	type RouteReason,
	type RoutingPolicy,
	type TierSpec,
} from "./types";
