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
import type { ScopeLike } from "../config/registry";
import type { Settings } from "../config/settings";
import {
	type CompactionSettings,
	cfgCompaction,
	cfgCompactionModelThresholds,
	cfgCompactionModelThresholdsEnabled,
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

/**
 * Persist `input` (see {@link parseCompactionPointInput}) as `model`'s own
 * `compaction.modelThresholds` entry in the global config; empty input removes
 * it. Throws on unparseable input, and when a project or higher-priority layer
 * sets the same key, which would leave the global write without effect.
 * Returns the entry written, or `undefined` when removed.
 */
export function setModelCompactionPoint(settings: Settings, model: Model, input: string): number | string | undefined {
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
	cfgCompactionModelThresholds.setEntry(settings, key, entry);
	const effective = cfgCompactionModelThresholds.get(settings)[key] ?? undefined;
	if (effective !== entry) {
		throw new Error(
			`${key} is overridden by a higher-priority config layer; the global entry was saved but has no effect`,
		);
	}
	return entry;
}
