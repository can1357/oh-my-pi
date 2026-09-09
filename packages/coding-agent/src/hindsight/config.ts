/**
 * Resolved Hindsight runtime configuration.
 *
 * Source of truth precedence (last wins):
 *   1. Built-in defaults
 *   2. Settings (`hindsight.*` schema entries via `Settings.get(...)`)
 *   3. `HINDSIGHT_*` environment variables
 *
 * Env wins because operators frequently override per-shell (CI, prod) without
 * touching the persisted settings file.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export type HindsightScoping = "global" | "per-project" | "per-project-tagged";

export interface HindsightConfig {
	hindsightApiUrl: string | null;
	hindsightApiToken: string | null;

	bankId: string | null;
	bankIdPrefix: string;
	scoping: HindsightScoping;
	bankMission: string;
	retainMission: string | null;

	autoRecall: boolean;
	autoRetain: boolean;

	retainMode: "full-session" | "last-turn";
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	retainContext: string;

	recallBudget: "low" | "mid" | "high";
	recallMaxTokens: number;
	recallTypes: string[];
	recallContextTurns: number;
	recallMaxQueryChars: number;
	recallPromptPreamble: string;

	debug: boolean;

	/** Default per-request client deadline (ms) for ops without a specific override. */
	requestTimeoutMs: number;
	/** Client deadline (ms) for reflect (agentic synthesis; costlier than a metadata fetch). */
	reflectTimeoutMs: number;
	/** Client deadline (ms) for recall. */
	recallTimeoutMs: number;
	/** Client deadline (ms) for retain / retainBatch. */
	retainTimeoutMs: number;

	mentalModelsEnabled: boolean;
	mentalModelAutoSeed: boolean;
	mentalModelRefreshIntervalMs: number;
	mentalModelMaxRenderChars: number;
}

const VALID_RETAIN_MODES: HindsightConfig["retainMode"][] = ["full-session", "last-turn"];
const VALID_BUDGETS: HindsightConfig["recallBudget"][] = ["low", "mid", "high"];
const VALID_SCOPINGS: HindsightScoping[] = ["global", "per-project", "per-project-tagged"];

const DEFAULT_PREAMBLE =
	"Relevant memories from past conversations (prioritize recent when conflicting). " +
	"Only use memories that are directly useful to continue this conversation; ignore the rest:";

/** Coerce an env var value into a boolean using the OpenCode plugin's semantics. */
function envBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["true", "1", "yes"].includes(value.toLowerCase());
}

/** Coerce an env var value into an int, returning undefined for non-numeric input. */
function envInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
}

function envString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function pickBudget(value: unknown): HindsightConfig["recallBudget"] | undefined {
	return typeof value === "string" && (VALID_BUDGETS as string[]).includes(value)
		? (value as HindsightConfig["recallBudget"])
		: undefined;
}

function pickRetainMode(value: unknown): HindsightConfig["retainMode"] | undefined {
	return typeof value === "string" && (VALID_RETAIN_MODES as string[]).includes(value)
		? (value as HindsightConfig["retainMode"])
		: undefined;
}

function pickScoping(value: unknown): HindsightScoping | undefined {
	return typeof value === "string" && (VALID_SCOPINGS as string[]).includes(value)
		? (value as HindsightScoping)
		: undefined;
}

/**
 * Load the resolved Hindsight config.
 *
 * Pure (no I/O) aside from reading from `process.env` and the supplied
 * Settings instance. Tests can pass `Settings.isolated({...})` and stub
 * `process.env` per case.
 */
export function loadHindsightConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): HindsightConfig {
	const apiUrlEnv = envString(env.HINDSIGHT_API_URL);
	const apiTokenEnv = envString(env.HINDSIGHT_API_TOKEN);
	const bankIdEnv = envString(env.HINDSIGHT_BANK_ID);
	const bankMissionEnv = envString(env.HINDSIGHT_BANK_MISSION);
	const retainModeEnv = pickRetainMode(env.HINDSIGHT_RETAIN_MODE);
	const recallBudgetEnv = pickBudget(env.HINDSIGHT_RECALL_BUDGET);
	const autoRecallEnv = envBool(env.HINDSIGHT_AUTO_RECALL);
	const autoRetainEnv = envBool(env.HINDSIGHT_AUTO_RETAIN);
	const scopingEnv = pickScoping(env.HINDSIGHT_SCOPING);
	const debugEnv = envBool(env.HINDSIGHT_DEBUG);
	const recallMaxTokensEnv = envInt(env.HINDSIGHT_RECALL_MAX_TOKENS);
	const recallContextTurnsEnv = envInt(env.HINDSIGHT_RECALL_CONTEXT_TURNS);
	const recallMaxQueryCharsEnv = envInt(env.HINDSIGHT_RECALL_MAX_QUERY_CHARS);
	const retainEveryNTurnsEnv = envInt(env.HINDSIGHT_RETAIN_EVERY_N_TURNS);
	const requestTimeoutMsEnv = envInt(env.HINDSIGHT_REQUEST_TIMEOUT_MS);
	const reflectTimeoutMsEnv = envInt(env.HINDSIGHT_REFLECT_TIMEOUT_MS);
	const recallTimeoutMsEnv = envInt(env.HINDSIGHT_RECALL_TIMEOUT_MS);
	const retainTimeoutMsEnv = envInt(env.HINDSIGHT_RETAIN_TIMEOUT_MS);

	// Read from settings (each falls back to its schema default).
	const settingsRetainMode = pickRetainMode(settings.get("hindsight.retainMode"));
	if (settings.get("hindsight.retainMode") && !settingsRetainMode) {
		logger.warn("Hindsight: invalid retainMode setting, falling back to full-session", {
			value: settings.get("hindsight.retainMode"),
		});
	}
	const settingsRecallBudget = pickBudget(settings.get("hindsight.recallBudget"));
	const settingsScoping = pickScoping(settings.get("hindsight.scoping"));
	if (settings.get("hindsight.scoping") && !settingsScoping) {
		logger.warn("Hindsight: invalid scoping setting, falling back to per-project-tagged", {
			value: settings.get("hindsight.scoping"),
		});
	}

	const config: HindsightConfig = {
		hindsightApiUrl: apiUrlEnv ?? settings.get("hindsight.apiUrl") ?? null,
		hindsightApiToken: apiTokenEnv ?? settings.get("hindsight.apiToken") ?? null,

		bankId: bankIdEnv ?? settings.get("hindsight.bankId") ?? null,
		bankIdPrefix: settings.get("hindsight.bankIdPrefix") ?? "",
		scoping: scopingEnv ?? settingsScoping ?? "per-project-tagged",
		bankMission: bankMissionEnv ?? settings.get("hindsight.bankMission") ?? "",
		retainMission: settings.get("hindsight.retainMission") ?? null,

		autoRecall: autoRecallEnv ?? settings.get("hindsight.autoRecall"),
		autoRetain: autoRetainEnv ?? settings.get("hindsight.autoRetain"),

		retainMode: retainModeEnv ?? settingsRetainMode ?? "full-session",
		retainEveryNTurns: retainEveryNTurnsEnv ?? settings.get("hindsight.retainEveryNTurns"),
		retainOverlapTurns: settings.get("hindsight.retainOverlapTurns"),
		retainContext: settings.get("hindsight.retainContext") ?? "omp",

		recallBudget: recallBudgetEnv ?? settingsRecallBudget ?? "mid",
		recallMaxTokens: recallMaxTokensEnv ?? settings.get("hindsight.recallMaxTokens"),
		recallTypes: settings.get("hindsight.recallTypes") as string[],
		recallContextTurns: recallContextTurnsEnv ?? settings.get("hindsight.recallContextTurns"),
		recallMaxQueryChars: recallMaxQueryCharsEnv ?? settings.get("hindsight.recallMaxQueryChars"),
		recallPromptPreamble: DEFAULT_PREAMBLE,

		debug: debugEnv ?? settings.get("hindsight.debug"),

		requestTimeoutMs: requestTimeoutMsEnv ?? settings.get("hindsight.requestTimeoutMs"),
		reflectTimeoutMs: reflectTimeoutMsEnv ?? settings.get("hindsight.reflectTimeoutMs"),
		recallTimeoutMs: recallTimeoutMsEnv ?? settings.get("hindsight.recallTimeoutMs"),
		retainTimeoutMs: retainTimeoutMsEnv ?? settings.get("hindsight.retainTimeoutMs"),

		mentalModelsEnabled: settings.get("hindsight.mentalModelsEnabled"),
		mentalModelAutoSeed: settings.get("hindsight.mentalModelAutoSeed"),
		mentalModelRefreshIntervalMs: settings.get("hindsight.mentalModelRefreshIntervalMs"),
		mentalModelMaxRenderChars: settings.get("hindsight.mentalModelMaxRenderChars"),
	};

	return config;
}

/** Whether the caller has enough config to talk to a Hindsight server. */
export function isHindsightConfigured(
	config: HindsightConfig,
): config is HindsightConfig & { hindsightApiUrl: string } {
	return typeof config.hindsightApiUrl === "string" && config.hindsightApiUrl.length > 0;
}
