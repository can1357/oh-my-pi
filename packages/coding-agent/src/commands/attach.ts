import * as path from "node:path";
import { getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { attachHelp as commandHelp } from "../cli/command-help";
import { listLiveAttachSessions, sendLiveReviewComment } from "../session/live-attach";

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
		file: Flags.string({ description: "Reviewed file path (send)" }),
		"start-line": Flags.integer({ description: "First selected line, 1-indexed (send)" }),
		"start-column": Flags.integer({ description: "First selected column, 1-indexed (send)" }),
		"end-line": Flags.integer({ description: "Last selected line, 1-indexed (send)" }),
		"end-column": Flags.integer({ description: "Last selected column, 1-indexed (send)" }),
		comment: Flags.string({ description: "Review comment; defaults to stdin (send)" }),
	};
	static examples = [
		"omp attach list --json",
		'printf "Handle the nil case" | omp attach send <endpoint-id> --session <session-id> --file src/main.ts --start-line 20 --start-column 1 --end-line 24 --json',
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
				process.stdout.write(`${session.sessionId}\t${session.busy ? "working" : "idle"}\t${title}\n`);
			}
			return;
		}
		if (action !== "send") {
			renderCommandHelp("omp", "attach", Attach);
			return;
		}

		if (!args.endpoint) throw new Error("attach send requires an endpoint ID");
		if (!flags.session) throw new Error("attach send requires --session");
		if (!flags.file) throw new Error("attach send requires --file");
		if (flags["start-line"] === undefined) throw new Error("attach send requires --start-line");
		if (flags["start-column"] === undefined) throw new Error("attach send requires --start-column");
		if (flags["end-line"] === undefined) throw new Error("attach send requires --end-line");
		if (flags.comment === undefined && process.stdin.isTTY === true) {
			throw new Error("attach send requires --comment or piped stdin");
		}
		const comment = (flags.comment ?? (await Bun.stdin.text())).trim();
		if (comment.length === 0) throw new Error("Review comment is empty");
		const result = await sendLiveReviewComment({
			endpointId: args.endpoint,
			sessionId: flags.session,
			cwd,
			file: path.resolve(cwd, flags.file),
			startLine: flags["start-line"],
			startColumn: flags["start-column"],
			endLine: flags["end-line"],
			endColumn: flags["end-column"],
			comment,
		});
		if (result.status === "error") throw new Error(result.error ?? "Attached OMP review failed");
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result)}\n`);
			return;
		}
		process.stdout.write(`Review complete; ${result.changed ? "file changed" : "file unchanged"}.\n`);
	}
}
