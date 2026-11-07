/**
 * Discover local Collab sessions, retrieve remote links and send agent messages.
 */
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCollabLinkCommand, runCollabListCommand, runCollabSendCommand } from "../cli/collab-cli";
import { collabHelp as commandHelp } from "../cli/command-help";
import { COLLAB_REGISTRY_VERSION, CollabLinkError, CollabSendError } from "../collab/registry";

const SEND_USAGE =
	"collab send <receiver-instance> <text> --from <sender-instance> --from-generation N --generation N --request-id <id> [--json]";

function parseGeneration(value: string | undefined, flag: string): number {
	const generation = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : NaN;
	if (!Number.isSafeInteger(generation) || generation <= 0) {
		throw new CliUsageError(`--${flag} requires a positive safe integer (usage: ${SEND_USAGE})`);
	}
	return generation;
}

export default class Collab extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), link, or send",
			required: false,
			options: ["list", "link", "send"],
		}),
		selector: Args.string({ description: "Instance ID (link or send), or PID (link only)", required: false }),
		text: Args.string({ description: "Agent message text (send only)", required: false }),
	};

	static flags = {
		view: Flags.boolean({
			description: "Request a view-only link instead of control access (link only)",
			default: false,
		}),
		from: Flags.string({ description: "Exact sending session instance ID (required for send)" }),
		"from-generation": Flags.string({ description: "Sending session generation (required for send)" }),
		generation: Flags.string({ description: "Receiving session generation (required for send)" }),
		"request-id": Flags.string({
			description: "Idempotency ID, 8–128 ASCII letters, digits, . _ : or - (required for send)",
		}),
		json: Flags.boolean({ char: "j", description: "Emit deterministic machine-readable JSON", default: false }),
	};

	static examples = [
		"omp collab list",
		"omp collab list --json",
		"omp collab link <instanceId|pid>",
		"omp collab link <pid> --view",
		"omp collab send <receiver-instance> 'Please review the change' --from <sender-instance> --from-generation 1 --generation 1 --request-id review-001",
	];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Collab);
		const action = args.action ?? "list";
		const hasSendFlags =
			flags.from !== undefined ||
			flags["from-generation"] !== undefined ||
			flags.generation !== undefined ||
			flags["request-id"] !== undefined;
		if (action !== "send" && hasSendFlags) {
			throw new CliUsageError("--from, --from-generation, --generation and --request-id apply only to collab send");
		}
		if (action === "send") {
			if (
				argv.length !== 3 ||
				!args.selector ||
				args.text === undefined ||
				!flags.from ||
				!flags["request-id"] ||
				flags.view
			) {
				throw new CliUsageError(
					`collab send requires exact sender/receiver identities and message text (usage: ${SEND_USAGE})`,
				);
			}
			const sender = {
				instanceId: flags.from,
				generation: parseGeneration(flags["from-generation"], "from-generation"),
			};
			const recipient = {
				instanceId: args.selector,
				generation: parseGeneration(flags.generation, "generation"),
			};
			try {
				await runCollabSendCommand({
					sender,
					request: { requestId: flags["request-id"], recipient, text: args.text },
					json: flags.json,
				});
			} catch (error) {
				if (!(error instanceof CollabSendError)) throw error;
				process.stderr.write(
					flags.json
						? `${JSON.stringify({ version: COLLAB_REGISTRY_VERSION, error: { code: error.code, message: error.message } })}\n`
						: `error: ${error.message}\n`,
				);
				process.exitCode = 1;
			}
			return;
		}
		if (action === "list") {
			if (argv.length > 1 || flags.view) {
				throw new CliUsageError("collab list accepts no selector or --view (usage: collab list [--json])");
			}
			await runCollabListCommand({ json: flags.json });
			return;
		}

		if (argv.length !== 2 || !args.selector) {
			throw new CliUsageError(
				"collab link requires exactly one selector (usage: collab link <instanceId|pid> [--view] [--json])",
			);
		}
		try {
			await runCollabLinkCommand({ selector: args.selector, view: flags.view, json: flags.json });
		} catch (error) {
			if (!(error instanceof CollabLinkError)) throw error;
			process.stderr.write(`error: ${error.message}\n`);
			process.exitCode = 1;
		}
	}
}
