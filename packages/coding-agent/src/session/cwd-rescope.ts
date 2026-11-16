import type { Settings } from "../config/settings";
import { clearClaudePluginRootsCache } from "../discovery/helpers";
import { rebindMemoryBackendForCwd } from "../hindsight/backend";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../system-prompt";
import type { AgentSession } from "./agent-session";

/**
 * Re-scope everything `session` derived from its working directory after the process moved to
 * `cwd` (`/move`, resuming a session from another project); the session manager's cwd MUST
 * already be `cwd`. Covers project settings and memory, plugin roots, the title prompt, task
 * agents, extensions, custom tools and owned MCP servers, then skills and slash commands, whose
 * refresh rebuilds the system prompt last so it reflects every refreshed source.
 *
 * `settings` is the store to re-scope; hosts without an initialized one pass `undefined`.
 */
export async function rescopeSessionToCwd(
	session: AgentSession,
	settings: Settings | undefined,
	cwd: string,
): Promise<void> {
	if (settings) {
		await settings.reloadForCwd(cwd);
		// The reload fired the memory scope hooks; complete the rebind before the move
		// commits so the next prompt cannot recall or retain against the source project.
		await rebindMemoryBackendForCwd(session);
	}
	clearClaudePluginRootsCache();
	session.setTitleSystemPrompt(await resolvePromptInput(discoverTitleSystemPromptFile(cwd), "title system prompt"));
	await session.refreshProjectScope();
	await session.refreshSkillsAndCommands();
}
