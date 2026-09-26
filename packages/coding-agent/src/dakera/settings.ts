/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 *
 * No `env:` bindings here on purpose: `loadDakeraConfig` resolves `DAKERA_*` variables
 * itself (injectable env bag for tests, plus the `DAKERA_API_KEY` token alias the
 * registry cannot express), so these handles own the persisted-settings layer only.
 */
import { register } from "../config/registry";

// Dakera (https://dakera.ai) — self-hosted remote memory. There is no bank
// concept: isolation is the `agent_id`, so the Hindsight bank/scoping knobs
// collapse into an agent-id scheme (see dakera/bank.ts). Recall accepts a
// tag filter (`tags`, ANY-match), which is what makes `per-project-tagged` work.
export const cfgDakeraApiUrl = register({
	id: "dakera.apiUrl",
	type: "string",
	default: "http://localhost:3000",
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera API URL",
		description: "Dakera server URL (plain HTTP or TLS, depending on your deployment)",
		condition: "dakeraActive",
	},
});

export const cfgDakeraApiToken = register({
	id: "dakera.apiToken",
	type: "string",
	credential: true,
	default: undefined,
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera API Token",
		description: "Bearer token for the Dakera REST API",
		condition: "dakeraActive",
	},
});

export const cfgDakeraAgentId = register({
	id: "dakera.agentId",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera Agent ID",
		description: "Memory isolation key (default: omp, plus a project segment in per-project mode)",
		condition: "dakeraActive",
	},
});

export const cfgDakeraAgentIdPrefix = register({ id: "dakera.agentIdPrefix", type: "string", default: undefined });

export const cfgDakeraScoping = register({
	id: "dakera.scoping",
	type: "enum",
	values: ["global", "per-project", "per-project-tagged"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera Scoping",
		description:
			"global = one shared agent_id; per-project = isolated agent_id per repository; per-project-tagged = shared agent_id with project tags, so the current project plus global-tagged memories merge on recall",
		options: [
			{
				value: "global",
				label: "Global",
				description: "One shared agent_id — every project sees the same memories",
			},
			{
				value: "per-project",
				label: "Per project",
				description: "Isolated agent_id per repository — projects cannot see each other's memories",
			},
			{
				value: "per-project-tagged",
				label: "Per project (tagged)",
				description:
					"Shared agent_id; retains are tagged `project:<repo>` and recall filters on it, so this project's memories plus `global:shared` ones surface together",
			},
		],
		condition: "dakeraActive",
	},
});

export const cfgDakeraAutoRecall = register({
	id: "dakera.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera Auto Recall",
		description: "Recall memories on the first turn of each session",
		condition: "dakeraActive",
	},
});

export const cfgDakeraAutoRetain = register({
	id: "dakera.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera Auto Retain",
		description: "Store the transcript every N user turns",
		condition: "dakeraActive",
	},
});

export const cfgDakeraRetainMode = register({
	id: "dakera.retainMode",
	type: "enum",
	values: ["full-session", "last-turn"] as const,
	default: "full-session",
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera Retain Mode",
		description: "full-session = one growing episodic memory per session, last-turn = chunked",
		options: [
			{
				value: "full-session",
				label: "Full session",
				description: "Store the whole transcript as one episodic memory per session",
			},
			{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
		],
		condition: "dakeraActive",
	},
});

export const cfgDakeraRetainEveryNTurns = register({ id: "dakera.retainEveryNTurns", type: "number", default: 3 });

export const cfgDakeraRetainImportance = register({ id: "dakera.retainImportance", type: "number", default: 0.5 });

export const cfgDakeraRecallTopK = register({ id: "dakera.recallTopK", type: "number", default: 8 });

// Dakera raises a memory's importance every time it is read, so this is a
// floor on stored values, not a stable relevance threshold.
export const cfgDakeraRecallMinImportance = register({ id: "dakera.recallMinImportance", type: "number", default: 0 });

export const cfgDakeraRecallRerank = register({ id: "dakera.recallRerank", type: "boolean", default: true });

export const cfgDakeraRecallContextTurns = register({ id: "dakera.recallContextTurns", type: "number", default: 1 });

export const cfgDakeraRecallMaxQueryChars = register({
	id: "dakera.recallMaxQueryChars",
	type: "number",
	default: 800,
});

export const cfgDakeraReflectModel = register({
	id: "dakera.reflectModel",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Dakera",
		label: "Dakera Reflect Model",
		description: "Model selector for the synthesised `reflect` answer, empty = smol role, then default",
		condition: "dakeraActive",
	},
});

export const cfgDakeraDebug = register({ id: "dakera.debug", type: "boolean", default: false });

export const cfgDakeraRequestTimeoutMs = register({ id: "dakera.requestTimeoutMs", type: "number", default: 30_000 });

export const cfgDakeraRecallTimeoutMs = register({ id: "dakera.recallTimeoutMs", type: "number", default: 30_000 });

export const cfgDakeraRetainTimeoutMs = register({ id: "dakera.retainTimeoutMs", type: "number", default: 60_000 });

export const cfgDakeraReflectTimeoutMs = register({ id: "dakera.reflectTimeoutMs", type: "number", default: 120_000 });
