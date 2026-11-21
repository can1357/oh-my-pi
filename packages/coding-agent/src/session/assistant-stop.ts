import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isSilentAbort, isUserInterruptAbort } from "./messages";

/** How a model loop's last assistant message ended, as surfaces that report turn outcomes see it. */
export interface LastAssistantStop {
	/** The reply text, else the error that ended it (never a silent or user-interrupt abort's). */
	response: string;
	/** `stop_failure` when the turn ended on an error or a non-user abort that carries a message. */
	event: "stop" | "stop_failure";
	error_type?: "error" | "aborted";
}

/** Classify how the last assistant message in `messages` (a loop's `agent_end` payload) ended. */
export function lastAssistantStop(messages: readonly AgentMessage[]): LastAssistantStop {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;

		const text = message.content
			.filter(content => content.type === "text")
			.map(content => content.text)
			.join("");

		let response = "";
		if (text.length > 0) {
			response = text;
		} else {
			const errorMessage = message.errorMessage;
			if (typeof errorMessage === "string" && errorMessage.length > 0 && !isSilentAbort(message)) {
				if (message.stopReason === "error") {
					response = errorMessage;
				} else if (message.stopReason === "aborted" && !isUserInterruptAbort(message)) {
					response = errorMessage;
				}
			}
		}

		if (message.stopReason === "error") {
			return { response, event: "stop_failure", error_type: "error" };
		}
		if (
			message.stopReason === "aborted" &&
			!isSilentAbort(message) &&
			!isUserInterruptAbort(message) &&
			typeof message.errorMessage === "string" &&
			message.errorMessage.length > 0
		) {
			return { response, event: "stop_failure", error_type: "aborted" };
		}
		return { response, event: "stop" };
	}
	return { response: "", event: "stop" };
}
