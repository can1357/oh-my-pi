/** Settings for the realtime voice surface. */
import { defaultLiveModelFor } from "@oh-my-pi/pi-catalog/compat/providers";
import { register } from "../config/registry";
import type { Settings } from "../config/settings";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "./voices";
import { LIVE_MODEL } from "./protocol";

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
	default: "",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Gemini Live Model",
		description: "Gemini Live API model resource ID",
	},
});

export const cfgLiveComputer = register({
	id: "live.computer",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Gemini Live Computer Control",
		description: "Allow Gemini Live to send screenshots to Google and control your real keyboard and mouse",
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

/** Resolve the selected provider's Live model; Google overrides precede its catalog default. */
export function resolveLiveModel(settings: Settings): string {
	if (cfgLiveProvider.get(settings) !== "google") return LIVE_MODEL;
	const override = cfgLiveGoogleModel.get(settings).trim();
	if (override) return override;
	const catalogDefault = defaultLiveModelFor("google");
	if (catalogDefault === undefined) throw new Error("Google catalog entry has no default Live model");
	return catalogDefault;
}

/** Provider-specific default; RPC's explicit voice still takes precedence. */
export function resolveLiveVoice(settings: Settings): string {
	return cfgLiveProvider.get(settings) === "google" ? cfgLiveGoogleVoice.get(settings) : cfgLiveVoice.get(settings);
}
