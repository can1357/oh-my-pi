import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import { isLocalAgentSession } from "../session/agent-session-handle";

const SCOUT_RUNTIME_HEADER = "⁂ Reconnaissance runtime\n";

export function withScoutRuntimePrompt(
	blocks: readonly string[],
	options: { agentId: string; budget: number; reportingGraceRequests: number; restored?: boolean },
): string[] {
	const session = AgentRegistry.global().get(options.agentId)?.session;
	if (!session || !isLocalAgentSession(session)) return [...blocks];
	const toolNames = session.getEnabledToolNames();
	const shellTools = ["bash", "eval"].filter(name => toolNames.includes(name));
	const inventory = options.restored
		? `Effective enabled tools: ${toolNames.join(", ") || "none"}. This runtime set overrides any earlier saved tool inventory.`
		: "The Tool Inventory and xd:// devices above describe your effective tools, not your parent's tools or the agent definition's requested tools.";
	const shell =
		shellTools.length > 0
			? `Shell/code execution tools available: ${shellTools.join(", ")}. Use only the tools advertised above.`
			: "Shell execution is unavailable: neither bash nor eval is enabled. Do not call them or invent shell tools; use the available read/search tools.";
	const allowance =
		options.budget > 0
			? `Exploration allowance: ${options.budget} assistant requests per run. At ${options.budget}, stop exploring and deliver your report. At ${Math.ceil(options.budget * 1.5)}, the runtime stops exploration and forces a partial report; ${options.reportingGraceRequests} further requests are reserved for reporting before hard abort.`
			: "The request-budget guard is explicitly disabled for this run. Report as soon as you have the requested evidence.";
	const notice = `${SCOUT_RUNTIME_HEADER}${inventory}\n${shell}\n${allowance}\nBudget exhaustion is a completion condition, even if work remains. Return collected evidence, relevant paths, unresolved questions, and capability limits in a partial report. Never spend the reporting allowance on more exploration.`;
	return [...blocks.filter(block => !block.startsWith(SCOUT_RUNTIME_HEADER)), notice];
}

export async function refreshScoutRuntimePrompt(session: AgentSession, agentName: string): Promise<void> {
	if (agentName !== "scout") return;
	await session.setActiveToolPresentation(session.getEnabledToolNames(), session.getMountedXdevToolNames(), true);
}
