/**
 * Resolved Dakera runtime configuration.
 *
 * Source of truth precedence (last wins):
 *   1. Built-in defaults
 *   2. Settings (`dakera.*` registry handles in `dakera/settings.ts`)
 *
 * Env wins because operators frequently override per-shell (CI, prod) without
 * touching the persisted settings file. Both `DAKERA_API_TOKEN` (the
 * coding-agent convention, mirroring `HINDSIGHT_API_TOKEN`) and
 * `DAKERA_API_KEY` (the name the Dakera server and SDKs use) are accepted for
 * the bearer token, so a deployment can export one variable and have the
 * server, the MCP surface and omp agree.
 */

import type { Settings } from "../config/settings";
import {
	cfgDakeraApiToken,
	cfgDakeraApiUrl,
	cfgDakeraAgentId,
	cfgDakeraAgentIdPrefix,
	cfgDakeraAutoRecall,
	cfgDakeraAutoRetain,
	cfgDakeraDebug,
	cfgDakeraRecallContextTurns,
	cfgDakeraRecallMaxQueryChars,
	cfgDakeraRecallMinImportance,
	cfgDakeraRecallRerank,
	cfgDakeraRecallTimeoutMs,
	cfgDakeraRecallTopK,
	cfgDakeraReflectModel,
	cfgDakeraReflectTimeoutMs,
	cfgDakeraRequestTimeoutMs,
	cfgDakeraRetainEveryNTurns,
	cfgDakeraRetainImportance,
	cfgDakeraRetainMode,
	cfgDakeraRetainTimeoutMs,
	cfgDakeraScoping,
} from "./settings";

export type DakeraScoping = "global" | "per-project" | "per-project-tagged";

export interface DakeraConfig {
	apiUrl: string | null;
	apiToken: string | null;

	agentId: string | null;
	agentIdPrefix: string;
	scoping: DakeraScoping;

	autoRecall: boolean;
	autoRetain: boolean;

	retainMode: "full-session" | "last-turn";
	retainEveryNTurns: number;
	/** `importance` sent on store (0.0–1.0). Dakera raises it on every read. */
	retainImportance: number;

	recallTopK: number;
	recallMinImportance: number;
	/** Server-side rerank pass. Expensive on CPU-only hosts; server default is on. */
	recallRerank: boolean;
	recallContextTurns: number;
	recallMaxQueryChars: number;

	/** Model selector for the client-side `reflect` synthesis; empty = smol role, then default. */
	reflectModel: string | null;

	debug: boolean;

	/** Default per-request client deadline (ms) for ops without a specific override. */
	requestTimeoutMs: number;
	/** Client deadline (ms) for recall. */
	recallTimeoutMs: number;
	/** Client deadline (ms) for store / storeBatch. */
	retainTimeoutMs: number;
	/** Client deadline (ms) for the `reflect` model call. */
	reflectTimeoutMs: number;
}

const VALID_RETAIN_MODES: DakeraConfig["retainMode"][] = ["full-session", "last-turn"];
const VALID_SCOPINGS: DakeraScoping[] = ["global", "per-project", "per-project-tagged"];

const DEFAULT_PREAMBLE =
	"Relevant memories from past conversations (prioritize recent when conflicting). " +
	"Only use memories that are directly useful to continue this conversation; ignore the rest:";

function envBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["true", "1", "yes"].includes(value.toLowerCase());
}

function envNumber(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function envString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function pickRetainMode(value: unknown): DakeraConfig["retainMode"] | undefined {
	return typeof value === "string" && (VALID_RETAIN_MODES as string[]).includes(value)
		? (value as DakeraConfig["retainMode"])
		: undefined;
}

function pickScoping(value: unknown): DakeraScoping | undefined {
	return typeof value === "string" && (VALID_SCOPINGS as string[]).includes(value)
		? (value as DakeraScoping)
		: undefined;
}

/**
 * Load the resolved Dakera config.
 *
 * Pure (no I/O) aside from reading `process.env` and the supplied Settings
 * instance, so tests can pass `Settings.isolated({...})` and stub env per case.
 */
export function loadDakeraConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): DakeraConfig {
	const apiUrlEnv = envString(env.DAKERA_API_URL);
	const apiTokenEnv = envString(env.DAKERA_API_TOKEN) ?? envString(env.DAKERA_API_KEY);
	const agentIdEnv = envString(env.DAKERA_AGENT_ID);
	const scopingEnv = pickScoping(env.DAKERA_SCOPING);
	const retainModeEnv = pickRetainMode(env.DAKERA_RETAIN_MODE);
	const autoRecallEnv = envBool(env.DAKERA_AUTO_RECALL);
	const autoRetainEnv = envBool(env.DAKERA_AUTO_RETAIN);
	const rerankEnv = envBool(env.DAKERA_RECALL_RERANK);
	const debugEnv = envBool(env.DAKERA_DEBUG);

	// Invalid persisted enum values are caught by the registry (`compute` warns and
	// falls back to the default), so only the raw env value needs validation here.
	return {
		apiUrl: apiUrlEnv ?? cfgDakeraApiUrl.get(settings) ?? null,
		apiToken: apiTokenEnv ?? cfgDakeraApiToken.get(settings) ?? null,
		agentId: agentIdEnv ?? cfgDakeraAgentId.get(settings) ?? null,
		agentIdPrefix: cfgDakeraAgentIdPrefix.get(settings) ?? "",
		scoping: scopingEnv ?? cfgDakeraScoping.get(settings),
		autoRecall: autoRecallEnv ?? cfgDakeraAutoRecall.get(settings),
		autoRetain: autoRetainEnv ?? cfgDakeraAutoRetain.get(settings),
		retainMode: retainModeEnv ?? cfgDakeraRetainMode.get(settings),
		retainEveryNTurns: envNumber(env.DAKERA_RETAIN_EVERY_N_TURNS) ?? cfgDakeraRetainEveryNTurns.get(settings),
		retainImportance: envNumber(env.DAKERA_RETAIN_IMPORTANCE) ?? cfgDakeraRetainImportance.get(settings),
		recallTopK: envNumber(env.DAKERA_RECALL_TOP_K) ?? cfgDakeraRecallTopK.get(settings),
		recallMinImportance: envNumber(env.DAKERA_RECALL_MIN_IMPORTANCE) ?? cfgDakeraRecallMinImportance.get(settings),
		recallRerank: rerankEnv ?? cfgDakeraRecallRerank.get(settings),
		recallContextTurns: envNumber(env.DAKERA_RECALL_CONTEXT_TURNS) ?? cfgDakeraRecallContextTurns.get(settings),
		recallMaxQueryChars: envNumber(env.DAKERA_RECALL_MAX_QUERY_CHARS) ?? cfgDakeraRecallMaxQueryChars.get(settings),
		reflectModel: envString(env.DAKERA_REFLECT_MODEL) ?? cfgDakeraReflectModel.get(settings) ?? null,
		debug: debugEnv ?? cfgDakeraDebug.get(settings),
		requestTimeoutMs: envNumber(env.DAKERA_REQUEST_TIMEOUT_MS) ?? cfgDakeraRequestTimeoutMs.get(settings),
		recallTimeoutMs: envNumber(env.DAKERA_RECALL_TIMEOUT_MS) ?? cfgDakeraRecallTimeoutMs.get(settings),
		retainTimeoutMs: envNumber(env.DAKERA_RETAIN_TIMEOUT_MS) ?? cfgDakeraRetainTimeoutMs.get(settings),
		reflectTimeoutMs: envNumber(env.DAKERA_REFLECT_TIMEOUT_MS) ?? cfgDakeraReflectTimeoutMs.get(settings),
	};
}

/** Whether the caller has enough config to talk to a Dakera server. */
export function isDakeraConfigured(config: DakeraConfig): config is DakeraConfig & { apiUrl: string } {
	return typeof config.apiUrl === "string" && config.apiUrl.length > 0;
}

/** Preamble above the injected `<memories>` block. */
export const DAKERA_RECALL_PREAMBLE = DEFAULT_PREAMBLE;
