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
	/** Immutable prepared dispatch returned by {@link preparePanelRun}. */
	readonly plan?: PanelRunPlan;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: AgentProgress) => void;
}

/** The resolved panel evidence and bounded synthesis input returned to the primary session. */
export interface PanelRunResult {
	readonly role: ResolvedPanelRole;
	readonly members: readonly ResolvedPanelMember[];
	readonly results: readonly PanelistResult[];
	/** True only when the panel-level cancellation signal was aborted. */
	readonly cancelled: boolean;
	readonly usage: PanelUsage;
	readonly synthesisInput: string;
}

/** A fully resolved, pre-dispatch panel lineup. */
export interface PanelRunPreview {
	readonly role: ResolvedPanelRole;
	readonly members: readonly ResolvedPanelMember[];
}

/**
 * An approved, immutable panel dispatch. It retains the exact resolved role,
 * members, assignments, and persona configuration selected for one request.
 */
export interface PanelRunPlan {
	readonly preview: PanelRunPreview;
	readonly taskMode: PanelTaskMode;
	readonly request: string;
}

interface PreparedPanelMember {
	readonly member: ResolvedPanelMember;
	readonly assignment: string;
	readonly agentDefinition: AgentDefinition;
}

interface PreparedPanelRun {
	readonly session: ToolSession;
	readonly requestedRole?: string;
	readonly ephemeralRole?: PanelRole;
	readonly prepared: PreparedPanelMember[];
}

const preparedPanelRuns = new WeakMap<PanelRunPlan, PreparedPanelRun>();

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

interface ResolvedPanelRun {
	readonly settings: PanelSettings;
	readonly preview: PanelRunPreview;
}

function resolvePanelRun(
	options: Pick<PanelRunOptions, "session" | "taskMode" | "requestedRole" | "ephemeralRole">,
): ResolvedPanelRun {
	const { session, taskMode, requestedRole, ephemeralRole } = options;
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
	return { settings, preview: { role, members } };
}

/** Clone and freeze the preview boundary before it can be handed to the TUI. */
function freezePanelPreview(preview: PanelRunPreview): PanelRunPreview {
	const roleMembers = Object.freeze(preview.role.role.members.map(member => Object.freeze({ ...member })));
	const roleConfig = Object.freeze({ strategy: preview.role.role.strategy, members: roleMembers });
	const role = Object.freeze({ roleId: preview.role.roleId, role: roleConfig });
	const members = Object.freeze(preview.members.map(member => Object.freeze({ ...member })));
	return Object.freeze({ role, members });
}

function preparedPanelRunFor(options: PanelRunOptions, plan: PanelRunPlan): PreparedPanelRun {
	const prepared = preparedPanelRuns.get(plan);
	if (
		prepared === undefined ||
		prepared.session !== options.session ||
		plan.taskMode !== options.taskMode ||
		plan.request !== options.request ||
		prepared.requestedRole !== options.requestedRole ||
		prepared.ephemeralRole !== options.ephemeralRole
	) {
		throw new PanelConfigError("panel", "approved panel plan does not match this dispatch");
	}
	return prepared;
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

/**
 * Resolve, validate, and prepare an immutable panel dispatch before a user
 * approves it. Passing the returned plan to {@link runPanel} prevents a second
 * settings/model resolution between preview and member dispatch.
 */
export function preparePanelRun(options: Omit<PanelRunOptions, "onProgress" | "plan" | "signal">): PanelRunPlan {
	const resolved = resolvePanelRun(options);
	const preview = freezePanelPreview(resolved.preview);
	const prepared = prepareMembers({
		role: preview.role,
		members: preview.members,
		taskMode: options.taskMode,
		request: options.request,
		settings: resolved.settings,
	});
	const plan = Object.freeze({
		preview,
		taskMode: options.taskMode,
		request: options.request,
	});
	preparedPanelRuns.set(plan, {
		session: options.session,
		requestedRole: options.requestedRole,
		ephemeralRole: options.ephemeralRole,
		prepared,
	});
	return plan;
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

/**
 * Resolve and run every member of a saved role or parsed one-off role, retaining
 * a typed record for every success, failure, and cancellation before rendering
 * primary-session synthesis input.
 */
export async function runPanel(options: PanelRunOptions): Promise<PanelRunResult> {
	const { session, taskMode, request, signal, onProgress } = options;
	const plan = options.plan ?? preparePanelRun(options);
	const {
		preview: { role, members },
	} = plan;
	const { prepared } = preparedPanelRunFor(options, plan);

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

	const results = Array.from({ length: prepared.length }, (_, index): PanelistResult => {
		const result = settled.results[index];
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
	const cancelled = signal?.aborted === true;
	const synthesisInput = renderPanelSynthesisInput({
		roleId: role.roleId,
		taskMode,
		strategy: role.role.strategy,
		request,
		results,
	});

	return { role, members, results, usage, synthesisInput, cancelled };
}
