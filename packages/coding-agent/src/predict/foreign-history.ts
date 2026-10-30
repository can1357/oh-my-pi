/**
 * Prompts other coding agents recorded on this machine: Claude Code's and
 * Codex's `history.jsonl`. The text-prediction daemon feeds them once into a
 * learning engine whose state starts empty, so a new install already knows the
 * user's vocabulary before omp has history of its own.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { resolveClaudePaths } from "../config/claude-paths";
import { readForeignJsonRecords } from "../session/foreign-session-jsonl";

/** Claude Code placeholders for pasted text and images: not words the user typed. */
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/g;

/** Claude Code then Codex prompts, each in file order; missing or unreadable files contribute nothing. */
export async function readForeignPrompts(): Promise<string[]> {
	const files = [
		path.join(resolveClaudePaths().configDir, "history.jsonl"),
		path.join(os.homedir(), ".codex", "history.jsonl"),
	];
	const prompts: string[] = [];
	for (const file of files) {
		try {
			for await (const { value } of readForeignJsonRecords(file)) {
				// Claude Code writes `display`; Codex (and older Claude Code) `text`.
				const text = value.display ?? value.text;
				// Slash commands are not prose.
				if (typeof text !== "string" || text.startsWith("/")) continue;
				const prompt = text.replace(PLACEHOLDER, " ").trim();
				if (prompt) prompts.push(prompt);
			}
		} catch (error) {
			if (!isEnoent(error)) logger.debug("text-predict: foreign history unreadable", { file, error: String(error) });
		}
	}
	return prompts;
}
