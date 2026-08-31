import type { SttTranscriber } from "./contracts";
import { DEFAULT_STT_MODEL_KEY, STT_MODELS, type SttModelKey } from "./local/models";
import { LocalSttTranscriber } from "./local/transcriber";
import { CodexSttTranscriber } from "./providers/codex";
import { CODEX_TRANSCRIBER_META, type SttTranscriberDefinition } from "./types";

// Metadata (ids, options, defaults, guards) lives in ./types; re-exported here
// so existing consumers keep one import site (mirrors web/search's provider.ts).
export * from "./types";

const LOCAL_TRANSCRIBERS = STT_MODELS.map(
	model =>
		({
			id: model.key,
			label: model.label,
			description: model.description,
			create: () => new LocalSttTranscriber({ modelKey: model.key }),
		}) satisfies SttTranscriberDefinition<SttModelKey>,
);

const CODEX_TRANSCRIBER = {
	...CODEX_TRANSCRIBER_META,
	create: () => new CodexSttTranscriber(),
} as const satisfies SttTranscriberDefinition<typeof CODEX_TRANSCRIBER_META.id>;

const STT_TRANSCRIBERS = [...LOCAL_TRANSCRIBERS, CODEX_TRANSCRIBER] as const;

export function createSttTranscriber(id: string): SttTranscriber {
	const definition = STT_TRANSCRIBERS.find(candidate => candidate.id === id);
	return (
		definition?.create() ?? LOCAL_TRANSCRIBERS.find(candidate => candidate.id === DEFAULT_STT_MODEL_KEY)!.create()
	);
}
