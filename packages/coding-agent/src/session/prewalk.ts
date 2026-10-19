import type { Agent, AgentMessage, AgentToolResult, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AutoPrewalkDecision } from "../auto-prewalk/classifier";
import type { Settings } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../plan-mode/plan-autosave";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import type { PlanModeState } from "../plan-mode/state";
import planYoloHandoffPrompt from "../prompts/system/plan-yolo-handoff.md" with { type: "text" };
import prewalkChecklistPrompt from "../prompts/system/prewalk-checklist.md" with { type: "text" };
import prewalkContinuePrompt from "../prompts/system/prewalk-continue.md" with { type: "text" };
import prewalkPlanPrompt from "../prompts/system/prewalk-plan.md" with { type: "text" };
import { type ConfiguredThinkingLevel, prewalkWouldBeNoop } from "@oh-my-pi/pi-tui/thinking";
import { isMCPToolName } from "../tools/builtin-names";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import type { PlanProposalHandler } from "../tools/resolve";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { PlanYolo, Prewalk } from "./agent-session-types";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
import type { SessionManager } from "./session-manager";
import { cfgPrewalkAuto } from "./settings";
const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

/** Hidden plan steering is consumed within the live run and must not reappear after a context rebuild. */
export function isPrewalkPlanNudge(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PREWALK_PLAN_MESSAGE_TYPE;
}
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};
const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

/**
 * Whether a completed tool result is the first workspace-mutating action that
 * arms the prewalk hand-off. A direct `edit`/`write` call always counts; a
 * `write` that dispatched an `xd://` device (e.g. `lsp`, `ast_edit`, `debug`)
 * counts only when the wrapped tool resolved to a `write`/`exec` approval tier.
 * Read-only device calls — LSP navigation, `debug` inspection, `ast_edit` on
 * internal URLs, help lookups — leave the tier `read` (or absent) and must not
 * switch the model mid-investigation (issue #7312). MCP approval stays
 * conservatively `write`, so an MCP tool the server declared read-only is
 * excluded through the hint the dispatch recorded for the tool that ran.
 */
function isPrewalkImplementationAction(result: ToolResultMessage): boolean {
	if (!PREWALK_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;
	// A direct filesystem edit/write carries no `xd://` dispatch metadata.
	if (!details || typeof details !== "object" || !("xdev" in details) || !details.xdev) return true;
	const xdev = details.xdev;
	// Device dispatch: switch only on a genuine mutation tier. An absent tier
	// (help lookup, unresolved approval) declines the switch.
	if (typeof xdev !== "object" || !("tier" in xdev)) return false;
	if (xdev.tier !== "write" && xdev.tier !== "exec") return false;
	return !("readOnlyHint" in xdev && xdev.readOnlyHint === true);
}

/** Capabilities the prewalk coordinator borrows from its owning session. */
export interface PrewalkCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	restoreThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	resolveDefaultPrewalk(): Prewalk | undefined;
	/** Resolves `prewalk.autoTarget`; warns and returns undefined when it cannot be used. */
	resolveAutoPrewalkTarget(): Prewalk | undefined;
	/** Judges a new task for `prewalk.auto`; undefined when there is nothing to judge. */
	classifyAutoPrewalk(request: string, signal: AbortSignal): Promise<AutoPrewalkDecision | undefined>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	setActiveToolsByName(names: string[]): Promise<void>;
	restoreNonMCPToolPresentation(nonMCPToolNames: string[], nonMCPMountedToolNames: string[]): Promise<void>;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	getMountedXdevToolNames(): string[];
	hasBuiltInTool(name: string): boolean;
	getPlanModeState(): PlanModeState | undefined;
	setPlanModeState(state: PlanModeState | undefined): void;
	getPlanReferencePath(): string;
	setPlanProposalHandler(handler: PlanProposalHandler | null): void;
	waitForSessionMessagePersistence(message: AgentMessage): Promise<void>;
	localProtocolOptions(): LocalProtocolOptions;
}

/** Initial state for prewalk and plan-yolo startup flows. */
export interface PrewalkCoordinatorOptions {
	prewalk?: Prewalk;
	planYolo?: PlanYolo;
	/** Keep `prewalk.auto` away from this session until `/new` (`--no-prewalk`). */
	suppressAutoPrewalk?: boolean;
}

/** The models around a completed handoff, kept to return to the planning model. */
interface PrewalkHandoff {
	source: Model;
	sourceThinkingLevel: ConfiguredThinkingLevel | undefined;
	target: Model;
	targetThinkingLevel: ConfiguredThinkingLevel | undefined;
	/** Armed by `prewalk.auto`: the handoff belongs to one task, so the next task returns to `source`. */
	auto: boolean;
}

/** Coordinates one-way model prewalks and automatic plan-yolo handoffs. */

export type PrewalkRestartResult = "armed" | "reset" | "rejected";
export class PrewalkCoordinator {
	readonly #host: PrewalkCoordinatorHost;
	#prewalk: Prewalk | undefined;
	#planInjected = false;
	#continuePending = false;
	#todoSeen = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousNonMCPPresentation: { enabled: string[]; mounted: string[] } | undefined;
	#planYoloArmed = false;
	#handoff: PrewalkHandoff | undefined;
	/** The pending arm `prewalk.auto` made, as opposed to a manual or configured one. */
	#autoArm: Prewalk | undefined;
	/** Session-local opt-out from auto-prewalk: `/prewalk off`, or `--no-prewalk` at startup. `/new` clears it. */
	#autoSuppressed: boolean;

	constructor(host: PrewalkCoordinatorHost, options: PrewalkCoordinatorOptions = {}) {
		this.#host = host;
		this.#prewalk = options.prewalk;
		this.#planYolo = options.planYolo;
		this.#autoSuppressed = options.suppressAutoPrewalk === true;
	}

	/** Current prewalk target, if the one-way switch remains armed. */
	get state(): Prewalk | undefined {
		return this.#prewalk;
	}

	/** Whether the armed prewalk would perform a model or thinking-level handoff. */
	get willHandoff(): boolean {
		const prewalk = this.#prewalk;
		return prewalk !== undefined && !this.#isNoop(prewalk);
	}

	#isNoop(prewalk: Prewalk): boolean {
		return prewalkWouldBeNoop(
			this.#host.model(),
			this.#host.configuredThinkingLevel(),
			prewalk.target,
			prewalk.thinkingLevel,
		);
	}

	#clearPrewalkState(): void {
		this.#prewalk = undefined;
		this.#autoArm = undefined;
		this.#planInjected = false;
		this.#continuePending = false;
		this.#todoSeen = false;
	}

	/** A later model/effort selection owns the active model, even if its identity is unchanged. */
	releaseHandoff(): void {
		this.#handoff = undefined;
	}

	/** Retire the outgoing cycle and prepare a configured prewalk for a fresh main session. */
	async resetForNewSession(enabled: boolean): Promise<void> {
		const handoff = this.#handoff;
		this.#autoSuppressed = false;
		const restoreSource =
			handoff !== undefined &&
			(enabled || (handoff.auto && this.#autoMode() === "on")) &&
			this.#onHandoffTarget(handoff);
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.releaseHandoff();
		// Best-effort: /new has already committed the transcript switch, so an
		// unusable planning model must not abort the rest of session setup.
		if (restoreSource) await this.#restoreSource(handoff);
		if (!enabled) return;
		const prewalk = this.#host.resolveDefaultPrewalk();
		if (!prewalk) return;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		// Like startup, inject guidance at the first completed turn, not into an empty transcript.
		this.#prewalk = prewalk;
	}

	/** Whether the session still sits on the model and effort `handoff` switched to. */
	#onHandoffTarget(handoff: PrewalkHandoff): boolean {
		const current = this.#host.model();
		return (
			current?.provider === handoff.target.provider &&
			current?.id === handoff.target.id &&
			this.#host.configuredThinkingLevel() === handoff.targetThinkingLevel
		);
	}

	async #restoreSource(handoff: PrewalkHandoff): Promise<void> {
		try {
			await this.#host.setModelTemporary(handoff.source, handoff.sourceThinkingLevel, { ephemeral: true });
			// Temporary selection treats undefined as "keep/default"; restoration must preserve
			// the original selector, including auto or an explicitly inherited effort.
			this.#host.restoreThinkingLevel(handoff.sourceThinkingLevel);
		} catch (error) {
			this.#host.emitNotice(
				"warning",
				`Prewalk: could not restore ${handoff.source.provider}/${handoff.source.id}: ${error instanceof Error ? error.message : String(error)}`,
				"prewalk",
			);
		}
	}

	/** `/prewalk off`: keep auto-prewalk out of this session until `/new`. */
	suppressAuto(): void {
		this.#autoSuppressed = true;
	}

	/** Effective `prewalk.auto` mode: session opt-outs and plan mode (whose plan-file write would trip a handoff) turn it off. */
	#autoMode(): "off" | "suggest" | "on" {
		if (this.#autoSuppressed || this.#host.getPlanModeState()?.enabled === true) return "off";
		return cfgPrewalkAuto.get(this.#host.settings);
	}

	/**
	 * Starts a new user task under `prewalk.auto: on`. An auto handoff belongs to the task that armed it, so the
	 * session returns to that task's planning model unless a later explicit selection took ownership. An auto arm
	 * the previous task never used is dropped so this task is judged on its own. Manual and configured arms stay.
	 */
	async beginAutoTask(): Promise<void> {
		if (this.#autoMode() !== "on") return;
		if (this.#autoArm && this.#autoArm === this.#prewalk) {
			this.#scrubPlanNudge(undefined, true);
			this.#clearPrewalkState();
		}
		const handoff = this.#handoff;
		if (!handoff?.auto) return;
		this.releaseHandoff();
		if (this.#onHandoffTarget(handoff)) await this.#restoreSource(handoff);
	}

	/**
	 * Starts judging a new user task. Undefined when auto-prewalk is off for this turn or an arm already owns it.
	 * Never rejects: a failed judgment resolves undefined, so the turn proceeds as if auto-prewalk were off.
	 */
	classifyAuto(request: string, signal: AbortSignal): Promise<AutoPrewalkDecision | undefined> | undefined {
		if (this.#autoMode() === "off" || this.#prewalk !== undefined) return undefined;
		return this.#host.classifyAutoPrewalk(request, signal).catch(error => {
			logger.debug("auto-prewalk: skipped after a failure", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		});
	}

	/**
	 * Applies a decision right before its task is dispatched; synchronous, so nothing can interleave before the
	 * request carries it. `suggest` reports the decision. Under `on`, a confident prewalk arms a handoff from the
	 * active model to the auto target and returns the plan nudge for the caller to deliver with the task.
	 */
	applyAuto(decision: AutoPrewalkDecision | undefined): AgentMessage | undefined {
		const mode = this.#autoMode();
		if (!decision || mode === "off" || this.#prewalk !== undefined) return undefined;
		if (mode === "suggest" || !decision.arm) {
			const chance = decision.probabilities.prewalk.toFixed(2);
			const summary =
				decision.route !== "prewalk"
					? `${decision.route} (prewalk ${chance})`
					: decision.arm
						? `prewalk ${chance}`
						: `prewalk ${chance} (below threshold)`;
			if (mode === "suggest") this.#host.emitNotice("info", `Auto-prewalk: ${summary}`, "prewalk");
			else logger.debug("auto-prewalk: not armed", { decision: summary });
			return undefined;
		}
		const target = this.#host.resolveAutoPrewalkTarget();
		// Already on the target: nothing to hand off, and nothing worth reporting on every task.
		if (!target || this.#isNoop(target)) return undefined;
		const planMessage = this.#armPending(target.target, target.thinkingLevel);
		if (planMessage) this.#autoArm = this.#prewalk;
		return planMessage;
	}

	#disarmNoop(prewalk: Prewalk): void {
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: target ${prewalk.target.provider}/${prewalk.target.id} already matches the active model and thinking level; nothing to switch.`,
			"prewalk",
		);
	}

	/** Advances the one-way prewalk switch at a completed assistant-turn boundary. */
	async advanceAtTurnEnd(liveMessages: AgentMessage[], context: AgentTurnEndContext | undefined): Promise<void> {
		const prewalk = this.#prewalk;
		if (!prewalk || context?.message.role !== "assistant") return;
		if (this.#isNoop(prewalk)) {
			this.#scrubPlanNudge(liveMessages);
			this.#disarmNoop(prewalk);
			return;
		}
		if (context.toolResults.some(result => result.toolName === "todo" && !result.isError)) this.#todoSeen = true;

		const hasToolResults = context.toolResults.length > 0;
		if (this.#planInjected && hasToolResults) {
			this.#continuePending = true;
		} else if (this.#continuePending) {
			this.#continuePending = false;
			this.#host.agent.steer({
				role: "custom",
				customType: PREWALK_CONTINUE_MESSAGE_TYPE,
				content: prewalkContinuePrompt,
				attribution: "agent",
				display: false,
				timestamp: Date.now(),
			});
		}

		const todoGateOpen = this.#todoSeen || !this.#host.getActiveToolNames().includes("todo");
		const action = todoGateOpen
			? context.toolResults.find(result => isPrewalkImplementationAction(result))
			: undefined;
		if (!action) {
			if (!this.#planInjected) {
				this.#planInjected = true;
				this.#continuePending = true;
				this.#host.agent.steer({
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: prewalkPlanPrompt,
					display: false,
					attribution: "agent",
					timestamp: Date.now(),
				});
				this.#host.emitNotice("info", "Prewalk: injected deep-plan nudge.", "prewalk");
			}
			return;
		}

		await this.#host.waitForSessionMessagePersistence(context.message);
		for (const toolResult of context.toolResults) {
			await this.#host.waitForSessionMessagePersistence(toolResult);
		}
		this.#scrubPlanNudge(liveMessages);
		const target = prewalk.target;
		if (this.#isNoop(prewalk)) {
			this.#disarmNoop(prewalk);
			return;
		}
		const source = this.#host.model();
		const sourceThinkingLevel = this.#host.configuredThinkingLevel();
		const auto = this.#autoArm === prewalk;
		await this.#host.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#clearPrewalkState();
		if (source) {
			this.#handoff = {
				source,
				sourceThinkingLevel,
				target,
				targetThinkingLevel: this.#host.configuredThinkingLevel(),
				auto,
			};
		}
		this.#host.emitNotice(
			"info",
			`Prewalk: switched to ${target.provider}/${target.id} after first ${action.toolName} call.`,
			"prewalk",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
			content: prewalkChecklistPrompt,
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
	}

	/** Drops a pending prewalk hand-off (e.g. `prewalk.enabled` turned off); no-op when none is armed. */
	disarm(): void {
		const active = this.#prewalk;
		if (!active) return;
		this.#scrubPlanNudge(undefined, true);
		this.#clearPrewalkState();
		this.#host.emitNotice(
			"info",
			`Prewalk: disarmed; staying on the active model instead of switching to ${active.target.provider}/${active.target.id}.`,
			"prewalk",
		);
	}

	/** Arms a prewalk immediately for an explicit slash-command request; it takes over a matching auto arm. */
	arm(target: Model, thinkingLevel?: ConfiguredThinkingLevel): boolean {
		const active = this.#prewalk;
		if (active) {
			this.#host.emitNotice(
				"info",
				`Prewalk: already armed for ${active.target.provider}/${active.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			const matches =
				active.target.provider === target.provider &&
				active.target.id === target.id &&
				active.thinkingLevel === thinkingLevel;
			if (matches) this.#autoArm = undefined;
			return matches;
		}
		const planMessage = this.#armPending(target, thinkingLevel);
		if (!planMessage) return false;
		this.#host.agent.steer(planMessage);
		return true;
	}

	/** Arms an inactive prewalk; returns the plan nudge for the caller to deliver, or undefined for a no-op target. */
	#armPending(target: Model, thinkingLevel: ConfiguredThinkingLevel | undefined): AgentMessage | undefined {
		const candidate = { target, thinkingLevel };
		if (this.#isNoop(candidate)) {
			this.#disarmNoop(candidate);
			return undefined;
		}
		this.#prewalk = candidate;
		this.#planInjected = true;
		this.#continuePending = true;
		this.#todoSeen = false;
		this.#host.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
		return {
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: prewalkPlanPrompt,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Restores the planning model and reuses or creates the requested one-shot handoff.
	 * A different active arm rejects the restart before the current model changes.
	 */
	async restart(
		source: Model,
		sourceThinkingLevel: ConfiguredThinkingLevel | undefined,
		target: Model,
		targetThinkingLevel: ConfiguredThinkingLevel | undefined,
	): Promise<PrewalkRestartResult> {
		const active = this.#prewalk;
		if (
			active &&
			(active.target.provider !== target.provider ||
				active.target.id !== target.id ||
				active.thinkingLevel !== targetThinkingLevel)
		) {
			this.arm(target, targetThinkingLevel);
			return "rejected";
		}

		await this.#host.setModelTemporary(source, sourceThinkingLevel, { ephemeral: true });
		if (!active) return this.arm(target, targetThinkingLevel) ? "armed" : "reset";
		if (this.#isNoop(active)) {
			this.#scrubPlanNudge();
			this.#disarmNoop(active);
			return "reset";
		}
		return "armed";
	}

	/** Lazily enables plan-yolo's plan phase before the first prompt is built. */
	async armPlanYoloIfNeeded(): Promise<void> {
		if (!this.#planYolo || this.#planYoloArmed) return;
		this.#planYoloArmed = true;
		const previousEnabledTools = this.#host.getEnabledToolNames();
		const previousMountedTools = this.#host.getMountedXdevToolNames();
		const previousPlanModeState = this.#host.getPlanModeState();
		const planModeState: PlanModeState = {
			enabled: true,
			planFilePath: this.#host.getPlanReferencePath() || "local://PLAN.md",
			workflow: "parallel",
		};
		// PlanYolo's injected write is a plan transport, not a user grant. Publish
		// plan mode before applying the tool set so SessionTools keeps an existing
		// device-only write restricted.
		this.#host.setPlanModeState(planModeState);
		// Only the built-in write carries the xd:// propose transport. A shadowing
		// extension `write` would answer every proposal as a file write and the plan
		// phase would never end (#14030), so it is left out of the plan tool set.
		const planTools = this.#host.hasBuiltInTool("write")
			? [...previousEnabledTools, "write"]
			: previousEnabledTools.filter(name => name !== "write");
		try {
			await this.#host.setActiveToolsByName([...new Set(planTools)]);
		} catch (error) {
			this.#host.setPlanModeState(previousPlanModeState);
			this.#planYoloArmed = false;
			throw error;
		}
		this.#planYoloPreviousNonMCPPresentation = {
			enabled: previousEnabledTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		};
		this.#host.setPlanProposalHandler(title => this.#finalizePlanYoloProposal(title));
	}

	#scrubPlanNudge(liveMessages?: AgentMessage[], includeContinuation = false): void {
		if (liveMessages) {
			for (let index = liveMessages.length - 1; index >= 0; index--) {
				if (!isPrewalkPlanNudge(liveMessages[index])) continue;
				invalidateMessageCache(liveMessages[index]);
				liveMessages.splice(index, 1);
			}
		}
		const stateMessages = this.#host.agent.state.messages;
		const filtered = stateMessages.filter(message => !isPrewalkPlanNudge(message));
		if (filtered.length !== stateMessages.length) this.#host.agent.replaceMessages(filtered);
		// Delivered continuations are persisted history; only pending ones can be canceled.
		const isPendingNudge = (message: AgentMessage): boolean =>
			isPrewalkPlanNudge(message) ||
			(includeContinuation && message.role === "custom" && message.customType === PREWALK_CONTINUE_MESSAGE_TYPE);
		const steering = this.#host.agent.peekSteeringQueue();
		if (steering.some(isPendingNudge)) {
			this.#host.agent.replaceQueue(
				"steering",
				steering.filter(message => !isPendingNudge(message)),
			);
		}
	}

	async #finalizePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		const planYolo = this.#planYolo;
		const state = this.#host.getPlanModeState();
		if (!planYolo || !state?.enabled) throw new ToolError("Plan mode is not active.");
		const {
			planFilePath,
			planContent,
			title: resolvedTitle,
		} = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url =>
				readPlanFile(url, {
					localProtocolOptions: this.#host.localProtocolOptions(),
					cwd: this.#host.sessionManager.getCwd(),
				}),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: this.#host.localProtocolOptions() }),
		});
		let autosavedPlan: string | null = null;
		try {
			autosavedPlan = await autosaveApprovedPlan({
				settings: this.#host.settings,
				cwd: this.#host.sessionManager.getCwd(),
				title: resolvedTitle,
				planContent,
			});
			if (autosavedPlan) {
				const displayPath = truncateToWidth(replaceTabs(shortenPath(autosavedPlan)), TRUNCATE_LENGTHS.CONTENT);
				this.#host.emitNotice("info", `Plan autosaved to ${displayPath}.`, "plan-yolo");
			}
		} catch (error) {
			logger.warn("Failed to autosave approved plan", { error });
			const detail = truncateToWidth(
				shortenEmbeddedPaths(
					replaceTabs(error instanceof Error ? error.message : String(error))
						.replace(/[\r\n]+/g, " ")
						.trim(),
				),
				TRUNCATE_LENGTHS.CONTENT,
			);
			this.#host.emitNotice(
				"warning",
				`Plan autosave failed: ${detail} Continuing with implementation.`,
				"plan-yolo",
			);
		}
		this.#host.setPlanModeState(undefined);
		const previousPresentation = this.#planYoloPreviousNonMCPPresentation;
		try {
			if (previousPresentation) {
				await this.#host.restoreNonMCPToolPresentation(previousPresentation.enabled, previousPresentation.mounted);
			}
		} catch (error) {
			this.#host.setPlanModeState(state);
			throw error;
		}
		this.#host.setPlanProposalHandler(null);
		this.#planYolo = undefined;
		this.#planYoloPreviousNonMCPPresentation = undefined;
		await this.#host.setModelTemporary(planYolo.target, planYolo.thinkingLevel, { ephemeral: true });
		this.#host.emitNotice(
			"info",
			`Plan-yolo: plan approved, switched to ${planYolo.target.provider}/${planYolo.target.id} to implement "${resolvedTitle}".`,
			"plan-yolo",
		);
		this.#host.agent.steer({
			role: "custom",
			customType: PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
			content: prompt.render(planYoloHandoffPrompt, { planFilePath, title: resolvedTitle }),
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		});
		return {
			content: [{ type: "text", text: `Plan approved. Implementing now with ${planYolo.target.id}.` }],
			details: { planFilePath, title: resolvedTitle, planExists: true },
		};
	}
}
