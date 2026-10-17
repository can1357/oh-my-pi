/**
 * Manage plugins (install, uninstall, list, etc.).
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { pluginHelp as commandHelp } from "../cli/command-help";
import { type PluginAction, type PluginCommandArgs, runPluginCommand } from "../cli/plugin-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

export default class Plugin extends Command {
	static description = commandHelp.description;
	static aliases = ["plugins"];
	static args = {
		action: Args.string({
			description: "Plugin action",
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: "Packages, paths, or plugin names",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		fix: Flags.boolean({ description: "Attempt to fix issues (doctor)" }),
		analyze: Flags.boolean({
			description:
				"Analyze two extensions (installed names, or paths to an extension file or directory) with an AI model (doctor): sends their files to the model, never runs them; read-only",
		}),
		model: Flags.string({ description: "Model for --analyze (default: the smol role)" }),
		yes: Flags.boolean({ description: "Consent to sending files to the model for --analyze; never applies changes" }),
		apply: Flags.boolean({
			description: "After --analyze, offer to hide the non-preferred copy in omp (asks for separate confirmation)",
		}),
		force: Flags.boolean({ description: "Force install" }),
		"dry-run": Flags.boolean({ description: "Show actions without applying changes" }),
		local: Flags.boolean({ char: "l", description: "Operate on local plugin directory" }),
		enable: Flags.string({ description: "Enable a feature" }),
		disable: Flags.string({ description: "Disable a feature" }),
		set: Flags.string({ description: "Set plugin config (key=value)" }),
		scope: Flags.string({
			description: 'Install scope: "user" (default) or "project"',
			options: ["user", "project"],
		}),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Plugin);
		const action = (args.action ?? "list") as PluginAction;

		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];
		const cmd: PluginCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				fix: flags.fix,
				force: flags.force,
				analyze: flags.analyze,
				model: flags.model,
				yes: flags.yes,
				apply: flags.apply,
				dryRun: flags["dry-run"],
				local: flags.local,
				enable: flags.enable,
				disable: flags.disable,
				set: flags.set,
				scope: flags.scope as "user" | "project" | undefined,
			},
		};

		await initTheme();
		await runPluginCommand(cmd);
	}
}
