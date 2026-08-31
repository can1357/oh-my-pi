/**
 * AIML API partner attribution + identity.
 *
 * oh-my-pi tags every request it makes to AIML API with a client source and a
 * partner id, so the traffic is attributed to this client on AIML API's side.
 * The partner id/name ship as compiled-in defaults and can be overridden with
 * the `AIMLAPI_PARTNER_ID` / `AIMLAPI_PARTNER_NAME` environment variables.
 *
 * Kept here (next to the AIML API model manager) so both the model-discovery
 * fetch in `@oh-my-pi/pi-catalog` and the inference transport / login flow in
 * `@oh-my-pi/pi-ai` source the same values without duplicating them.
 */

/** Compiled-in partner id; override with `AIMLAPI_PARTNER_ID`. */
const DEFAULT_AIMLAPI_PARTNER_ID = "part_esrFuB5coroCvy4ri4dDqbCX";

/** Compiled-in partner name; override with `AIMLAPI_PARTNER_NAME`. */
const DEFAULT_AIMLAPI_PARTNER_NAME = "oh-my-pi";

/** Client source tag: agent traffic originating from oh-my-pi. */
export const AIMLAPI_SOURCE = "agent/oh-my-pi";

/** Resolve the partner id (env override wins over the compiled-in default). */
export function resolveAimlApiPartnerId(): string {
	const override = Bun.env.AIMLAPI_PARTNER_ID?.trim();
	return override ? override : DEFAULT_AIMLAPI_PARTNER_ID;
}

/** Resolve the partner name (env override wins over the compiled-in default). */
export function resolveAimlApiPartnerName(): string {
	const override = Bun.env.AIMLAPI_PARTNER_NAME?.trim();
	return override ? override : DEFAULT_AIMLAPI_PARTNER_NAME;
}

/**
 * Attribution headers sent on every AIML API request — model discovery,
 * inference, and the "Get API key" device-authorization flow alike.
 */
export function getAimlApiCommonHeaders(): Record<string, string> {
	return {
		"X-AIMLAPI-Source": AIMLAPI_SOURCE,
		"X-AIMLAPI-Partner-ID": resolveAimlApiPartnerId(),
	};
}
