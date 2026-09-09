/**
 * `omp auth-broker` — manage the omp credential vault.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_BROKER_ACTIONS,
	type AuthBrokerAction,
	type AuthBrokerCommandArgs,
	runAuthBrokerCommand,
} from "../cli/auth-broker-cli";
import { authBrokerHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

export default class AuthBroker extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_BROKER_ACTIONS],
		}),
		// Second positional: provider id (login/logout) or filesystem path (import).
		source: Args.string({
			description: "OAuth provider id (login/logout) or path (import)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the bearer token" }),
		via: Flags.string({
			description: "SSH user@host for remote login (login --via=user@host)",
		}),
		provider: Flags.string({
			description: "Override provider id for `import` (e.g. when JSON `type` is unrecognized)",
		}),
		"include-disabled": Flags.boolean({
			description: "Import credentials whose JSON has `disabled: true` (import)",
		}),
		"from-local": Flags.boolean({
			description: "migrate source: local SQLite + env vars (required for `migrate`)",
		}),
		"include-env": Flags.boolean({
			description: "Capture env-var API keys for providers not yet on broker (migrate)",
		}),
		"include-oauth": Flags.boolean({
			description: "Also upload OAuth from local SQLite during migrate (default skips them)",
		}),
		"dry-run": Flags.boolean({ description: "Print actions without executing (import / login --via / migrate)" }),
	};

	static examples = [
		"# Boot the broker against the local SQLite store\n  omp auth-broker serve",
		"# Boot on a non-default port\n  omp auth-broker serve --bind=127.0.0.1:9000",
		"# Print the bearer token\n  omp auth-broker token",
		"# Rotate the bearer token\n  omp auth-broker token --regenerate",
		"# List supported OAuth providers\n  omp auth-broker list",
		"# Local login (run on the broker host)\n  omp auth-broker login anthropic",
		"# Interactive provider selection\n  omp auth-broker login",
		"# Remote login over SSH tunnel\n  omp auth-broker login anthropic --via=user@broker",
		"# Log out of a provider (interactive without provider arg)\n  omp auth-broker logout anthropic",
		"# Import a CLIProxyAPI auth dump\n  omp auth-broker import ~/.cliproxy/auth",
		"# Import a single CLIProxyAPI JSON, overriding the provider mapping\n  omp auth-broker import ~/.cliproxy/auth/claude-foo.json --provider anthropic",
		"# Preview a migration from local store + env vars to the configured broker\n  omp auth-broker migrate --from-local --include-env --dry-run",
		"# Apply the migration\n  omp auth-broker migrate --from-local --include-env",
		"# Health-check the configured remote broker\n  omp auth-broker status",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthBroker);
		if (!args.action) {
			renderCommandHelp("omp", "auth-broker", AuthBroker);
			return;
		}
		const action = args.action as AuthBrokerAction;
		const cmd: AuthBrokerCommandArgs = {
			action,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				via: flags.via,
				// `login`/`logout` reuse the legacy `provider` slot; `import` keeps `source` separate
				// so `provider` flag (used as an override) is unambiguous.
				provider: action === "import" ? flags.provider : (args.source ?? flags.provider),
				source: args.source,
				includeDisabled: flags["include-disabled"],
				fromLocal: flags["from-local"],
				includeEnv: flags["include-env"],
				includeOauth: flags["include-oauth"],
				dryRun: flags["dry-run"],
			},
		};
		await initTheme();
		await runAuthBrokerCommand(cmd);
	}
}
