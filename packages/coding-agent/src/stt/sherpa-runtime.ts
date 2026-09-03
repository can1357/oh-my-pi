import { createRequire } from "node:module";
import * as os from "node:os";
import { resolveRuntimeModule } from "@oh-my-pi/pi-utils";

const SHERPA_PACKAGE = "sherpa-onnx-node";

interface SherpaOfflineResult {
	text?: string;
}

interface SherpaOfflineStream {
	acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void;
}

interface SherpaOfflineConfig {
	modelConfig: {
		transducer: { encoder: string; decoder: string; joiner: string };
		tokens: string;
		modelType: string;
		numThreads: number;
		provider: string;
		debug: number;
	};
	decodingMethod: string;
}

/** A sherpa-onnx recognizer instance used by the STT worker. */
export interface SherpaOfflineRecognizer {
	createStream(): SherpaOfflineStream;
	decodeAsync(stream: SherpaOfflineStream): Promise<SherpaOfflineResult>;
}

/** The native sherpa-onnx module surface used by the STT worker. */
export interface SherpaRuntime {
	OfflineRecognizer: {
		createAsync(config: SherpaOfflineConfig): Promise<SherpaOfflineRecognizer>;
	};
}

/** Loads the nearest working source-workspace sherpa wrapper, including hoisted fallbacks. */
export function loadSourceSherpaRuntime(sourceUrl: string): SherpaRuntime {
	const sourceRequire = createRequire(sourceUrl);
	const nearestEntry = sourceRequire.resolve(SHERPA_PACKAGE);
	try {
		return createRequire(nearestEntry)(nearestEntry);
	} catch (error) {
		if (!(error instanceof Error && error.message.startsWith("Could not find sherpa-onnx-node. Tried"))) {
			throw error;
		}
		const platform = os.platform();
		const platformPackage = `sherpa-onnx-${platform === "win32" ? "win" : platform}-${os.arch()}`;
		for (const nodeModules of sourceRequire.resolve.paths(SHERPA_PACKAGE) ?? []) {
			if (!resolveRuntimeModule(nodeModules, platformPackage)) continue;
			const entry = resolveRuntimeModule(nodeModules, SHERPA_PACKAGE);
			if (!entry || entry === nearestEntry) continue;
			try {
				return createRequire(entry)(entry);
			} catch (candidateError) {
				if (
					!(
						candidateError instanceof Error &&
						candidateError.message.startsWith("Could not find sherpa-onnx-node. Tried")
					)
				) {
					throw candidateError;
				}
			}
		}
		throw error;
	}
}
