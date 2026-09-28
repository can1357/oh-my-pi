import { normalizeCharmHyperBaseUrl } from "@oh-my-pi/pi-catalog/wire/charm-hyper";
import { ProviderHttpError } from "../error";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";
import { isRecord } from "../utils";

const PROVIDER = "charm-hyper";
const CREDITS_PATH = "/credits";

/**
 * Charm Hyper sells prepaid credits: `/v1/credits` answers `{"balance": N}` and
 * nothing else — no allowance, no spend-to-date, no reset window — so the limit
 * is remaining-only by construction. Synthesizing a total from the first
 * observed balance would misreport every later top-up, so we report only what
 * the API states.
 *
 * The balance is **account-wide**, not per-key: spending 1.216 credits through
 * one key dropped a second key's reported balance from 95 to 94 (verified
 * 2026-09-11), and Hyper issues several keys per account. The endpoint exposes
 * no account identity to group them by, so the limit is marked
 * `scope.shared` — every credential reports the same pool, and consumers must
 * collapse rather than sum it.
 */
async function fetchCharmHyperUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	if (credential.type !== "api_key" || !credential.apiKey) return null;

	// Honor a configured proxy base: inference and discovery already route
	// through it, and sending the stored key to the canonical host would both
	// fail for a proxy-scoped credential and disclose it off-site. Shared with
	// discovery and the model-cache namespace so all three agree on the
	// endpoint — including for a blank override, which means "not configured".
	const creditsUrl = `${normalizeCharmHyperBaseUrl(params.baseUrl)}${CREDITS_PATH}`;

	let payload: unknown;
	try {
		const response = await ctx.fetch(creditsUrl, {
			headers: {
				Authorization: `Bearer ${credential.apiKey}`,
				Accept: "application/json",
			},
			signal: params.signal,
		});
		if (!response.ok) {
			// A revoked key must invalidate the cached balance rather than let
			// the last-good report be re-served: only a thrown auth status
			// purges it, while `null` is the transient-failure path.
			if (response.status === 401 || response.status === 403) {
				throw new ProviderHttpError(
					`Charm Hyper credits endpoint returned ${response.status} ${response.statusText}`.trim(),
					response.status,
				);
			}
			ctx.logger?.warn("Charm Hyper usage fetch failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}
		payload = await response.json();
	} catch (error) {
		if (error instanceof ProviderHttpError) throw error;
		ctx.logger?.warn("Charm Hyper usage fetch error", { error: String(error) });
		return null;
	}

	if (!isRecord(payload)) return null;
	const balance = payload.balance;
	if (typeof balance !== "number" || !Number.isFinite(balance)) return null;

	const limit: UsageLimit = {
		id: "charm-hyper:credits",
		label: "Credit balance",
		// Windowless and shared: the label already says "balance", and the
		// shared flag tells renderers this is one account-level pool seen once
		// per stored key.
		scope: { provider: params.provider, windowId: "balance", shared: true },
		amount: { remaining: balance, unit: "credits" },
	};

	return {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: { endpoint: creditsUrl },
		raw: payload,
	};
}

export const charmHyperUsageProvider: UsageProvider = {
	id: PROVIDER,
	fetchUsage: fetchCharmHyperUsage,
	supports: params => params.provider === PROVIDER && params.credential.type === "api_key",
	validatesCredentials: true,
};
