import * as path from "node:path";
import { CLIP_DESCRIPTION_MAX, DEFAULT_STREAM_URL, STREAM_TITLE_MAX } from "@oh-my-pi/pi-wire";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { clipHelp as commandHelp } from "../cli/command-help";
import { Settings } from "../config/settings";
import { StencilCredential } from "../stencil/credential";
import { uploadClip } from "../stream/clip-upload";
import { latestRecording, recordingsDir } from "../stream/recording";

export default class Clip extends Command {
	static description = commandHelp.description;

	static args = {
		file: Args.string({ description: "Recording to upload (default: the newest /record capture)" }),
	};

	static flags = {
		title: Flags.string({ char: "t", description: "Clip title (defaults to the recording's title)" }),
		description: Flags.string({ char: "d", description: "Clip description shown under the player" }),
		server: Flags.string({ description: "Stream server base URL (overrides stream.serverUrl)" }),
	};

	static examples = [
		"omp clip",
		'omp clip -t "Streaming the lexer" -d "Rewrote the tokenizer live"',
		"omp clip /tmp/omp-recordings/2026-09-22T10-00-00-1a2b3c4d.ompcast",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Clip);
		if (flags.title !== undefined && flags.title.length > STREAM_TITLE_MAX) {
			throw new CliUsageError(`--title must be at most ${STREAM_TITLE_MAX} characters`);
		}
		if (flags.description !== undefined && flags.description.length > CLIP_DESCRIPTION_MAX) {
			throw new CliUsageError(`--description must be at most ${CLIP_DESCRIPTION_MAX} characters`);
		}
		const file = args.file ? path.resolve(args.file) : await latestRecording();
		if (!file) throw new CliUsageError(`no recordings in ${recordingsDir()}; start one with /record`);
		let recording: string;
		try {
			recording = await Bun.file(file).text();
		} catch (error) {
			if (isEnoent(error)) throw new CliUsageError(`recording not found: ${file}`);
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
				serverUrl: flags.server ?? settings.get("stream.serverUrl") ?? DEFAULT_STREAM_URL,
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
