/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { STT_SUBMIT_TRIGGER_OPTIONS, STT_SUBMIT_TRIGGER_VALUES } from "./submit-trigger";

// Speech-to-text
export const cfgSttEnabled = register({
	id: "stt.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Speech",
		label: "Speech-to-Text",
		description: "Enable speech-to-text input via microphone",
	},
});

export const cfgSttLanguage = register({ id: "stt.language", type: "string", default: "en" });

export const cfgSttSubmitTrigger = register({
	id: "stt.submitTrigger",
	type: "enum",
	values: STT_SUBMIT_TRIGGER_VALUES,
	default: "never",
	ui: {
		tab: "interaction",
		group: "Speech",
		label: "Speech-to-Text Submit Trigger",
		description:
			"Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.",
		options: STT_SUBMIT_TRIGGER_OPTIONS,
	},
});
