/**
 * Route oh-my-pi model roles through the local 9router gateway.
 */
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import { Args, Command, Flags } from "@pk-nerdsaver-ai/pi-utils/cli";
import { buildNineRouterHelp, runNineRouterCommand } from "../cli/9router-cli";

export default class NineRouter extends Command {
	static description = "Route model roles through the local 9router gateway";
	static usage = "omp 9router route";
	static args = {
		action: Args.string({
			description: "route",
			required: true,
		}),
	};

	static flags = {
		"api-key": Flags.string({
			description: "9router API key (falls back to 9ROUTER_API_KEY / NINEROUTER_API_KEY env vars)",
		}),
		mode: Flags.string({
			description: "Availability check: list or probe",
			options: ["list", "probe"],
		}),
		"probe-timeout": Flags.integer({
			description: "Timeout for each probe completion in ms",
		}),
		"probe-tokens": Flags.integer({
			description: "Max tokens for each probe completion",
		}),
		roles: Flags.string({
			description: "Comma-separated roles to route (default: all)",
			multiple: true,
		}),
		"slots-file": Flags.string({
			description: "JSON/JSON5 file with a custom { slots: [...] } map",
		}),
		json: Flags.boolean({ description: "Output JSON" }),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
	};

	static examples = [
		`# Route all roles using the 9router model list\n  ${APP_NAME} 9router route`,
		`# Route with a small chat probe on each candidate\n  ${APP_NAME} 9router route --mode probe`,
		`# Route only specific roles\n  ${APP_NAME} 9router route --roles default,smol,fast-context`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(NineRouter);
		if (args.action !== "route") {
			process.stdout.write(buildNineRouterHelp());
			return;
		}
		await runNineRouterCommand({
			action: "route",
			flags: {
				"api-key": flags["api-key"],
				json: flags.json,
				mode: flags.mode as "list" | "probe" | undefined,
				"probe-timeout": flags["probe-timeout"],
				"probe-tokens": flags["probe-tokens"],
				roles: flags.roles,
				"slots-file": flags["slots-file"],
				config: flags.config,
			},
		});
	}
}
