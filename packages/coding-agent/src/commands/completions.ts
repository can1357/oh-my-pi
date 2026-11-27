/**
 * `omp completions <bash|zsh|fish>` — print a shell completion script.
 *
 * The script is derived entirely from the declarative command/flag metadata
 * (see `cli/completion-gen.ts`), so it never drifts from the actual CLI surface.
 */

import * as fs from "node:fs";
import { APP_NAME, postmortem, VERSION } from "@oh-my-pi/pi-utils";
import { Args, type CliConfig, Command, type CommandCtor } from "@oh-my-pi/pi-utils/cli";
import { completionsHelp as commandHelp } from "../cli/command-help";
import { buildSpec, generateCompletion, type Shell } from "../cli/completion-gen";
import { commands } from "../cli-commands";

/** Entry name of the default command whose flags become top-level completions. */
const ROOT_COMMAND = "launch";
const SHELLS = ["bash", "zsh", "fish"] as const;

/** Generate a completion script from the live command registry. */
export async function generateLiveCompletion(shell: Shell): Promise<string> {
	const loaded = await Promise.all(commands.map(async entry => ({ entry, Cmd: await entry.load() })));
	const map = new Map<string, CommandCtor>();
	const aliasMap = new Map<string, readonly string[]>();
	for (const { entry, Cmd } of loaded) {
		map.set(entry.name, Cmd);
		const merged = new Set<string>([...(Cmd.aliases ?? []), ...(entry.aliases ?? [])]);
		aliasMap.set(entry.name, [...merged]);
	}

	const config: CliConfig = { bin: APP_NAME, version: VERSION, commands: map };
	return generateCompletion(shell, buildSpec(config, ROOT_COMMAND, aliasMap));
}

export default class Completions extends Command {
	static description = commandHelp.description;
	static args = {
		shell: Args.string({
			description: "Target shell",
			required: true,
			options: SHELLS,
		}),
	};

	static examples = [
		`# zsh — eval at startup, or write to a file in $fpath\n  eval "$(${APP_NAME} completions zsh)"`,
		`# bash\n  eval "$(${APP_NAME} completions bash)"`,
		`# fish\n  ${APP_NAME} completions fish > ~/.config/fish/completions/${APP_NAME}.fish`,
	];

	async run(): Promise<void> {
		const shell = this.argv[0];
		if (!isShell(shell)) {
			process.stderr.write(`Usage: ${APP_NAME} completions <${SHELLS.join("|")}>\n`);
			process.exitCode = 1;
			return;
		}

		writeStdoutFully(await generateLiveCompletion(shell));
		await postmortem.quit(0);
	}
}

/**
 * Write all of `text` to fd 1, tracking the written offset across partial
 * writes and `EAGAIN`. `Bun.write(Bun.stdout, …)` can replay the first chunk
 * when fd 1 is a non-blocking pipe, corrupting `eval "$(omp completions zsh)"`.
 */
function writeStdoutFully(text: string): void {
	const buf = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < buf.length) {
		try {
			offset += fs.writeSync(1, buf, offset, buf.length - offset);
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "EAGAIN")) throw err;
			Bun.sleepSync(1);
		}
	}
}

function isShell(value: string | undefined): value is Shell {
	return value === "bash" || value === "zsh" || value === "fish";
}
