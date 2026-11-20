/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { BROWSER_RELAY_ACTIONS, DEFAULT_RELAY_PORT, runBrowserRelayCommand } from "../cli/browser-relay-cli";
import { browserRelayHelp } from "../cli/command-help";

/** Install, sync, or serve omp in Chrome. */
export default class BrowserRelay extends Command {
	static description = browserRelayHelp.description;

	static args = {
		action: Args.string({
			description: `Action: ${BROWSER_RELAY_ACTIONS.join(" | ")} (default serve; native-host is launched by Chrome)`,
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
		"no-chrome": Flags.boolean({
			description: "Skip the unattended install into Chrome and print the manual steps",
			default: false,
		}),
		profile: Flags.string({
			description: "Chrome profile directory for the unattended install (install; default: last used)",
		}),
		verbose: Flags.boolean({ char: "v", description: "Log relay traffic summaries to stderr", default: false }),
	};

	static examples = [
		"omp browser-relay install    # install the omp extension, register it in Chrome and add its native host",
		"omp browser-relay sync       # sync every registered extension directory",
		"omp browser-relay            # serve the relay on the default port",
		"omp browser-relay -p 9333 --token s3cret",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		await runBrowserRelayCommand({
			action: BROWSER_RELAY_ACTIONS.find(action => action === args.action) ?? "serve",
			port: flags.port,
			token: flags.token,
			dir: flags.dir,
			group: !flags["no-group"],
			chrome: !flags["no-chrome"],
			profile: flags.profile,
			verbose: flags.verbose,
		});
	}
}
