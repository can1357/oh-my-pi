/**
 * DRR + power-of-two-choices pick among quota-share candidates.
 * Saturated inputs stay in the pool as deprioritized; they never beat an
 * unsaturated candidate.
 */

export interface QuotaShareInput {
	id: string;
	weight: number;
	inFlight: number;
	saturated: boolean;
}

export type QuotaSharePick = { id: string; disposition: "eligible" | "deprioritized" };

export function pickQuotaShare(inputs: readonly QuotaShareInput[]): QuotaSharePick | undefined {
	if (inputs.length === 0) {
		return undefined;
	}

	const unsaturated: QuotaShareInput[] = [];
	for (const input of inputs) {
		if (!input.saturated) {
			unsaturated.push(input);
		}
	}

	if (unsaturated.length === 0) {
		return { id: pickMinInFlight(inputs).id, disposition: "deprioritized" };
	}

	return { id: pickTwoChoice(unsaturated).id, disposition: "eligible" };
}

/** Lowest inFlight, then highest weight, then original order. */
function pickMinInFlight(candidates: readonly QuotaShareInput[]): QuotaShareInput {
	let best = candidates[0];
	for (let i = 1; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		if (
			candidate.inFlight < best.inFlight ||
			(candidate.inFlight === best.inFlight && candidate.weight > best.weight)
		) {
			best = candidate;
		}
	}
	return best;
}

/**
 * If 2+ candidates, consider the two lowest inFlight (stable) and pick the
 * higher weight. A single candidate is returned as-is.
 */
function pickTwoChoice(candidates: readonly QuotaShareInput[]): QuotaShareInput {
	let lowest = candidates[0];
	let second: QuotaShareInput | undefined;
	for (let i = 1; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		if (candidate.inFlight < lowest.inFlight) {
			second = lowest;
			lowest = candidate;
			continue;
		}
		if (second === undefined || candidate.inFlight < second.inFlight) {
			second = candidate;
		}
	}
	if (second !== undefined && second.weight > lowest.weight) {
		return second;
	}
	return lowest;
}
