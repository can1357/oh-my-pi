/**
 * Attach to a live native task subagent owned by another omp process.
 */
import { Args, CliUsageError, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { runAgentAttachCommand } from "../cli/agent-cli";
import { agentHelp as commandHelp } from "../cli/command-help";

const ACTIONS = ["attach"];

export default class Agent extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "Agent action",
			required: false,
			options: ACTIONS,
		}),
		agentId: Args.string({ description: "Exact live subagent ID", required: false }),
	};

	static flags = {
		owner: Flags.string({
			description: "Exact owner root session ID; required when the agent ID is live under several owners",
		}),
	};

	static examples = ["omp agent attach <agent-id>", "omp agent attach <agent-id> --owner <session-id>"];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Agent);
		if (!args.action) {
			renderCommandHelp("omp", "agent", Agent);
			return;
		}
		if (argv.length !== 2 || !args.agentId) {
			throw new CliUsageError(
				"agent attach requires exactly one agent ID (usage: agent attach <agent-id> [--owner <session-id>])",
			);
		}
		if (flags.owner === "") throw new CliUsageError("--owner requires a session ID");
		await runAgentAttachCommand({ agentId: args.agentId, ownerSessionId: flags.owner });
	}
}
