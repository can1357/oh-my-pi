/**
 * Auto-read file mentions from user prompts.
 *
 * When users reference files with @path syntax (e.g., "@src/foo.ts"),
 * we automatically inject the file contents as a FileMentionMessage
 * so the agent doesn't need to read them manually.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { FileMentionMessage } from "./messages";
import { createReadTool } from "./tools/read";

/** Regex to match @filepath patterns in text */
const FILE_MENTION_REGEX = /@((?:[^\s@]+\/)*[^\s@]+\.[a-zA-Z0-9]+)/g;

/** Extract all @filepath mentions from text */
export function extractFileMentions(text: string): string[] {
	const matches = [...text.matchAll(FILE_MENTION_REGEX)];
	return [...new Set(matches.map((m) => m[1]))];
}

/**
 * Generate a FileMentionMessage containing the contents of mentioned files.
 * Returns empty array if no files could be read.
 */
export async function generateFileMentionMessages(filePaths: string[], cwd: string): Promise<AgentMessage[]> {
	if (filePaths.length === 0) return [];

	const readTool = createReadTool(cwd);
	const files: FileMentionMessage["files"] = [];

	for (const filePath of filePaths) {
		try {
			const result = await readTool.execute("auto-read", { path: filePath });
			const textContent = result.content.find((c) => c.type === "text");
			if (textContent && textContent.type === "text") {
				const lineCount = textContent.text.split("\n").length;
				files.push({ path: filePath, content: textContent.text, lineCount });
			}
		} catch {
			// File doesn't exist or isn't readable - skip silently
		}
	}

	if (files.length === 0) return [];

	const message: FileMentionMessage = {
		role: "fileMention",
		files,
		timestamp: Date.now(),
	};

	return [message];
}
