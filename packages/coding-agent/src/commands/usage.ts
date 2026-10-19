/**
 * Show provider usage limits for every authenticated account.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { usageHelp as commandHelp } from "../cli/command-help";
import { runUsageCommand } from "../cli/usage-cli";

export default class Usage extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Optional subcommand to execute",
			required: false,
			options: ["invalidate", "clients", "accounts", "reset"],
		}),
		target: Args.string({
			description: "Saved reset to spend with `reset`: <provider>/<credential id> as `omp usage reset` lists it",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Output usage reports as JSON", default: false }),
		provider: Flags.string({ char: "p", description: "Only show usage for this provider id (e.g. anthropic)" }),
		redact: Flags.boolean({
			char: "r",
			description: "Redact account emails/ids (shortest unique prefix) for sharing screenshots",
			default: false,
		}),
		history: Flags.boolean({
			description: "Show recorded usage-limit history (hourly snapshots) instead of a live snapshot",
			default: false,
		}),
		days: Flags.integer({ char: "d", description: "History window in days (with --history or clients)", default: 7 }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before fetching usage (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
	};

	static examples = [
		"# Detailed per-account usage breakdown across all providers\n  omp usage",
		"# Only Anthropic accounts\n  omp usage --provider anthropic",
		"# Redact account identifiers for screenshots\n  omp usage --redact",
		"# Machine-readable output\n  omp usage --json",
		"# Usage-limit trend over the last 30 days\n  omp usage --history --days 30",
		"# Per-client token burn (which machine/app spent what) over the last 30 days\n  omp usage clients --days 30",
		"# OAuth identity keys for task.agentAccountPools (no tokens)\n  omp usage accounts",
		"# Saved Codex and Claude rate-limit resets per account, with each account's credential id\n  omp usage reset",
		"# Spend one saved reset on a listed account\n  omp usage reset codex/3",
		"# Invalidate cached usage reports for all providers\n  omp usage invalidate",
		"# Invalidate cached usage reports for a specific provider\n  omp usage invalidate --provider anthropic",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Usage);
		await runUsageCommand({
			action: args.action,
			json: flags.json,
			provider: flags.provider,
			target: args.target,
			redact: flags.redact,
			history: flags.history,
			days: flags.days,
			extensions: flags.extension,
			noExtensions: flags["no-extensions"],
		});
	}
}
