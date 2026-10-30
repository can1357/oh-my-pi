/**
 * Relocating a live session's working directory.
 *
 * A cwd change is not one assignment. The session file moves into the
 * destination project's bucket, the process chdir follows, and every
 * cwd-derived cache — project settings, memory scope, plugin roots, the title
 * prompt, skills and slash commands — has to be re-scoped with it, or the next
 * turn answers from two projects at once. The move commits only when every
 * step succeeded; a failure rolls the session and the process back to where
 * they started and says so.
 *
 * Shared by the headless `/move` command and the `cd` tool. The interactive
 * TUI keeps its own path (`InteractiveModeContext#applyCwdChange`) because it
 * also owns the status line, the terminal title, and the `/btw` move gate.
 */
import * as path from "node:path";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import type { AgentSession } from "./agent-session";
import type { SessionManager } from "./session-manager";

type SessionStateSnapshot = ReturnType<SessionManager["captureState"]>;

export interface CwdRelocationHost {
	readonly session: AgentSession;
	/** The instance whose project scope follows the session. */
	readonly settings: Settings;
	/**
	 * Runs after the session and the process are both at the new directory, for
	 * host state that is rebuilt rather than mutated (an ACP host's command
	 * list, plugin roots).
	 */
	afterRescope?(): Promise<void> | void;
}

export type CwdRelocationResult =
	| { ok: true; cwd: string; previousCwd: string; changed: boolean }
	| {
			ok: false;
			error: string;
			/** The rollback failed too: the session and the process may disagree about the workspace. */
			fatal: boolean;
	  };

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Re-point every cwd-derived cache at `cwd`. The caller must already have moved
 * the SessionManager's own cwd; `cwd` here is the directory it now holds.
 */
export async function rescopeCwdTo(host: Pick<CwdRelocationHost, "session" | "settings">, cwd: string): Promise<void> {
	setProjectDir(cwd);
	await host.settings.reloadForCwd(cwd);
	// The reload fired the memory scope hooks; complete the rebind so the next
	// prompt cannot recall or retain against the source project's memory.
	await rebindMemoryBackendForCwd(host.session);
	clearClaudePluginRootsCache();
	const source = discoverTitleSystemPromptFile(cwd);
	const titlePrompt = await resolvePromptInput(source, "title system prompt");
	host.session.setTitleSystemPrompt(titlePrompt);
	await host.session.refreshSkillsAndCommands();
}

async function rollback(
	host: CwdRelocationHost,
	snapshot: SessionStateSnapshot,
	attempted: string,
	cause: unknown,
): Promise<CwdRelocationResult> {
	const reason = describeError(cause);
	const manager = host.session.sessionManager;
	try {
		await manager.rollbackMove(snapshot);
		await rescopeCwdTo(host, snapshot.cwd);
	} catch (rollbackError) {
		const actual = manager.getCwd();
		// Re-align the caches with wherever the session actually ended up, so the
		// process and the session never point at two different projects.
		try {
			await rescopeCwdTo(host, actual);
		} catch {}
		return {
			ok: false,
			fatal: true,
			error: `Cannot change working directory to ${attempted}: ${reason} (rollback failed: ${describeError(rollbackError)}; workspace remains at ${actual})`,
		};
	}
	return { ok: false, fatal: false, error: `Cannot change working directory to ${attempted}: ${reason}` };
}

/**
 * Move `host.session` to `newCwd`: flush pending settings, relocate the session
 * and its artifacts, then re-scope the process. `newCwd` must exist and be a
 * directory — the caller checks that, because the message it can offer (which
 * of several candidate paths was meant) is better than a bare `ENOENT`.
 */
export async function relocateSessionCwd(host: CwdRelocationHost, newCwd: string): Promise<CwdRelocationResult> {
	const manager = host.session.sessionManager;
	const resolved = path.resolve(newCwd);
	const previousCwd = manager.getCwd();
	if (resolved === path.resolve(previousCwd)) {
		return { ok: true, cwd: resolved, previousCwd, changed: false };
	}

	try {
		await host.settings.flush();
	} catch (error) {
		return {
			ok: false,
			fatal: false,
			error: `Failed to save pending settings: ${describeError(error)}`,
		};
	}

	const snapshot = manager.captureState();
	try {
		await host.session.moveSession(resolved);
	} catch (error) {
		return { ok: false, fatal: false, error: `Move failed: ${describeError(error)}` };
	}

	try {
		await rescopeCwdTo(host, resolved);
		await host.afterRescope?.();
	} catch (error) {
		return await rollback(host, snapshot, resolved, error);
	}

	return { ok: true, cwd: resolved, previousCwd, changed: true };
}
