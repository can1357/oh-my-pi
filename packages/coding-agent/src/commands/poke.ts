/**
 * Post a message into a session's mailbox: a live omp holding the
 * session starts a turn on it; otherwise it waits until the session is opened
 * (or, with `--resume`, a headless run delivers it now).
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { pokeHelp as commandHelp } from "../cli/command-help";
import { runPokeCommand } from "../cli/poke-cli";

export default class Poke extends Command {
	static description = commandHelp.description;

	static args = {
		session: Args.string({ description: "Session id, id prefix, or session file", required: true }),
		message: Args.string({ description: "Message text (remaining arguments are joined)", required: true }),
	};

	static flags = {
		from: Flags.string({ description: "Sender label shown to the agent (default: user@host)" }),
		force: Flags.boolean({ description: "Deliver now even if the user interrupted the session with Esc" }),
		resume: Flags.boolean({ description: "If no omp has the session open, resume it headless for one turn" }),
	};

	static examples = [
		'omp poke 01a14cac "the nightly build finished; check dist/report.txt"',
		'omp poke --resume 01a14cac "deploy done; verify prod and report"',
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(Poke);
		await runPokeCommand({
			session: args.session ?? "",
			text: argv.slice(1).join(" "),
			from: flags.from,
			force: flags.force ?? false,
			resume: flags.resume ?? false,
		});
	}
}
