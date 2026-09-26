import { factoryDroidApiBaseUrl } from "@oh-my-pi/pi-catalog/discovery";
import * as AIError from "../../error";
import { isRecord } from "../../utils";
import type { AfterExchangeHook } from "../hooks/types";

/** Validate the WorkOS grant and resolve residency against the global host before routing by region. */
export const attachFactoryDroidRegion: AfterExchangeHook = async (credentials, context) => {
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	if (!isRecord(context.raw) || typeof context.raw.refresh_token !== "string" || !credentials.refresh) {
		throw new AIError.OAuthError("Factory token response missing refresh token", { kind: "validation" });
	}
	const timeout = AbortSignal.timeout(15_000);
	const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
	try {
		const response = await context.fetch(`${factoryDroidApiBaseUrl(undefined)}/api/cli/whoami`, {
			headers: { Authorization: `Bearer ${credentials.access}`, Accept: "application/json" },
			signal,
		});
		if (response.ok) {
			const body: unknown = await response.json();
			if (isRecord(body) && typeof body.region === "string" && body.region.length > 0) {
				return { ...credentials, region: body.region };
			}
		}
	} catch {
		if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
		// A missing or failed whoami is the default global region; stored residency is merged by the caller.
	}
	if (context.signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
	return credentials;
};
