import { type FetchImpl, wrapFetchForExtraCa } from "@oh-my-pi/pi-utils";

export { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Fetch implementation for catalog discovery probes: the caller's override
 * when given, otherwise global fetch wrapped for `NODE_EXTRA_CA_CERTS`.
 */
export function discoveryFetch(override?: FetchImpl): FetchImpl {
	return override ?? wrapFetchForExtraCa(fetch);
}

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number;
export function toPositiveNumber(value: unknown, fallback: number | null): number | null;
export function toPositiveNumber(value: unknown, fallback: number | null): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

/** Positive finite number, or `null` when the value is missing/non-positive. */
export function toPositiveNumberOrNull(value: unknown): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : null;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}

/**
 * Gateway author prefix ("OpenAI: ", "Z.ai: ", "Arcee AI: ") as emitted by
 * aggregator catalogs (OpenRouter, Kilo, NanoGPT, ZenMux).
 */
const AUTHOR_PREFIX = /^[A-Za-z][A-Za-z0-9 .+&'-]{0,23}: /;

/**
 * Model-extrinsic name decorations: alias markers ("(latest)"), provider
 * attribution ("(Antigravity)"), price tiers ("($$$$)"), and promo/lifecycle
 * tags ("(20% off)", "(retires Jun 5)"). Variant tags that map to distinct
 * wire ids — "(Thinking)", "(free)", "(Fast)", dates, regions, sizes — stay.
 */
const NOISE_TAGS = /\s*\((?:latest|Antigravity|\$+|>?\d+% off|retires [^)]*)\)/g;

/**
 * Normalize a model display name: drop the gateway author prefix and
 * model-extrinsic decorations. Returns the input verbatim when nothing
 * matches (or when stripping would leave an empty name).
 */
export function cleanModelName(name: string): string {
	const cleaned = name.replace(AUTHOR_PREFIX, "").replace(NOISE_TAGS, "").replace(/ {2,}/g, " ").trim();
	return cleaned.length > 0 ? cleaned : name;
}
