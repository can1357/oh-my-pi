import type { Api, Model } from "@oh-my-pi/pi-ai";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { parseRetryFallbackSelector } from "../session/retry-fallback-chains";

/** Role-resolved model used by online tiny tasks (auto-thinking, titles). */
export interface OnlineTinyCandidate {
	role: string;
	model: Model<Api>;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Collect unique online models for lightweight background tasks.
 *
 * Order: each requested role's primary, then `retry.fallbackChains` for those
 * roles (and `default`) when `retry.modelFallback` is not disabled. Auto-thinking
 * and titles previously pinned the first resolvable tiny/smol model and ignored
 * fallback chains, so a 400 on that primary failed the whole background task.
 */
export function collectOnlineTinyCandidates(
	roles: readonly string[],
	settings: Settings,
	availableModels: Model<Api>[],
): OnlineTinyCandidate[] {
	const seen = new Set<string>();
	const out: OnlineTinyCandidate[] = [];
	const add = (role: string, model: Model<Api>) => {
		const key = modelKey(model);
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ role, model });
	};

	for (const role of roles) {
		const resolved = resolveRoleSelection([role], settings, availableModels);
		if (resolved?.model) add(resolved.role, resolved.model);
	}

	if (settings.get("retry.modelFallback") === false) return out;

	const chains = settings.get("retry.fallbackChains");
	if (!chains || typeof chains !== "object") return out;
	const lookup = {
		find(provider: string, id: string) {
			return availableModels.find(model => model.provider === provider && model.id === id);
		},
	};
	for (const role of [...roles, "default"]) {
		const chain = chains[role];
		if (!Array.isArray(chain)) continue;
		for (const selector of chain) {
			if (typeof selector !== "string") continue;
			const parsed = parseRetryFallbackSelector(selector, lookup);
			if (!parsed) continue;
			const model = lookup.find(parsed.provider, parsed.id);
			if (model) add(role, model);
		}
	}
	return out;
}
