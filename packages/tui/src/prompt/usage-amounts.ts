import { resolveUsedFraction, type UsageLimit } from "@oh-my-pi/pi-ai/usage";

/**
 * Formatting for usage limits that carry an absolute amount but no fraction,
 * shared by the `/usage` TUI report and the fullscreen dashboard so both
 * surfaces agree on what a bucket is worth.
 *
 * Providers report one of two one-sided shapes: spend-to-date with no
 * allowance (`used` only), or a prepaid balance with no total (`remaining`
 * only). Neither can fill a quota bar, so each renders as text instead.
 */
function isAbsoluteUnit(limit: UsageLimit): boolean {
	return limit.amount.unit !== "percent" && limit.amount.unit !== "unknown";
}

export function isUsedOnlyAbsoluteAmount(limit: UsageLimit): boolean {
	const amount = limit.amount;
	return (
		isAbsoluteUnit(limit) &&
		amount.used !== undefined &&
		Number.isFinite(amount.used) &&
		amount.limit === undefined &&
		amount.remaining === undefined &&
		resolveUsedFraction(limit) === undefined
	);
}

export function isRemainingOnlyAbsoluteAmount(limit: UsageLimit): boolean {
	const amount = limit.amount;
	return (
		isAbsoluteUnit(limit) &&
		amount.remaining !== undefined &&
		Number.isFinite(amount.remaining) &&
		amount.limit === undefined &&
		amount.used === undefined &&
		resolveUsedFraction(limit) === undefined
	);
}

function formatQuantity(value: number, unit: UsageLimit["amount"]["unit"], suffix: string): string {
	if (unit === "usd") return `$${value.toFixed(2)} ${suffix}`;
	const formatted = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
	return `${formatted} ${unit} ${suffix}`;
}

/**
 * Total the prepaid headroom a set of limits actually represents.
 *
 * A `scope.shared` limit is one account-wide pool observed once per stored
 * credential, so N keys on the same account yield N identical rows that must
 * collapse to a single value — summing them would claim several times the
 * credits a single request can draw on. Limits without the flag are genuinely
 * per-account and do add up. Returns `undefined` unless every limit is
 * remaining-only and agrees on a unit, so mixed buckets fall through to the
 * caller's own handling.
 */
export function totalRemainingOnly(
	limits: readonly UsageLimit[],
): { value: number; unit: UsageLimit["amount"]["unit"] } | undefined {
	const first = limits[0];
	if (first === undefined || !limits.every(isRemainingOnlyAbsoluteAmount)) return undefined;
	const unit = first.amount.unit;
	if (!limits.every(limit => limit.amount.unit === unit)) return undefined;

	let total = 0;
	let sharedMax: number | undefined;
	for (const limit of limits) {
		const remaining = limit.amount.remaining ?? 0;
		if (limit.scope.shared === true) {
			sharedMax = sharedMax === undefined ? remaining : Math.max(sharedMax, remaining);
			continue;
		}
		total += remaining;
	}
	return { value: total + (sharedMax ?? 0), unit };
}

/** `"100 credits left"` for a bucket of remaining-only limits, else `undefined`. */
export function formatRemainingOnlyTotal(limits: readonly UsageLimit[]): string | undefined {
	const total = totalRemainingOnly(limits);
	return total === undefined ? undefined : formatQuantity(total.value, total.unit, "left");
}

/**
 * Text for a bucket no quota bar can draw: spend-to-date or prepaid headroom.
 * Used-only limits report the worst (highest) spend; remaining-only limits go
 * through {@link totalRemainingOnly} so shared pools are not double-counted.
 */
export function formatAbsoluteOnlyAmount(limits: readonly UsageLimit[]): string | undefined {
	const first = limits[0];
	if (first === undefined) return undefined;
	if (limits.every(isUsedOnlyAbsoluteAmount)) {
		const unit = first.amount.unit;
		if (!limits.every(limit => limit.amount.unit === unit)) return undefined;
		const used = limits.reduce((max, limit) => Math.max(max, limit.amount.used ?? 0), 0);
		return formatQuantity(used, unit, "used");
	}
	return formatRemainingOnlyTotal(limits);
}
