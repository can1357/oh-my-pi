/**
 * Manage configuration settings.
 */

import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { configHelp as commandHelp } from "../cli/command-help";
import { type ConfigAction, type ConfigCommandArgs, runConfigCommand } from "../cli/config-cli";
import { initTheme } from "../modes/theme/theme";

const ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg"];

export default class Config extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Config action",
			required: false,
			options: ACTIONS,
		}),
		key: Args.string({
			description: "Setting key",
			required: false,
		}),
		value: Args.string({
			description: "Value (for set/reset)",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		"if-absent": Flags.boolean({ description: "Set only if the raw global setting is absent (set only)" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Config);
		const action = (args.action ?? "list") as ConfigAction;
		if (flags["if-absent"] && action !== "set") {
			throw new CliUsageError("--if-absent is only valid for `omp config set`");
		}
		const value = Array.isArray(args.value) ? args.value.join(" ") : args.value;

		const cmd: ConfigCommandArgs = {
			action,
			key: args.key,
			value,
			flags: {
				json: flags.json,
				ifAbsent: flags["if-absent"],
			},
		};

		await initTheme();
		await runConfigCommand(cmd);
	}
}
