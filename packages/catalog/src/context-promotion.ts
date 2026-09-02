import { compareRevision, parseRevision } from "./compat/revision";
import { classifyModel } from "./compat/taxonomy";
import { bareModelId } from "./identity/id";
import type { Api, ModelSpec } from "./types";

function revisionsEqual(left: string | undefined, right: string): boolean {
	if (left === undefined) return false;
	const parsedLeft = parseRevision(left);
	const parsedRight = parseRevision(right);
	return parsedLeft !== undefined && parsedRight !== undefined && compareRevision(parsedLeft, parsedRight) === 0;
}

/**
 * Link OpenAI model variants to larger-context siblings on the same provider/API.
 * The runtime still verifies that the selected target actually has a larger context.
 */
export function linkOpenAIPromotionTargets(models: ModelSpec<Api>[]): void {
	for (const candidate of models) {
		const candidateIdentity = classifyModel(candidate.provider, candidate.id, { lenient: true });
		if (candidateIdentity.class !== "openai") continue;
		let targetVersion: string | undefined;
		if (candidateIdentity.family === "codex-spark") {
			targetVersion = "5.5";
		} else if (revisionsEqual(candidateIdentity.revision, "5.5")) {
			targetVersion = "5.4";
		} else {
			continue;
		}
		let fallback: ModelSpec<Api> | undefined;
		let fallbackBareLength = Number.POSITIVE_INFINITY;
		for (const model of models) {
			if (model === candidate) continue;
			if (model.provider !== candidate.provider || model.api !== candidate.api) continue;
			const identity = classifyModel(model.provider, model.id, { lenient: true });
			if (identity.class !== "openai" || !revisionsEqual(identity.revision, targetVersion)) continue;
			const bareLength = bareModelId(model.id).length;
			if (bareLength < fallbackBareLength) {
				fallback = model;
				fallbackBareLength = bareLength;
			}
		}
		if (fallback) candidate.contextPromotionTarget = `${fallback.provider}/${fallback.id}`;
	}
}
