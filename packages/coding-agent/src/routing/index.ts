// src/routing/index.ts — barrel for the Jev model-routing layer.
export {
	filterAvailable,
	isWithinWindow,
	localHour,
	needsRouting,
	type AvailabilityContext,
	type AvailabilityResult,
	type Excluded,
	type ExclusionReason,
	type Quota,
	type TierAvailability,
	type TierCandidate,
	type Window,
} from "./availability";
export { buildRoutingQuestions, routeTurn, verifyAndEscalate } from "./route";
export {
	DEFAULT_ROUTING_POLICY,
	type ModelTier,
	type RouteDecision,
	type RouteReason,
	type RoutingPolicy,
	type TierSpec,
} from "./types";
