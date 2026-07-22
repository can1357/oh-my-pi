/**
 * `omp okf` — inspect and validate the project's Open Knowledge Format (OKF)
 * v0.1 knowledge bundle (`.wiki/` and `~/.ompk/okf/`).
 */
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@pk-nerdsaver-ai/pi-utils/cli";
import { OKF_ACTIONS, type OkfAction, type OkfCommandArgs, runOkfCommand } from "../cli/okf-cli";

export default class Okf extends Command {
	static description = "Inspect and validate the OKF (Open Knowledge Format) knowledge bundle";

	static args = {
		action: Args.string({
			description: "OKF action",
			required: false,
			options: OKF_ACTIONS,
		}),
		id: Args.string({
			description: "Concept id (for `show`)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		cwd: Flags.string({ description: "Directory to resolve the project bundle from (default: cwd)" }),
	};

	static examples = [
		`# List every discovered concept\n  ${APP_NAME} okf list`,
		`# Show one concept\n  ${APP_NAME} okf show concepts/agent-loop-patterns`,
		`# Validate OKF v0.1 conformance (exits 1 on error)\n  ${APP_NAME} okf lint`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Okf);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "okf", Okf);
			return;
		}

		const cmd: OkfCommandArgs = {
			action: args.action as OkfAction,
			id: args.id,
			flags: {
				json: flags.json,
				cwd: flags.cwd,
			},
		};

		await runOkfCommand(cmd);
	}
}
