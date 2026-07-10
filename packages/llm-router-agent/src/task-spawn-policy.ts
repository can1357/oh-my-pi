import { classifySpawnDifficulty, type RouteLabel } from "./qwen-client.js";
import { taskSpawnTelemetry, writeTelemetry } from "./telemetry.js";
import type {
	RouterConfig,
	TaskSpawnConfig,
	TaskSpawnLabelMappings,
	TelemetryRecord,
} from "./types.js";

export type RouterWorkClass = "mechanical" | "judgment";
export type RouterAutonomy = "bound" | "supervised" | "independent";

export interface RouterSpawnRouteCandidate {
	selector: string;
	tier: "light" | "mid" | "frontier";
	provider?: string;
	modelId?: string;
	maxRequests: number;
	maxRuntimeMs: number;
}

export interface RouterSpawnPolicyInput {
	correlationId: string;
	agentName: string;
	assignment: string;
	workClass: RouterWorkClass;
	autonomy: RouterAutonomy;
	eligible: readonly RouterSpawnRouteCandidate[];
	requestedModel?: string;
	fusionSidekick: boolean;
	manualModelSelection: boolean;
}

export interface RouterSpawnPolicyResult {
	allow: boolean;
	routeLabel?: RouteLabel;
	candidateSelectors?: readonly string[];
	maxRequests?: number;
	maxRuntimeMs?: number;
	reasonCode?: string;
}

export type RouterTaskSpawnPolicy = (
	input: Readonly<RouterSpawnPolicyInput>,
	signal?: AbortSignal,
) => Promise<RouterSpawnPolicyResult>;

const DEFAULT_LABEL_MAPPINGS: TaskSpawnLabelMappings = {
	light: "light",
	mid: "mid",
	heavy: "frontier",
};

/**
 * Sole enable flag for spawn-only Qwen policy. Missing/default/false means Lane E
 * must register no hook and this factory returns a no-fetch policy.
 */
export function isTaskSpawnEnabled(config: RouterConfig): boolean {
	return config.taskSpawn?.enabled === true;
}

/**
 * Package-local spawn policy handler. Lane E adapts core hook types to this wire
 * shape and registers the handler only when {@link isTaskSpawnEnabled} is true.
 * This module never registers against the coding-agent extension API.
 */
export function createTaskSpawnPolicy(config: RouterConfig): RouterTaskSpawnPolicy {
	const taskSpawn = config.taskSpawn;
	const enabled = taskSpawn?.enabled === true;

	return async (input, signal) => {
		if (!enabled) {
			return unchangedAllow(input, "task_spawn_disabled");
		}

		throwIfAborted(signal);

		if (input.fusionSidekick) {
			await emitTelemetry(config, input, {
				allow: true,
				reasonCode: "skip_fusion_sidekick",
			});
			return unchangedAllow(input, "skip_fusion_sidekick");
		}

		if (input.manualModelSelection) {
			await emitTelemetry(config, input, {
				allow: true,
				reasonCode: "skip_manual_model_selection",
			});
			return unchangedAllow(input, "skip_manual_model_selection");
		}

		if (input.eligible.length === 0) {
			const denied: RouterSpawnPolicyResult = {
				allow: false,
				reasonCode: "no_eligible_candidates",
			};
			await emitTelemetry(config, input, denied);
			return denied;
		}

		// Judgment minimum happens before classifier; never select light for judgment work.
		let workingEligible = input.eligible;
		if (input.workClass === "judgment") {
			workingEligible = input.eligible.filter((candidate) => candidate.tier !== "light");
			if (workingEligible.length === 0) {
				const denied: RouterSpawnPolicyResult = {
					allow: false,
					reasonCode: "judgment_floor",
				};
				await emitTelemetry(config, input, denied);
				return denied;
			}
		}

		const classification = await classifySpawnDifficulty(
			input.assignment,
			{
				endpoint: requiredEndpoint(taskSpawn),
				timeoutMs: requiredTimeoutMs(taskSpawn),
				systemPrompt: requiredSystemPrompt(taskSpawn),
				model: taskSpawn?.model,
			},
			signal,
		);

		throwIfAborted(signal);

		let routeLabel = classification.label;
		let reasonCode = classification.reason ?? "classifier_selected";
		if (input.workClass === "judgment" && routeLabel === "light") {
			routeLabel = "mid";
			reasonCode = "judgment_floor";
		}

		const mappings = taskSpawn?.labelMappings ?? DEFAULT_LABEL_MAPPINGS;
		let targetTier: RouterSpawnRouteCandidate["tier"] = mappings[routeLabel];
		if (input.workClass === "judgment" && targetTier === "light") {
			targetTier = "mid";
			reasonCode = "judgment_floor";
		}

		const narrowed = workingEligible.filter((candidate) => candidate.tier === targetTier);
		const preserved = narrowed.length === 0;
		// Fallback mid with no prevalidated mid candidate preserves the deterministic eligible set.
		const selected = preserved ? workingEligible : narrowed;
		if (preserved) {
			reasonCode =
				classification.source === "fallback" || routeLabel === "mid"
					? classification.reason ?? "fallback_preserve_eligible"
					: "preserve_eligible_no_tier_match";
		}

		const result: RouterSpawnPolicyResult = {
			allow: true,
			routeLabel,
			candidateSelectors: selected.map((candidate) => candidate.selector),
			maxRequests: minPositive(selected.map((candidate) => candidate.maxRequests)),
			maxRuntimeMs: minPositive(selected.map((candidate) => candidate.maxRuntimeMs)),
			reasonCode,
		};

		await emitTelemetry(config, input, result, {
			classifierSource: classification.source,
			classifierReason: classification.reason,
			latencyMs: classification.latencyMs,
			appliedNarrowing: !preserved && narrowed.length < workingEligible.length,
			selectedTier: [targetTier],
		});

		return result;
	};
}

function unchangedAllow(
	_input: Readonly<RouterSpawnPolicyInput>,
	reasonCode: string,
): RouterSpawnPolicyResult {
	// Omit selectors/budgets so Lane E composition leaves ordering and budgets unchanged.
	return {
		allow: true,
		reasonCode,
	};
}

async function emitTelemetry(
	config: RouterConfig,
	input: Readonly<RouterSpawnPolicyInput>,
	result: RouterSpawnPolicyResult,
	extra: {
		classifierSource?: "classifier" | "fallback";
		classifierReason?: string;
		latencyMs?: number;
		appliedNarrowing?: boolean;
		selectedTier?: readonly string[];
	} = {},
): Promise<void> {
	// Disabled/missing taskSpawn must never emit assignment-derived telemetry.
	if (config.taskSpawn?.enabled !== true) return;

	const record: TelemetryRecord = taskSpawnTelemetry({
		correlationId: input.correlationId,
		agentName: input.agentName,
		workClass: input.workClass,
		autonomy: input.autonomy,
		eligibleTier: uniqueTiers(input.eligible),
		eligibleCount: input.eligible.length,
		routeLabel: result.routeLabel,
		allow: result.allow,
		reasonCode: result.reasonCode,
		candidateSelectors: result.candidateSelectors,
		maxRequests: result.maxRequests,
		maxRuntimeMs: result.maxRuntimeMs,
		classifierSource: extra.classifierSource,
		classifierReason: extra.classifierReason,
		latencyMs: extra.latencyMs,
		appliedNarrowing: extra.appliedNarrowing ?? false,
		selectedTier: extra.selectedTier,
	});
	await writeTelemetry(config, record);
}

function uniqueTiers(eligible: readonly RouterSpawnRouteCandidate[]): string[] {
	const tiers: string[] = [];
	for (const candidate of eligible) {
		if (!tiers.includes(candidate.tier)) tiers.push(candidate.tier);
	}
	return tiers;
}

function minPositive(values: readonly number[]): number | undefined {
	const finite = values.filter((value) => Number.isFinite(value));
	if (finite.length === 0) return undefined;
	return Math.min(...finite);
}

function requiredEndpoint(config: TaskSpawnConfig | undefined): string {
	const endpoint = config?.endpoint?.trim();
	if (!endpoint) {
		throw new Error("taskSpawn.endpoint is required when taskSpawn.enabled is true");
	}
	return endpoint;
}

function requiredTimeoutMs(config: TaskSpawnConfig | undefined): number {
	const timeoutMs = config?.timeoutMs;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
		throw new Error("taskSpawn.timeoutMs must be a positive finite number");
	}
	return timeoutMs;
}

function requiredSystemPrompt(config: TaskSpawnConfig | undefined): string {
	const systemPrompt = config?.systemPrompt?.trim();
	if (!systemPrompt) {
		throw new Error("taskSpawn.systemPrompt is required when taskSpawn.enabled is true");
	}
	return systemPrompt;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (typeof DOMException === "function") {
		throw new DOMException("This operation was aborted", "AbortError");
	}
	const error = new Error("This operation was aborted");
	error.name = "AbortError";
	throw error;
}
