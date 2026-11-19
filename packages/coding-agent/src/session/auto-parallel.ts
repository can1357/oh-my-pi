/**
 * Session side of `task.autoParallel`. {@link AutoParallelCoordinator.start} judges a new top-level
 * prompt alongside the rest of prompt setup; {@link AutoParallelCoordinator.apply} runs right before
 * dispatch and reports the split (`suggest`) or returns it as a hidden delegation hint for the
 * caller to deliver with the prompt (`on`). See `auto-parallel/planner.ts` for how prompts split.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ParallelPlan } from "../auto-parallel/planner";
import type { Settings } from "../config/settings";
import autoParallelPrompt from "../prompts/system/auto-parallel.md" with { type: "text" };
import { cfgTaskAutoParallel } from "../task/settings";
import { toolWireName } from "../tools/builtin-names";

/** Custom message type of the hidden delegation hint. */
export const AUTO_PARALLEL_MESSAGE_TYPE = "auto-parallel-plan";

/** Widest subtask preview in a `suggest` notice. */
const NOTICE_PREVIEW_WIDTH = 40;

/** Capabilities the coordinator borrows from its owning session. */
export interface AutoParallelHost {
	settings: Settings;
	planModeEnabled(): boolean;
	getEnabledToolNames(): string[];
	toolRegistry(): Map<string, AgentTool>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	/** Plans `request` with the session's judge ({@link planParallel}). */
	planParallel(request: string, signal: AbortSignal): Promise<ParallelPlan | undefined>;
}

/** One line per subtask's first item, cut to {@link NOTICE_PREVIEW_WIDTH}, `+N` for the items after it. */
function describe(plan: ParallelPlan): string {
	if (plan.subtasks.length < 2) return "no split";
	const previews = plan.subtasks.map(([first, ...rest]) => {
		const head = truncateToWidth(replaceTabs(plan.items[first].split("\n", 1)[0]), NOTICE_PREVIEW_WIDTH);
		return rest.length > 0 ? `${head} +${rest.length}` : head;
	});
	return `${plan.subtasks.length} subtasks: ${previews.join(" | ")}`;
}

/** Judges new top-level prompts for `task.autoParallel` and turns a split into a delegation hint. */
export class AutoParallelCoordinator {
	readonly #host: AutoParallelHost;

	constructor(host: AutoParallelHost) {
		this.#host = host;
	}

	/** Effective mode: plan mode, or no task tool to delegate with, turns it off. */
	#mode(): "off" | "suggest" | "on" {
		if (this.#host.planModeEnabled() || !this.#host.getEnabledToolNames().includes("task")) return "off";
		return cfgTaskAutoParallel.get(this.#host.settings);
	}

	/**
	 * Starts judging a new prompt; undefined when auto-parallel is off for this turn.
	 * Never rejects: a failed judgment resolves undefined, so the turn proceeds as if auto-parallel were off.
	 */
	start(request: string, signal: AbortSignal): Promise<ParallelPlan | undefined> | undefined {
		if (this.#mode() === "off") return undefined;
		return this.#host.planParallel(request, signal).catch(error => {
			logger.debug("auto-parallel: skipped after a failure", {
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		});
	}

	/**
	 * Applies `plan` right before its prompt is dispatched. `suggest` reports it; under `on`, a split into two or
	 * more subtasks returns the hint for the caller to deliver with the prompt.
	 */
	apply(plan: ParallelPlan | undefined): AgentMessage | undefined {
		const mode = this.#mode();
		if (!plan || mode === "off") return undefined;
		if (mode === "suggest") {
			this.#host.emitNotice("info", `Auto-parallel: ${describe(plan)}`, "task");
			return undefined;
		}
		if (plan.subtasks.length < 2) {
			logger.debug("auto-parallel: no split", { items: plan.items.length });
			return undefined;
		}
		const text = (items: readonly number[]) => items.map(item => plan.items[item]);
		return {
			role: "custom",
			customType: AUTO_PARALLEL_MESSAGE_TYPE,
			content: prompt.render(autoParallelPrompt, {
				subtasks: plan.subtasks.map(text),
				context: text(plan.context),
				wrapup: text(plan.wrapup),
				taskTool: toolWireName(this.#host.toolRegistry(), "task"),
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}
