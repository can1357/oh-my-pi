import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { predictHelp as commandHelp } from "../cli/command-help";
import { runPredictCompare } from "../cli/predict-cli";

export default class Predict extends Command {
	static description = commandHelp.description;

	static examples = ["omp predict"];

	async run(): Promise<void> {
		await this.parse(Predict);
		if (!process.stdin.isTTY || !process.stdout.isTTY)
			throw new CliUsageError("omp predict needs an interactive terminal");
		await runPredictCompare();
	}
}
