/**
 * Synthesize text with the local TTS engine and play it (or save it with --out).
 *
 * Text comes from the argument or --file. Input is segmented into
 * sentence-sized chunks ({@link SpeakableStream}) and synthesized through the
 * streaming TTS worker, so arbitrarily long text plays gaplessly instead of
 * hitting Kokoro's single-call ~510-phoneme truncation. --out concatenates the
 * streamed segments into one WAV. The first run downloads the configured local
 * model into the worker's cache.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sayHelp as commandHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { TTS_LOCAL_VOICE_VALUES } from "../tts/models";
import { SpeakableStream } from "../tts/speakable";
import { StreamingAudioPlayer } from "../tts/streaming-player";
import { shutdownTtsClient, ttsClient } from "../tts/tts-client";
import { resolveLocalSpeechModelId } from "../tts/vocalizer";
import { encodeWav } from "../tts/wav";

import { cfgTtsLocalSpeed, cfgTtsLocalVoice } from "../tts/settings";

export default class Say extends Command {
	static description = commandHelp.description;
	static args = {
		text: Args.string({ description: __ompTranslate("Text to speak (or use --file)") }),
	};

	static flags = {
		voice: Flags.string({ description: __ompTranslate("Voice id"), options: TTS_LOCAL_VOICE_VALUES }),
		speed: Flags.string({
			description: __ompTranslate("Speaking rate, 0.5–2.5 (1 = normal; default: tts.localSpeed)"),
		}),
		model: Flags.string({ description: __ompTranslate("Local TTS model key") }),
		file: Flags.string({ char: "f", description: __ompTranslate("Read the text to speak from this file") }),
		out: Flags.string({ char: "o", description: __ompTranslate("Write WAV to this path instead of playing") }),
	};

	static examples = [
		'omp say "hello world"',
		"omp say --file notes.md --voice bm_fable --speed 1.25",
		'omp say "hello world" --out /tmp/hello.wav',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Say);
		if (args.text && flags.file) {
			process.stderr.write(chalk.red(__ompTranslate("error: pass either text or --file, not both\n")));
			process.exit(1);
		}

		const settings = await Settings.init({ cwd: getProjectDir() });
		const model = flags.model ?? (await this.#resolveDefaultModel(settings));
		const voice = flags.voice ?? cfgTtsLocalVoice.get(settings);
		const speed = flags.speed === undefined ? cfgTtsLocalSpeed.get(settings) : Number(flags.speed);
		if (!Number.isFinite(speed) || speed <= 0) {
			process.stderr.write(chalk.red(__ompTranslate("error: invalid --speed: {0}\n", `${flags.speed}`)));
			process.exit(1);
		}

		let exitCode = 0;
		const unsubscribe = ttsClient.onProgress(event => {
			if (event.status === "progress" && typeof event.progress === "number") {
				process.stderr.write(
					`\r${chalk.dim(__ompTranslate("downloading {0}: {1}%", `${event.file ?? model}`, `${Math.round(event.progress)}`))}`,
				);
			} else if (event.status === "done" || event.status === "ready") {
				// Clear the progress line once the download finishes.
				process.stderr.write("\r\x1b[K");
			}
		});

		try {
			const text = flags.file ? await Bun.file(flags.file).text() : (args.text ?? "");
			const splitter = new SpeakableStream();
			const segments = [...splitter.push(text), ...splitter.flush()];
			if (segments.length === 0) {
				process.stderr.write(chalk.red(__ompTranslate("error: nothing speakable in the input\n")));
				exitCode = 1;
				return;
			}

			const stream = ttsClient.synthesizeStream(model, { voice, speed });
			for (const segment of segments) stream.push(segment);
			stream.end();

			if (flags.out) {
				const pcms: Float32Array[] = [];
				let total = 0;
				let sampleRate = 0;
				for await (const chunk of stream.chunks) {
					pcms.push(chunk.pcm);
					total += chunk.pcm.length;
					sampleRate = chunk.sampleRate;
				}
				if (total === 0) {
					this.#synthesisFailed(model);
					exitCode = 1;
					return;
				}
				const pcm = new Float32Array(total);
				let offset = 0;
				for (const part of pcms) {
					pcm.set(part, offset);
					offset += part.length;
				}
				const wav = encodeWav(pcm, sampleRate);
				await Bun.write(flags.out, wav);
				const durationSec = total / sampleRate;
				process.stdout.write(
					`${chalk.green(__ompTranslate("saved\u0004speech.audio.saved"))} ${flags.out} ` +
						`${chalk.dim(__ompTranslate("({0}, {1}, {2}s, {3} bytes)", `${voice}`, `${model}`, `${durationSec.toFixed(1)}`, `${wav.byteLength}`))}\n`,
				);
				return;
			}

			const player = new StreamingAudioPlayer();
			let spoken = 0;
			let seconds = 0;
			for await (const chunk of stream.chunks) {
				player.start(chunk.sampleRate);
				player.write(chunk.pcm);
				spoken++;
				seconds += chunk.pcm.length / chunk.sampleRate;
			}
			if (spoken === 0) {
				player.stop();
				this.#synthesisFailed(model);
				exitCode = 1;
				return;
			}
			await player.end();
			process.stdout.write(
				`${chalk.green(__ompTranslate("spoke"))} ${chalk.dim(__ompTranslate("({0}, {1}, {2}s, {3} segments)", `${voice}`, `${model}`, `${seconds.toFixed(1)}`, `${spoken}`))}\n`,
			);
		} catch (err) {
			process.stderr.write(
				chalk.red(__ompTranslate("error: {0}\n", `${err instanceof Error ? err.message : String(err)}`)),
			);
			exitCode = 1;
		} finally {
			unsubscribe();
			await shutdownTtsClient();
		}

		if (exitCode !== 0) process.exit(exitCode);
	}

	async #resolveDefaultModel(settings: Settings): Promise<string> {
		const authStorage = await discoverAuthStorage(undefined, { settings });
		try {
			const registry = new ModelRegistry(authStorage, undefined, { settings });
			return resolveLocalSpeechModelId({ settings, registry });
		} finally {
			authStorage.close();
		}
	}

	#synthesisFailed(model: string): void {
		process.stderr.write(
			chalk.red(
				__ompTranslate(
					'error: could not synthesize with local TTS model "{0}". Run `omp setup speech` to install it.\n',
					`${model}`,
				),
			),
		);
	}
}
