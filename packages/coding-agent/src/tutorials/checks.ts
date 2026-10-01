/**
 * Step-check evaluation against what actually happened in the session.
 *
 * The controller folds every {@link AgentSessionEvent} the TUI receives into a
 * {@link StepObservation} (reset when a step starts) and records slash commands
 * as the input controller dispatches them. At each evaluation point the current
 * step's checks run against that observation plus the sandbox repo on disk.
 */
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { containsMagicKeyword } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import type { AgentSessionEvent } from "../session/agent-session-events";
import type { StepCheck } from "./lesson";

/** Everything observed since the current step started. */
export interface StepObservation {
	/** Agent turns that finished (yielded back to the user). */
	turns: number;
	userTexts: string[];
	toolCalls: { name: string; args: unknown }[];
	/** Canonical slash-command names, without the leading `/`. */
	commands: string[];
	/** Final assistant text of the most recent finished turn. */
	lastReply: string;
}

export function emptyObservation(): StepObservation {
	return { turns: 0, userTexts: [], toolCalls: [], commands: [], lastReply: "" };
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * Fold one session event into `observation`. Returns true when the event ends a
 * turn that handed control back to the user — the point at which checks run.
 */
export function recordSessionEvent(observation: StepObservation, event: AgentSessionEvent): boolean {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "user") observation.userTexts.push(messageText(event.message));
			return false;
		case "tool_execution_start":
			observation.toolCalls.push({ name: event.toolName, args: event.args });
			return false;
		case "agent_end": {
			// A non-yielded end means the agent continues on its own (retry, compaction continuation).
			if (event.yielded === false) return false;
			observation.turns++;
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const message = event.messages[i]!;
				if (message.role !== "assistant") continue;
				const text = messageText(message).trim();
				if (text) {
					observation.lastReply = text;
					break;
				}
			}
			return true;
		}
		default:
			return false;
	}
}

async function checkPasses(check: StepCheck, observation: StepObservation, repoDir: string): Promise<boolean> {
	switch (check.kind) {
		case "turn":
			return observation.turns > 0;
		case "keyword":
			return observation.userTexts.some(text => containsMagicKeyword(text, check.word));
		case "tool":
			return observation.toolCalls.some(
				call => call.name === check.name && (!check.match || check.match.test(JSON.stringify(call.args ?? {}))),
			);
		case "command":
			return observation.commands.includes(check.name);
		case "reply":
			return check.pattern.test(observation.lastReply);
		case "file": {
			try {
				return check.matches.test(await Bun.file(path.join(repoDir, check.path)).text());
			} catch (error) {
				if (isEnoent(error)) return false;
				throw error;
			}
		}
	}
}

/** Return the first check that does not pass, or `undefined` when the step is complete. */
export async function findFailingCheck(
	checks: readonly StepCheck[],
	observation: StepObservation,
	repoDir: string,
): Promise<StepCheck | undefined> {
	for (const check of checks) {
		if (!(await checkPasses(check, observation, repoDir))) return check;
	}
	return undefined;
}
