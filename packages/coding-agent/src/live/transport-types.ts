import type { Api, AuthStorage } from "@oh-my-pi/pi-ai";
import type { LiveClientMessage, LiveServerEvent } from "./protocol";

/** Registered native-duplex `/live` backends. */
export type VoiceProviderId = "codex" | "grok";

/** Callbacks emitted by a live transport implementation. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Shared configuration passed from the live-session controller to a provider. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
	voice: string;
	model?: string;
}

/** Message identity attached to transcripts emitted by a live transport. */
export interface LiveTransportIdentity {
	voiceProvider: VoiceProviderId;
	api: Api;
	provider: string;
	model: string;
}

/** Unified real-time transport interface powering `/live` mode. */
export interface ILiveTransport {
	readonly identity: LiveTransportIdentity;
	connect(): Promise<void>;
	send(message: LiveClientMessage): Promise<void>;
	shouldStreamAudio(inputLevel: number, outputLevel: number): boolean;
	pushAudio(samples: Float32Array): void;
	setMuted(muted: boolean): Promise<void>;
	close(): Promise<void>;
}
