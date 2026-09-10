/**
 * `omp auth-gateway` — run a forward proxy that injects auth from the broker.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { authGatewayHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

export default class AuthGateway extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status/check)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token (token)" }),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed.",
		}),
		strict: Flags.boolean({
			description:
				"For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential.",
		}),
	};

	static examples = [
		"# Boot the gateway against the configured broker\n  omp auth-gateway serve",
		"# Boot on a non-default port\n  omp auth-gateway serve --bind=127.0.0.1:4000",
		"# Print the gateway bearer token (creates one on first run)\n  omp auth-gateway token",
		"# Rotate the gateway bearer token\n  omp auth-gateway token --regenerate",
		"# Run on loopback without any bearer (anyone on this host can call)\n  omp auth-gateway serve --no-auth",
		"# Show local gateway + broker config status\n  omp auth-gateway status",
		"# Probe each broker credential to see which one is producing 401s\n  omp auth-gateway check",
		"# Same, machine-readable for scripts\n  omp auth-gateway check --json",
		"# Strict check — also exercises each credential with a real chat-completion ping\n  omp auth-gateway check --strict",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthGateway);
		if (!args.action) {
			renderCommandHelp("omp", "auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				noAuth: flags["no-auth"],
				strict: flags.strict,
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
