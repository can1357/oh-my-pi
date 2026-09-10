import { EventLoopKeepalive } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";
import type { InteractiveMode } from "./interactive-mode";
import type { SubmittedUserInput } from "./types";

export async function submitInteractiveInput(
	mode: Pick<
		InteractiveMode,
		"markPendingSubmissionStarted" | "finishPendingSubmission" | "showError" | "checkShutdownRequested"
	>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage" | "isStreaming">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) return;

	try {
		using _keepalive = new EventLoopKeepalive();
		const streamingBehavior = input.streamingBehavior ?? ("followUp" as const);
		if (!input.started && !mode.markPendingSubmissionStarted(input)) return;
		if (input.customType) {
			await session.promptCustomMessage(
				{
					customType: input.customType,
					content: input.text,
					display: input.display ?? false,
					attribution: "agent",
				},
				{ streamingBehavior },
			);
		} else if (input.synthetic) {
			await session.prompt(input.text, {
				synthetic: true,
				expandPromptTemplates: false,
				userInitiated: input.userInitiated,
			});
		} else {
			await session.prompt(input.text, { images: input.images, streamingBehavior });
		}
	} catch (error: unknown) {
		mode.showError(error instanceof Error ? error.message : "Unknown error occurred");
	} finally {
		mode.finishPendingSubmission(input);
		await mode.checkShutdownRequested();
	}
}
