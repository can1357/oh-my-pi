import { postmortem } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { compressHelp as commandHelp } from "../cli/command-help";
import { CliUsageError } from "../cli/usage-error";
import { runCompressCommand } from "../compress";

export default class Compress extends Command {
	static description = commandHelp.description;
	static args = {
		files: Args.string({ description: "Files or glob patterns to compress", required: true, multiple: true }),
	};
	static flags = {
		out: Flags.string({ char: "o", description: "Write the approved text here instead of stdout (single file)" }),
		inPlace: Flags.boolean({ char: "i", description: "Overwrite each source file with its approved text" }),
		rounds: Flags.integer({ char: "r", description: "Maximum drafts per file before giving up", default: 3 }),
		agents: Flags.integer({ char: "n", description: "Files compressed concurrently", default: 4 }),
		model: Flags.string({ char: "m", description: "Model selector" }),
	};

	static examples = [
		"omp compress prompts/tools/read.md",
		"omp compress notes.md -o notes.compressed.md",
		"omp compress 'src/prompts/**/*.md' -i",
		"omp compress a.md b.md c.md -i -n 8",
		"omp compress spec.md -r 5 -m opus",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Compress);
		const files = args.files ?? [];
		if (files.length === 0) throw new CliUsageError("compress requires at least one file or glob pattern");
		if (flags.rounds <= 0) throw new CliUsageError("--rounds must be a positive integer");
		if (flags.agents <= 0) throw new CliUsageError("--agents must be a positive integer");
		if (flags.inPlace && flags.out) throw new CliUsageError("--in-place and --out are mutually exclusive");
		const result = await runCompressCommand({
			files,
			model: flags.model,
			maxRounds: flags.rounds,
			concurrency: flags.agents,
			output: flags.out,
			inPlace: flags.inPlace,
		});
		await postmortem.quit(result.exitCode);
	}
}
