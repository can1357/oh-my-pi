/**
 * Tiny-model UI labels for spawned subagents.
 */
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import type { ModelRegistry } from "../config/model-registry";
import { resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import taskLabelSystemPrompt from "../prompts/system/task-label.md" with { type: "text" };
import { generateSessionTitle, type TitleUsageReporter } from "../utils/title-generator";
import { labelEchoesHandle } from "./task-details";

const TASK_LABEL_SYSTEM_PROMPT = prompt.render(taskLabelSystemPrompt);

/** Compresses a delegated assignment into a one-sentence UI label via the tiny title model — fired by the executor spawn path because the task wire schema no longer carries a `description`; null on empty input or failure. `onUsage` receives every request that ran, for the spawning session's usage journal. */
export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	signal?: AbortSignal,
	parentActiveModelPattern?: string,
	parentActiveProvider?: string,
	onUsage?: TitleUsageReporter,
): Promise<string | null> {
	const text = assignment.trim();
	if (!text) return null;
	try {
		const resolvedModel =
			cfgOffline.get(settings) && parentActiveModelPattern
				? resolveModelOverride([parentActiveModelPattern], registry, settings, { exactOnly: true }).model
				: undefined;
		const currentModel =
			resolvedModel && (!parentActiveProvider || resolvedModel.provider === parentActiveProvider)
				? resolvedModel
				: undefined;
		const label = await generateSessionTitle(
			text,
			registry,
			settings,
			sessionId,
			currentModel,
			undefined,
			TASK_LABEL_SYSTEM_PROMPT,
			signal,
			undefined,
			onUsage,
		);
		if (!label || labelEchoesHandle(sessionId, label)) return null;
		return label;
	} catch (err) {
		logger.debug("task-label: generation failed", {
			titleSessionId: sessionId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}
