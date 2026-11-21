/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { ALL_TOOLS, DEFAULT_SPOTLIGHT_MODEL, DEFAULT_SPOTLIGHT_URL } from "./types";

export const cfgSpotlightExperimentEnabled = register({
	id: "spotlight.experiment.enabled",
	env: "PI_SPOTLIGHT_EXPERIMENT",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Developer",
		label: "Spotlight Experiment",
		description:
			"Shape tool output and rank find results with Stencil Spotlight, and log each shaped result to the session",
	},
});

/**
 * Share of would-be cuts held out at random: the model gets the unshaped (plain) result instead, and the trace records
 * the cut it would have made, as the counterfactual for the cuts applied.
 */
export const cfgSpotlightExperimentHoldout = register({
	id: "spotlight.experiment.holdout",
	env: { name: "PI_SPOTLIGHT_HOLDOUT", parse: parseShare },
	type: "number",
	default: 0.05,
	validate: raw => validateShare("spotlight.experiment.holdout", raw),
});

/**
 * Share of the results not held out that are shaped without Spotlight: the no-score fallback rules decide the cut, so
 * score-free cuts against scored ones measure what Spotlight's ranking adds.
 */
export const cfgSpotlightExperimentScoreFree = register({
	id: "spotlight.experiment.scoreFree",
	env: { name: "PI_SPOTLIGHT_SCORE_FREE", parse: parseShare },
	type: "number",
	default: 0.15,
	validate: raw => validateShare("spotlight.experiment.scoreFree", raw),
});

/**
 * The tools whose results the experiment shapes and journals, by name (`*`: every tool). A tool left out returns its
 * plain result and is not journaled.
 */
export const cfgSpotlightExperimentTools = register({
	id: "spotlight.experiment.tools",
	env: { name: "PI_SPOTLIGHT_TOOLS", parse: parseToolList },
	type: "array",
	default: [ALL_TOOLS] as readonly string[],
});

/** A comma-separated list of tool names, or unset when it names none. */
function parseToolList(raw: string): readonly string[] | undefined {
	const names = raw
		.split(",")
		.map(name => name.trim())
		.filter(Boolean);
	return names.length > 0 ? names : undefined;
}

function validateShare(id: string, raw: unknown): void {
	if (raw === undefined || parseShare(String(raw)) !== undefined) return;
	throw new Error(`Invalid ${id}: expected a number from 0 to 1, got ${Bun.inspect(raw)}.`);
}

/** A share from text: a number in [0, 1], else unset. */
function parseShare(raw: string): number | undefined {
	const text = raw.trim();
	if (!text) return undefined;
	const value = Number(text);
	return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export const cfgSpotlightUrl = register({
	id: "spotlight.url",
	env: "STENCIL_SPOTLIGHT_URL",
	type: "string",
	default: DEFAULT_SPOTLIGHT_URL,
});

export const cfgSpotlightModel = register({
	id: "spotlight.model",
	type: "string",
	default: DEFAULT_SPOTLIGHT_MODEL,
});

export const cfgSpotlightThinking = register({
	id: "spotlight.thinking",
	type: "enum",
	values: ["low", "med", "high", "max"] as const,
	default: "med",
});

/** Budget of one Spotlight ranking inside a tool call; past it the call falls back to unranked rules. */
export const cfgSpotlightTimeoutMs = register({
	id: "spotlight.timeoutMs",
	type: "number",
	default: 5000,
});
