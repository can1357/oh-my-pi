import * as path from "node:path";
import { getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { attachHelp as commandHelp } from "../cli/command-help";
import { listLiveAttachSessions, sendLiveSessionMessage } from "../session/live-attach";

const ACTIONS = ["list", "send"] as const;

export default class Attach extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "list or send", required: false, options: [...ACTIONS] }),
		endpoint: Args.string({ description: "Live endpoint ID (send)", required: false }),
	};
	static flags = {
		cwd: Flags.string({ description: "Project directory (defaults to cwd)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
		session: Flags.string({ description: "Expected OMP session ID (send)" }),
		message: Flags.string({ description: "Message; defaults to stdin (send)" }),
	};
	static examples = [
		"omp attach list --json",
		'printf "Review src/main.ts lines 20-24 for nil handling" | omp attach send <endpoint-id> --session <session-id>',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Attach);
		const action = args.action ?? "list";
		const cwd = path.resolve(flags.cwd ?? getProjectDir());
		if (action === "list") {
			const sessions = await listLiveAttachSessions(cwd);
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(sessions)}\n`);
				return;
			}
			if (sessions.length === 0) {
				process.stdout.write("No live OMP sessions in this directory.\n");
				return;
			}
			for (const session of sessions) {
				const title = sanitizeText((session.title ?? "Untitled session").replace(/[\r\n\t]+/g, " "));
				process.stdout.write(`${session.endpointId}\t${session.sessionId}\t${title}\n`);
			}
			return;
		}
		if (action !== "send") {
			renderCommandHelp("omp", "attach", Attach);
			return;
		}

		if (!args.endpoint) throw new Error("attach send requires an endpoint ID");
		if (!flags.session) throw new Error("attach send requires --session");
		if (flags.message === undefined && process.stdin.isTTY === true) {
			throw new Error("attach send requires --message or piped stdin");
		}
		const message = flags.message ?? (await Bun.stdin.text());
		if (message.trim().length === 0) throw new Error("Attach message is empty");
		const result = await sendLiveSessionMessage({
			endpointId: args.endpoint,
			sessionId: flags.session,
			cwd,
			message,
		});
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result)}\n`);
			return;
		}
		process.stdout.write("Message delivered.\n");
	}
}
