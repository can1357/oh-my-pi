import { bareModelId, classifyModel, compareRevision, parseRevision } from "@oh-my-pi/pi-catalog/identity";

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	// Callers pass raw ids and `provider/id` strings alike; classify the bare
	// model segment so a provider prefix cannot hijack class membership.
	const identity = classifyModel("", bareModelId(modelId), { lenient: true });
	if (identity.class !== "openai" || identity.revision === undefined) return false;
	const revision = parseRevision(identity.revision);
	const target = parseRevision("5.6");
	return revision !== undefined && target !== undefined && compareRevision(revision, target) === 0;
}
