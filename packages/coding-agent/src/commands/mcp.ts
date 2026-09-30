import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { mcpHelp as commandHelp } from "../cli/command-help";
import { runMCPReauthCommand } from "../mcp/reauth";

export default class Mcp extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "MCP action",
			options: ["reauth"],
			required: true,
		}),
		server: Args.string({
			description: "Configured MCP server name",
			required: false,
		}),
	};

	static examples = [`# Reauthorize an MCP server\n  ${APP_NAME} mcp reauth atlassian`];

	async run(): Promise<void> {
		const { args } = await this.parse(Mcp);
		if (args.action !== "reauth") {
			throw new Error(`Unknown MCP action "${args.action}". Supported action: reauth`);
		}
		if (!args.server) throw new Error("MCP server name is required for reauth");
		await runMCPReauthCommand(args.server);
	}
}
