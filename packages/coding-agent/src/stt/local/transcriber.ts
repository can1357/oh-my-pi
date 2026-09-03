import { logger } from "@oh-my-pi/pi-utils";
import { type SttStreamHandle, sttClient } from "../asr-client";
import type {
	SttTranscriber,
	SttTranscriberContext,
	SttTranscriptionCallbacks,
	SttTranscriptionSession,
} from "../contracts";
import { downloadSttModel, isSttModelCached } from "../downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";

interface LocalTranscriberOptions {
	modelKey: SttModelKey;
}

class LocalTranscriptionSession implements SttTranscriptionSession {
	readonly #stream: SttStreamHandle;

	constructor(stream: SttStreamHandle) {
		this.#stream = stream;
	}

	pushAudio(samples: Float32Array): void {
		this.#stream.pushAudio(samples);
	}

	stop(): Promise<string> {
		return this.#stream.stop();
	}

	async dispose(): Promise<void> {
		this.#stream.cancel();
	}
}

/** Local on-device transcription backed by the existing ASR worker. */
export class LocalSttTranscriber implements SttTranscriber {
	readonly id: SttModelKey;
	readonly label: string;
	readonly description: string;
	readonly #modelKey: SttModelKey;
	#resolved = false;
	constructor(options: LocalTranscriberOptions) {
		const model = resolveSttModelSpec(options.modelKey);
		this.id = model.key;
		this.label = model.label;
		this.description = model.description;
		this.#modelKey = model.key;
	}

	async createSession(
		context: SttTranscriberContext,
		callbacks: SttTranscriptionCallbacks,
	): Promise<SttTranscriptionSession> {
		await this.#prepare(callbacks.onStatus, context.signal);

		const stream = sttClient.startStream(this.#modelKey, {
			language: context.language || undefined,
			signal: context.signal,
			onPartial: callbacks.onPartial,
			onSegment: callbacks.onSegment,
		});

		return new LocalTranscriptionSession(stream);
	}

	async #prepare(onStatus: (message: string) => void, signal: AbortSignal): Promise<void> {
		if (this.#resolved) return;
		let wroteStatus = false;

		const status = (message: string): void => {
			wroteStatus = true;
			onStatus(message);
		};

		if (await isSttModelCached(this.#modelKey)) {
			this.#warm();
			this.#resolved = true;
			return;
		}

		await downloadSttModel(
			this.#modelKey,
			progress => status(`Downloading speech model ${progress.label} (${progress.percent}%)`),
			{ signal },
		);

		if (wroteStatus) onStatus("");

		this.#resolved = true;
	}

	#warm(): void {
		void downloadSttModel(this.#modelKey).catch(error => {
			this.#resolved = false;
			logger.debug("stt: background model warmup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}
