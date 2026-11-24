import type { Api, Model } from "./types";

/** Per-million surcharge on every token class; Cursor's own models are exempt. */
export function resolveTeamsTokenRatePerMillion(
	model: Pick<Model<Api>, "cursorTokenRateExempt" | "teamsTokenRatePerMillion">,
): number {
	return model.cursorTokenRateExempt ? 0 : (model.teamsTokenRatePerMillion ?? 0);
}

/** Stamp each provider's configured rate onto its models, clearing rates no longer configured. */
export function applyTeamsTokenRateConfig(
	models: readonly Model<Api>[],
	providerRates: ReadonlyMap<string, number>,
): Model<Api>[] {
	return models.map(model => {
		const rate = providerRates.get(model.provider);
		if (rate === model.teamsTokenRatePerMillion) return model;
		if (rate === undefined) {
			const { teamsTokenRatePerMillion: _cleared, ...rest } = model;
			return rest;
		}
		return { ...model, teamsTokenRatePerMillion: rate };
	});
}
