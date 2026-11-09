import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { AgentSession } from "../../session/agent-session";
import { isSessionSettled } from "../../session/session-settle";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import type { RpcSessionState } from "./rpc-types";

/**
 * Snapshot one RPC `get_state` payload. Shared by every transport so a second
 * client sees exactly the state the stdio transport reports.
 */
export function getRpcSessionState(session: AgentSession, scheduledTurn?: () => boolean): RpcSessionState {
	const queuedMessages = session.getQueuedMessages();
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		queuedMessageCount: session.queuedMessageCount,
		hasPendingAsyncWork: session.hasPendingAsyncWork(),
		// A scheduled goal continuation will start a turn: not settled.
		isSettled: isSessionSettled(session, scheduledTurn),
		queuedMessages: {
			steering: [...queuedMessages.steering],
			followUp: [...queuedMessages.followUp],
			liveSteered: queuedMessages.liveSteered,
		},
		todoPhases: session.getTodoPhases(),
		fastModeEnabled: session.isFastModeEnabled(),
		tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
		fastModeActive: session.isFastModeActive(),
		slowModeSupported: session.isSlowModeSupported(),
		slowModeEnabled: session.isSlowModeEnabled(),
		slowModeScope: session.getSlowModeScope(),
		usageLimit: session.getUsageLimitState(),
		messageCount: session.messages.length,
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: toolWireSchema(tool),
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
		goal: session.getGoalModeState() ?? null,
	};
}
