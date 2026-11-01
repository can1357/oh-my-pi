import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";

import { prompt, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui";

import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import goalObjectiveUpdateApproval from "../../prompts/goals/goal-objective-update-approval.md" with { type: "text" };

import type { ToolSession } from "../../tools";
import { throwIfAborted } from "../../tools/tool-errors";
import { requestApproval } from "../../tools/approval";

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

import { completionBudgetReport, type GoalRuntime, remainingTokens } from "../runtime";
import { cfgGoalEnabled, cfgGoalModelObjectiveUpdates } from "../settings";
import type { Goal, GoalToolDetails } from "@oh-my-pi/pi-tui/tools/goal";

const goalSchema = type({
	op: type("'create' | 'get' | 'update' | 'complete' | 'resume' | 'drop'").describe("goal operation"),
	"objective?": type("string").describe("goal objective"),
	"token_budget?": type("number.integer").describe("token budget"),
});

export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: remainingTokens(resolvedGoal),
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(resolvedGoal)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string; tokenBudget?: number } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("objective is required when op=create");
	}
	const tokenBudget = params.token_budget;
	if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new ToolError("token_budget must be a positive integer when provided");
	}
	return { objective, tokenBudget };
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	/** Goal ops touch only session state: `get` reads it; the rest change the goal, so `always-ask` still prompts. */
	readonly approval = (args: unknown): ToolTier =>
		args !== null && typeof args === "object" && "op" in args && args.op === "get" ? "read" : "write";
	readonly label = "Goal";
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async #updateObjective(
		runtime: GoalRuntime,
		params: GoalToolInput,
		signal: AbortSignal | undefined,
		context: AgentToolContext | undefined,
	): Promise<Goal> {
		throwIfAborted(signal);
		const mode = cfgGoalModelObjectiveUpdates.get(this.#session.settings);

		if (mode === "disabled") {
			throw new ToolError(
				"Model objective edits are disabled (goal.modelObjectiveUpdates). Ask the user to edit the goal.",
			);
		}

		if (params.token_budget !== undefined) {
			throw new ToolError("op=update cannot change the token budget. Ask the user to use /goal budget.");
		}

		const objective = params.objective?.trim();

		if (!objective) throw new ToolError("objective is required when op=update");
		const state = this.#session.getGoalModeState?.();

		if (!state?.enabled || (state.goal.status !== "active" && state.goal.status !== "budget-limited")) {
			throw new ToolError("cannot update objective because no goal is active");
		}

		const expectedGoalId = state.goal.id;
		const expectedObjective = state.goal.objective;
		const sessionId = this.#session.getSessionId?.();

		if (mode === "confirm") {
			const toolContext = context ?? this.#session.getToolContext?.();

			if (!toolContext?.ui?.approve || toolContext.hasUI === false) {
				throw new ToolError("Objective edits require user approval, but no interactive approval UI is available.");
			}

			const ui = toolContext.ui;
			const approve = toolContext.ui.approve.bind(ui);

			const details = prompt.render(goalObjectiveUpdateApproval, {
				currentObjective: replaceTabs(sanitizeText(expectedObjective)),
				proposedObjective: replaceTabs(sanitizeText(objective)),
			});

			const approved = await untilAborted(signal, () =>
				requestApproval(
					{
						approve: proposal => approve(proposal, { signal }),
					},
					{ name: this.name, approval: "write", formatApprovalDetails: () => [details] },
					params,
					{ reason: "Update goal objective" },
				),
			);

			if (approved !== "once") {
				throw new ToolError("Goal objective update was not approved. The objective is unchanged.");
			}
		}

		const updated = await runtime.updateGoalObjective({ objective, expectedGoalId, expectedObjective }, () => {
			throwIfAborted(signal);

			if (
				!cfgGoalEnabled.get(this.#session.settings) ||
				cfgGoalModelObjectiveUpdates.get(this.#session.settings) !== mode ||
				this.#session.getSessionId?.() !== sessionId
			) {
				throw new ToolError("Goal editing permissions or session changed. Request the edit again.");
			}
		});

		return updated.goal;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) {
			throw new ToolError("Goal mode is not active.");
		}

		let response: GoalToolResponse;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateCreateParams(params));
			response = buildGoalToolResponse(created.goal);
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null);
		} else if (params.op === "update") {
			response = buildGoalToolResponse(await this.#updateObjective(runtime, params, signal, context));
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal);
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null);
		} else {
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true });
		}
		let text: string;
		if (response.goal) {
			text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
			if (response.goal.tokenBudget !== undefined) {
				text += ` / ${response.goal.tokenBudget} budget`;
			}
			if (response.remainingTokens !== null) {
				text += `\nRemaining tokens: ${response.remainingTokens}`;
			}
			if (response.completionBudgetReport) {
				text += `\n\n${response.completionBudgetReport}`;
			}
		} else {
			text = "No active goal.";
		}

		if (params.op === "get") {
			text += `\nObjective editing: ${cfgGoalModelObjectiveUpdates.get(this.#session.settings)}`;
		}
		return {
			content: [{ type: "text", text }],
			details: {
				op: params.op,
				goal: response.goal,
				remainingTokens: response.remainingTokens,
				completionBudgetReport: response.completionBudgetReport,
			},
		};
	}
}
