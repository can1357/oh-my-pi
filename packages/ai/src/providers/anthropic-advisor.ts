/**
 * Anthropic advisor tool (`advisor_20260301`, beta `advisor-tool-2026-03-01`).
 *
 * The executor model calls `advisor` like any tool; Anthropic runs the advisor
 * model server-side inside the same `/v1/messages` request and streams back an
 * `advisor_tool_result` block. Both blocks replay verbatim on later requests
 * (redacted advice is decrypted server-side), and a call still pending when
 * the response ends (`pause_turn`, or a client `tool_use` in the same turn)
 * runs at the start of the next request that carries the tool.
 *
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
 */
import { resolveAdvisorModel } from "@oh-my-pi/pi-catalog/compat/advisor";
import type { AnthropicAdvisorOptions, Message, Model } from "../types";
import haikuPrompt from "./anthropic-advisor-haiku.md" with { type: "text" };
import defaultPrompt from "./anthropic-advisor.md" with { type: "text" };
import type { AdvisorTool, ContentBlockParam, MessageParam, UsageIteration } from "./anthropic-wire";

/** The advisor tool for `model`, or undefined when unset or the catalog rejects the pairing. */
export function resolveAnthropicAdvisorTool(
	model: Model<"anthropic-messages">,
	advisor: AnthropicAdvisorOptions | undefined,
): AdvisorTool | undefined {
	if (!advisor) return undefined;
	const advisorModel = resolveAdvisorModel(model, advisor.model);
	if (!advisorModel) return undefined;
	return { type: "advisor_20260301", name: "advisor", model: advisorModel };
}

/**
 * Executor guidance on when to consult the advisor (Anthropic's suggested
 * coding-task blocks). Haiku executors get the documented alternative, which
 * front-loads the first consult on coding work.
 */
export function anthropicAdvisorPrompt(model: Model<"anthropic-messages">): string {
	return model.identity?.family === "haiku" ? haikuPrompt : defaultPrompt;
}

/** Whether any assistant turn in `messages` carries advisor history blocks. */
export function contextHasAdvisorHistory(messages: readonly Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "anthropicServerTool") continue;
			if (block.block.type === "advisor_tool_result") return true;
			if (block.block.type === "server_tool_use" && block.block.name === "advisor") return true;
		}
	}
	return false;
}

/**
 * Ids of advisor calls in `messages` that never got an `advisor_tool_result`.
 * Replaying one requires the advisor tool on the request (it runs then);
 * without the tool the API rejects the request, so it must be dropped.
 */
export function pendingAdvisorCallIds(messages: readonly Message[]): ReadonlySet<string> {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "anthropicServerTool") continue;
			if (block.block.type === "server_tool_use" && block.block.name === "advisor") calls.add(block.block.id);
			else if (block.block.type === "advisor_tool_result") results.add(block.block.tool_use_id);
		}
	}
	for (const id of results) calls.delete(id);
	return calls;
}

/**
 * Whether `param` is an assistant turn ending on an advisor call that has no
 * result yet (a `pause_turn` response). Resuming replays it as the last
 * message unchanged; a trailing user nudge is not part of that contract.
 */
export function endsWithPendingAdvisorCall(param: MessageParam | undefined): boolean {
	if (param?.role !== "assistant" || typeof param.content === "string") return false;
	const last: ContentBlockParam | undefined = param.content.at(-1);
	return last?.type === "server_tool_use" && last.name === "advisor";
}

/** Whether the usage report includes an advisor sub-inference (billed at the advisor's rates). */
export function hasAdvisorIteration(iterations: readonly UsageIteration[] | null | undefined): boolean {
	return iterations?.some(iteration => iteration?.type === "advisor_message") ?? false;
}
