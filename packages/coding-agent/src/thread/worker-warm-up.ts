/**
 * Worker side of a subagent host's warm-up (`warmUp` on the worker link), run
 * once after boot so the first subagent spawned here starts as fast as later
 * ones (the build identity arrives at boot, the model-registry mirror through
 * the auth service's `prewarmModelRegistryMirror`).
 *
 * 1. The read-only, cached discoveries every subagent session in `cwd`
 *    performs at creation, so their per-thread caches are filled.
 * 2. One throwaway session built and disposed through the same
 *    `createAgentSession` path a subagent takes, so its one-time costs (lazy
 *    module state, tool construction, system-prompt rendering, the session
 *    publisher, JIT tiers) are paid here. It is sealed off from shared state:
 *    a private agent registry (nothing reaches main's), an in-memory session
 *    manager, a derived settings overlay with the memory backend and
 *    auto-learn off, no extensions, MCP, LSP, IRC, or UI, and no prompt.
 */
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { discoverAdvisorConfigs } from "../advisor/config";
import { discoverWatchdogFiles } from "../advisor/watchdog";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession, discoverPromptTemplates, discoverSlashCommands } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { resolveActiveRepoContext } from "../utils/active-repo-context";
import type { SubagentWorkerWarmUp } from "./protocol";

/** Agent id of the throwaway warm-up session (in its private registry only). */
const WARM_UP_AGENT_ID = "WorkerWarmUp";

/**
 * Pay this worker's one-time first-session costs for the session context subagents here inherit
 * (see the module doc). Failures are logged: they only leave the first real run to pay instead.
 */
export async function warmUpSubagentWorker({ cwd, settings, modelRegistry }: SubagentWorkerWarmUp): Promise<void> {
	const agentDir = getAgentDir();
	const results = await Promise.allSettled([
		discoverSlashCommands(cwd),
		discoverPromptTemplates(cwd, agentDir),
		discoverWatchdogFiles(cwd, agentDir),
		discoverAdvisorConfigs(cwd, agentDir),
		resolveActiveRepoContext(cwd),
	]);
	for (const result of results) {
		if (result.status === "rejected") logger.debug("Subagent worker warm-up step failed", { err: result.reason });
	}
	if (!settings || !modelRegistry) return;
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings: settings.overlay({ "memory.backend": "off", "autolearn.enabled": false }, { derived: true }),
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			agentRegistry: new AgentRegistry(),
			agentId: WARM_UP_AGENT_ID,
			bindProcessState: false,
			taskDepth: 1,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			hasUI: false,
			cacheWarming: false,
		});
		await session.dispose();
	} catch (error) {
		logger.debug("Subagent worker warm-up session failed", { err: error });
	}
}
