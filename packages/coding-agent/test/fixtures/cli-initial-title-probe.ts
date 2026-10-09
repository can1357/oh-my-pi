import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentSession } from "../../src/session/agent-session";

const outputPath = Bun.env.OMP_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("OMP_TITLE_PROBE_PATH is required");
}

let generatedFrom: string | undefined;

AgentSession.prototype.generateTitle = (firstMessage: string): Promise<string | null> => {
	generatedFrom = firstMessage;
	return Promise.resolve("CLI Initial Title");
};

AgentSession.prototype.prompt = async function(message: string): Promise<boolean> {
	// Drive the reply-gated auto-title flow without a model: land the operator
	// message, then start its reply so the session requests a title.
	const userMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: message }],
		attribution: "user",
		timestamp: Date.now(),
	} as AgentMessage;
	this.agent.emitExternalEvent({ type: "message_end", message: userMessage });
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		timestamp: Date.now(),
	} as AssistantMessage;
	this.agent.emitExternalEvent({
		type: "message_update",
		message: assistantMessage,
		assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistantMessage },
	});
	// The title request starts synchronously off the reply event; let its
	// promise chain (generateTitle stub, then setSessionName) settle.
	await Bun.sleep(500);
	await Bun.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.sessionName }));
	process.exit(0);
};
