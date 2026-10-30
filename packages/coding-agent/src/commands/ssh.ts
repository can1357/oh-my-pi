/**
 * Manage SSH host configurations.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sshHelp as commandHelp } from "../cli/command-help";
import { runSSHCommand, type SSHAction, type SSHCommandArgs } from "../cli/ssh-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ACTIONS: SSHAction[] = ["add", "remove", "list"];

export default class SSH extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: __ompTranslate("SSH action"),
			required: false,
			options: ACTIONS,
		}),
		targets: Args.string({
			description: __ompTranslate("Host name or arguments"),
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: __ompTranslate("Output JSON\u0004cli.output.json") }),
		host: Flags.string({ description: __ompTranslate("Host address") }),
		user: Flags.string({ description: __ompTranslate("Username") }),
		port: Flags.string({ description: __ompTranslate("Port number") }),
		key: Flags.string({ description: __ompTranslate("Identity key path") }),
		desc: Flags.string({ description: __ompTranslate("Host description") }),
		compat: Flags.boolean({ description: __ompTranslate("Enable compatibility mode") }),
		scope: Flags.string({ description: __ompTranslate("Config scope (project|user)"), options: ["project", "user"] }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(SSH);
		const action = (args.action ?? "list") as SSHAction;
		const targets = Array.isArray(args.targets) ? args.targets : args.targets ? [args.targets] : [];

		const cmd: SSHCommandArgs = {
			action,
			args: targets,
			flags: {
				json: flags.json,
				host: flags.host,
				user: flags.user,
				port: flags.port,
				key: flags.key,
				desc: flags.desc,
				compat: flags.compat,
				scope: flags.scope as "project" | "user" | undefined,
			},
		};

		await initTheme();
		await runSSHCommand(cmd);
	}
}
