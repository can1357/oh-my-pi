import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as path from "node:path";
import { CLIP_DESCRIPTION_MAX, STREAM_TITLE_MAX } from "@oh-my-pi/pi-wire";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { clipHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { StencilCredential } from "../stencil/credential";
import { uploadClip } from "../stream/clip-upload";
import { latestRecording, recordingsDir } from "../stream/recording";

import { cfgStreamServerUrl } from "../stream/settings";

export default class Clip extends Command {
	static description = commandHelp.description;

	static args = {
		file: Args.string({ description: __ompTranslate("Recording to upload (default: the newest /record capture)") }),
	};

	static flags = {
		title: Flags.string({ char: "t", description: __ompTranslate("Clip title (defaults to the recording's title)") }),
		description: Flags.string({ char: "d", description: __ompTranslate("Clip description shown under the player") }),
		server: Flags.string({ description: __ompTranslate("Stream server base URL (overrides stream.serverUrl)") }),
	};

	static examples = [
		"omp clip",
		'omp clip -t "Streaming the lexer" -d "Rewrote the tokenizer live"',
		"omp clip /tmp/omp-recordings/2026-09-22T10-00-00-1a2b3c4d.ompcast",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Clip);
		if (flags.title !== undefined && flags.title.length > STREAM_TITLE_MAX) {
			throw new CliUsageError(__ompTranslate("--title must be at most {0} characters", `${STREAM_TITLE_MAX}`));
		}
		if (flags.description !== undefined && flags.description.length > CLIP_DESCRIPTION_MAX) {
			throw new CliUsageError(
				__ompTranslate("--description must be at most {0} characters", `${CLIP_DESCRIPTION_MAX}`),
			);
		}
		const file = args.file ? path.resolve(args.file) : await latestRecording();
		if (!file)
			throw new CliUsageError(__ompTranslate("no recordings in {0}; start one with /record", `${recordingsDir()}`));
		let recording: string;
		try {
			recording = await Bun.file(file).text();
		} catch (error) {
			if (isEnoent(error)) throw new CliUsageError(__ompTranslate("recording not found: {0}", `${file}`));
			throw error;
		}

		const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
		const credential = new StencilCredential();
		try {
			const token = await credential.resolve();
			if (!token) {
				process.stderr.write(`clip: ${StencilCredential.missingMessage}\n`);
				process.exitCode = 1;
				return;
			}
			const clip = await uploadClip({
				serverUrl: flags.server ?? cfgStreamServerUrl.get(settings),
				token,
				recording,
				title: flags.title,
				description: flags.description,
			});
			process.stdout.write(`${clip.url}\n`);
		} catch (error) {
			process.stderr.write(`clip: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		} finally {
			credential.close();
		}
	}
}
