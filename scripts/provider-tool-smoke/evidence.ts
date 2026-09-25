import type { AgentSessionEvent } from "../../packages/coding-agent/src/session/agent-session";

/** Require real tool completion and continuation; exit zero or echoed prompt text is insufficient. */
export function inspectWorkflow(
	events: AgentSessionEvent[],
	input: string,
	output: string | undefined,
	challenge: string,
	exitCode: number,
) {
	const completed = events.filter(event => event.type === "tool_execution_end");
	const successful = completed.filter(event => !event.isError);
	const names = successful.map(event => event.toolName);
	const readIndex = names.indexOf("read");
	const writeIndex = names.indexOf("write");
	const bashIndex = names.indexOf("bash");
	const ordered = readIndex >= 0 && writeIndex > readIndex && bashIndex > writeIndex;
	const assistants = events
		.filter(event => event.type === "message_end")
		.map(event => event.message)
		.filter(message => message.role === "assistant");
	const final = assistants.at(-1);
	const finalText =
		final?.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("") ?? "";
	const bashObserved = successful.some(
		event =>
			event.toolName === "bash" &&
			event.result.content.some(block => block.type === "text" && block.text.includes(challenge)),
	);
	const failures = assistants.filter(message => message.stopReason === "error" || message.stopReason === "aborted");
	const outputMatches = output === input;
	const challengeMatches = bashObserved && finalText.trim().endsWith(challenge);
	return {
		pass:
			exitCode === 0 &&
			ordered &&
			outputMatches &&
			challengeMatches &&
			final?.stopReason === "stop" &&
			failures.length === 0,
		exitCode,
		ordered,
		outputMatches,
		challengeMatches,
		tools: completed.map(event => ({ name: event.toolName, isError: event.isError })),
		models: [...new Set(assistants.map(message => message.model))],
		stopReasons: assistants.map(message => message.stopReason),
		errors: failures.map(message => message.errorMessage),
	};
}
