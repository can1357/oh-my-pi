import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelCompactionPoint } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	applyModelCompactionThreshold,
	formatCompactionPointInput,
	matchModelCompactionThreshold,
	parseCompactionPointInput,
} from "../config/compaction-threshold";
import type { ContextWindowTiers } from "../config/model-registry";
import type { ScopeLike } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	type CompactionSettings,
	cfgCompaction,
	cfgCompactionModelThresholds,
	cfgCompactionModelThresholdsEnabled,
	cfgExtendedContext,
} from "./context-settings";

/** The compaction policy in force for `model`: the configured policy with its `compaction.modelThresholds` entry applied. */
export function resolveModelCompactionSettings(
	scope: ScopeLike,
	model: { provider: string; id: string } | null | undefined,
): CompactionSettings {
	const thresholds = cfgCompactionModelThresholdsEnabled.get(scope)
		? cfgCompactionModelThresholds.get(scope)
		: undefined;
	return applyModelCompactionThreshold(cfgCompaction.get(scope), thresholds, model);
}

/** Where auto-compaction triggers for `model` and which setting decides it, for the model hub preview. */
export function describeModelCompactionPoint(scope: ScopeLike, model: Model): ModelCompactionPoint {
	const configured = cfgCompaction.get(scope);
	const thresholds = cfgCompactionModelThresholdsEnabled.get(scope)
		? cfgCompactionModelThresholds.get(scope)
		: undefined;
	const match = matchModelCompactionThreshold(thresholds, model);
	const settings = match ? { ...configured, ...match.threshold } : configured;
	const contextWindow = model.contextWindow ?? 0;
	return {
		tokens: settings.enabled && contextWindow > 0 ? resolveThresholdTokens(contextWindow, settings) : undefined,
		percent: settings.thresholdTokens > 0 || settings.thresholdPercent <= 0 ? undefined : settings.thresholdPercent,
		source: match?.key ?? (configured.thresholdTokens > 0 || configured.thresholdPercent > 0 ? "global" : "default"),
		draft: match?.key === `${model.provider}/${model.id}` ? formatCompactionPointInput(match.threshold) : undefined,
	};
}

/** A window size as the hub's one-line notices show it: `272K`, `1.05M`. */
function formatWindow(tokens: number): string {
	return tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}

/** Outcome of {@link setModelCompactionPoint}: the entry written (`undefined` = removed), or a warning to acknowledge first. */
export type ModelCompactionPointUpdate =
	| { kind: "saved"; entry: number | string | undefined }
	| { kind: "confirm"; message: string };

/**
 * Persist `input` (see {@link parseCompactionPointInput}) as `model`'s own
 * `compaction.modelThresholds` entry in the global config; empty input removes
 * it. Throws on unparseable input, on a token count at or past the largest
 * window `model` can run with (`tiers.extended`, else its current window), and
 * when a project or higher-priority layer sets the same key, which would leave
 * the global write without effect.
 *
 * A token count at or past `tiers.standard` opts the model into its extended
 * window (see `ModelRegistry.contextWindowTiers`); unless extended context is
 * already on, it is written only once `confirmed`, and otherwise returns the
 * warning to show.
 */
export function setModelCompactionPoint(
	settings: Settings,
	model: Model,
	input: string,
	options: { tiers?: ContextWindowTiers; confirmed?: boolean } = {},
): ModelCompactionPointUpdate {
	const entry = parseCompactionPointInput(input) ?? undefined;
	const key = `${model.provider}/${model.id}`;
	const projectThresholds = settings.getProjectSettings().compaction;
	if (
		isRecord(projectThresholds) &&
		isRecord(projectThresholds.modelThresholds) &&
		Object.hasOwn(projectThresholds.modelThresholds, key)
	) {
		throw new Error(`${key} is set in the project config; edit compaction.modelThresholds there`);
	}
	if (typeof entry === "number") {
		const { tiers } = options;
		const ceiling = tiers?.extended ?? model.contextWindow;
		if (ceiling !== null && ceiling !== undefined && entry >= ceiling) {
			throw new Error(`Must be below the ${formatWindow(ceiling)} ${tiers ? "max " : ""}window`);
		}
		if (tiers && entry >= tiers.standard && !options.confirmed && !cfgExtendedContext.get(settings)) {
			const premiumThreshold = model.cost.longContext?.inputThreshold;
			const pricing =
				premiumThreshold !== undefined && entry > premiumThreshold
					? `; >${formatWindow(premiumThreshold)} costs more`
					: "";
			// Kept short: the hub shows it on one line beside the input field.
			return { kind: "confirm", message: `Opens ${formatWindow(tiers.extended)} window${pricing}` };
		}
	}
	cfgCompactionModelThresholds.setEntry(settings, key, entry);
	const effective = cfgCompactionModelThresholds.get(settings)[key] ?? undefined;
	if (effective !== entry) {
		throw new Error(
			`${key} is overridden by a higher-priority config layer; the global entry was saved but has no effect`,
		);
	}
	return { kind: "saved", entry };
}
