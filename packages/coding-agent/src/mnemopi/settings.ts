/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Mnemopi local SQLite memory backend.
export const cfgMnemopiDbPath = register({
	id: "mnemopi.dbPath",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi DB Path",
		description: "Optional SQLite DB path. Defaults to the agent memories directory.",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiBank = register({
	id: "mnemopi.bank",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Bank",
		description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiScoping = register({
	id: "mnemopi.scoping",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Scoping",
		description:
			"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
		options: [
			{
				value: "global",
				label: "Global",
				description: "One shared Mnemopi bank for every project",
			},
			{
				value: "per-project",
				label: "Per project",
				description: "Project-local Mnemopi bank per cwd basename",
			},
			{
				value: "per-project-tagged",
				label: "Per project (tagged)",
				description: "Write to a project-local bank but merge project + shared recall results",
			},
		],
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingVariant = register({
	id: "mnemopi.embeddingVariant",
	type: "enum",
	values: ["en", "multilingual"] as const,
	default: "en",
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Embedding variant",
		description:
			"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.",
		options: [
			{
				value: "en",
				label: "English (bge-base-en-v1.5)",
				description: "BAAI/bge-base-en-v1.5 (768d), English-only",
			},
			{
				value: "multilingual",
				label: "Multilingual (multilingual-e5-large)",
				description: "intfloat/multilingual-e5-large (1024d), cross-language recall",
			},
		],
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiAutoRecall = register({
	id: "mnemopi.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Auto Recall",
		description: "Recall local memories into the first turn of each session",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiAutoRetain = register({
	id: "mnemopi.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Auto Retain",
		description: "Retain completed conversation turns into local Mnemopi memory",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiPolyphonicRecall = register({
	id: "mnemopi.polyphonicRecall",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Polyphonic Recall",
		description: "Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEnhancedRecall = register({
	id: "mnemopi.enhancedRecall",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Enhanced Recall",
		description: "Enable the tiered query result cache for repeated and similar recall queries",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiProactiveLinking = register({
	id: "mnemopi.proactiveLinking",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Proactive Linking",
		description:
			"Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiNoEmbeddings = register({
	id: "mnemopi.noEmbeddings",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Disable Embeddings",
		description: "Force deterministic FTS-only recall instead of vector embeddings",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingModel = register({
	id: "mnemopi.embeddingModel",
	type: "string",
	default: undefined,
	// Without the env term a variant default would silently shadow a user's configured env model.
	env: { name: "MNEMOPI_EMBEDDING_MODEL", fallback: true },
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Embedding Model",
		description:
			"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingApiUrl = register({
	id: "mnemopi.embeddingApiUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Embedding API URL",
		description: "Optional OpenAI-compatible embedding endpoint passed to Mnemopi",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiEmbeddingApiKey = register({
	id: "mnemopi.embeddingApiKey",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi Embedding API Key",
		description: "Optional embedding API key passed to Mnemopi",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiLlmMode = register({
	id: "mnemopi.llmMode",
	type: "enum",
	values: ["none", "smol", "remote"] as const,
	default: "smol",
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM Mode",
		description:
			"Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint",
		condition: "mnemopiActive",
		options: [
			{ value: "none", label: "None", description: "Disable Mnemopi LLM-backed extraction" },
			{
				value: "smol",
				label: "Online (tiny)",
				description: "Use the online tiny model (the TINY role from /models, else @smol)",
			},
			{ value: "remote", label: "Remote", description: "Use the Mnemopi remote LLM settings below" },
		],
	},
});

export const cfgMnemopiLlmBaseUrl = register({
	id: "mnemopi.llmBaseUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM Base URL",
		description: "Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiLlmApiKey = register({
	id: "mnemopi.llmApiKey",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM API Key",
		description: "Optional LLM API key for Mnemopi remote mode",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiLlmModel = register({
	id: "mnemopi.llmModel",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemopi",
		label: "Mnemopi LLM Model",
		description: "Optional LLM model name for Mnemopi remote mode",
		condition: "mnemopiActive",
	},
});

export const cfgMnemopiRetainEveryNTurns = register({ id: "mnemopi.retainEveryNTurns", type: "number", default: 4 });

export const cfgMnemopiRecallLimit = register({ id: "mnemopi.recallLimit", type: "number", default: 8 });

export const cfgMnemopiRecallContextTurns = register({ id: "mnemopi.recallContextTurns", type: "number", default: 3 });

export const cfgMnemopiRecallMaxQueryChars = register({
	id: "mnemopi.recallMaxQueryChars",
	type: "number",
	default: 4000,
});

export const cfgMnemopiInjectionTokenLimit = register({
	id: "mnemopi.injectionTokenLimit",
	type: "number",
	default: 5000,
});

export const cfgMnemopiDebug = register({ id: "mnemopi.debug", type: "boolean", default: false });
