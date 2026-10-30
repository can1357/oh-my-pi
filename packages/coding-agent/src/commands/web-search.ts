/**
 * Test web search models.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { searchHelp as commandHelp } from "../cli/command-help";
import { runSearchCommand, type SearchCommandArgs } from "../cli/web-search-cli";

const RECENCY: NonNullable<SearchCommandArgs["recency"]>[] = ["day", "week", "month", "year"];

export default class Search extends Command {
	static description = commandHelp.description;
	static aliases = ["q", "web-search"];

	static args = {
		query: Args.string({ description: __ompTranslate("Search query text"), required: false, multiple: true }),
	};

	static flags = {
		model: Flags.string({ description: __ompTranslate("Catalog model selector") }),
		recency: Flags.string({ description: __ompTranslate("Recency filter"), options: RECENCY }),
		limit: Flags.integer({ char: "l", description: __ompTranslate("Max results to return") }),
		compact: Flags.boolean({ description: __ompTranslate("Render condensed output") }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Search);
		const query = Array.isArray(args.query) ? args.query.join(" ") : (args.query ?? "");

		const cmd: SearchCommandArgs = {
			query,
			model: flags.model,
			recency: flags.recency as SearchCommandArgs["recency"],
			limit: flags.limit,
			expanded: !flags.compact,
		};

		await runSearchCommand(cmd);
	}
}
