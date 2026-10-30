import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type BuiltSkillPromptMessage,
	parseSkillInvocation,
	type Skill,
	type SkillPromptInput,
} from "../extensibility/skills";
import type { AgentSession } from "./agent-session";
import type { PromptOptions } from "./agent-session-types";
import { SKILL_PROMPT_MESSAGE_TYPE } from "./messages";

/** A `/skill:<name>` command resolved to a registered skill. */
export interface SkillCommandInvocation extends SkillPromptInput {
	skill: Skill;
	queueChipText: string;
}

export interface DispatchSkillCommandOptions extends Pick<PromptOptions, "streamingBehavior" | "onPromptAdmitted"> {
	queueOnly?: boolean;
	images?: ImageContent[];
	/** Prompt already rendered after a currentness check; skips reading SKILL.md again. */
	prebuilt?: BuiltSkillPromptMessage;
}

/**
 * Fast in-memory pre-check for a skill invocation: settings gate, text shape
 * and skill lookup. Returns undefined when `text` is not a runnable skill
 * command. Performs no I/O.
 */
export function resolveSkillInvocation(
	session: Pick<AgentSession, "skills" | "skillsSettings">,
	text: string,
): SkillCommandInvocation | undefined {
	if (!session.skillsSettings?.enableSkillCommands) return undefined;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return undefined;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return undefined;
	return { skill, args: parsed.args, prompt: parsed.prompt, queueChipText: text };
}

/**
 * Build the skill prompt (unless `prebuilt`) through the session, so stale skills are
 * rediscovered and model mentions in the args are expanded, then dispatch it as a
 * user-attributed skill message.
 */
export async function dispatchSkillCommand(
	session: Pick<AgentSession, "buildUserSkillPrompt" | "promptCustomMessage">,
	invocation: SkillCommandInvocation,
	options?: DispatchSkillCommandOptions,
): Promise<boolean> {
	const built = options?.prebuilt ?? (await session.buildUserSkillPrompt(invocation.skill, invocation));
	const images = options?.images;
	return session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: images?.length ? [{ type: "text", text: built.message }, ...images] : built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{
			streamingBehavior: options?.streamingBehavior ?? "steer",
			queueOnly: options?.queueOnly,
			queueChipText: invocation.queueChipText,
			onPromptAdmitted: options?.onPromptAdmitted,
		},
	);
}
