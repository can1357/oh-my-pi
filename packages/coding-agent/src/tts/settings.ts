/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_TTS_VOICE, TTS_LOCAL_VOICE_OPTIONS, TTS_LOCAL_VOICE_VALUES } from "./models";

export const cfgTtsLocalVoice = register({
	id: "tts.localVoice",
	type: "enum",
	values: TTS_LOCAL_VOICE_VALUES,
	default: DEFAULT_TTS_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Local TTS Voice",
		description: "Kokoro voice used by the local TTS backend (American/British, female/male)",
		options: TTS_LOCAL_VOICE_OPTIONS,
	},
});

export const cfgSpeechEnabled = register({
	id: "speech.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization",
		description: "Speak the assistant's output aloud through the speakers as it streams",
	},
});

export const cfgSpeechMode = register({
	id: "speech.mode",
	type: "enum",
	values: ["all", "assistant", "yield"] as const,
	default: "assistant",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization Mode",
		description:
			"What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end",
		options: [
			{ value: "all", label: "All (messages + thinking)" },
			{ value: "assistant", label: "Assistant messages" },
			{ value: "yield", label: "Final message only" },
		],
	},
});

export const cfgSpeechEnhanced = register({
	id: "speech.enhanced",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Enhanced Speech Rewriting",
		description:
			"Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure",
	},
});

export const cfgSpeechVoice = register({
	id: "speech.voice",
	type: "enum",
	values: TTS_LOCAL_VOICE_VALUES,
	default: DEFAULT_TTS_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Speech Vocalization Voice",
		description: "Kokoro voice used when speaking the assistant's output aloud",
		options: TTS_LOCAL_VOICE_OPTIONS,
	},
});
