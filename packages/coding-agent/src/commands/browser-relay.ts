/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	BROWSER_RELAY_ACTIONS,
	type BrowserRelayAction,
	DEFAULT_RELAY_PORT,
	runBrowserRelayCommand,
} from "../cli/browser-relay-cli";

export default class BrowserRelay extends Command {
	static description = "Run the local CDP relay that lets the browser prelude drive your own Chrome tabs";

	static args = {
		action: Args.string({
			description: `Action: ${BROWSER_RELAY_ACTIONS.join(" | ")} (default serve)`,
			options: [...BROWSER_RELAY_ACTIONS],
			required: false,
		}),
	};

	static flags = {
		port: Flags.integer({ char: "p", description: "Port to listen on", default: DEFAULT_RELAY_PORT }),
		token: Flags.string({ description: "Require the extension to present this token" }),
		dir: Flags.string({
			description: "Extension install directory (install; default ~/.omp/browser-relay/extension)",
		}),
		"no-group": Flags.boolean({
			description: "Don't gather controllable tabs into an 'omp' tab group",
			default: false,
		}),
		verbose: Flags.boolean({ char: "v", description: "Log relay traffic summaries to stderr", default: false }),
	};

	static examples = [
		"omp browser-relay install    # write the Chrome extension to disk + setup steps",
		"omp browser-relay            # serve the relay on the default port",
		"omp browser-relay -p 9333 --token s3cret",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		await runBrowserRelayCommand({
			action: (args.action as BrowserRelayAction | undefined) ?? "serve",
			port: flags.port,
			token: flags.token,
			dir: flags.dir,
			group: !flags["no-group"],
			verbose: flags.verbose,
		});
	}
}
