import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "./lsp/index";
import { resolveToCwd } from "./path-utils";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** Options for creating the write tool */
export interface WriteToolOptions {
	writethrough?: WritethroughCallback;
}

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
}

export function createWriteTool(
	cwd: string,
	options: WriteToolOptions = {},
): AgentTool<typeof writeSchema, WriteToolDetails> {
	const writethrough = options.writethrough ?? writethroughNoop;
	return {
		name: "write",
		label: "Write",
		description: `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveToCwd(path, cwd);

			const diagnostics = await writethrough(absolutePath, content, signal);

			let resultText = `Successfully wrote ${content.length} bytes to ${path}`;
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: {},
				};
			}

			const messages = diagnostics?.messages;
			if (messages && messages.length > 0) {
				resultText += `\n\nLSP Diagnostics (${diagnostics.summary}):\n`;
				resultText += messages.map((d) => `  ${d}`).join("\n");
			}
			return {
				content: [{ type: "text", text: resultText }],
				details: { diagnostics },
			};
		},
	};
}

/** Default write tool using process.cwd() - for backwards compatibility */
export const writeTool = createWriteTool(process.cwd());
