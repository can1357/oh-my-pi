/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

const HINDSIGHT_RECALL_TYPES_DEFAULT: string[] = ["world", "experience"];

// Hindsight (https://hindsight.vectorize.io)
export const cfgHindsightApiUrl = register({
	id: "hindsight.apiUrl",
	env: "HINDSIGHT_API_URL",
	type: "string",
	default: "http://localhost:8888",
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight API URL",
		description: "Hindsight server URL (Cloud or self-hosted)",
		condition: "hindsightActive",
	},
});

export const cfgHindsightApiToken = register({
	id: "hindsight.apiToken",
	env: "HINDSIGHT_API_TOKEN",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight API Token",
		description: "Bearer token for authenticated Hindsight servers",
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankId = register({
	id: "hindsight.bankId",
	env: "HINDSIGHT_BANK_ID",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Bank ID",
		description: "Memory bank identifier (default: project name)",
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankIdPrefix = register({ id: "hindsight.bankIdPrefix", type: "string", default: undefined });

export const cfgHindsightScoping = register({
	id: "hindsight.scoping",
	env: "HINDSIGHT_SCOPING",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project-tagged",
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Scoping",
		description:
			"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
		options: [
			{
				value: "global",
				label: "Global",
				description: "One shared bank — every project sees the same memories",
			},
			{
				value: "per-project",
				label: "Per project",
				description: "Isolated bank per cwd basename — projects cannot see each other's memories",
			},
			{
				value: "per-project-tagged",
				label: "Per project (tagged)",
				description:
					"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
			},
		],
		condition: "hindsightActive",
	},
});

export const cfgHindsightBankMission = register({
	id: "hindsight.bankMission",
	env: "HINDSIGHT_BANK_MISSION",
	type: "string",
	default: undefined,
});

export const cfgHindsightRetainMission = register({
	id: "hindsight.retainMission",
	type: "string",
	default: undefined,
});

export const cfgHindsightAutoRecall = register({
	id: "hindsight.autoRecall",
	env: "HINDSIGHT_AUTO_RECALL",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Auto Recall",
		description: "Recall memories on the first turn of each session",
		condition: "hindsightActive",
	},
});

export const cfgHindsightAutoRetain = register({
	id: "hindsight.autoRetain",
	env: "HINDSIGHT_AUTO_RETAIN",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Auto Retain",
		description: "Retain transcript every N turns and at session boundaries",
		condition: "hindsightActive",
	},
});

export const cfgHindsightRetainMode = register({
	id: "hindsight.retainMode",
	env: "HINDSIGHT_RETAIN_MODE",
	type: "enum",
	values: ["full-session", "last-turn"] as const,
	default: "full-session",
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Retain Mode",
		description: "full-session = upsert one document per session, last-turn = chunked",
		options: [
			{
				value: "full-session",
				label: "Full session",
				description: "Upsert one document per session (recommended)",
			},
			{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
		],
		condition: "hindsightActive",
	},
});

export const cfgHindsightRetainEveryNTurns = register({
	id: "hindsight.retainEveryNTurns",
	env: "HINDSIGHT_RETAIN_EVERY_N_TURNS",
	type: "number",
	default: 3,
});

export const cfgHindsightRetainOverlapTurns = register({
	id: "hindsight.retainOverlapTurns",
	type: "number",
	default: 2,
});

export const cfgHindsightRetainContext = register({ id: "hindsight.retainContext", type: "string", default: "omp" });

export const cfgHindsightRecallBudget = register({
	id: "hindsight.recallBudget",
	env: "HINDSIGHT_RECALL_BUDGET",
	type: "enum",
	values: ["low", "mid", "high"] as const,
	default: "mid",
});

export const cfgHindsightRecallMaxTokens = register({
	id: "hindsight.recallMaxTokens",
	env: "HINDSIGHT_RECALL_MAX_TOKENS",
	type: "number",
	default: 1024,
});

export const cfgHindsightRecallContextTurns = register({
	id: "hindsight.recallContextTurns",
	env: "HINDSIGHT_RECALL_CONTEXT_TURNS",
	type: "number",
	default: 1,
});

export const cfgHindsightRecallMaxQueryChars = register({
	id: "hindsight.recallMaxQueryChars",
	env: "HINDSIGHT_RECALL_MAX_QUERY_CHARS",
	type: "number",
	default: 800,
});

export const cfgHindsightRecallTypes = register({
	id: "hindsight.recallTypes",
	type: "array",
	default: HINDSIGHT_RECALL_TYPES_DEFAULT,
});

export const cfgHindsightDebug = register({
	id: "hindsight.debug",
	env: "HINDSIGHT_DEBUG",
	type: "boolean",
	default: false,
});

export const cfgHindsightRequestTimeoutMs = register({
	id: "hindsight.requestTimeoutMs",
	env: "HINDSIGHT_REQUEST_TIMEOUT_MS",
	type: "number",
	default: 30_000,
});

export const cfgHindsightReflectTimeoutMs = register({
	id: "hindsight.reflectTimeoutMs",
	env: "HINDSIGHT_REFLECT_TIMEOUT_MS",
	type: "number",
	default: 120_000,
});

export const cfgHindsightRecallTimeoutMs = register({
	id: "hindsight.recallTimeoutMs",
	env: "HINDSIGHT_RECALL_TIMEOUT_MS",
	type: "number",
	default: 30_000,
});

export const cfgHindsightRetainTimeoutMs = register({
	id: "hindsight.retainTimeoutMs",
	env: "HINDSIGHT_RETAIN_TIMEOUT_MS",
	type: "number",
	default: 60_000,
});

export const cfgHindsightMentalModelsEnabled = register({
	id: "hindsight.mentalModelsEnabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Mental Models",
		description:
			"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
		condition: "hindsightActive",
	},
});

export const cfgHindsightMentalModelAutoSeed = register({
	id: "hindsight.mentalModelAutoSeed",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Hindsight",
		label: "Hindsight Mental Model Auto-Seed",
		description:
			"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
		condition: "hindsightActive",
	},
});

export const cfgHindsightMentalModelMaxRenderChars = register({
	id: "hindsight.mentalModelMaxRenderChars",
	type: "number",
	default: 16_000,
});
