/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Demonstrates the "prompt generator" pattern:
 * 1. /qna command gets the last assistant message
 * 2. Shows a spinner while extracting (hides editor)
 * 3. Loads the result into the editor for user to fill in answers
 */
import { complete, type UserMessage } from "@oh-my-pi/pi-ai";
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering and format them for the user to fill in.

Output format:
- List each question on its own line, prefixed with "Q: "
- After each question, add a blank line for the answer prefixed with "A: "
- If no questions are found, output "No questions found in the last message."

Example output:
Q: What is your preferred database?
A: 

Q: Should we use TypeScript or JavaScript?
A: 

Keep questions in the order they appeared. Be concise.`;

export default function (pi: HookAPI) {
	pi.registerCommand("qna", {
		description: "Extract questions from last assistant message into editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("qna requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Run extraction with loader UI
			const result = await ctx.ui.custom<string | null>((_ui, _theme, _keybindings, done) => {
				const abort = new AbortController();

				// Do the work
				const doExtract = async () => {
					const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: [SYSTEM_PROMPT], messages: [userMessage] },
						{ apiKey, signal: abort.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text)
						.join("\n");
				};

				doExtract()
					.then(done)
					.catch(() => done(null));

				// A pi-tui node: the root takes keyboard focus, so Escape reaches its onKey.
				return (
					<col
						onKey={key => {
							if (key.id !== "escape") return false;
							abort.abort();
							done(null);
							return true;
						}}
					>
						<spinner label={`Extracting questions using ${ctx.model!.id}…`} />
						<text spans={[{ t: "esc to cancel", s: "muted" }]} />
					</col>
				);
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(result);
			ctx.ui.notify("Questions loaded. Edit and submit when ready.", "info");
		},
	});
}
