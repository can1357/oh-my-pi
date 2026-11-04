/**
 * CLI handler for `omp agent attach`. Resolves the exact live subagent, then
 * runs the attached view until the user detaches or the owner ends the
 * connection. Exit status is 0 for a detach and 1 for any failure or a lost
 * connection.
 */
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type AgentAttachClient, AgentAttachClientError, connectAgentAttach } from "../agent-attach/client";
import { runAgentAttachView } from "../modes/agent-attach-view";

export interface AgentAttachCommandArgs {
	agentId: string;
	/** Exact owner root session ID. Required when the ID is live under several owners. */
	ownerSessionId?: string;
}

export async function runAgentAttachCommand(args: AgentAttachCommandArgs): Promise<void> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new CliUsageError("agent attach needs an interactive terminal on stdin and stdout");
	}
	await initTheme();
	let client: AgentAttachClient;
	try {
		client = await connectAgentAttach(args);
	} catch (error) {
		if (!(error instanceof AgentAttachClientError)) throw error;
		process.stderr.write(`error: ${error.message}\n`);
		if (error.owners) {
			process.stderr.write(`owners: ${error.owners.join(", ")}\n`);
			process.stderr.write(`retry with: omp agent attach ${args.agentId} --owner <session-id>\n`);
		}
		process.exitCode = 1;
		return;
	}
	const outcome = await runAgentAttachView(client);
	if (outcome === "disconnected") {
		process.stderr.write(`error: connection to subagent ${args.agentId} ended\n`);
		process.exitCode = 1;
	}
}
