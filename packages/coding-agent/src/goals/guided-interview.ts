import { prompt } from "@oh-my-pi/pi-utils";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };

/**
 * Render the `/guided-goal` interview kickoff: the hidden developer message that
 * makes the agent interview the user before calling `goal create`. Shared by the
 * interactive `/guided-goal` command and RPC/SDK hosts that start the same
 * interview without the TUI.
 */
export function renderGuidedGoalInterview(initial?: string): string {
	return prompt.render(guidedGoalInterviewPrompt, { initial: initial?.trim() || undefined });
}
