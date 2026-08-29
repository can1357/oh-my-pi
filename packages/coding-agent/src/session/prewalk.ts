import type { Agent, AgentMessage, AgentToolResult, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { LocalProtocolOptions } from "../internal-urls";
import { resolveApprovedPlan } from "../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import type { PlanModeState } from "../plan-mode/state";
import planYoloHandoffPrompt from "../prompts/system/plan-yolo-handoff.md" with { type: "text" };
import prewalkChecklistPrompt from "../prompts/system/prewalk-checklist.md" with { type: "text" };
import prewalkContinuePrompt from "../prompts/system/prewalk-continue.md" with { type: "text" };
import prewalkPlanPrompt from "../prompts/system/prewalk-plan.md" with { type: "text" };
import { type ConfiguredThinkingLevel, prewalkWouldBeNoop } from "../thinking";
import { isMCPToolName } from "../tools/builtin-names";
import type { PlanProposalHandler } from "../tools/resolve";
import { ToolError } from "../tools/tool-errors";
import type { PlanYolo, Prewalk } from "./agent-session-types";
import { PREWALK_PLAN_MESSAGE_TYPE } from "./messages";
import type { SessionManager } from "./session-manager";

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
 * switch the model mid-investigation (issue #7312).
 */
function isPrewalkImplementationAction(result: ToolResultMessage): boolean {
	if (!PREWALK_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;
	// A direct filesystem edit/write carries no `xd://` dispatch metadata.
	if (!details || typeof details !== "object" || !("xdev" in details) || !details.xdev) return true;
	const xdev = details.xdev;
	// Device dispatch: switch only on a genuine mutation tier. An absent tier
	// (help lookup, unresolved approval) declines the switch, matching the
	// reporter's "stay on the large model a couple turns longer" preference.
	if (typeof xdev !== "object" || !("tier" in xdev)) return false;
	return xdev.tier === "write" || xdev.tier === "exec";
}

/** Capabilities the prewalk coordinator borrows from its owning session. */
export interface PrewalkCoordinatorHost {
	agent: Agent;
	sessionManager: SessionManager;
	model(): Model | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void>;
	setActiveToolsByName(names: string[]): Promise<void>;
	setActiveToolPresentation(toolNames: string[], mountedToolNames: string[]): Promise<void>;
	runToolRegistryMutation<T>(mutation: () => Promise<T>): Promise<T>;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	getSelectedMCPToolNames(): string[];
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
}

/** Coordinates one-way model prewalks and automatic plan-yolo handoffs. */
export class PrewalkCoordinator {
	readonly #host: PrewalkCoordinatorHost;
	#prewalk: Prewalk | undefined;
	#planInjected = false;
	#continuePending = false;
	#todoSeen = false;
	#planYolo: PlanYolo | undefined;
	#planYoloPreviousNonMCPPresentation: { enabled: string[]; mounted: string[] } | undefined;
	#planYoloArmed = false;

	constructor(host: PrewalkCoordinatorHost, options: PrewalkCoordinatorOptions = {}) {
		this.#host = host;
		this.#prewalk = options.prewalk;
		this.#planYolo = options.planYolo;
	}

	/** Current prewalk target, if the one-way switch remains armed. */
	get state(): Prewalk | undefined {
		return this.#prewalk;
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
		this.#planInjected = false;
		this.#continuePending = false;
		this.#todoSeen = false;
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
		await this.#host.setModelTemporary(target, prewalk.thinkingLevel, { ephemeral: true });
		this.#clearPrewalkState();
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

	/** Arms a prewalk immediately for an explicit slash-command request. */
	arm(target: Model, thinkingLevel?: ConfiguredThinkingLevel): boolean {
		const active = this.#prewalk;
		if (active) {
			this.#host.emitNotice(
				"info",
				`Prewalk: already armed for ${active.target.provider}/${active.target.id}, waiting for the first edit/write.`,
				"prewalk",
			);
			return (
				active.target.provider === target.provider &&
				active.target.id === target.id &&
				active.thinkingLevel === thinkingLevel
			);
		}
		const candidate = { target, thinkingLevel };
		if (this.#isNoop(candidate)) {
			this.#disarmNoop(candidate);
			return false;
		}
		this.#prewalk = candidate;
		this.#planInjected = true;
		this.#continuePending = true;
		this.#todoSeen = false;
		this.#host.agent.steer({
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: prewalkPlanPrompt,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.emitNotice(
			"info",
			`Prewalk: armed for ${target.provider}/${target.id} — will switch at the first edit/write once the todo list exists.`,
			"prewalk",
		);
		return true;
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
		const augmentations = this.#host.hasBuiltInTool("write") ? ["write"] : [];
		try {
			await this.#host.setActiveToolsByName([...new Set([...previousEnabledTools, ...augmentations])]);
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

	#scrubPlanNudge(liveMessages: AgentMessage[]): void {
		if (!this.#planInjected) return;
		const isPlanNudge = isPrewalkPlanNudge;
		for (let index = liveMessages.length - 1; index >= 0; index--) {
			if (!isPlanNudge(liveMessages[index])) continue;
			invalidateMessageCache(liveMessages[index]);
			liveMessages.splice(index, 1);
		}
		const stateMessages = this.#host.agent.state.messages;
		const filtered = stateMessages.filter(message => !isPlanNudge(message));
		if (filtered.length !== stateMessages.length) this.#host.agent.replaceMessages(filtered);
	}

	async #finalizePlanYoloProposal(title: string): Promise<AgentToolResult<unknown>> {
		const planYolo = this.#planYolo;
		const state = this.#host.getPlanModeState();
		if (!planYolo || !state?.enabled) throw new ToolError("Plan mode is not active.");
		const { planFilePath, title: resolvedTitle } = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url =>
				readPlanFile(url, {
					localProtocolOptions: this.#host.localProtocolOptions(),
					cwd: this.#host.sessionManager.getCwd(),
				}),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: this.#host.localProtocolOptions() }),
		});
		this.#host.setPlanModeState(undefined);
		const previousPresentation = this.#planYoloPreviousNonMCPPresentation;
		try {
			if (previousPresentation) {
				await this.#host.runToolRegistryMutation(async () => {
					const liveMCP = this.#host.getSelectedMCPToolNames();
					const liveMountedMCP = this.#host.getMountedXdevToolNames().filter(isMCPToolName);
					await this.#host.setActiveToolPresentation(
						[...new Set([...previousPresentation.enabled, ...liveMCP])],
						[...new Set([...previousPresentation.mounted, ...liveMountedMCP])],
					);
				});
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
