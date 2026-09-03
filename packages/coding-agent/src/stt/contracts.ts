import type { AuthStorage } from "@oh-my-pi/pi-ai";

export interface SttTranscriberContext {
	authStorage?: AuthStorage;
	sessionId?: string;
	language?: string;
	signal: AbortSignal;
}

export interface SttTranscriptionCallbacks {
	onPartial(text: string): void;
	onSegment(text: string): void;
	onDurationWarning(message: string): void;
	onStatus(message: string): void;
	onError(error: Error): void;
}

export interface SttTranscriptionSession {
	pushAudio(samples: Float32Array): void;
	stop(): Promise<string>;
	dispose(): Promise<void>;
}

export interface SttTranscriber {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	createSession(
		context: SttTranscriberContext,
		callbacks: SttTranscriptionCallbacks,
	): Promise<SttTranscriptionSession>;
}
