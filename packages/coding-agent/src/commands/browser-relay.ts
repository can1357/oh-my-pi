/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	BROWSER_RELAY_ACTIONS,
	type BrowserRelayAction,
	DEFAULT_RELAY_PORT,
	runBrowserRelayCommand,
} from "../cli/browser-relay-cli";

export default class BrowserRelay extends Command {
	static description = __ompTranslate(
		"Run the local CDP relay that lets the browser prelude drive your own Chrome tabs\u0004browser-relay.command.description",
	);

	static args = {
		action: Args.string({
			description: __ompTranslate("Action: {0} (default serve)", `${BROWSER_RELAY_ACTIONS.join(" | ")}`),
			options: [...BROWSER_RELAY_ACTIONS],
			required: false,
		}),
	};

	static flags = {
		port: Flags.integer({ char: "p", description: __ompTranslate("Port to listen on"), default: DEFAULT_RELAY_PORT }),
		token: Flags.string({ description: __ompTranslate("Require the extension to present this token") }),
		dir: Flags.string({
			description: __ompTranslate("Extension install directory (install; default ~/.omp/browser-relay/extension)"),
		}),
		"no-group": Flags.boolean({
			description: __ompTranslate("Don't gather controllable tabs into an 'omp' tab group"),
			default: false,
		}),
		verbose: Flags.boolean({
			char: "v",
			description: __ompTranslate("Log relay traffic summaries to stderr"),
			default: false,
		}),
	};

	static examples = [
		__ompTranslate("omp browser-relay install    # write the Chrome extension to disk + setup steps"),
		__ompTranslate("omp browser-relay            # serve the relay on the default port"),
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
