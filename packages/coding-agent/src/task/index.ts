import { subprocessToolRegistry } from "./subprocess-tool-registry";
import { isTaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { taskSubprocessRenderer } from "@oh-my-pi/pi-tui/tools/subprocess";
/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolSpeculationPolicy,
} from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { $env, hasFsCode, isRecord, logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { Settings } from "../config/settings";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import taskDescriptionTemplate from "../prompts/tools/task.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskCoordinationAdvisoryTemplate from "../prompts/tools/task-coordination-advisory.md" with { type: "text" };
import taskSpawnFeedbackTemplate from "../prompts/tools/task-spawn-feedback.md" with { type: "text" };
import taskSpecializationAdvisoryTemplate from "../prompts/tools/task-specialization-advisory.md" with { type: "text" };
import taskFollowUpTemplate from "../prompts/tools/task-follow-up.md" with { type: "text" };
import taskYieldTemplate from "../prompts/tools/task-yield.md" with { type: "text" };
import { TASK_EFFORTS, type TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import { truncateForPrompt } from "../tools/approval";
import { hasWaitTool } from "../tools/wait";
import { isIrcEnabled } from "../irc/messaging";
import { isReadOnlyAgent } from "./read-only-policy";
import { formatTaskResultSummary } from "./result-summary";
import { isScoutSpawnable, type ResolvedSpawnPolicy, resolveSpawnPolicy } from "./spawn-policy";
import { isBundledSeance, seanceTaskGuidance, seanceTaskSchemaFields, validateSeanceParams } from "./seance";
import { SEANCE_AGENT_NAME } from "./seance-policy";
import {
	type AgentDefinition,
	canSpawnAtDepth,
	getTaskSchema,
	MAX_TASK_FILE_BYTES,
	type TaskToolSchemaInstance,
} from "./types";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { AsyncJobError, type AsyncJobManagerApi } from "../async";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { sessionResolveContext } from "../internal-urls/context";
import { InternalUrlRouter } from "../internal-urls/router";
import { AgentRegistry, isResumable, MAIN_AGENT_ID } from "../registry/agent-registry";
import { type DiscoveryResult, discoverAgents } from "./discovery";
import { createEvalCustomTools, describeEvalTools, evalToolsEnabled } from "./eval-tools";
import {
	approvedTaskFile,
	bindTaskFileApproval,
	taskFileApprovalPath,
	taskFileMatchesApproval,
	taskFileRestrictionPaths,
} from "./file-approval";
import { getPerCallModelAdvertisement, type PerCallModelAdvertisement } from "./model-approval";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "@oh-my-pi/pi-tui/tools/task";
import { repairTaskParams } from "@oh-my-pi/pi-tui/tools/task-repair-args";
import {
	invalidModelSelectorReason,
	renderSubagentUserPrompt,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "./structured-subagent";
import { SpawnRun, type SpawnPermit } from "./spawn-run";
import { type TaskLauncher, TaskLaunchSession } from "./speculative-launch";
import type { TextTap } from "../job-widgets/text-tap";
import type { SubagentToolResult } from "./executor";
import { appendToolResult, createTaskWidgetInputs } from "./widget-inputs";

import { cfgAsyncEnabled } from "../tools/settings";
import {
	cfgTaskBatch,
	cfgTaskDisabledAgents,
	cfgTaskEnableEffort,
	cfgTaskEnableLsp,
	cfgTaskFile,
	cfgTaskIsolationApply,
	cfgTaskIsolationEnabled,
	cfgTaskMaxConcurrency,
	cfgTaskMaxRecursionDepth,
	cfgTaskMaxRuntimeMs,
	cfgTaskSpeculativeLaunch,
	cfgTaskStructured,
	perCallModelEnabled,
} from "./settings";

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export type { AgentDefinition, SubagentEventPayload, SubagentLifecyclePayload, SubagentProgressPayload } from "./types";
export type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
export * from "./result-summary";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

interface TaskDescriptionOptions {
	agents: AgentDefinition[];
	sessionAgents: readonly AgentDefinition[];
	isolationEnabled: boolean;
	applyIsolatedChanges: boolean;
	disabledAgents: string[];
	batchEnabled: boolean;
	effortEnabled: boolean;
	perCallModelEnabled: boolean;
	perCallModelAdvertisement?: PerCallModelAdvertisement;
	evalToolsEnabled: boolean;
	structured: boolean;
	file: boolean;
	asyncEnabled: boolean;
	ircEnabled: boolean;
	planMode: boolean;
	asyncGuidance: string;
	parentSpawns: string;
}

/** Plan mode hides seance; a `spawns` list led by it defaults to the next permitted agent. */
function defaultAgentFor(spawnPolicy: ResolvedSpawnPolicy, planMode: boolean): string {
	if (!planMode || spawnPolicy.defaultAgent !== SEANCE_AGENT_NAME) return spawnPolicy.defaultAgent;
	return spawnPolicy.allowedAgents?.find(agent => agent !== SEANCE_AGENT_NAME) ?? spawnPolicy.defaultAgent;
}

/** Render the tool description from a cached agent list and current settings. */
function renderDescription(options: TaskDescriptionOptions): string {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns);
	const spawningDisabled = !spawnPolicy.enabled;
	const agents = [...options.agents, ...options.sessionAgents];
	let filteredAgents =
		options.disabledAgents.length > 0 ? agents.filter(agent => !options.disabledAgents.includes(agent.name)) : agents;
	if (spawningDisabled) {
		filteredAgents = [];
	} else if (spawnPolicy.allowedAgents !== null) {
		const allowed = new Set(spawnPolicy.allowedAgents);
		filteredAgents = filteredAgents.filter(agent => allowed.has(agent.name));
	}
	if (options.planMode) {
		filteredAgents = filteredAgents.filter(agent => !isBundledSeance(agent));
	}
	const renderedAgents = filteredAgents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
		// Marked only while `task.structured` is off; with it on, every agent's result is structured.
		structured: !options.structured && agent.structured === true,
	}));
	const seanceAgent = filteredAgents.find(agent => agent.name === SEANCE_AGENT_NAME);
	const scoutAvailable = isScoutSpawnable(options.disabledAgents, options.parentSpawns);
	return prompt.render(taskDescriptionTemplate, {
		agents: renderedAgents,
		scoutAvailable,
		spawningDisabled,
		defaultAgent: defaultAgentFor(spawnPolicy, options.planMode),
		isolationEnabled: options.isolationEnabled,
		applyIsolatedChanges: options.applyIsolatedChanges,
		batchEnabled: options.batchEnabled,
		effortEnabled: options.effortEnabled,
		perCallModelEnabled: options.perCallModelEnabled,
		perCallModelAdvertisement: options.perCallModelAdvertisement,
		evalToolsEnabled: options.evalToolsEnabled,
		structured: options.structured,
		file: options.file,
		asyncEnabled: options.asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		hasStructuredAgents: renderedAgents.some(agent => agent.structured),
		hasModelMentions: options.sessionAgents.length > 0,
		seanceGuidance: seanceAgent && isBundledSeance(seanceAgent) ? seanceTaskGuidance : "",
		ircEnabled: options.ircEnabled,
		asyncGuidance: options.asyncGuidance,
	});
}
function createTaskModeError(text: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		isError: true,
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Reject legacy fields and shape/configuration combinations the current tool
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` remains an eval-only alias and is rejected.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if (Object.hasOwn(params, "schema")) {
		return "The task tool uses `outputSchema`; rename the stale `schema` field.";
	}
	if (batchEnabled && params.tasks !== undefined && Object.hasOwn(params, "agent")) {
		return "Top-level `agent` is not part of the batch shape. Set `tasks[].agent` instead.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with one task source per item and unique names, `context`
 * non-empty, no top-level `task` or `taskFile` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
}

function validateTaskInput(item: TaskItem | undefined, label: string, fileEnabled: boolean): string | undefined {
	const hasTask = item?.task !== undefined;
	const hasTaskFile = item?.taskFile !== undefined;
	if (!fileEnabled) {
		if (typeof item?.task !== "string" || item.task.trim() === "") {
			return label === "The call"
				? "Missing `task`. Provide complete, self-contained instructions for the agent."
				: `${label} is missing \`task\`. Every task needs complete, self-contained instructions.`;
		}
		return undefined;
	}
	if (hasTask === hasTaskFile) {
		return `${label} must provide exactly one of \`task\` or \`taskFile\`.`;
	}
	if (hasTask && (typeof item?.task !== "string" || item.task.trim() === "")) {
		return `${label} needs non-empty, self-contained \`task\` instructions.`;
	}
	if (
		hasTaskFile &&
		(typeof item?.taskFile !== "string" || (!path.isAbsolute(item.taskFile) && !item.taskFile.startsWith("local://")))
	) {
		return `${label} \`taskFile\` must be an absolute path or local:// URL to a UTF-8 file.`;
	}
	return undefined;
}

function validateSpawnParams(
	params: TaskParams,
	batchEnabled: boolean,
	fileEnabled: boolean,
	defaultAgent: string,
	settings: Settings,
): string | undefined {
	const tasks = params.tasks;
	if (
		!fileEnabled &&
		(params.taskFile !== undefined || (Array.isArray(tasks) && tasks.some(item => item?.taskFile !== undefined)))
	) {
		return "task.file is disabled, so the task tool does not accept `taskFile`.";
	}
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item with `task` or `taskFile`.";
		}
		if (params.task !== undefined || params.taskFile !== undefined) {
			return "Top-level `task` or `taskFile` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			const label = `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""}`;
			const inputError = validateTaskInput(item, label, fileEnabled);
			if (inputError) return inputError;
			const effortError = validateEffort(item.effort, label);
			if (effortError) return effortError;
			const modelError = validateModel(item, label, defaultAgent, settings);
			if (modelError) return modelError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (batchEnabled && params.task === undefined && params.taskFile === undefined) {
		return "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`.";
	}
	return (
		validateTaskInput(params, "The call", fileEnabled) ??
		validateEffort(params.effort, "The call") ??
		validateModel(params, "The call", defaultAgent, settings)
	);
}

/**
 * A `model` on a call naming `seance` is checked at preflight, once the name resolves:
 * the bundled seance takes it as its source-session override, a shadowing agent as a per-call model.
 */
function validateModel(
	item: TaskItem | TaskParams,
	label: string,
	defaultAgent: string,
	settings: Settings,
): string | undefined {
	return (item.agent?.trim() || defaultAgent) === SEANCE_AGENT_NAME
		? undefined
		: invalidModelSelectorReason(item.model, label, { settings, invocationKind: "task" });
}

function spawnModelFields(params: TaskParams): Pick<StructuredSubagentRequest, "perCallModel" | "seanceModel"> {
	if (params.model === undefined) return {};
	if (params.agent === SEANCE_AGENT_NAME) return { seanceModel: params.model };
	// `validateModel` rejected anything but one string before dispatch.
	return typeof params.model === "string" ? { perCallModel: params.model } : {};
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task, taskFile: params.taskFile };
	if ("solutionSpace" in params) item.solutionSpace = params.solutionSpace;
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("tools" in params) item.tools = params.tools;
	if ("effort" in params) item.effort = params.effort;
	if ("isolated" in params) item.isolated = params.isolated;
	if ("sourceSession" in params) item.sourceSession = params.sourceSession;
	if ("model" in params) item.model = params.model;
	return [item];
}

interface ResolvedTaskItem extends TaskItem {
	taskFileSha256?: string;
}

interface SpawnParams extends TaskParams {
	taskFileSha256?: string;
}

function submittedTaskFiles(args: unknown): string[] {
	if (!isRecord(args)) return [];
	const items = Array.isArray(args.tasks) ? args.tasks : [args];
	return items.flatMap(item => (isRecord(item) && typeof item.taskFile === "string" ? [item.taskFile] : []));
}

/** The filesystem path a `taskFile` names; approval and dispatch share it so both see the same file. */
function taskFilePath(session: ToolSession, taskFile: string): string | undefined {
	return taskFile.startsWith("local://")
		? InternalUrlRouter.instance().locateSync(taskFile, sessionResolveContext(session))
		: taskFile;
}

async function resolveTaskFile(owner: object, session: ToolSession, item: TaskItem): Promise<ResolvedTaskItem> {
	if (item.taskFile === undefined) return item;
	try {
		const approved = approvedTaskFile(owner, item.taskFile);
		const filePath = approved?.path ?? taskFilePath(session, item.taskFile);
		if (filePath === undefined) throw new Error("does not resolve to a local file");
		// On POSIX, a non-blocking open lets fstat reject a FIFO without waiting for a writer.
		const file = await fs
			.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (approved ? fs.constants.O_NOFOLLOW : 0))
			.catch(error => {
				if (approved && (hasFsCode(error, "ELOOP") || hasFsCode(error, "ENOENT") || hasFsCode(error, "ENOTDIR"))) {
					throw new Error("changed after approval; retry the call");
				}
				throw error;
			});
		try {
			const stat = await file.stat({ bigint: true });
			if (approved && !taskFileMatchesApproval(stat, approved)) {
				throw new Error("changed after approval; retry the call");
			}
			if (!stat.isFile()) throw new Error("must resolve to a regular file");
			const bytes = await Bun.file(file.fd)
				.slice(0, MAX_TASK_FILE_BYTES + 1)
				.bytes();
			if (bytes.byteLength > MAX_TASK_FILE_BYTES) throw new Error("exceeds the 4 MiB limit");
			let task: string;
			try {
				task = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			} catch {
				throw new Error("contains invalid UTF-8");
			}
			if (!task.trim()) throw new Error("must contain non-empty task instructions");
			return { ...item, task, taskFileSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
		} finally {
			await file.close();
		}
	} catch (error) {
		throw new Error(
			`taskFile ${JSON.stringify(item.taskFile)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: ResolvedTaskItem, defaultAgent: string): SpawnParams {
	const spawn: SpawnParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (item.taskFile !== undefined) spawn.taskFile = item.taskFile;
	if (item.taskFileSha256 !== undefined) spawn.taskFileSha256 = item.taskFileSha256;
	if (item.solutionSpace !== undefined) spawn.solutionSpace = item.solutionSpace;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("tools" in item) spawn.tools = item.tools;
	if ("effort" in item) spawn.effort = item.effort;
	if ("sourceSession" in item) spawn.sourceSession = item.sourceSession;
	if ("model" in item) spawn.model = item.model;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** A validated call's spawn list: its items and the per-spawn params each run receives. */
interface SpawnPlan {
	params: TaskParams;
	items: TaskItem[];
	spawns: TaskParams[];
}

/**
 * Repair, validate, and normalize a call into its spawns. Returns the
 * validation error the call reports instead when the shape is rejected. Shared
 * by dispatch and the speculative launcher so both derive identical spawns.
 */
function planSpawns(
	rawParams: unknown,
	batchEnabled: boolean,
	fileEnabled: boolean,
	defaultAgent: string,
	seanceAdvertised: boolean,
	settings: Settings,
): SpawnPlan | string {
	const params = repairTaskParams(rawParams as TaskParams);
	const error =
		validateShapeParams(batchEnabled, params) ??
		validateSpawnParams(params, batchEnabled, fileEnabled, defaultAgent, settings) ??
		validateSeanceParams({ params, batchEnabled, defaultAgent, seanceAdvertised });
	if (error) return error;
	const items = resolveSpawnItems(params);
	return { params, items, spawns: items.map(item => spawnParamsFor(params, item, defaultAgent)) };
}

/**
 * One sync-executed spawn: its item, position in the original call, and a run
 * already started speculatively.
 */
interface SyncSpawnRef {
	item: ResolvedTaskItem;
	index: number;
	run?: SpawnRun;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
	/** Some spawn returned an error result. */
	isError: boolean;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line. An
 * error payload from any spawn makes the merged view an error too, the way a
 * one-spawn call returns that payload as is.
 */
function mergeSyncPayloads(
	spawns: readonly Pick<SyncSpawnRef, "item" | "index">[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	let isError = false;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		isError ||= payload.isError === true;
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
		isError,
	};
}

/** A sync fan-out's merged payloads as the one tool result the call returns. */
function syncFanoutResult(merged: MergedSyncPayloads, startTime: number): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
		...(merged.isError ? { isError: true } : {}),
		details: {
			projectAgentsDir: merged.projectAgentsDir,
			results: merged.results,
			totalDurationMs: Date.now() - startTime,
			usage: merged.usage,
			outputPaths: merged.outputPaths,
		},
	};
}

/** The payload of a spawn that failed outside its run (it never produced a result of its own). */
function spawnFailurePayload(item: TaskItem, index: number, message: string): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text: `Task ${item.name?.trim() || `#${index + 1}`} failed: ${message}` }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/** One spawn of a call that async jobs host. */
interface JobSpawn {
	agentId: string;
	item: ResolvedTaskItem;
	index: number;
	/** Its agent type declares `blocking: true`: the call waits on it until it settles or a message arrives. */
	blocking: boolean;
	run: SpawnRun | undefined;
	progress: AgentProgress;
	/** Set once its job is registered. */
	jobId?: string;
	/** Settles (never rejects) once its job has run its last progress report. */
	jobDone?: Promise<void>;
	/** Runs as a background job: an ordinary item, or a blocking item the call handed off. */
	background: boolean;
	/** Its job reported an outcome, `failed` with it; a schedule failure counts as a failed one. */
	settled: boolean;
	failed: boolean;
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	return prompt
		.render(taskSpecializationAdvisoryTemplate, {
			count: generics.length,
			agent: generics[0],
			scoutAvailable,
		})
		.trim();
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * peer messages when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return prompt.render(taskCoordinationAdvisoryTemplate, { count: items.length }).trim();
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends AsyncJobError {}

/**
 * Process-level create-time discovery memo and published reload snapshots,
 * keyed by resolved cwd plus the exact effective `extensions` array.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process. Sessions
 * may share a cwd while carrying different overlay/runtime extension settings,
 * so cwd alone is not an isolation boundary. Explicit plugin reloads replace
 * only the matching cwd+extensions snapshot. Execution-time discovery
 * (`#runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * both caches automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
const discoverySnapshots = new Map<string, AgentDefinition[]>();
let discoveryMemoFn: typeof discoverAgents | undefined;

/** Stable cache identity for the filesystem root and the full effective extension-root struct. */
function discoveryCacheKey(cwd: string, extensionRoots?: EffectiveExtensionRoots): string {
	return `${path.resolve(cwd)}\0${JSON.stringify(extensionRoots ?? null)}`;
}

function discoverAgentsForCreate(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
		discoverySnapshots.clear();
	}
	const key = discoveryCacheKey(cwd, extensionRoots);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd, undefined, extensionRoots);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

/** Rescan one cwd and publish its definitions to existing and future task tools. */
export async function refreshAgentDiscovery(cwd: string, extensionRoots?: EffectiveExtensionRoots): Promise<void> {
	const key = discoveryCacheKey(cwd, extensionRoots);
	discoveryMemo.delete(key);
	const pending = discoverAgentsForCreate(cwd, extensionRoots);
	const { agents } = await pending;
	if (discoveryMemo.get(key) === pending) {
		discoverySnapshots.set(key, agents);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one subagent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs: a
 * `blocking: true` agent's job holds the call until it settles or a message
 * arrives, which hands it to the background. When disabled, the tool blocks
 * until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme> {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly bindApprovalTargets = (args: unknown): void => {
		bindTaskFileApproval(this, submittedTaskFiles(args), taskFile => taskFilePath(this.session, taskFile));
	};
	// Restricted folders cover task files, but approvals are never remembered per file: the grant would
	// cover whatever the path holds later, and inline items in the same batch.
	readonly approvalRestrictionPaths = (args: unknown): readonly string[] | undefined => {
		return taskFileRestrictionPaths(this, submittedTaskFiles(args), taskFile => taskFilePath(this.session, taskFile));
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		const formatTaskFile = (taskFile: string): string => {
			const submitted = truncateForPrompt(sanitizeText(JSON.stringify(taskFile)));
			const target = taskFileApprovalPath(this, taskFile);
			return target !== undefined && target !== taskFile
				? `${submitted} -> ${truncateForPrompt(sanitizeText(JSON.stringify(target)))}`
				: submitted;
		};
		if (typeof params.agent === "string") {
			lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
		}
		if (typeof params.name === "string" && params.name.trim()) {
			lines.push(`Name: ${truncateForPrompt(params.name)}`);
		}
		if (typeof params.model === "string") {
			lines.push(`Model: ${truncateForPrompt(params.model)}`);
		}
		if (typeof params.task === "string") {
			lines.push(`Task:\n${truncateForPrompt(params.task)}`);
		}
		if (typeof params.taskFile === "string") {
			lines.push(`Task file: ${formatTaskFile(params.taskFile)}`);
		}
		if (typeof params.context === "string" && params.context.trim()) {
			lines.push(`Context:\n${truncateForPrompt(params.context)}`);
		}
		const tasks: unknown[] = Array.isArray(params.tasks) ? params.tasks : [];
		if (tasks.length > 0) {
			const defaultAgent = this.#defaultAgent();
			const effectiveAgent = (item: unknown): string => {
				if (item && typeof item === "object" && "agent" in item) {
					const agent = item.agent;
					if (typeof agent === "string" && agent.trim()) return agent.trim();
				}
				return defaultAgent;
			};
			const agentCounts = new Map<string, number>();
			for (const item of tasks) {
				const agent = effectiveAgent(item);
				agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);
			}
			const agentSummary = [...agentCounts].map(([agent, count]) => `${agent} ×${count}`).join(", ");
			lines.push(`Batch agents: ${truncateForPrompt(agentSummary)}`);

			const firstTask = tasks[0];
			if (firstTask && typeof firstTask === "object") {
				if ("name" in firstTask && typeof firstTask.name === "string" && firstTask.name.trim()) {
					lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
				}
				lines.push(`Agent: ${truncateForPrompt(effectiveAgent(firstTask))}`);
				if ("task" in firstTask && typeof firstTask.task === "string") {
					lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
				}
			}
			for (const [index, item] of tasks.entries()) {
				if (isRecord(item) && typeof item.model === "string") {
					lines.push(`Task ${index + 1} model: ${truncateForPrompt(item.model)}`);
				}
				if (isRecord(item) && typeof item.taskFile === "string") {
					lines.push(`Task ${index + 1} file: ${formatTaskFile(item.taskFile)}`);
				}
			}
			if (tasks.length > 1) {
				lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
			}
		}
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = false;
	readonly loadMode = "essential";
	// Arktype validates model calls against the active wire schema, but the flat
	// single-spawn schema carries `"+": "delete"`: a batch `{ context, tasks[] }`
	// payload has those keys stripped, then can fail on a missing flat-form field.
	// That preempts the tool's own actionable shape checks (`validateShapeParams` /
	// `validateSpawnParams`), which never run. Lenient validation forwards the
	// raw args to `execute()` on any arktype failure so those checks surface the
	// real reason ("enable task.batch, or use the flat `task` shape"). Valid
	// calls still normalize through arktype; `execute()` resolves `agent`
	// defaults independently, so the success path is unchanged.
	readonly lenientArgValidation = true;
	readonly renderResult = renderResult;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors `taskToolRenderer`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	/**
	 * One semaphore per TaskTool instance (i.e. per session): bounds concurrent
	 * subagents across parallel `task` calls within the session. Resized in
	 * place from `task.maxConcurrency` before every acquire/release so a
	 * mid-session settings change (UI toggle, `/settings`) applies to both new
	 * spawns and work already parked in the semaphore queue.
	 */
	#spawnSemaphore: Semaphore | undefined;
	readonly #permit: SpawnPermit = {
		acquire: signal => this.#getSpawnSemaphore().acquire(signal),
		release: () => this.#releaseSpawnSemaphore(),
	};
	/** Streamed calls' speculative launches, keyed by tool-call id until dispatch adopts or discards them. */
	readonly #launchSessions = new Map<string, TaskLaunchSession>();
	/**
	 * Agent ids of job-hosted blocking spawns a call is waiting on. Their
	 * lifecycle/progress payloads report `detached: false` meanwhile, so
	 * surfaces that skip inline spawns keep skipping them; once handed to the
	 * background they report as the detached jobs they are.
	 */
	readonly #waitedOn = new Set<string>();
	readonly #launcher: TaskLauncher = {
		spawns: args => {
			const plan = planSpawns(
				args,
				this.#isBatchEnabled(),
				cfgTaskFile.get(this.session.settings),
				this.#defaultAgent(),
				this.#seanceSchemaFields() !== undefined,
				this.session.settings,
			);
			return typeof plan === "string" ? undefined : plan.spawns;
		},
		start: (toolCallId, spawn, index, signal) => this.#startSpeculative(toolCallId, spawn, index, signal),
	};

	/**
	 * Batch calls start each subagent as soon as its `tasks[]` item streams in;
	 * see `./speculative-launch` for the abort/adoption contract.
	 */
	readonly speculation: ToolSpeculationPolicy = {
		stream: {
			open: async context => {
				if (!cfgTaskSpeculativeLaunch.get(this.session.settings) || !this.#isBatchEnabled()) return undefined;
				if (!context.coordinator.authorizeLaunch) return undefined;
				const id = context.parentToolCallId;
				const session = new TaskLaunchSession({
					sink: context.coordinator,
					tool: this,
					launcher: this.#launcher,
					onClose: () => {
						if (this.#launchSessions.get(id) === session) this.#launchSessions.delete(id);
					},
				});
				this.#launchSessions.set(id, session);
				return session;
			},
		},
	};

	get parameters(): TaskToolSchemaInstance {
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = !planMode && cfgTaskIsolationEnabled.get(this.session.settings);
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: cfgTaskEnableEffort.get(this.session.settings),
			evalToolsEnabled: evalToolsEnabled(this.session),
			structured: this.#isStructured(),
			file: cfgTaskFile.get(this.session.settings),
			defaultAgent: this.#defaultAgent(),
			seanceFields: this.#seanceSchemaFields(),
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	/** Background-job lifecycle contract; inherited by extension replacements that delegate to Task. */
	get delegationGuidance(): string {
		if (!cfgAsyncEnabled.get(this.session.settings)) return "";
		return prompt.render(taskAsyncContractTemplate, {
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			waitTool: hasWaitTool(this.session),
		});
	}

	/** Dynamic description that reflects current task settings. */
	get description(): string {
		const disabledAgents = cfgTaskDisabledAgents.get(this.session.settings);
		const agents =
			discoverySnapshots.get(discoveryCacheKey(this.session.cwd, this.session.effectiveExtensionRoots?.())) ??
			this.#discoveredAgents;
		const sessionAgents = this.session.advertisedSessionAgents?.() ?? this.session.getSessionAgents?.() ?? [];
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const isolationEnabled = cfgTaskIsolationEnabled.get(this.session.settings);
		const perCallModel = perCallModelEnabled(this.session.settings, "task");
		return renderDescription({
			agents,
			sessionAgents,
			isolationEnabled: !planMode && isolationEnabled,
			applyIsolatedChanges: cfgTaskIsolationApply.get(this.session.settings),
			disabledAgents,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: cfgTaskEnableEffort.get(this.session.settings),
			perCallModelEnabled: perCallModel,
			perCallModelAdvertisement: perCallModel
				? getPerCallModelAdvertisement(
						this.session.settings,
						this.session.getActiveModel?.(),
						this.session.modelRegistry,
					)
				: undefined,
			evalToolsEnabled: evalToolsEnabled(this.session),
			structured: this.#isStructured(),
			file: cfgTaskFile.get(this.session.settings),
			asyncEnabled: cfgAsyncEnabled.get(this.session.settings),
			ircEnabled: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			planMode,
			asyncGuidance: this.delegationGuidance,
			parentSpawns: this.session.getSessionSpawns() ?? "*",
		});
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
	}

	#isBatchEnabled(): boolean {
		return cfgTaskBatch.get(this.session.settings);
	}

	#isStructured(): boolean {
		return cfgTaskStructured.get(this.session.settings);
	}

	/**
	 * Result contract for a spawn: with `task.structured` the caller's
	 * `outputSchema`/`schemaMode` pass through; without it the child gets no
	 * schema or `yield` tool and returns its final message, unless its agent
	 * declares `structured: true` (resolved in the shared subagent policy).
	 */
	#resultParams(params: TaskParams): Pick<StructuredSubagentRequest, "outputSchema" | "schemaMode" | "structured"> {
		if (!this.#isStructured()) return { structured: false };
		return {
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
		};
	}

	/**
	 * Thinking override for a spawn. `task.enableEffort` gates the caller's
	 * `effort` at runtime, not only in the advertised schema: stale transcripts
	 * and lenient argument fallbacks still deliver the field, and honoring it
	 * would override the agent's configured thinking selector.
	 */
	#effortParams(params: TaskParams): Pick<StructuredSubagentRequest, "effort"> {
		if (params.effort === undefined || !cfgTaskEnableEffort.get(this.session.settings)) return {};
		return { effort: params.effort };
	}

	#seanceSchemaFields() {
		const spawnPolicy = resolveSpawnPolicy(this.session.getSessionSpawns());
		const planMode = this.session.getPlanModeState?.()?.enabled === true;
		const disabledAgents = cfgTaskDisabledAgents.get(this.session.settings);
		if (
			planMode ||
			!spawnPolicy.enabled ||
			disabledAgents.includes(SEANCE_AGENT_NAME) ||
			(spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(SEANCE_AGENT_NAME))
		) {
			return undefined;
		}
		const agents =
			discoverySnapshots.get(discoveryCacheKey(this.session.cwd, this.session.effectiveExtensionRoots?.())) ??
			this.#discoveredAgents;
		const sessionAgents = this.session.advertisedSessionAgents?.() ?? this.session.getSessionAgents?.() ?? [];
		const seanceAgent = [...agents, ...sessionAgents].find(agent => agent.name === SEANCE_AGENT_NAME);
		return seanceAgent && isBundledSeance(seanceAgent) ? seanceTaskSchemaFields : undefined;
	}

	#defaultAgent(): string {
		return defaultAgentFor(
			resolveSpawnPolicy(this.session.getSessionSpawns()),
			this.session.getPlanModeState?.()?.enabled === true,
		);
	}

	/** Session-retained id allocator; async ids are claimed before job registration. */
	#outputManager(): AgentOutputManager {
		let manager = this.session.agentOutputManager;
		if (!manager) {
			manager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			this.session.agentOutputManager = manager;
		}
		return manager;
	}

	/** Start one spawn's subagent run behind the session semaphore. */
	#launch(spawn: {
		toolCallId: string;
		params: SpawnParams;
		index: number;
		agentId?: string;
		detached: boolean;
	}): SpawnRun {
		return new SpawnRun(
			this.#permit,
			run =>
				this.#runSpawn(
					spawn.toolCallId,
					spawn.params,
					run.signal,
					run.onUpdate,
					spawn.agentId,
					spawn.index,
					spawn.detached,
					run.timing,
					spawn.detached ? run.onArtifactsRetained : undefined,
					run.tools,
				),
			{ agentId: spawn.agentId, detached: spawn.detached },
		);
	}

	/**
	 * Start a streamed item's run ahead of dispatch. Preflight and execution
	 * mode mirror dispatch exactly; refuses (undefined) whenever dispatch would
	 * reject the item, so a refusal halts further speculation for the call.
	 */
	async #startSpeculative(
		toolCallId: string,
		spawn: TaskParams,
		index: number,
		signal: AbortSignal,
	): Promise<SpawnRun | undefined> {
		// File bytes must be captured at dispatch, not while arguments stream.
		if (spawn.taskFile !== undefined) return undefined;
		if (spawn.tools?.length && this.session.getPlanModeState?.()?.enabled === true) return undefined;
		let blocking: boolean;
		try {
			blocking = (await this.#resolveSpawnPreflight(spawn)).effectiveAgent.blocking === true;
		} catch {
			return undefined;
		}
		// Every spawn of a call that async jobs host runs job-hosted, blocking
		// items included: the call may hand those to the background.
		const detached = cfgAsyncEnabled.get(this.session.settings) && this.session.asyncJobManager !== undefined;
		const agentId = await this.#outputManager().allocate(spawn.name?.trim() || generateTaskName());
		if (signal.aborted) return undefined;
		// The call will wait on a blocking item: it reports as waited on from
		// its first payload (payloads start after the permit, never inside this
		// synchronous launch). A run the call never adopts (discarded, settings
		// flipped mid-stream) leaves the set once it settles.
		const run = this.#launch({ toolCallId, params: spawn, index, agentId, detached });
		if (detached && blocking) {
			this.#waitedOn.add(agentId);
			const forget = () => this.#waitedOn.delete(agentId);
			void run.result.then(forget, forget);
		}
		return run;
	}

	#getSpawnSemaphore(): Semaphore {
		const max = cfgTaskMaxConcurrency.get(this.session.settings);
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}

	/**
	 * Resolve the shared policy before detached work exists. The resulting
	 * policy intentionally stays local: executor dispatch resolves again from
	 * normalized task params rather than smuggling internal policy over the
	 * task wire contract.
	 */
	#resolveSpawnPreflight(params: TaskParams) {
		return resolveEffectiveSubagentPolicy({
			session: this.session,
			invocationKind: "task",
			assignment: (params.task ?? "").trim(),
			context: this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined,
			agent: params.agent,
			sourceSession: params.sourceSession,
			...spawnModelFields(params),
			...this.#resultParams(params),
			...this.#effortParams(params),
			...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(this.session.settings),
			enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.session.settings),
		});
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgentsForCreate(session.cwd, session.effectiveExtensionRoots?.());
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const launchSession = this.#launchSessions.get(toolCallId);
		this.#launchSessions.delete(toolCallId);
		try {
			return await this.#dispatch(
				toolCallId,
				rawParams,
				launchSession,
				signal,
				onUpdate,
				context?.toolCall?.wakeSignal,
			);
		} finally {
			// No-op once dispatch adopted; otherwise nothing launched early may outlive the call.
			launchSession?.discard("task call settled without adopting speculative launches");
		}
	}

	async #dispatch(
		toolCallId: string,
		rawParams: unknown,
		launchSession: TaskLaunchSession | undefined,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		wakeSignal?: AbortSignal,
	): Promise<AgentToolResult<TaskToolDetails>> {
		// Schema defaults fill `agent` for model calls, but internal callers
		// and stale transcripts can bypass arktype. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = this.#defaultAgent();
		const batchEnabled = this.#isBatchEnabled();
		const plan = planSpawns(
			rawParams,
			batchEnabled,
			cfgTaskFile.get(this.session.settings),
			defaultAgent,
			this.#seanceSchemaFields() !== undefined,
			this.session.settings,
		);
		if (typeof plan === "string") {
			return createTaskModeError(plan);
		}
		const { params } = plan;
		const spawnItems: ResolvedTaskItem[] = [];
		try {
			for (const item of plan.items) spawnItems.push(await resolveTaskFile(this, this.session, item));
		} catch (error) {
			return createTaskModeError(error instanceof Error ? error.message : String(error));
		}
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const evalToolNames = spawnItems.flatMap(item => item.tools ?? []);
		if (evalToolNames.length > 0) {
			if (this.session.getPlanModeState?.()?.enabled === true) {
				return createTaskModeError("Task execution failed: Eval-defined tools are unavailable in plan mode.");
			}
			try {
				await describeEvalTools(this.session, evalToolNames, signal);
			} catch (error) {
				return createTaskModeError(
					`Task execution failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		// Resolve every item before choosing an execution path. No executor or
		// job manager may observe a batch unless every effective policy is valid.
		const preflights = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return { error: error instanceof StructuredSubagentError ? error.message : String(error) };
				}
			}),
		);
		const preflightFailures = preflights
			.map((preflight, index) => ("error" in preflight ? { index, error: preflight.error } : undefined))
			.filter((failure): failure is { index: number; error: string } => failure !== undefined);
		if (preflightFailures.length > 0) {
			if (!batchEnabled) {
				return createTaskModeError(`Task execution failed: ${preflightFailures[0]!.error}`);
			}
			return createTaskModeError(
				preflightFailures
					.map(({ index, error }) => {
						const item = spawnItems[index]!;
						return `Task ${item.name?.trim() || `#${index + 1}`} failed preflight: ${error}`;
					})
					.join("\n"),
			);
		}
		const policies = preflights.map(preflight => preflight.policy!);
		const itemBlocking = policies.map(policy => policy.effectiveAgent.blocking === true);

		// Without async jobs every item runs inline on this turn. With them
		// every item runs as a job: an ordinary item as a background job, an
		// item whose agent type declares `blocking: true` as a foreground job
		// the call waits on until it settles or a message arrives
		// (`wakeSignal`); a message hands it to the background so the model
		// reads the message right away and the result arrives on its own.
		const asyncEnabled = cfgAsyncEnabled.get(this.session.settings);
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		// Runs started while the call streamed. A run is job-hosted (detached)
		// iff a job manager hosts this call; a run launched under the other
		// mode (settings flipped mid-stream) cannot be re-homed and starts over.
		const adopted = launchSession ? await launchSession.adopt(normalizedSpawnParams) : new Map<number, SpawnRun>();
		for (const [index, run] of adopted) {
			if (run.identity.detached === (manager !== undefined)) continue;
			run.discard("task execution mode changed after speculative launch");
			adopted.delete(index);
		}
		const depthCapacity = canSpawnAtDepth(
			cfgTaskMaxRecursionDepth.get(this.session.settings),
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);
		const scoutAvailable = isScoutSpawnable(
			cfgTaskDisabledAgents.get(this.session.settings),
			this.session.getSessionSpawns?.() ?? "*",
		);
		// Coordination only makes sense for spawns that keep running after this
		// call returns; a spawn that finished before it returned is done.
		const adviseFor = (liveItems: TaskItem[]): string | undefined =>
			this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents,
						items: liveItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: liveItems.length > 0,
						scoutAvailable,
					});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached AgentToolResult would be a hidden trap.
		const withAdvisory = (
			result: AgentToolResult<TaskToolDetails>,
			advisory: string | undefined,
		): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};

		if (!manager) {
			// Inline: async execution disabled (the user turned jobs off; Legion
			// pods do so deliberately so task children stay inside the turn its
			// takeover abort owns), or an orphaned host that never wired a job
			// manager.
			if (asyncEnabled) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			const result = await this.#executeSyncFanout(
				toolCallId,
				params,
				spawnItems.map((item, index) => ({ item, index, run: adopted.get(index) })),
				defaultAgent,
				signal,
				onUpdate,
			);
			return withAdvisory(result, adviseFor([]));
		}

		const outputManager = this.#outputManager();
		const callStartedAt = Date.now();
		const spawns: JobSpawn[] = [];
		for (const [index, item] of spawnItems.entries()) {
			const agentType = resolvedAgents[index]!;
			const policy = policies[index]!;
			const agentSource = policy.agent.source;
			const run = adopted.get(index);
			const agentId =
				run?.identity.agentId ?? (await outputManager.allocate(item.name?.trim() || generateTaskName()));
			const assignment = (item.task ?? "").trim();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				run,
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					modelRole: policy.modelRole,
					status: "pending",
					task: renderSubagentUserPrompt(assignment),
					assignment,
					...(item.taskFile !== undefined ? { taskFile: item.taskFile, taskFileSha256: item.taskFileSha256 } : {}),
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
				background: !itemBlocking[index],
				settled: false,
				failed: false,
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const blockingSpawns = spawns.filter(spawn => spawn.blocking);
		const asyncItems = asyncSpawns.map(spawn => spawn.item);
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Background spawns report into
		// the shared progress snapshot through their jobs: the async half stays
		// "running" until every background job settles, then turns "failed" if
		// any failed. A blocking spawn the call waited on lands in `results`
		// before it returns, so post-return job updates never drop it; one the
		// call handed off joins the async half.
		let primaryJobId = asyncSpawns[0]?.agentId ?? spawns[0]!.agentId;
		const syncResults: SingleResult[] = [];
		// oxlint-disable-next-line prefer-const -- read by buildAsyncDetails before assignment
		let syncUsage: Usage | undefined;
		// oxlint-disable-next-line prefer-const -- read by buildAsyncDetails before assignment
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => {
			const background = spawns.filter(spawn => spawn.background);
			return {
				projectAgentsDir: syncProjectAgentsDir,
				results: [...syncResults],
				totalDurationMs: Date.now() - callStartedAt,
				usage: syncUsage,
				outputPaths: syncOutputPaths,
				progress: spawns.map(spawn => ({ ...spawn.progress })),
				async: {
					state: background.some(spawn => !spawn.settled)
						? "running"
						: background.some(spawn => spawn.failed)
							? "failed"
							: "completed",
					jobId: primaryJobId,
					type: "task",
				},
			};
		};

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					run: spawn.run,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						spawn.settled = true;
						spawn.failed = failed;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// An adopted run already executes; without its job nothing would own it.
				spawn.run?.discard(`background job registration failed: ${message}`);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				spawn.settled = true;
				spawn.failed = true;
			}
		}

		if (started.length === 0 && blockingSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to start background task job${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
				: "";
		const renderSpawnFeedback = (mixed: boolean): string =>
			prompt
				.render(taskSpawnFeedbackTemplate, {
					mixed,
					singular: started.length === 1,
					singleCall: spawns.length === 1,
					showListing: mixed || spawns.length > 1,
					count: started.length,
					agentId: started[0]?.agentId,
					jobId: started[0]?.jobId,
					agentLabel,
					started,
					scheduleFailureSummary,
				})
				.trim();

		if (blockingSpawns.length === 0) {
			onUpdate?.({
				content: [
					{
						type: "text",
						text:
							spawns.length === 1
								? `Spawned agent \`${started[0].agentId}\`...`
								: `Spawned ${started.length} agents...`,
					},
				],
				details: buildAsyncDetails(),
			});
			return withAdvisory(
				{ content: [{ type: "text", text: renderSpawnFeedback(false) }], details: buildAsyncDetails() },
				adviseFor(asyncItems),
			);
		}

		// Blocking subset: foreground jobs the call waits on. A mixed call's
		// background jobs above already run.
		const mixed = asyncSpawns.length > 0;
		const blockingLabel = blockingSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		if (mixed) {
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Running ${blockingLabel} inline; ${started.length} background agent${started.length === 1 ? "" : "s"} spawned...`,
					},
				],
				details: buildAsyncDetails(),
			});
		}
		// While the call waits, progress keeps the shape the call reports for
		// inline spawns: one spawn's own updates, a fan-out's combined rows, or a
		// mixed call's aggregate. A spawn handed to the background reports
		// through its job instead.
		const latestProgress = new Map<number, AgentProgress>();
		const reportForeground = (spawn: JobSpawn, update: AgentToolResult<TaskToolDetails>): void => {
			if (!onUpdate || spawn.background) return;
			if (!mixed && spawns.length === 1) {
				void onUpdate(update);
				return;
			}
			const progress = update.details?.progress?.[0];
			if (!progress) return;
			if (mixed) {
				void onUpdate({
					content: [{ type: "text", text: `Running ${blockingLabel} inline...` }],
					details: buildAsyncDetails(),
				});
				return;
			}
			latestProgress.set(spawn.index, { ...progress, index: spawn.index });
			void onUpdate({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - callStartedAt,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, entry]) => entry),
				},
			});
		};
		const registrationFailures = new Map<JobSpawn, string>();
		for (const spawn of blockingSpawns) {
			// Waited on from its first payload: lifecycle/progress report it inline.
			this.#waitedOn.add(spawn.agentId);
			const spawnParams = spawnParamsFor(params, spawn.item, defaultAgent);
			// The call holds the run so it can report the result inline.
			const run =
				spawn.run ??
				this.#launch({
					toolCallId,
					params: spawnParams,
					index: spawn.index,
					agentId: spawn.agentId,
					detached: true,
				});
			spawn.run = run;
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams,
					agentId: spawn.agentId,
					run,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					foreground: true,
					onRunUpdate: update => reportForeground(spawn, update),
					onUpdate: update => (spawn.background ? onUpdate?.(update) : undefined),
					onSettled: failed => {
						spawn.settled = true;
						spawn.failed = failed;
					},
				});
				spawn.jobId = jobId;
				spawn.jobDone = manager.getJob(jobId)?.promise ?? Promise.resolve();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				run.discard(`foreground job registration failed: ${message}`);
				registrationFailures.set(spawn, message);
			}
		}
		const hosted = blockingSpawns.filter(spawn => spawn.jobId !== undefined);
		const done = new Set<JobSpawn>();
		for (const spawn of hosted) void spawn.jobDone!.then(() => done.add(spawn));

		// One payload per reported spawn, taken once: releasing its foreground
		// job and reading its run's result.
		const payloadCache = new Map<JobSpawn, Promise<AgentToolResult<TaskToolDetails> | undefined>>();
		const payloadOf = (spawn: JobSpawn): Promise<AgentToolResult<TaskToolDetails> | undefined> => {
			let payload = payloadCache.get(spawn);
			if (!payload) {
				const failure = registrationFailures.get(spawn);
				if (failure !== undefined) {
					payload = Promise.resolve(spawnFailurePayload(spawn.item, spawn.index, failure));
				} else {
					manager.releaseForegroundJob(spawn.jobId!);
					// Rejects only when the run never started (aborted before its permit).
					payload = spawn.run!.result.catch(() => undefined);
				}
				payloadCache.set(spawn, payload);
			}
			return payload;
		};

		let outcome = await this.#awaitForegroundJobs(hosted, signal, wakeSignal);
		// Payloads of the spawns a wake reports inline, read before any promotion.
		let wakePayloads: (AgentToolResult<TaskToolDetails> | undefined)[] | undefined;
		if (outcome === "wake") {
			// Finish every await the result needs before promoting anything, so
			// the promotion below runs in the same synchronous step as the last
			// cancellation check and the return: a cancel that lands at any
			// point before it still cancels the children instead of handing
			// them off.
			const finished = blockingSpawns.filter(spawn => !hosted.includes(spawn) || done.has(spawn));
			wakePayloads = await Promise.all(finished.map(payloadOf));
			if (signal?.aborted) {
				outcome = "abort";
				wakePayloads = undefined;
			}
		}
		if (outcome === "abort") {
			for (const spawn of hosted) manager.cancel(spawn.jobId!, undefined, signal?.reason);
			await Promise.all(hosted.map(spawn => spawn.jobDone));
		}
		// No longer waited on, only now: a cancelled child stayed inline to its
		// last payload; a handed-off one runs as a detached job from here on.
		for (const spawn of blockingSpawns) this.#waitedOn.delete(spawn.agentId);
		// A wake hands every blocking job not yet reported to the background:
		// visible, and its result delivered like any background spawn's.
		const handedOff = outcome === "wake" ? hosted.filter(spawn => !payloadCache.has(spawn)) : [];
		for (const spawn of handedOff) {
			spawn.background = true;
			manager.backgroundJob(spawn.jobId!);
		}
		if (started.length === 0 && handedOff.length > 0) primaryJobId = handedOff[0]!.jobId!;
		const reported = blockingSpawns.filter(spawn => !spawn.background);

		if (!mixed && handedOff.length === 0) {
			// Every spawn blocking, none handed off: exactly the inline result.
			if (spawns.length === 1) {
				const [spawn] = reported;
				const failure = registrationFailures.get(spawn!);
				if (failure !== undefined) return spawnFailurePayload(spawn!.item, spawn!.index, failure);
				manager.releaseForegroundJob(spawn!.jobId!);
				return withAdvisory(await spawn!.run!.result, adviseFor([]));
			}
			const payloads = wakePayloads ?? (await Promise.all(reported.map(payloadOf)));
			return withAdvisory(syncFanoutResult(mergeSyncPayloads(reported, payloads), callStartedAt), adviseFor([]));
		}

		// After a promotion nothing may await before the return: a wake's
		// reported payloads were read above, in `reported` order.
		const payloads = wakePayloads ?? (await Promise.all(reported.map(payloadOf)));
		const merged = mergeSyncPayloads(reported, payloads);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the reported spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < reported.length; position++) {
			const spawn = reported[position]!;
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const sections = [merged.contentParts.join("\n\n")];
		if (handedOff.length > 0) {
			sections.push(
				prompt
					.render(taskYieldTemplate, {
						singular: handedOff.length === 1,
						continuing: handedOff.map(spawn => ({ agentId: spawn.agentId, jobId: spawn.jobId })),
						waitTool: hasWaitTool(this.session),
					})
					.trim(),
			);
		}
		if (mixed) sections.push(started.length > 0 ? renderSpawnFeedback(true) : scheduleFailureSummary.trim());
		const text = sections.filter(section => section.trim().length > 0).join("\n\n");
		return withAdvisory(
			{
				content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
				...(merged.isError ? { isError: true } : {}),
				details: buildAsyncDetails(),
			},
			adviseFor([...asyncItems, ...handedOff.map(spawn => spawn.item)]),
		);
	}

	/**
	 * Wait on a call's blocking jobs until they all settle, a wake arrives (a
	 * message the model should read now), or the call aborts. Cancellation
	 * always wins: a wake that lands with (or just before) an abort still
	 * reports "abort", so no cancelled child is handed to the background. A
	 * wake raised before the wait began ends it at once. While it waits the
	 * caller is blocked on those agents for reply waits; the hold is
	 * interruptible only when a wake can actually end the wait (the loop
	 * omits `wakeSignal` in `interruptMode: "wait"`), so a child asking its
	 * parent still sees the cycle there. One hold per agent, since the call
	 * waits for all of them.
	 */
	async #awaitForegroundJobs(
		spawns: readonly JobSpawn[],
		signal: AbortSignal | undefined,
		wakeSignal: AbortSignal | undefined,
	): Promise<"settled" | "wake" | "abort"> {
		if (signal?.aborted) return "abort";
		if (wakeSignal?.aborted) return "wake";
		const registry = this.session.agentRegistry ?? AgentRegistry.global();
		const waiter = this.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const interruptible = wakeSignal !== undefined;
		const releases = spawns.map(spawn => registry.awaits.hold(waiter, [spawn.agentId], { interruptible }));
		const { promise: interrupted, resolve } = Promise.withResolvers<"wake" | "abort">();
		const onAbort = () => resolve("abort");
		const onWake = () => resolve("wake");
		signal?.addEventListener("abort", onAbort, { once: true });
		wakeSignal?.addEventListener("abort", onWake, { once: true });
		try {
			const outcome = await Promise.race([
				Promise.all(spawns.map(spawn => spawn.jobDone)).then(() => "settled" as const),
				interrupted,
			]);
			return outcome === "wake" && signal?.aborted ? "abort" : outcome;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			wakeSignal?.removeEventListener("abort", onWake);
			for (const release of releases) release();
		}
	}

	/**
	 * Register one job that runs a single spawn to completion and delivers its
	 * yield text. The job body mirrors the sync path; `buildDetails` supplies
	 * the (possibly batch-shared) progress snapshot and `onSettled` feeds the
	 * caller's aggregate counters. A `foreground` job backs a blocking spawn
	 * the call waits on: hidden and undelivered until the call hands it to the
	 * background, and `onRunUpdate` sees the run's own updates meanwhile.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManagerApi;
		toolCallId: string;
		spawnParams: SpawnParams;
		agentId: string;
		/** Run already started (while the call streamed, or by the call itself); the job adopts it instead of launching. */
		run?: SpawnRun;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
		foreground?: boolean;
		/** Each run update, after its live metrics are copied into `progress`. */
		onRunUpdate?: (update: AgentToolResult<TaskToolDetails>) => void;
	}): string {
		const {
			manager,
			toolCallId,
			spawnParams,
			agentId,
			run,
			progress,
			ircEnabled,
			buildDetails,
			onUpdate,
			onSettled,
			foreground,
			onRunUpdate,
		} = options;
		// A queued job launches (or adopts) its run when it starts; until then
		// its widget has no tool tap to read.
		let spawnRun: SpawnRun | undefined = run;
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			// Isolated runs are parked without a reviver once the run ends
			// (`finalizeSubagentLifecycle`), so "message it" would point the
			// caller at a follow-up path that no longer exists. The template says
			// nothing about the worktree itself: the runner keeps it when captured
			// changes could not be written, and names that path in the result.
			const isolated = spawnParams.isolated === true;
			const ref = aborted ? AgentRegistry.global().get(agentId) : undefined;
			return `\n\n${prompt.render(taskFollowUpTemplate, {
				agentId,
				aborted,
				isolated,
				ircEnabled,
				resumable: !isolated && isResumable(ref),
				transcriptAvailable: aborted ? await hasResolvableTranscript(agentId) : true,
			})}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ jobId, signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const forwardSyncProgress: AgentToolUpdateCallback<TaskToolDetails> = async update => {
					const nextProgress = update.details?.progress?.[0];
					if (nextProgress) {
						// The job body owns status and identity (id/index/agent);
						// copy only the live metrics the subagent streams so the
						// polling row reflects the resolved model, reasoning level,
						// and running counters without reverting the "running"
						// status back to the subagent's initial "pending" snapshot.
						progress.modelRole = nextProgress.modelRole ?? progress.modelRole;
						progress.resolvedModel = nextProgress.resolvedModel;
						progress.resolvedModelIdentity = nextProgress.resolvedModelIdentity;
						progress.resolvedThinkingLevel = nextProgress.resolvedThinkingLevel;
						progress.resolvedModelIsFallback = nextProgress.resolvedModel
							? nextProgress.resolvedModelIsFallback
							: undefined;
						progress.advisor = nextProgress.advisor ?? progress.advisor;
						progress.completionPercent = nextProgress.completionPercent ?? progress.completionPercent;
						progress.stage = nextProgress.stage ?? progress.stage;
						progress.watch = nextProgress.watch ?? progress.watch;
						progress.resolvedModelRoute = nextProgress.resolvedModelRoute ?? progress.resolvedModelRoute;
						progress.tokens = nextProgress.tokens;
						progress.requests = nextProgress.requests;
						progress.contextTokens = nextProgress.contextTokens;
						progress.contextWindow = nextProgress.contextWindow;
						progress.cost = nextProgress.cost;
						progress.toolCount = nextProgress.toolCount;
						progress.currentTool = nextProgress.currentTool;
						progress.currentToolArgs = nextProgress.currentToolArgs;
						progress.currentToolArgsKey = nextProgress.currentToolArgsKey;
						progress.currentToolIntent = nextProgress.currentToolIntent;
						progress.currentToolStartMs = nextProgress.currentToolStartMs;
						progress.lastIntent = nextProgress.lastIntent;
						progress.recentTools = nextProgress.recentTools.slice();
						progress.recentOutput = nextProgress.recentOutput.slice();
						progress.retryState = nextProgress.retryState;
						progress.retryFailure = nextProgress.retryFailure;
					}
					onRunUpdate?.(update);
					const updateText =
						update.content.find(part => part.type === "text")?.text ?? `Running background task ${agentId}...`;
					await reportProgress(updateText, buildDetails() as unknown as Record<string, unknown>);
				};
				const activeRun = (spawnRun ??= this.#launch({
					toolCallId,
					params: spawnParams,
					index: progress.index,
					agentId,
					detached: true,
				}));
				activeRun.attach({
					signal: runSignal,
					onUpdate: forwardSyncProgress,
					onArtifactsRetained: cleanup => {
						// Tie the retained temp directory's lifetime to this job
						// row: the manager runs `cleanup` exactly once, on
						// eviction or manager disposal, instead of it leaking
						// for the process lifetime. Look up by the resolved
						// `jobId`, not the requested `agentId` — `register()`
						// suffixes `jobId` on collision, and looking up the
						// requested id would hit an unrelated pre-existing row.
						const job = manager.getJob(jobId);
						if (job) job.retainedArtifactsCleanup = cleanup;
						else void cleanup();
					},
				});
				// An acquire-time abort and a post-acquire abort take the same
				// path: progress + onSettled have to fire even when the spawn
				// never reached the executor, otherwise the batch aggregate state
				// stays "running" forever.
				const permitHeld = await activeRun.started.then(
					() => true,
					() => false,
				);
				if (!permitHeld || runSignal.aborted) {
					progress.status = "aborted";
					onSettled?.(true);
					throw new Error("Aborted before execution");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(
						`Running background task ${agentId}...`,
						buildDetails() as unknown as Record<string, unknown>,
					);
					const result = await activeRun.result;
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success. A runner
					// error on a zero exit (changes captured but not landed, or a
					// retained workspace) is a failure too: the work needs manual
					// recovery, which a "completed" job would hide. Mirrors the sync
					// path's status derivation. `isError` marks a child that finished
					// before a later step (isolation merge, nested patch apply) threw.
					const resultFailed =
						result.isError === true ||
						!singleResult ||
						(singleResult.aborted ?? false) ||
						singleResult.exitCode !== 0 ||
						singleResult.error !== undefined;
					progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.retryState = undefined;
					progress.modelRole = singleResult?.modelRole ?? progress.modelRole;
					progress.advisor = singleResult?.advisor ?? progress.advisor;
					progress.resolvedModelRoute = singleResult?.resolvedModelRoute ?? progress.resolvedModelRoute;
					if (singleResult?.resolvedModel) {
						progress.resolvedModel = singleResult.resolvedModel;
						progress.resolvedModelIdentity = singleResult.resolvedModelIdentity;
						progress.resolvedThinkingLevel = singleResult.resolvedThinkingLevel;
						progress.resolvedModelIsFallback = singleResult.resolvedModelIsFallback;
					} else {
						delete progress.resolvedModel;
						delete progress.resolvedModelIdentity;
						delete progress.resolvedThinkingLevel;
						delete progress.resolvedModelIsFallback;
					}
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
					const structured = singleResult?.structuredOutput;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText, structured);
					}
					return structured ? { text: deliveryText, structured } : deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText, buildDetails() as unknown as Record<string, unknown>);
					const message = error instanceof Error ? error.message : String(error);
					const hint = AgentRegistry.global().get(agentId) ? await buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				...(foreground ? { foreground: true } : {}),
				ownerId: this.session.getAgentId?.() ?? undefined,
				widgetInputs: createTaskWidgetInputs({
					manager,
					agentId,
					tools: () => spawnRun?.tools,
					progress,
					intent: this.session.getToolCallIntent?.(toolCallId),
				}),
				onProgress: text => {
					onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				},
			},
		);
	}

	/**
	 * Sync fan-out (async execution unavailable): run every spawn to completion
	 * inline and merge the per-spawn payloads into a single tool result, an
	 * error when any spawn's payload is. The session-scoped semaphore still
	 * bounds concurrency across parallel task calls.
	 */
	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const run =
				spawn.run ??
				this.#launch({
					toolCallId,
					params: spawnParamsFor(params, spawn.item, defaultAgent),
					index: spawn.index,
					detached: false,
				});
			run.attach({ signal, onUpdate });
			return await run.result;
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		return syncFanoutResult(mergeSyncPayloads(spawns, payloads), startTime);
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `index` is each item's position in the original call so
	 * progress rows and merged results keep stable ordering. Per-item progress
	 * snapshots flow through `onItemProgress`. Returns per-spawn payloads in
	 * input order; `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const run =
					spawn.run ??
					this.#launch({
						toolCallId,
						params: spawnParamsFor(params, spawn.item, defaultAgent),
						index: spawn.index,
						detached: false,
					});
				run.attach({
					signal: workerSignal,
					onUpdate: onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined,
				});
				try {
					await run.started;
				} catch (error) {
					if (workerSignal.aborted) return undefined;
					throw error;
				}
				return await run.result;
			},
			signal,
		);
		// A worker never invoked (call aborted first) never attached its adopted run.
		spawns.forEach((spawn, position) => {
			if (!results[position]) spawn.run?.discard("task call aborted before the spawn started");
		});
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			return spawnFailurePayload(spawns[position].item, spawns[position].index, message);
		});
	}

	/** Spawn a fresh subagent and run it to completion; the body of every {@link SpawnRun}. */
	async #runSpawn(
		toolCallId: string,
		params: SpawnParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
		onArtifactsRetained?: (cleanup: () => Promise<void>) => void,
		tools?: TextTap,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const assignment = (params.task ?? "").trim();
		const taskFileMetadata =
			params.taskFile !== undefined ? { taskFile: params.taskFile, taskFileSha256: params.taskFileSha256 } : {};
		const context = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		let latestProgress: AgentProgress | undefined;
		try {
			const execution = await runStructuredSubagent({
				session: this.session,
				invocationKind: "task",
				assignment,
				context,
				agent: params.agent,
				sourceSession: params.sourceSession,
				...spawnModelFields(params),
				...this.#resultParams(params),
				...this.#effortParams(params),
				solutionSpace: params.solutionSpace,
				...(params.tools?.length
					? {
							customTools: createEvalCustomTools(
								this.session,
								await describeEvalTools(this.session, params.tools, signal),
							),
						}
					: {}),
				// `name` is the spawn handle: keep it for id allocation when this
				// path did not pre-reserve one. Do not treat it as a HUD description.
				identity: { id: preAllocatedId, label: params.name },
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				// A job-hosted blocking spawn is waited on until the call hands it
				// to the background; lifecycle/progress payloads say so.
				...(detached && preAllocatedId !== undefined
					? { parentWaits: () => this.#waitedOn.has(preAllocatedId) }
					: {}),
				// Detached (async) spawns advertise `agent://<id>` handles in the
				// eventual async-result delivery, which can land well after this
				// call returns. Without this, a temporary (in-memory session)
				// artifacts directory is deleted immediately on completion and the
				// advertised URL 404s by the time delivery happens.
				retainArtifacts: detached,
				...(onArtifactsRetained ? { onArtifactsRetained } : {}),
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				...("isolated" in params ? { isolation: { requested: params.isolated } } : {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(this.session.settings),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: cfgTaskMaxRuntimeMs.get(this.session.settings),
				signal,
				...(tools ? { onToolResult: (result: SubagentToolResult) => appendToolResult(tools, result) } : {}),
				onProgress: progress => {
					latestProgress = { ...progress, ...taskFileMetadata, recentTools: progress.recentTools.slice() };
					onUpdate?.({
						content: [{ type: "text", text: `Running agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [latestProgress],
						},
					});
				},
			});
			return this.#buildResultPayload(
				{ ...execution.result, ...taskFileMetadata },
				execution.policy.discovery.projectAgentsDir,
				Date.now() - startTime,
				execution.mergeSummary,
			);
		} catch (error) {
			const message = error instanceof StructuredSubagentError ? error.message : String(error);
			// A child that finished before the failure keeps its exit status,
			// usage, and artifact path. `error` is set so nothing reads a zero
			// exit code as a completed run.
			const settled = error instanceof StructuredSubagentError ? error.result : undefined;
			const cause = error instanceof StructuredSubagentError ? error.cause : undefined;
			const salvaged = settled
				? {
						...settled,
						...taskFileMetadata,
						error: settled.error ?? (cause instanceof Error ? cause.message : message),
					}
				: undefined;
			return {
				content: [{ type: "text", text: `Task execution failed: ${message}` }],
				isError: true,
				details: {
					projectAgentsDir: null,
					results: salvaged ? [salvaged] : [],
					totalDurationMs: Date.now() - startTime,
					...(salvaged?.usage ? { usage: salvaged.usage } : {}),
					...(salvaged?.outputPath ? { outputPaths: [salvaged.outputPath] } : {}),
					...(latestProgress ? { progress: [latestProgress] } : {}),
				},
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const summary = formatTaskResultSummary(result, { totalDurationMs, mergeSummary });
		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}

subprocessToolRegistry.register<TaskToolDetails>("task", {
	...taskSubprocessRenderer,
	extractData: event => (isTaskToolDetails(event.result?.details) ? event.result.details : undefined),
});
