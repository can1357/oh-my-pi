import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { DaemonCompletionNotification } from "../launch/protocol";
import launchCompletionTemplate from "../prompts/session/launch-completion.md" with { type: "text" };
import type { CustomMessage } from "./messages";

const MAX_EXIT_REASON_LENGTH = 1_024;

function modelExitReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	const sanitized = sanitizeText(reason).replace(/\s+/g, " ").trim();
	if (!sanitized) return undefined;
	return sanitized.length > MAX_EXIT_REASON_LENGTH ? `${sanitized.slice(0, MAX_EXIT_REASON_LENGTH - 1)}…` : sanitized;
}

/** Yield-queue kind for broker-owned supervised process completions. */
export const LAUNCH_COMPLETION_MESSAGE_TYPE = "launch-completion";

/** One broker completion awaiting injection into its owning session. */
export type LaunchCompletionEntry = DaemonCompletionNotification;

/** Whether a broker completion belongs to the primary session or its advisor. */
export function isLaunchCompletionOwner(owner: string, sessionId: string): boolean {
	return owner === sessionId || owner === `${sessionId}-advisor`;
}

/** Build one model-visible notification per terminal supervised process exit. */
export function buildLaunchCompletionBatchMessage(entries: LaunchCompletionEntry[]): CustomMessage {
	return {
		role: "custom",
		customType: LAUNCH_COMPLETION_MESSAGE_TYPE,
		content: entries
			.map(({ daemon }) =>
				prompt.render(launchCompletionTemplate, {
					name: daemon.name,
					state: daemon.state,
					exitCode: daemon.exitCode,
					hasExitCode: daemon.exitCode !== undefined,
					exitReason: modelExitReason(daemon.exitReason),
				}),
			)
			.join("\n"),
		display: true,
		attribution: "agent",
		details: { daemons: entries.map(entry => entry.daemon) },
		timestamp: Date.now(),
	};
}
