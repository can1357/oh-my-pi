/**
 * Inbound attachment storage: documents from Telegram land under
 * `<stateDir>/inbox/<threadId>/` with a path the session can read, and the
 * prompt carries that path.
 */
import * as path from "node:path";
import type { TelegramDocument } from "./types";

const DEFAULT_FILE_NAME = "file";

/**
 * Inbox name for one attachment: the message id first, so two same-named
 * uploads (two `log.txt` documents) never overwrite each other, then the
 * original name with path separators folded to `_` to keep it readable.
 */
export function inboxFileName(messageId: number, document: TelegramDocument | undefined | null): string {
	const name = String(document?.file_name ?? "")
		.trim()
		.replace(/[\\/]/gu, "_");
	return `${messageId}-${name === "" ? DEFAULT_FILE_NAME : name}`;
}

/** Writes one attachment; resolves the absolute path handed to the session. */
export async function writeInboxFile(input: {
	stateDir: string;
	threadId: number;
	name: string;
	data: Uint8Array;
}): Promise<string> {
	const file = path.join(input.stateDir, "inbox", String(input.threadId), input.name);
	await Bun.write(file, input.data);
	return file;
}
