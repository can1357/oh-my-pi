import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { getSkillSlashCommandName, parseSkillInvocation } from "../extensibility/skills";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../session/messages";
import type { InteractiveModeContext } from "./types";

type SkillCommandHost = Pick<
	InteractiveModeContext,
	| "skillCommands"
	| "showError"
	| "renderOptimisticSkillMessage"
	| "clearOptimisticSkillMessage"
	| "optimisticSkillMessagePending"
	| "restoreDroppedPrompt"
> & {
	session: Pick<InteractiveModeContext["session"], "buildUserSkillPrompt" | "promptCustomMessage" | "isStreaming">;
};

type SkillPromptMessage = Pick<
	CustomMessage<SkillPromptDetails>,
	"customType" | "content" | "display" | "details" | "attribution"
> & {
	customType: typeof SKILL_PROMPT_MESSAGE_TYPE;
	content: string | (TextContent | ImageContent)[];
	display: true;
	details: SkillPromptDetails;
	attribution: "user";
};

type SkillPromptOptions = {
	streamingBehavior: "steer" | "followUp";
	queueChipText: string;
};

interface InvokeSkillCommandOptions {
	propagateErrors?: boolean;
	queueOnly?: boolean;
	images?: ImageContent[];
	imageLinks?: (string | undefined)[];
	/**
	 * Paint the built row before the awaited dispatch so a slow preflight (memory
	 * recall, `before_agent_start` hooks, auto-thinking, pre-prompt compaction)
	 * does not leave the submission invisible (issue #8895).
	 */
	optimistic?: boolean;
	/** With `queueOnly`: called with the messages the skill prompt pushed onto a queue (see `PromptOptions.onPromptQueued`). */
	onPromptQueued?: (queued: readonly AgentMessage[]) => void;
	/**
	 * Without `queueOnly`: prompts that must run after the skill, in order (see `PromptOptions.followUps`).
	 * If the skill fails before reaching the session, it goes back to the editor with them as one list.
	 */
	followUps?: string[];
}

/** Built custom-message payload and delivery options for a `/skill:` command. */
export interface BuiltSkillCommandPrompt {
	message: SkillPromptMessage;
	options: SkillPromptOptions;
}

/** Return true when `text` invokes a registered `/skill:<name>` command. */
export function isKnownSkillCommand(ctx: SkillCommandHost, text: string): boolean {
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	return ctx.skillCommands.has(getSkillSlashCommandName({ name: parsed.name }));
}

/** Build the user-attributed custom message for a registered `/skill:<name>` command. */
export async function buildSkillCommandPrompt(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	images?: ImageContent[],
): Promise<BuiltSkillCommandPrompt | undefined> {
	const parsed = parseSkillInvocation(text);
	if (!parsed) return undefined;
	const skill = ctx.skillCommands.get(getSkillSlashCommandName({ name: parsed.name }));
	if (!skill) return undefined;

	const built = await ctx.session.buildUserSkillPrompt(skill, parsed);
	const textBlock: TextContent = { type: "text", text: built.message };
	const promptContent = images && images.length > 0 ? [textBlock, ...images] : built.message;

	return {
		message: {
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: promptContent,
			display: true,
			details: built.details,
			attribution: "user",
		},
		options: { streamingBehavior, queueChipText: text },
	};
}

/** Invoke a registered `/skill:<name>` command as a user-attributed custom message. */
export async function invokeSkillCommandFromText(
	ctx: SkillCommandHost,
	text: string,
	streamingBehavior: "steer" | "followUp",
	options?: InvokeSkillCommandOptions,
): Promise<boolean> {
	let optimistic = false;
	let reachedSession = false;
	try {
		const built = await buildSkillCommandPrompt(ctx, text, streamingBehavior, options?.images);
		if (!built) {
			restoreUndeliveredList(ctx, text, options);
			return false;
		}
		const promptOptions = options?.queueOnly
			? { ...built.options, queueOnly: true, onPromptQueued: options.onPromptQueued }
			: { ...built.options, followUps: options?.followUps };
		optimistic = options?.optimistic === true && !options?.queueOnly && !ctx.session.isStreaming;
		if (optimistic) {
			ctx.renderOptimisticSkillMessage(
				{ role: "custom", ...built.message, timestamp: Date.now() },
				{ imageLinks: options?.imageLinks },
			);
		}
		reachedSession = true;
		await ctx.session.promptCustomMessage(built.message, promptOptions);
		return true;
	} catch (err) {
		if (optimistic) ctx.clearOptimisticSkillMessage();
		if (!reachedSession) restoreUndeliveredList(ctx, text, options);
		if (options?.propagateErrors) {
			throw err;
		}
		ctx.showError(`Failed to load skill: ${err instanceof Error ? err.message : String(err)}`);
		return true;
	} finally {
		if (optimistic && ctx.optimisticSkillMessagePending) {
			// Dispatch resolved without a canonical skill message_start (aborted
			// preflight, or a streaming-race requeue): drop the pending row.
			ctx.clearOptimisticSkillMessage();
		}
	}
}

/** The session owns follow-ups it received; a list that never reached it goes back to the editor here. */
function restoreUndeliveredList(
	ctx: SkillCommandHost,
	text: string,
	options: InvokeSkillCommandOptions | undefined,
): void {
	if (!options?.followUps?.length) return;
	ctx.restoreDroppedPrompt({ text, images: options.images, followUps: options.followUps });
}
