import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	extractExplicitThinkingSelector,
	formatModelStringWithRouting,
	resolveModelOverride,
} from "../config/model-resolver";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { AgentDefinition, AgentProgress, SingleResult } from "../task/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "../thinking";
import type { ToolSession } from "../tools";
import { createPanelPersonaAgent, PANEL_INDEPENDENT_AGENT } from "./agents";
import {
	PanelConfigError,
	parsePanelSettings,
	resolvePanelPersona,
	resolvePanelRole,
	validateResolvedPanelRole,
} from "./config";
import { renderPanelAssignment, renderPanelSynthesisInput } from "./prompts";
import type {
	PanelistResult,
	PanelRole,
	PanelSettings,
	PanelTaskMode,
	ResolvedPanelMember,
	ResolvedPanelRole,
} from "./types";

/** The hard upper bound on simultaneously executing panel members. */
export const PANEL_MAX_CONCURRENCY = 4;

/**
 * Stable result id for a non-persisted `ephemeralRole`. It is reserved by this
 * runtime for its in-memory settings wrapper and is never written to settings.
 */
export const PANEL_EPHEMERAL_ROLE_ID = "__ephemeral__";

/** Aggregate billable work performed by every settled panel member. */
export interface PanelUsage {
	readonly tokens: number;
	readonly requests: number;
	readonly cost: number;
}

/** Inputs accepted by the panel execution runtime. */
export interface PanelRunOptions {
	readonly session: ToolSession;
	readonly taskMode: PanelTaskMode;
	readonly request: string;
	readonly requestedRole?: string;
	/** A one-off role parsed and validated for this run only. Mutually exclusive with `requestedRole`. */
	readonly ephemeralRole?: PanelRole;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: AgentProgress) => void;
}

/** The resolved panel evidence and bounded synthesis input returned to the primary session. */
export interface PanelRunResult {
	readonly role: ResolvedPanelRole;
	readonly members: readonly ResolvedPanelMember[];
	readonly results: readonly PanelistResult[];
	readonly usage: PanelUsage;
	readonly synthesisInput: string;
}

interface PreparedPanelMember {
	readonly member: ResolvedPanelMember;
	readonly assignment: string;
	readonly agentDefinition: AgentDefinition;
}

function memberPath(roleId: string, index: number, field: "model" | "thinking" | "persona"): string {
	return `panel.roles.${roleId}.members[${index}].${field}`;
}

/**
 * Parses a caller-supplied one-off role through the normal settings schema.
 * The synthetic wrapper retains configured personas but is never persisted.
 */
function resolveEphemeralPanelRole(role: PanelRole, settings: PanelSettings): ResolvedPanelRole {
	const ephemeralSettings = parsePanelSettings({
		personas: settings.personas,
		roles: { [PANEL_EPHEMERAL_ROLE_ID]: role },
	});
	return resolvePanelRole(ephemeralSettings, PANEL_EPHEMERAL_ROLE_ID);
}

/** Concrete thinking levels validated against a model's supported effort range; the auto/off/inherit selectors always pass through untouched. */
function validateThinkingLevel(model: Model, thinking: ConfiguredThinkingLevel | undefined, path: string): void {
	if (
		thinking === undefined ||
		thinking === AUTO_THINKING ||
		thinking === ThinkingLevel.Inherit ||
		thinking === ThinkingLevel.Off
	) {
		return;
	}
	if (!getSupportedEfforts(model).includes(thinking as Effort)) {
		throw new PanelConfigError(
			path,
			`thinking level "${thinking}" is not supported by ${model.provider}/${model.id}`,
		);
	}
}

function resolveMembers(options: { session: ToolSession; role: ResolvedPanelRole }): ResolvedPanelMember[] {
	const { session, role } = options;
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		throw new PanelConfigError("panel", "model registry is unavailable");
	}

	return role.role.members.map((member, index) => {
		const modelPath = memberPath(role.roleId, index, "model");
		const resolved = resolveModelOverride([member.model], modelRegistry, session.settings);
		const model = resolved.model;
		if (!model) {
			throw new PanelConfigError(modelPath, `model selector "${member.model}" is unavailable`);
		}
		if (!modelRegistry.hasConfiguredAuth(model)) {
			throw new PanelConfigError(
				modelPath,
				`model "${model.provider}/${model.id}" has no configured authentication`,
			);
		}

		const thinking =
			member.thinking ??
			extractExplicitThinkingSelector(member.model, session.settings, {
				isLiteralModelId: (provider, id) => model.provider === provider && model.id === id,
			}) ??
			resolved.thinkingLevel;
		validateThinkingLevel(model, thinking, memberPath(role.roleId, index, "thinking"));

		return {
			...member,
			index,
			selector: formatModelStringWithRouting(model),
			modelId: model.id,
			family: modelFamilyToken(model.id),
			...(thinking === undefined || thinking === ThinkingLevel.Inherit ? {} : { thinking }),
		};
	});
}

function prepareMembers(options: {
	role: ResolvedPanelRole;
	members: readonly ResolvedPanelMember[];
	taskMode: PanelTaskMode;
	request: string;
	settings: PanelSettings;
}): PreparedPanelMember[] {
	const { role, members, taskMode, request, settings } = options;
	return members.map(member => {
		const persona =
			role.role.strategy === "personas" ? resolvePanelPersona(settings, member.persona ?? "", taskMode) : undefined;
		return {
			member,
			assignment: renderPanelAssignment({
				taskMode,
				strategy: role.role.strategy,
				request,
				...(persona === undefined ? {} : { persona }),
			}),
			agentDefinition:
				persona === undefined ? PANEL_INDEPENDENT_AGENT : createPanelPersonaAgent(member.persona ?? "", persona),
		};
	});
}

function failedPanelistResult(options: {
	member: ResolvedPanelMember;
	status: "failed" | "aborted";
	error: string;
}): PanelistResult {
	return {
		member: options.member,
		status: options.status,
		output: "",
		error: options.error,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		cost: 0,
	};
}

function panelistResultFromExecution(member: ResolvedPanelMember, result: SingleResult): PanelistResult {
	const aborted = result.aborted === true;
	const failed = !aborted && (result.exitCode !== 0 || result.error !== undefined);
	const status = aborted ? "aborted" : failed ? "failed" : "completed";
	const error = aborted
		? (result.abortReason ?? result.error ?? (result.stderr || "Panel member was aborted"))
		: failed
			? (result.error ?? (result.stderr || `Panel member exited with code ${result.exitCode}`))
			: undefined;
	return {
		member,
		status,
		output: result.output,
		...(error === undefined ? {} : { error }),
		truncated: result.truncated,
		durationMs: result.durationMs,
		tokens: result.tokens,
		requests: result.requests,
		cost: result.usage?.cost.total ?? 0,
	};
}

function aggregateUsage(results: readonly PanelistResult[]): PanelUsage {
	return results.reduce<PanelUsage>(
		(usage, result) => ({
			tokens: usage.tokens + result.tokens,
			requests: usage.requests + result.requests,
			cost: usage.cost + result.cost,
		}),
		{ tokens: 0, requests: 0, cost: 0 },
	);
}

/** Summary line shared by text and TUI panel command completions. */
export function formatPanelCompletionStatus(result: PanelRunResult): string {
	let completed = 0;
	let failed = 0;
	let aborted = 0;
	for (const panelist of result.results) {
		if (panelist.status === "completed") completed += 1;
		else if (panelist.status === "failed") failed += 1;
		else aborted += 1;
	}
	const { tokens, requests, cost } = result.usage;
	return `Panel: ${completed} completed, ${failed} failed, ${aborted} aborted. Usage: ${tokens.toLocaleString()} tokens, ${requests.toLocaleString()} request${requests === 1 ? "" : "s"}, $${cost.toFixed(4)}.`;
}

/**
 * Resolve and run every member of a saved role or parsed one-off role, retaining
 * a typed record for every success, failure, and cancellation before rendering
 * primary-session synthesis input.
 */
export async function runPanel(options: PanelRunOptions): Promise<PanelRunResult> {
	const { session, taskMode, request, requestedRole, ephemeralRole, signal, onProgress } = options;
	if (requestedRole !== undefined && ephemeralRole !== undefined) {
		throw new PanelConfigError("panel", "requestedRole and ephemeralRole cannot be combined");
	}

	const settings = parsePanelSettings(session.settings.get("panel"));
	const role =
		ephemeralRole === undefined
			? resolvePanelRole(settings, requestedRole)
			: resolveEphemeralPanelRole(ephemeralRole, settings);
	const members = resolveMembers({ session, role });
	validateResolvedPanelRole(role.roleId, role.role, members, taskMode);
	const prepared = prepareMembers({ role, members, taskMode, request, settings });

	const settled = await mapWithConcurrencyLimitAllSettled(
		prepared,
		PANEL_MAX_CONCURRENCY,
		async (preparedMember, _index, memberSignal) =>
			runStructuredSubagent({
				session,
				invocationKind: "panel",
				assignment: preparedMember.assignment,
				model: preparedMember.member.selector,
				agentDefinition: preparedMember.agentDefinition,
				thinkingLevel: preparedMember.member.thinking,
				identity: { label: `Panelist${preparedMember.member.index + 1}` },
				index: preparedMember.member.index,
				keepAlive: true,
				retainArtifacts: true,
				signal: memberSignal,
				onProgress,
			}),
		signal,
	);

	const results = settled.results.map((result, index): PanelistResult => {
		const member = prepared[index].member;
		if (result === undefined) {
			return failedPanelistResult({
				member,
				status: "aborted",
				error: "Panel member was not started because the panel was aborted",
			});
		}
		if (result.status === "rejected") {
			return failedPanelistResult({
				member,
				status: signal?.aborted === true ? "aborted" : "failed",
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
		return panelistResultFromExecution(member, result.value.result);
	});
	const usage = aggregateUsage(results);
	const synthesisInput = renderPanelSynthesisInput({
		roleId: role.roleId,
		taskMode,
		strategy: role.role.strategy,
		request,
		results,
	});

	return { role, members, results, usage, synthesisInput };
}
