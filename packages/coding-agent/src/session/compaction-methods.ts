/** Ordered automatic context-maintenance methods and their settings metadata. */

import {
	type CompactionSettings as EngineCompactionSettings,
	shouldUseProviderNativeCompaction,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CompactionSettings } from "../config/settings-schema";

/** Choices presented by the ordered compaction-method setting. */
export const COMPACTION_METHOD_CHOICES = [
	{
		value: "remote",
		label: "OpenAI server compaction",
		description: "Use provider-native OpenAI-compatible server compaction when the active route supports it",
	},
	{
		value: "snapcompact",
		label: "Snapcompact",
		description: "Archive history onto dense bitmap images the active vision model reads back; no LLM call",
	},
	{
		value: "handoff",
		label: "Handoff",
		description: "Generate a handoff document and continue from it as the compaction summary",
	},
	{
		value: "soft",
		label: "Soft compaction",
		description: "Summarize in place with a compaction model without using server compaction",
	},
	{
		value: "shake",
		label: "Shake",
		description: "Drop recoverable heavy content in place without an LLM call",
	},
] as const;

/** One selectable automatic context-maintenance method. */
export type CompactionMethod = (typeof COMPACTION_METHOD_CHOICES)[number]["value"];

/** Default fallback order: server-native first, portable summary last. */
export const DEFAULT_COMPACTION_METHOD_ORDER: CompactionMethod[] = [
	"remote",
	"snapcompact",
	"handoff",
	"shake",
	"soft",
];

const COMPACTION_METHODS: Record<CompactionMethod, true> = {
	remote: true,
	snapcompact: true,
	handoff: true,
	soft: true,
	shake: true,
};

/** Whether an unknown configuration value names a supported compaction method. */
export function isCompactionMethod(value: unknown): value is CompactionMethod {
	return typeof value === "string" && Object.hasOwn(COMPACTION_METHODS, value);
}

/**
 * Filter malformed entries and preserve first occurrence order from a configured
 * compaction-method preference list.
 */
export function resolveCompactionMethodOrder(value: unknown): CompactionMethod[] {
	if (!Array.isArray(value)) return [];

	const methods: CompactionMethod[] = [];
	for (const method of value) {
		if (isCompactionMethod(method) && !methods.includes(method)) methods.push(method);
	}
	return methods;
}

const STRATEGY_BY_COMPACTION_METHOD: Record<CompactionMethod, "context-full" | "handoff" | "shake" | "snapcompact"> = {
	remote: "context-full",
	snapcompact: "snapcompact",
	handoff: "handoff",
	soft: "context-full",
	shake: "shake",
};

/**
 * Convert the selected preference into the engine's compact operation flags.
 * The engine intentionally remains usable by SDK consumers that do not expose
 * the coding agent's preference list.
 */
export function resolveMethodSettings(
	settings: CompactionSettings,
	method: CompactionMethod,
): EngineCompactionSettings {
	return {
		...settings,
		strategy: STRATEGY_BY_COMPACTION_METHOD[method],
		remoteEnabled: method === "remote",
	};
}

/** Whether server compaction has either a configured endpoint or an active native route. */
export function canUseRemoteCompaction(model: Model | null | undefined, settings: EngineCompactionSettings): boolean {
	return (
		(typeof settings.remoteEndpoint === "string" && settings.remoteEndpoint.length > 0) ||
		(model !== null && model !== undefined && shouldUseProviderNativeCompaction(model, settings))
	);
}

/**
 * First configured method a threshold pass would run, or undefined when it is
 * local (snapcompact/shake) — local methods are effectively instant, so there
 * is nothing to speculate. Shared by the maintenance loop's speculation gate
 * and the status line's annotated context gauge (speculation marker).
 */
export function resolveSpeculationMethod(
	model: Model | null | undefined,
	settings: CompactionSettings,
): "remote" | "handoff" | "soft" | undefined {
	for (const candidate of resolveCompactionMethodOrder(settings.methodOrder)) {
		const available =
			candidate === "remote"
				? canUseRemoteCompaction(model, resolveMethodSettings(settings, candidate))
				: candidate === "snapcompact"
					? model?.input?.includes("image") === true
					: true;
		if (!available) continue;
		return candidate === "remote" || candidate === "handoff" || candidate === "soft" ? candidate : undefined;
	}
	return undefined;
}
