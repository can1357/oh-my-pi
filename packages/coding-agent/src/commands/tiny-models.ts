import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { tinyModelsHelp as commandHelp } from "../cli/command-help";
import { runTinyModelsCommand, type TinyModelsAction, type TinyModelsCommandArgs } from "../cli/tiny-models-cli";

const ACTIONS: TinyModelsAction[] = ["download", "list"];

export default class TinyModels extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: __ompTranslate("Action to perform"),
			required: false,
			options: ACTIONS,
		}),
		model: Args.string({
			description: __ompTranslate("Model key (`smollm` = word completion), or all"),
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: __ompTranslate("Output JSON\u0004cli.output.json") }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(TinyModels);
		const command: TinyModelsCommandArgs = {
			action: (args.action ?? "download") as TinyModelsAction,
			model: args.model,
			flags: {
				json: flags.json,
			},
		};
		await runTinyModelsCommand(command);
	}
}
