import { prompt } from "@oh-my-pi/pi-utils";
import idleRecapPrompt from "../prompts/system/recap-user.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { previewLine, TRUNCATE_LENGTHS } from "../tools/render-utils";

const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

export function idleRecapDelayMs(idleSeconds: number): number {
	return Math.max(IDLE_RECAP_MIN_SECONDS, Math.min(IDLE_RECAP_MAX_SECONDS, idleSeconds)) * 1000;
}

export interface IdleRecapHints {
	goal?: string;
	task?: string;
}

export async function generateIdleRecap(
	session: Pick<AgentSession, "runEphemeralTurn">,
	hints: IdleRecapHints,
	signal: AbortSignal,
): Promise<string | undefined> {
	const promptText = prompt.render(idleRecapPrompt, {
		goal: hints.goal ?? "",
		task: hints.task ?? "",
	});
	const { replyText } = await session.runEphemeralTurn({ promptText, signal });
	return previewLine(replyText, TRUNCATE_LENGTHS.RECAP) || undefined;
}
