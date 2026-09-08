import type { SttTranscriber } from "./contracts";
import { DEFAULT_STT_MODEL_KEY, isSttModelKey, STT_MODELS, type SttModelKey } from "./local/models";

export interface SttTranscriberDefinition<Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	readonly description: string;
	create(): SttTranscriber;
}

/**
 * Transcriber id/option metadata. Lives in this leaf module — never in the
 * registry — so `config/settings-schema` can consume it without pulling the
 * transcriber implementation graph (local worker client, Codex provider),
 * which imports settings itself (import-cycle TDZ crash otherwise).
 */

export const DEFAULT_STT_TRANSCRIBER_ID = DEFAULT_STT_MODEL_KEY;

export const CODEX_TRANSCRIBER_META = {
	id: "codex",
	label: "OpenAI Codex",
	description: "Cloud transcription using the configured OpenAI Codex account.",
} as const;

export type SttTranscriberId = SttModelKey | typeof CODEX_TRANSCRIBER_META.id;

export const STT_TRANSCRIBER_OPTIONS = [
	...STT_MODELS.map(({ key, label, description }) => ({ value: key, label, description })),
	{
		value: CODEX_TRANSCRIBER_META.id,
		label: CODEX_TRANSCRIBER_META.label,
		description: CODEX_TRANSCRIBER_META.description,
	},
];

export const STT_TRANSCRIBER_VALUES: SttTranscriberId[] = STT_TRANSCRIBER_OPTIONS.map(option => option.value);

export function isSttTranscriberId(value: string): value is SttTranscriberId {
	return value === CODEX_TRANSCRIBER_META.id || isSttModelKey(value);
}
