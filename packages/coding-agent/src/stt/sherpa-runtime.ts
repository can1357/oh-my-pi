import { createRequire } from "node:module";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getTinyModelsCacheDir,
	resolveRuntimeModule,
	type RuntimeInstallPhase,
} from "@oh-my-pi/pi-utils";

/** Native speech package installed by the shared STT runtime loader. */
export const SHERPA_PACKAGE = "sherpa-onnx-node";
/** Pinned speech runtime version shared by installation and cache paths. */
export const SHERPA_VERSION = "1.13.2";

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

export interface SherpaOnlineStream {
	acceptWaveform(audio: { samples: Float32Array; sampleRate: number }): void;
	inputFinished(): void;
}

/** The synchronous online API runs only inside the STT subprocess. */
export interface SherpaOnlineRecognizer {
	createStream(): SherpaOnlineStream;
	isReady(stream: SherpaOnlineStream): boolean;
	decode(stream: SherpaOnlineStream): void;
	getResult(stream: SherpaOnlineStream): { text: string };
	isEndpoint(stream: SherpaOnlineStream): boolean;
	reset(stream: SherpaOnlineStream): void;
}

/** The native sherpa-onnx module surface used by the STT worker. */
export interface SherpaRuntime {
	OfflineRecognizer: {
		createAsync(config: SherpaOfflineConfig): Promise<SherpaOfflineRecognizer>;
	};
	OnlineRecognizer: new (config: SherpaOfflineConfig & { enableEndpoint: boolean }) => SherpaOnlineRecognizer;
}

/**
 * Install the pinned native runtime on first use in both source/npm and compiled
 * builds. Reuse the shared version-keyed cache; native libraries resolve relative
 * to the installed wrapper without a module-resolver patch.
 */
export async function loadSherpaRuntime(onPhase?: (phase: RuntimeInstallPhase) => void): Promise<SherpaRuntime> {
	const runtimeDir = await ensureRuntimeInstalled({
		runtimeDir: path.join(path.dirname(getTinyModelsCacheDir()), "stt-runtime", `sherpa-${SHERPA_VERSION}`),
		install: { dependencies: { [SHERPA_PACKAGE]: SHERPA_VERSION } },
		probePackage: SHERPA_PACKAGE,
		onPhase,
	});
	const nodeModules = path.join(runtimeDir, "node_modules");
	const entry = resolveRuntimeModule(nodeModules, SHERPA_PACKAGE);
	if (!entry) throw new Error(`Unable to resolve ${SHERPA_PACKAGE} in runtime at ${nodeModules}`);
	const runtime: SherpaRuntime = createRequire(entry)(entry);
	return runtime;
}
