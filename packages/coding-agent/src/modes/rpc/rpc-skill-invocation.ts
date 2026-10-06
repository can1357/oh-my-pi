/**
 * The `/skill:<name>` invocation RPC prompts use, shared with extension
 * `sendUserInput`. A leaf module: the extension action builders import it, and
 * importing `rpc-mode` from there would load the slash-command registry
 * while it is still initializing.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import {
	type BuiltSkillPromptMessage,
	buildSkillPromptMessage,
	parseSkillInvocation,
	type Skill,
	type SkillPromptInput,
} from "../../extensibility/skills";
import type { AgentSession } from "../../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../../session/messages";

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;

export interface RpcSkillInvocation extends SkillPromptInput {
	skill: Skill;
	queueChipText: string;
}

/**
 * Fast in-memory pre-check for a skill invocation: settings gate, text shape,
 * and skill lookup. Returns null when the message is not a runnable skill
 * command. Performs no I/O — safe to run on the RPC serial queue.
 */
export function resolveRpcSkillInvocation(session: RpcSkillCommandSession, text: string): RpcSkillInvocation | null {
	if (!session.skillsSettings?.enableSkillCommands) return null;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return null;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return null;
	return { skill, args: parsed.args, prompt: parsed.prompt, queueChipText: text };
}

/** Options for {@link runRpcSkillCommand}. */
export interface RpcSkillCommandOptions {
	/** How the skill prompt queues while the agent is streaming (default: steer). */
	streamingBehavior?: "steer" | "followUp" | "aside";
	/** The skill prompt message, when the caller has already built it. */
	prebuilt?: BuiltSkillPromptMessage;
	/** Called once the session admits the prompt. */
	onPromptAdmitted?: () => void;
	/** Images sent after the skill prompt text. */
	images?: ImageContent[];
	/** Caller correlation id recorded as `tag` on the skill prompt message. */
	tag?: string;
}

/**
 * Slow half of a skill invocation: builds the skill prompt message (file I/O)
 * and dispatches it through the full prompt pipeline (usage preflight,
 * compaction checks, provider calls). Resolves once the turn is scheduled.
 * Must not run on the RPC serial queue's response path — register it with
 * watchAndReportPromptResult and answer the command once it is admitted.
 */
export async function runRpcSkillCommand(
	session: RpcSkillCommandSession,
	invocation: RpcSkillInvocation,
	options: RpcSkillCommandOptions = {},
): Promise<boolean> {
	const { streamingBehavior = "steer", prebuilt, onPromptAdmitted, images, tag } = options;
	const built = prebuilt ?? (await buildSkillPromptMessage(invocation.skill, invocation, "user"));
	return session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: images?.length ? [{ type: "text", text: built.message }, ...images] : built.message,
			display: true,
			details: built.details,
			attribution: "user",
			...(tag !== undefined && { tag }),
		},
		{ streamingBehavior, queueChipText: invocation.queueChipText, onPromptAdmitted },
	);
}
