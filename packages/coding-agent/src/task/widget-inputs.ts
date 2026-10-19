/**
 * What a background `task` job offers its live widget (see
 * `job-widgets/types.ts`): the subagent's finished tool calls as the `tools`
 * source, every source of the jobs the subagent itself started re-exposed as
 * `<jobId>:<sourceId>`, and a brief read live from the job's progress.
 */
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { AsyncJobManager } from "../async/job-manager";
import type { TextTap } from "../job-widgets/text-tap";
import {
	type JobTextChunk,
	type JobTextSource,
	type JobWidgetBrief,
	type JobWidgetInputs,
	TOOL_CALL_MARK,
} from "../job-widgets/types";
import type { SubagentToolResult } from "./executor";

/** Label of the `tools` source (`TOOLS_SOURCE_ID` in `job-widgets/types`), for the widget author. */
export const TOOLS_SOURCE_LABEL = `subagent tool calls: \`${TOOL_CALL_MARK}<tool> <intent>\` (omp's marker) then the result text`;
/** Most of one tool result kept in the tap: its last 64 Ki characters. */
const MAX_TOOL_RESULT_CHARS = 64 * 1024;

/** Append one finished subagent tool call to a task job's `tools` tap: `\n» <tool> <intent>\n<result>\n`. */
export function appendToolResult(tap: TextTap, result: SubagentToolResult): void {
	const head = result.intent ? `${result.tool} ${result.intent}` : result.tool;
	const text = result.text.length > MAX_TOOL_RESULT_CHARS ? result.text.slice(-MAX_TOOL_RESULT_CHARS) : result.text;
	tap.append(`\n${TOOL_CALL_MARK}${head}\n${text}\n`);
}

/** A child job's source under the task job's namespace: `<jobId>:<sourceId>`. */
class ChildJobSource implements JobTextSource {
	readonly id: string;
	readonly label: string;

	constructor(
		jobId: string,
		readonly source: JobTextSource,
	) {
		this.id = `${jobId}:${source.id}`;
		this.label = `${jobId} ${source.label}`;
	}

	read(from: number): JobTextChunk {
		return this.source.read(from);
	}
}

/** Inputs for {@link createTaskWidgetInputs}. */
export interface TaskWidgetInputsOptions {
	/** The root's shared manager, where the subagent's own jobs are registered. */
	manager: AsyncJobManager;
	/** Registry id of the subagent: the `ownerId` of the jobs it starts. */
	agentId: string;
	/** The run's tool tap, once the run exists; a queued job has none yet. */
	tools: () => TextTap | undefined;
	/** The job's live progress record (stage, watch and assignment are read from it on every call). */
	progress: AgentProgress;
	/** The parent's intent line on the `task` call that started the job. */
	intent?: string;
}

/** Widget inputs of one background `task` job; see the module doc. */
export function createTaskWidgetInputs(options: TaskWidgetInputsOptions): JobWidgetInputs {
	const { manager, agentId, progress, intent } = options;
	// Re-exposed sources keep their identity across calls while the child job
	// still offers the same source object, so readers see one stable source.
	const children = new Map<string, ChildJobSource>();
	return {
		sources: () => {
			const sources: JobTextSource[] = [];
			const tools = options.tools();
			if (tools) sources.push(tools);
			const live = new Set<string>();
			for (const job of manager.getAllJobs({ ownerId: agentId })) {
				const inputs = job.widgetInputs;
				if (!inputs) continue;
				for (const source of inputs.sources()) {
					const id = `${job.id}:${source.id}`;
					let child = children.get(id);
					if (child?.source !== source) {
						child = new ChildJobSource(job.id, source);
						children.set(id, child);
					}
					live.add(id);
					sources.push(child);
				}
			}
			for (const id of children.keys()) {
				if (!live.has(id)) children.delete(id);
			}
			return sources;
		},
		brief: (): JobWidgetBrief => ({
			kind: "task",
			task: progress.assignment ?? progress.task,
			...(intent ? { intent } : {}),
			...(progress.watch ? { watch: progress.watch } : {}),
			...(progress.stage ? { stage: progress.stage } : {}),
		}),
	};
}
