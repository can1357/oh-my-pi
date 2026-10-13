/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Mnemosyne OSS local SQLite memory backend. The Python SDK is user-managed;
// OMP never installs it and never forwards provider credentials to it.
export const cfgMnemosyneOssExecutable = register({
	id: "mnemosyne-oss.executable",
	type: "string",
	default: "",
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Python executable",
		description:
			"Optional Python interpreter with mnemosyne-memory 4.x installed. Blank resolves the configured Python/PATH runtime.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssDataDir = register({
	id: "mnemosyne-oss.dataDir",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Store data directory",
		description: "Shared Mnemosyne store directory. Defaults to MNEMOSYNE_DATA_DIR or ~/.hermes/mnemosyne/data.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssBank = register({
	id: "mnemosyne-oss.bank",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Bank",
		description: "Optional shared bank base name. Per-project modes derive a stable project-local bank from it.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssScoping = register({
	id: "mnemosyne-oss.scoping",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Scoping",
		description:
			"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus shared-bank recall",
		options: [
			{ value: "global", label: "Global", description: "One shared Mnemosyne bank for every project" },
			{ value: "per-project", label: "Per project", description: "Project-local Mnemosyne bank per cwd" },
			{
				value: "per-project-tagged",
				label: "Per project (tagged)",
				description: "Write to a project-local bank and recall both project and shared banks",
			},
		],
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssOwnership = register({
	id: "mnemosyne-oss.ownership",
	type: "enum",
	values: ["shared", "omp"] as const,
	default: "shared",
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Bank ownership",
		description:
			"Shared banks cannot be cleared by OMP. Choose OMP only for a non-default bank owned exclusively by OMP.",
		options: [
			{ value: "shared", label: "Shared", description: "Safe default; OMP refuses destructive bank deletion" },
			{ value: "omp", label: "OMP-owned", description: "Allows clearing this non-default bank" },
		],
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssAutoRecall = register({
	id: "mnemosyne-oss.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Auto recall",
		description: "Recall local memories into the first turn of each root session",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssAutoRetain = register({
	id: "mnemosyne-oss.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Auto retain",
		description: "Retain completed root-session conversation suffixes",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssLocalEmbeddings = register({
	id: "mnemosyne-oss.localEmbeddings",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Local embeddings",
		description: "Use only local embeddings. Turn off for lexical-only recall; hosted embeddings are never used.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssEmbeddingModel = register({
	id: "mnemosyne-oss.embeddingModel",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Local embedding model",
		description: "Optional local embedding model ID. Leave empty for the SDK default.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssLocalConsolidation = register({
	id: "mnemosyne-oss.localConsolidation",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Local consolidation model",
		description:
			"Permit consolidation with a local LLM only when a local LLM repository or file is also set. Off, or on without a local model path, uses Mnemosyne's no-LLM heuristic consolidation.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssLocalLlmRepo = register({
	id: "mnemosyne-oss.localLlmRepo",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Local LLM repository",
		description: "Optional local consolidation model repository; used only when local consolidation is on.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssLocalLlmFile = register({
	id: "mnemosyne-oss.localLlmFile",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Local LLM file",
		description: "Optional local consolidation model file; used only when local consolidation is on.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssAutoMigrate = register({
	id: "mnemosyne-oss.autoMigrate",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "Mnemosyne OSS",
		label: "Allow schema migration",
		description: "Permit Mnemosyne schema migration. Shared databases are never migrated unless explicitly enabled.",
		condition: "mnemosyneOssActive",
	},
});

export const cfgMnemosyneOssRetainEveryNTurns = register({
	id: "mnemosyne-oss.retainEveryNTurns",
	type: "number",
	default: 4,
});

export const cfgMnemosyneOssRecallLimit = register({ id: "mnemosyne-oss.recallLimit", type: "number", default: 8 });

export const cfgMnemosyneOssRecallContextTurns = register({
	id: "mnemosyne-oss.recallContextTurns",
	type: "number",
	default: 3,
});

export const cfgMnemosyneOssRecallMaxQueryChars = register({
	id: "mnemosyne-oss.recallMaxQueryChars",
	type: "number",
	default: 4000,
});

export const cfgMnemosyneOssInjectionTokenLimit = register({
	id: "mnemosyne-oss.injectionTokenLimit",
	type: "number",
	default: 5000,
});

export const cfgMnemosyneOssRequestTimeoutMs = register({
	id: "mnemosyne-oss.requestTimeoutMs",
	type: "number",
	default: 30000,
});

export const cfgMnemosyneOssSleepTimeoutMs = register({
	id: "mnemosyne-oss.sleepTimeoutMs",
	type: "number",
	default: 120000,
});

export const cfgMnemosyneOssShutdownTimeoutMs = register({
	id: "mnemosyne-oss.shutdownTimeoutMs",
	type: "number",
	default: 1500,
});

export const cfgMnemosyneOssDebug = register({ id: "mnemosyne-oss.debug", type: "boolean", default: false });
