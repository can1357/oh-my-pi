import { prompt } from "@oh-my-pi/pi-utils";
import { displayExitReason } from "../launch/exit-reason";
import type { DaemonCompletionNotification } from "../launch/protocol";
import launchCompletionTemplate from "../prompts/session/launch-completion.md" with { type: "text" };
import type { CustomMessage } from "./messages";

function modelExitReason(reason: string | undefined): string | undefined {
	return displayExitReason(reason);
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
