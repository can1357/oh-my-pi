/** Settings for the realtime voice surface. */
import { register } from "../config/registry";
import type { Settings } from "../config/settings";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "./voices";

export const cfgLiveProvider = register({
	id: "live.provider",
	type: "enum",
	values: ["openai-codex", "google"] as const,
	default: "openai-codex",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Provider",
		description: "Provider used by /live and RPC live sessions",
		options: [
			{ value: "openai-codex", label: "Codex" },
			{ value: "google", label: "Gemini" },
		],
	},
});

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "enum",
	values: LIVE_VOICE_VALUES,
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Codex Live Voice",
		description: "Voice used by Codex-backed realtime voice sessions",
		options: LIVE_VOICE_OPTIONS,
	},
});

export const cfgLiveGoogleModel = register({
	id: "live.google.model",
	type: "string",
	default: "gemini-3.8-live-extended-thinking",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Gemini Live Model",
		description: "Gemini Live API model resource ID",
	},
});

export const cfgLiveGoogleVoice = register({
	id: "live.google.voice",
	type: "string",
	default: "Aoede",
	ui: { tab: "providers", group: "Services", label: "Gemini Live Voice", description: "Google prebuilt voice name" },
});

export const cfgLiveGoogleThinking = register({
	id: "live.google.thinkingLevel",
	type: "enum",
	values: ["low", "medium", "high"] as const,
	default: "high",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Gemini Live Thinking",
		description: "Background reasoning level for Gemini Live Extended Thinking",
		options: [
			{ value: "low", label: "Low" },
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
		],
	},
});

/** Provider-specific default; RPC's explicit voice still takes precedence. */
export function resolveLiveVoice(settings: Settings): string {
	return cfgLiveProvider.get(settings) === "google" ? cfgLiveGoogleVoice.get(settings) : cfgLiveVoice.get(settings);
}
