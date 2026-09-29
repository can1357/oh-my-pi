/**
 * Live subagent state (roster + streamed progress) for transcript cards. The
 * session provides it once; transcripts in the main view and the agent drawer
 * read the same snapshot, so a task card's rows track the rail in real time.
 */
import type { AgentSnapshot, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { createContext, useContext } from "react";

export interface AgentLive {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
}

const EMPTY: AgentLive = { agents: [], progress: new Map(), lifecycle: new Map() };
export const AgentLiveContext = createContext<AgentLive>(EMPTY);

export function useAgentLive(): AgentLive {
	return useContext(AgentLiveContext);
}
