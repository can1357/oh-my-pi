/**
 * Test web search providers.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { searchHelp as commandHelp } from "../cli/command-help";
import { runSearchCommand, type SearchCommandArgs } from "../cli/web-search-cli";
import { SEARCH_PROVIDER_ORDER } from "../web/search/provider";

const PROVIDERS: Array<string> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY: NonNullable<SearchCommandArgs["recency"]>[] = ["day", "week", "month", "year"];

export default class Search extends Command {
	static description = commandHelp.description;
	static aliases = ["q"];

	static args = {
		query: Args.string({ description: "Search query text", required: false, multiple: true }),
	};

	static flags = {
		provider: Flags.string({ description: "Search provider", options: PROVIDERS }),
		recency: Flags.string({ description: "Recency filter", options: RECENCY }),
		limit: Flags.integer({ char: "l", description: "Max results to return" }),
		compact: Flags.boolean({ description: "Render condensed output" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Search);
		const query = Array.isArray(args.query) ? args.query.join(" ") : (args.query ?? "");

		const cmd: SearchCommandArgs = {
			query,
			provider: flags.provider as SearchCommandArgs["provider"],
			recency: flags.recency as SearchCommandArgs["recency"],
			limit: flags.limit,
			expanded: !flags.compact,
		};

		await runSearchCommand(cmd);
	}
}
