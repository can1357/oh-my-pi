import type { ProviderExhaustionExclusion } from "./provider-exhaustion";

/** Infrastructure routing failure; it carries no model-quality verdict. */
export class ProviderUnavailableError extends Error {
	readonly failureKind = "infrastructure";
	constructor(provider: string, classification: string, exclusions?: ProviderExhaustionExclusion[]) {
		super(
			exclusions
				? JSON.stringify({ code: "provider_chain_unavailable", providers: exclusions })
				: `${provider}: provider unavailable (${classification})`,
		);
		this.name = "ProviderUnavailableError";
	}
}
