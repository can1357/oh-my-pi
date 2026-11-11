import { register } from "../config/registry";

export const cfgGoalEnabled = register({
	id: "goal.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Mode",
		description: "Enable per-session goal mode and the hidden goal tool",
	},
});

export const cfgGoalModelObjectiveUpdates = register({
	id: "goal.modelObjectiveUpdates",
	type: "enum",
	values: ["disabled", "confirm", "on-request"] as const,
	default: "disabled",
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Objective Updates",
		description: "Allow model edits to the goal objective. Token budget changes remain user-only",
		options: [
			{ value: "disabled", label: "Disabled", description: "Only the user can edit the goal objective" },
			{
				value: "confirm",
				label: "Confirm each edit",
				description: "Show the old and new objective and ask for approval before every model edit",
			},
			{
				value: "on-request",
				label: "On user request",
				description:
					"Trust the model to interpret explicit user requests to edit the objective, without another prompt",
			},
		],
	},
});

export const cfgGoalStatusInFooter = register({
	id: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Status in Footer",
		description: "Show token budget alongside the goal indicator in the status line",
	},
});

const GOAL_CONTINUATION_MODES_DEFAULT: string[] = ["interactive"];

export const cfgGoalContinuationModes = register({
	id: "goal.continuationModes",
	type: "array",
	default: GOAL_CONTINUATION_MODES_DEFAULT,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Continuation Modes",
		description: 'Run modes where active goals may auto-continue between turns ("interactive", "rpc")',
	},
});
