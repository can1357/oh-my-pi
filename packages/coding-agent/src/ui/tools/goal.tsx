/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Goal: `Goal set "objective" budget 50K` for calls; results show the goal's
 * status, its objective, its token/time usage and a completion report.
 *
 * Terminal look: `goal` (`src/ui/styles/tools/goal.ts`): one line while
 * pending, then a card on the status background.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** Goal args. */
export interface GoalArgs {
	readonly op?: string;
	readonly objective?: string;
	readonly token_budget?: number;
}

/** A goal as results report it. */
export interface GoalState {
	readonly objective?: string;
	readonly status?: string;
	readonly tokensUsed?: number;
	readonly timeUsedSeconds?: number;
	readonly tokenBudget?: number;
}

/** Goal result details. */
export interface GoalDetails {
	readonly op?: string;
	readonly goal?: GoalState | null;
	readonly completionBudgetReport?: string;
}

/** Terminal facts of the `goal` look. */
export type GoalTerm = {
	readonly look: "goal";
	readonly result?: boolean;
	/** `set`, `check`, `complete`. */
	readonly op: string;
	readonly objective?: string;
	/** `budget 50K`. */
	readonly budget?: string;
	readonly status?: string;
	/** Status span style (`warning strong`). */
	readonly statusStyle?: string;
	readonly usage?: string;
	readonly report?: string;
	readonly empty?: string;
	readonly error?: string;
};

const OP_LABELS: Readonly<Record<string, string>> = {
	create: "set",
	get: "check",
};
const STATUS_STYLE: Readonly<Record<string, string>> = {
	active: "accent strong",
	complete: "success strong",
	paused: "muted strong",
	"budget-limited": "warning strong",
	dropped: "error strong",
};

/** `12K`, `950`, `1.5M`. */
function tokens(count: number): string {
	if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
	if (count >= 1000) return `${Math.round(count / 1000)}K`;
	return String(count);
}

/** `1m15s`, `45s`, `2h3m`. */
function duration(seconds: number): string {
	const s = Math.floor(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

function head(op: string, ...parts: (TspSpan | undefined)[]): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: "Goal" }, { t: " " }, { s: "muted", t: op }];
	for (const part of parts) if (part) spans.push({ t: " " }, part);
	return spans;
}

function opLabel(op: string | undefined): string {
	return op ? (OP_LABELS[op] ?? op) : "?";
}

/** One display line: model-written objectives can carry terminal controls and newlines. */
function objectiveText(objective: string): string {
	return replaceTabs(sanitizeText(objective)).replaceAll("\n", " ").trim();
}

export const goalPresenter: ToolPresenter<GoalArgs, GoalDetails> = {
	merge: true,
	call(args) {
		const op = opLabel(args?.op);
		const objective = args?.objective ? objectiveText(args.objective) : undefined;
		const budget = args?.token_budget !== undefined ? `budget ${tokens(args.token_budget)}` : undefined;
		return {
			label: head(
				op,
				objective ? { s: "muted", t: `"${objective}"` } : undefined,
				budget ? { s: "muted", t: budget } : undefined,
			),
			term: { look: "goal", op, objective, budget } satisfies GoalTerm,
		};
	},
	result(result, _state, args): ToolView {
		const op = opLabel(result.details?.op ?? args?.op);
		if (result.isError) {
			const message = resultText(result).trim() || "Goal tool failed";
			return {
				label: head(op),
				tone: "error",
				body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
				term: {
					look: "goal",
					result: true,
					op,
					error: message,
				} satisfies GoalTerm,
			};
		}
		const goal = result.details?.goal;
		if (!goal) {
			return {
				label: head(op, { s: "muted", t: "no active goal" }),
				tone: "warning",
				term: {
					look: "goal",
					result: true,
					op,
					empty: "no active goal",
				} satisfies GoalTerm,
			};
		}
		const status = goal.status ?? "active";
		const statusStyle = STATUS_STYLE[status] ?? "muted strong";
		const objective = objectiveText(goal.objective ?? "");
		const used = tokens(goal.tokensUsed ?? 0);
		let usage =
			goal.tokenBudget !== undefined
				? `${used} / ${tokens(goal.tokenBudget)} tokens (${tokens(Math.max(0, goal.tokenBudget - (goal.tokensUsed ?? 0)))} left)`
				: `${used} tokens`;
		if (goal.timeUsedSeconds) usage += ` · ${duration(goal.timeUsedSeconds)} elapsed`;
		const report = result.details?.completionBudgetReport;
		return {
			label: head(op, { s: statusStyle, t: status }),
			body: [
				objective ? <text spans={[{ s: "muted", t: `"${objective}"` }]} wrap="word" /> : undefined,
				<text spans={[{ s: "dim", t: usage }]} wrap="word" />,
				report ? (
					<section key="report" head={[{ s: "toolTitle", t: "Report" }]}>
						<text spans={[{ s: "muted", t: report }]} wrap="word" />
					</section>
				) : undefined,
			],
			term: {
				look: "goal",
				result: true,
				op,
				objective,
				status,
				statusStyle,
				usage,
				report,
			} satisfies GoalTerm,
		};
	},
};

registerToolPresenter("goal", goalPresenter);
