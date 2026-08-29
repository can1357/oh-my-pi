/**
 * Provider/model attribution for subagent failure messages.
 *
 * A subagent can resolve to a different provider than its parent session:
 * modelRoles.task, agent frontmatter models, and catalog fallbacks can all
 * route a task away from the parent's transport. When such a spawn fails,
 * the raw stream error used to surface with no hint of which provider or
 * model produced it — in #4813 a Claude OAuth session reported Cursor
 * transport errors ("Connect error invalid_argument: Error") and the
 * misrouting was invisible to the user. Prefixing the failing model's
 * identity makes the failure name its transport, so a mismatch between the
 * expected provider and the one that actually errored is instantly visible.
 */

/** Minimal shape of the assistant message a failed turn leaves behind. */
export interface FailedAssistantModelInfo {
	provider?: string;
	model?: string;
}

/**
 * Attributes a subagent failure message with the provider/model that
 * produced it, falling back to the given text when the message is empty.
 * The prefix is skipped when the message already names the provider (some
 * provider errors embed it) or when no identity is known.
 */
export function attributeSubagentError(
	message: string | undefined,
	source: FailedAssistantModelInfo | undefined,
	fallback = "Subagent failed",
): string {
	const text = message?.trim() ? message : fallback;
	const provider = source?.provider?.trim() || undefined;
	const model = source?.model?.trim() || undefined;
	const identity = provider && model ? `${provider}/${model}` : (provider ?? model);
	if (!identity) return text;
	if (provider && text.toLowerCase().includes(provider.toLowerCase())) return text;
	return `[${identity}] ${text}`;
}
