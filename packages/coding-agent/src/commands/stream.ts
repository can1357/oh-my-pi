import * as path from "node:path";
import { DEFAULT_STREAM_URL, STREAM_TITLE_MAX } from "@oh-my-pi/pi-wire";
import { CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { streamHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { StreamCredential } from "../stream/auth";
import { resolveStreamUrls, runStreamConsole, type StreamUrls } from "../stream/streamer";

export default class Stream extends Command {
	static description = commandHelp.description;

	static flags = {
		title: Flags.string({ description: "Stream title (defaults to the current directory name)" }),
		server: Flags.string({ description: "Stream server base URL (overrides stream.serverUrl)" }),
		"no-tui": Flags.boolean({ description: "Use the line-oriented console instead of the interactive TUI" }),
	};

	static examples = [
		"omp stream",
		'omp stream --title "Building a parser"',
		"omp stream --server https://live.example.com",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Stream);
		const cwd = process.cwd();
		const title = flags.title ?? path.basename(cwd);
		if (title.length > STREAM_TITLE_MAX) {
			throw new CliUsageError(`title must be at most ${STREAM_TITLE_MAX} characters`);
		}
		const settings = await Settings.loadReadOnly({ cwd });
		let urls: StreamUrls;
		try {
			urls = resolveStreamUrls(flags.server ?? settings.get("stream.serverUrl") ?? DEFAULT_STREAM_URL);
		} catch (error) {
			throw new CliUsageError(error instanceof Error ? error.message : String(error));
		}
		const credential = new StreamCredential();
		try {
			if (!(await credential.resolve())) {
				process.stderr.write(`stream: ${StreamCredential.missingMessage}\n`);
				process.exitCode = 1;
				return;
			}
			const exitCode = await runStreamConsole({
				projectDir: cwd,
				title,
				hostUrl: urls.hostUrl,
				token: () => credential.resolve(),
				noTui: flags["no-tui"],
			});
			if (exitCode !== 0) process.exitCode = exitCode;
		} catch (error) {
			process.stderr.write(`stream: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		} finally {
			credential.close();
		}
	}
}
