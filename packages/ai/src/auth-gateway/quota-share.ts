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
	/**
	 * Accumulated fair-share debt (Deficit Round Robin). Candidates skipped
	 * while a peer served accrue debt; serving repays it. All-zero deficits
	 * reproduce pure P2C behaviour, so the field is optional.
	 */
	deficit?: number;
}

export type QuotaShareDeficitUpdate = { id: string; deficit: number };

export interface QuotaSharePick {
	id: string;
	disposition: "eligible" | "deprioritized";
	/** DRR accounting to persist per candidate until the next pick. */
	deficitUpdates: ReadonlyArray<QuotaShareDeficitUpdate>;
}

const DRR_DEFICIT_LIMIT = 1024;

function clampDeficit(value: number): number {
	return Math.max(-DRR_DEFICIT_LIMIT, Math.min(DRR_DEFICIT_LIMIT, value));
}

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
		return { id: pickMinInFlight(inputs).id, disposition: "deprioritized", deficitUpdates: [] };
	}

	const chosen = pickTwoChoice(unsaturated);
	// DRR accounting: serving repays the chosen candidate's debt (quantum =
	// cohort weight sum); every skipped peer accrues its own weight. Equal
	// health accounts therefore alternate instead of hammering the top-ranked.
	const quantum = unsaturated.reduce((sum, input) => sum + Math.max(1, input.weight), 0);
	const deficitUpdates = unsaturated.map(input => ({
		id: input.id,
		deficit: clampDeficit((input.deficit ?? 0) + (input.id === chosen.id ? -quantum : Math.max(1, input.weight))),
	}));
	return { id: chosen.id, disposition: "eligible", deficitUpdates };
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
	if (second === undefined) return lowest;
	// Fair-share tiebreak: between the two finalists, debt repayment outranks
	// weight — this is what makes equally healthy accounts alternate.
	if ((second.deficit ?? 0) > (lowest.deficit ?? 0)) {
		return second;
	}
	if (second.weight > lowest.weight) {
		return second;
	}
	return lowest;
}
