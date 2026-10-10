import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

export async function submitShortcut(
	session: AgentSession,
	sessionManager: SessionManager,
	shortcut: "." | "c",
): Promise<void> {
	const editor = new CustomEditor(getEditorTheme());
	let continuation: Promise<unknown> | undefined;
	const ctx = {
		editor,
		session,
		viewSession: session,
		sessionManager,
		isGuidedGoalInterviewActive: () => false,
		showStatus: () => undefined,
		onInputCallback: (input: SubmittedUserInput) => {
			continuation = session.prompt(input.text, {
				synthetic: input.synthetic,
				userInitiated: input.userInitiated,
			});
		},
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();

	let submission: Promise<void> | undefined;
	const onSubmit = editor.onSubmit;
	editor.onSubmit = text => {
		submission = Promise.resolve(onSubmit?.(text));
		return submission;
	};
	editor.setText(shortcut);
	editor.handleInput("\r");
	if (submission) await submission;
	if (continuation) await continuation;
	await session.waitForIdle();
}
