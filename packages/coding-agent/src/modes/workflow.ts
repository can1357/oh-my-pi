import { prompt } from "@oh-my-pi/pi-utils";
import workflowNoticeTemplate from "../prompts/system/workflow-notice.md" with { type: "text" };

/** WORKFLOW_NOTICE is the default hidden notice for sessions with batched task calls enabled. */
export const WORKFLOW_NOTICE: string = renderWorkflowNotice({ taskBatch: true });

/** renderWorkflowNotice renders the workflow notice for the active task schema. */
export function renderWorkflowNotice({
	taskBatch,
	scoutAvailable,
	evalTools,
}: {
	taskBatch: boolean;
	scoutAvailable?: boolean;
	/** Advertise `@tool`-defined tools for subagents (`eval.tools.enabled`). */
	evalTools?: boolean;
}): string {
	return prompt
		.render(workflowNoticeTemplate, {
			taskBatch,
			scoutAvailable: scoutAvailable ?? true,
			evalTools: evalTools ?? true,
		})
		.trim();
}
