/** Result of one host-backed transcript read for the Agent Hub viewer. */
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	/** Terminal read failure reported by the host; guests should surface it instead of retrying hot. */
	error?: string;
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = temporarily unavailable. */
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}
