/**
 * OpenRouter id normalization shared by model resolution and `disabledModels`
 * matching. A leaf module so neither depends on the other.
 */
import { MAX_THINKING_SUFFIX_OPTIONS, parseThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";

function getOpenRouterRouteSuffix(modelId: string): { baseId: string; suffix: string } | undefined {
	const colonIdx = modelId.lastIndexOf(":");
	if (colonIdx === -1) {
		return undefined;
	}

	const suffix = modelId.slice(colonIdx + 1).trim();
	// `max` is a thinking-level suffix, never an OpenRouter route suffix, so
	// `openrouter/<id>:max` falls through to the max-aware selector split instead of
	// being cloned into a literal `<id>:max` model id with the reasoning level lost.
	if (!suffix || parseThinkingSuffix(suffix, MAX_THINKING_SUFFIX_OPTIONS)) {
		return undefined;
	}

	return { baseId: modelId.slice(0, colonIdx), suffix };
}

function stripOpenRouterDateSuffix(modelId: string): string | undefined {
	const stripped = modelId.replace(/-\d{8}(?=$|:)/i, "");
	return stripped !== modelId ? stripped : undefined;
}

/** The ids an OpenRouter selector may resolve through: itself, then its route-suffix and date-stripped bases. */
export function getOpenRouterFallbackModelIds(modelId: string): string[] {
	const orderedCandidates: string[] = [];
	const queue = [modelId];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const candidate = queue.shift();
		if (!candidate || seen.has(candidate)) {
			continue;
		}
		seen.add(candidate);
		orderedCandidates.push(candidate);

		const routedSuffix = getOpenRouterRouteSuffix(candidate);
		if (routedSuffix) {
			queue.push(routedSuffix.baseId);
		}

		const strippedDate = stripOpenRouterDateSuffix(candidate);
		if (strippedDate) {
			queue.push(strippedDate);
		}
	}

	return orderedCandidates;
}
