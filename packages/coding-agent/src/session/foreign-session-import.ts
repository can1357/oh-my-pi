import { directoryExists } from "@oh-my-pi/pi-utils";
import type * as ClaudeStore from "./claude-session-store";
import type * as CodexStore from "./codex-session-store";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import type { SessionInfo } from "./session-listing";
import type { SessionManager } from "./session-manager";

/** Construct the importer for a supported foreign session source. */
export function createForeignSessionStore(source: ForeignSessionSource): ForeignSessionStore {
	if (source === "claude") {
		const { ClaudeSessionStore } = require("./claude-session-store") as typeof ClaudeStore;
		return new ClaudeSessionStore();
	}
	const { CodexSessionStore } = require("./codex-session-store") as typeof CodexStore;
	return new CodexSessionStore();
}

/** Display name for a supported foreign session source. */
export function foreignSessionSourceName(source: ForeignSessionSource): string {
	return source === "claude" ? "Claude" : "Codex";
}

/** Convert lightweight foreign metadata for the existing session picker. */
export function foreignSessionInfoToSessionInfo(info: ForeignSessionInfo): SessionInfo {
	const firstMessage = info.firstMessage ?? "(no messages)";
	return {
		path: info.path,
		id: info.id,
		cwd: info.cwd,
		title: info.title,
		created: info.created,
		modified: info.modified,
		messageCount: info.messageCount ?? 0,
		size: 0,
		firstMessage,
		allMessagesText: firstMessage,
	};
}

/** Import and persist one foreign session under a fresh OMP session identity. */
export async function persistForeignSession(
	store: ForeignSessionStore,
	info: ForeignSessionInfo,
	options?: { fallbackCwd?: string; sessionDir?: string; suppressBreadcrumb?: boolean },
): Promise<SessionManager> {
	const imported = await store.load(info);
	imported.appendCustomEntry("foreign_session_import", {
		source: info.source,
		sourceId: info.id,
		sourcePath: info.path,
		sourceCwd: info.cwd,
	});
	if (options?.fallbackCwd && !(await directoryExists(imported.getCwd()))) {
		await imported.moveTo(options.fallbackCwd);
	}
	return await imported.persistCopy(options);
}
