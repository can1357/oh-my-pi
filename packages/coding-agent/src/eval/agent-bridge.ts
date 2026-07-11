/**
 * Host-side handler for the eval `agent()` helper.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { registerArtifactsDir } from "../internal-urls/registry-helpers";
import { MCPManager } from "../mcp/manager";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import * as taskDiscovery from "../task/discovery";
import type { ExecutorOptions } from "../task/executor";
import * as taskExecutor from "../task/executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "../task/isolation-runner";
import { AgentOutputManager } from "../task/output-manager";
import type { AgentDefinition, AgentProgress, SingleResult } from "../task/types";
import { type NestedRepoPatch, parseIsolationMode } from "../task/worktree";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
// Import review tools for side effects (registers subagent tool handlers).
import "../tools/review";

/** Synthetic bridge name reserved for the `agent()` helper across both runtimes. */
export const EVAL_AGENT_BRIDGE_NAME = "__agent__";

/** Hard recursion limit for eval-driven subagents. */
export const EVAL_AGENT_MAX_DEPTH = 3;

const DEFAULT_AGENT_TYPE = "task";
const DEFAULT_AGENT_LABEL = "EvalAgent";

const agentArgsSchema = type({
	prompt: "string>0",
	"agent?": "string>0",
	"model?": "string>0|string>0[]",
	"label?": "string",
	"schema?": "unknown",
	"isolated?": "boolean",
	"apply?": "boolean",
	"merge?": "boolean",
	"handle?": "boolean",
});

interface EvalAgentArgs {
	prompt: string;
	agent?: string;
	model?: string | string[];
	label?: string;
	schema?: unknown;
	/**
	 * Run this subagent inside an isolation worktree (copy-on-write of the
	 * parent repo). Strict opt-in: defaults to `false` regardless of the
	 * session's `task.isolation.mode`, mirroring the `task` tool. Passing
	 * `true` while `task.isolation.mode === "none"` errors out instead of
	 * silently downgrading.
	 */
	isolated?: boolean;
	/**
	 * When isolated, apply the captured patch / merge the captured branch back
	 * to the parent repo (default `true`). Pass `false` to keep changes in the
	 * isolation worktree only — the patch artifact path / branch name lands in
	 * the result so the caller can inspect or apply manually.
	 */
	apply?: boolean;
	/**
	 * When isolated, allow branch-merge mode (cherry-pick onto HEAD). Defaults
	 * to `true`, in which case the active `task.isolation.merge` setting picks
	 * patch vs branch. Pass `false` to force patch mode even when the setting
	 * is `"branch"` — useful when a fan-out cannot tolerate the per-call git
	 * lock + repo mutation that branch mode performs.
	 */
	merge?: boolean;
	/** True when a runtime helper will return an `agent://` handle backed by the output artifacts. */
	handle?: boolean;
}

export interface EvalAgentBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalAgentResult {
	text: string;
	details: {
		agent: string;
		id: string;
		model?: string | string[];
		structured: boolean;
		/** True iff this run executed inside an isolation worktree. */
		isolated?: boolean;
		/** Captured patch artifact (patch mode) — surfaced regardless of `apply`. */
		patchPath?: string;
		/** Captured branch (branch mode) — surfaced regardless of `apply`. */
		branchName?: string;
		/** Captured nested repository patches — surfaced for isolated `apply=false` manual application. */
		nestedPatches?: NestedRepoPatch[];
		/**
		 * Tri-state apply outcome for isolated runs:
		 * - `true`  — apply ran (or had nothing to do) and left the repo clean.
		 * - `false` — apply attempted and failed; artifacts preserved.
		 * - `null`  — caller opted out via `apply=false`.
		 * Omitted for non-isolated runs.
		 */
		changesApplied?: boolean | null;
		/** Human-readable isolation apply/merge summary; kept out of schema-backed `text`. */
		isolationSummary?: string;
	};
}

function parseAgentArgs(args: unknown): EvalAgentArgs {
	const result = agentArgsSchema(args);
	if (result instanceof type.errors) {
		throw new ToolError(`agent() received invalid arguments: ${result.summary}`);
	}
	return result;
}

function assertDepthAllowed(session: ToolSession): void {
	const taskDepth = session.taskDepth ?? 0;
	if (taskDepth >= EVAL_AGENT_MAX_DEPTH) {
		throw new ToolError(
			`agent() cannot spawn another agent at task depth ${taskDepth}; maximum depth is ${EVAL_AGENT_MAX_DEPTH}.`,
		);
	}
}

function assertSpawnAllowed(session: ToolSession, agentName: string): void {
	const parentSpawns = session.getSessionSpawns() ?? "*";
	if (parentSpawns === "*") return;
	if (parentSpawns === "") {
		throw new ToolError(`Cannot spawn '${agentName}'. Allowed: none (spawns disabled for this agent)`);
	}
	const allowedSpawns = parentSpawns.split(",").map(spawn => spawn.trim());
	if (!allowedSpawns.includes(agentName)) {
		throw new ToolError(`Cannot spawn '${agentName}'. Allowed: ${parentSpawns}`);
	}
}

function assertAgentEnabled(session: ToolSession, agentName: string, agents: AgentDefinition[]): void {
	const disabledAgents = session.settings.get("task.disabledAgents") as string[];
	if (!disabledAgents.includes(agentName)) return;
	const enabled = agents.filter(agent => !disabledAgents.includes(agent.name)).map(agent => agent.name);
	throw new ToolError(
		`Agent "${agentName}" is disabled in settings. Enable it via /agents, or use a different agent type.${enabled.length > 0 ? ` Available: ${enabled.join(", ")}` : ""}`,
	);
}

function assertNotPlanMode(session: ToolSession): void {
	if (session.getPlanModeState?.()?.enabled) {
		throw new ToolError("agent() is unavailable in plan mode.");
	}
}

function renderSubagentPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim() });
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function outputIdBase(label: string | undefined, agentName: string): string {
	const source = trimToUndefined(label) ?? agentName ?? DEFAULT_AGENT_LABEL;
	const sanitized = source.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || DEFAULT_AGENT_LABEL;
}

function getOutputManager(session: ToolSession): AgentOutputManager {
	if (session.agentOutputManager) return session.agentOutputManager;
	const manager = new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager = manager;
	return manager;
}

interface ArtifactPaths {
	sessionFile: string | null;
	artifactsDir: string;
	unregisterArtifactsDir?: () => void;
	/**
	 * True when `artifactsDir` was created off the session path (no session
	 * file). Caller is then free to `rm -rf` it once all isolated patch
	 * artifacts have been consumed or applied.
	 */
	tempArtifactsDir: boolean;
}

async function getArtifacts(session: ToolSession): Promise<ArtifactPaths> {
	const sessionFile = session.getSessionFile();
	const sessionArtifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
	const tempArtifactsDir = sessionArtifactsDir === null;
	const artifactsDir = sessionArtifactsDir ?? path.join(os.tmpdir(), `omp-eval-agent-${Snowflake.next()}`);
	await fs.mkdir(artifactsDir, { recursive: true });
	const unregisterArtifactsDir = tempArtifactsDir ? registerArtifactsDir(artifactsDir) : undefined;
	return { sessionFile, artifactsDir, unregisterArtifactsDir, tempArtifactsDir };
}

/**
 * Persist nested-repo patches to the per-call artifacts dir so an isolated
 * apply failure can surface their paths in the thrown ToolError. The
 * isolation worktree is already gone by the time we run, so without this the
 * captured nested patches would be unrecoverable.
 */
async function persistNestedPatches(
	artifactsDir: string,
	agentId: string,
	nestedPatches: NestedRepoPatch[],
): Promise<string[]> {
	const written: string[] = [];
	for (let index = 0; index < nestedPatches.length; index++) {
		const patch = nestedPatches[index];
		if (!patch) continue;
		const slug = patch.relativePath.replace(/[^A-Za-z0-9._-]+/g, "_") || `nested-${index}`;
		const out = path.join(artifactsDir, `${agentId}.nested-${index}-${slug}.patch`);
		await Bun.write(out, patch.patch);
		written.push(out);
	}
	return written;
}

function plainIsolationSummary(summary: string): string {
	return summary.replace(/<\/?system-notification>/g, "").trim();
}

function emitProgressStatus(emitStatus: ((event: JsStatusEvent) => void) | undefined, progress: AgentProgress): void {
	if (!emitStatus) return;
	const preview = (progress.assignment ?? progress.task ?? "").split("\n")[0]?.slice(0, 120);
	emitStatus({
		op: "agent",
		id: progress.id,
		agent: progress.agent,
		status: progress.status,
		lastIntent: progress.lastIntent,
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		taskPreview: preview || undefined,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		cost: progress.cost,
		durationMs: progress.durationMs,
		model: progress.resolvedModel,
	});
}

/**
 * Coalesce a subagent failure into a non-empty, human-meaningful error message.
 *
 * When the executor aborts a subagent (runtime limit, parent cancellation, …)
 * the actionable explanation lives on `abortReason`, while `error`/`stderr`
 * are routinely empty strings. Plain `??` coalescing stops at the empty string
 * and ships an empty error through the bridge — Python then surfaces only the
 * generic `bridge call '__agent__' failed`. See #2006.
 */
function buildSubagentFailureMessage(agentName: string, result: SingleResult): string {
	const abortReason = trimToUndefined(result.abortReason);
	if (result.aborted && abortReason) return abortReason;
	return (
		trimToUndefined(result.error) ??
		trimToUndefined(result.stderr) ??
		abortReason ??
		`agent() subagent '${agentName}' failed.`
	);
}

/**
 * Run a single subagent on behalf of an eval cell's `agent()` call.
 */
export async function runEvalAgent(args: unknown, options: EvalAgentBridgeOptions): Promise<EvalAgentResult> {
	const parsed = parseAgentArgs(args);
	const agentName = parsed.agent ?? DEFAULT_AGENT_TYPE;
	const structured = Object.hasOwn(parsed, "schema");

	assertNotPlanMode(options.session);
	assertDepthAllowed(options.session);
	assertSpawnAllowed(options.session, agentName);

	const turnBudget = options.session.getTurnBudget?.();
	if (turnBudget?.hard && turnBudget.total !== null && turnBudget.spent >= turnBudget.total) {
		throw new ToolError(
			`agent() blocked: turn token budget exhausted (${turnBudget.spent}/${turnBudget.total} output tokens). Raise or drop the +Nk! ceiling to continue.`,
		);
	}

	const { agents } = await taskDiscovery.discoverAgents(options.session.cwd);
	const agent = taskDiscovery.getAgent(agents, agentName);
	if (!agent) {
		const available = agents.map(candidate => candidate.name).join(", ") || "none";
		throw new ToolError(`Unknown agent "${agentName}". Available: ${available}`);
	}
	assertAgentEnabled(options.session, agentName, agents);

	const effectiveAgent = agent;
	const parentActiveModelPattern = options.session.getActiveModelString?.();
	const agentModelOverrides = options.session.settings.get("task.agentModelOverrides");
	const modelOverride = resolveAgentModelPatterns({
		settingsOverride: parsed.model ?? agentModelOverrides[agentName],
		agentModel: effectiveAgent.model,
		settings: options.session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: options.session.getModelString?.(),
	});
	const availableSkills = [...(options.session.skills ?? [])];
	const resolvedAutoloadSkills =
		effectiveAgent.autoloadSkills?.length && availableSkills.length > 0
			? effectiveAgent.autoloadSkills
					.map(name => availableSkills.find(skill => skill.name === name))
					.filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
			: [];
	const contextFiles = options.session.contextFiles?.filter(
		file => path.basename(file.path).toLowerCase() !== "agents.md",
	);
	const localProtocolOptions: LocalProtocolOptions = options.session.localProtocolOptions ?? {
		getArtifactsDir: options.session.getArtifactsDir ?? (() => null),
		getSessionId: options.session.getSessionId ?? (() => null),
	};
	const parentArtifactManager = options.session.getArtifactManager?.() ?? undefined;
	const mcpManager = options.session.mcpManager ?? MCPManager.instance();
	const { sessionFile, artifactsDir, unregisterArtifactsDir, tempArtifactsDir } = await getArtifacts(options.session);
	const outputManager = getOutputManager(options.session);
	const id = await outputManager.allocate(outputIdBase(parsed.label, agentName));
	const assignment = parsed.prompt.trim();

	// Isolation gating. Strict opt-in: only the explicit `isolated=true`
	// argument turns it on; `task.isolation.mode` no longer drives the
	// default. Mirrors the `task` tool so eval `agent()` and `task` callers
	// see the same semantic. `isolated=true` while the mode is `"none"`
	// surfaces a clear error instead of silently downgrading.
	const isolationMode = options.session.settings.get("task.isolation.mode");
	const isolationEnabledInSettings = isolationMode !== "none";
	if (parsed.isolated === true && !isolationEnabledInSettings) {
		throw new ToolError(`agent(isolated=True) requires task.isolation.mode to be set; current mode is "none".`);
	}
	const isIsolated = parsed.isolated === true;
	const settingsMergeMode = options.session.settings.get("task.isolation.merge");
	const mergeMode: "patch" | "branch" = parsed.merge === false ? "patch" : settingsMergeMode;
	const applyChanges = parsed.apply !== false;

	// Isolation context capture (prepareIsolationContext → captureBaseline)
	// happens inside the timeout-pause closure below; on dirty/large repos the
	// baseline walk can run long and must stay covered by the eval idle
	// suspension.

	const buildCommitMessage = makeIsolationCommitMessage(options.session);

	const baseRunOptions: ExecutorOptions = {
		cwd: options.session.cwd,
		agent: effectiveAgent,
		task: renderSubagentPrompt(assignment),
		assignment,
		description: trimToUndefined(parsed.label),
		index: 0,
		id,
		taskDepth: options.session.taskDepth ?? 0,
		modelOverride,
		parentActiveModelPattern,
		thinkingLevel: effectiveAgent.thinkingLevel,
		outputSchema: structured ? parsed.schema : undefined,
		sessionFile,
		persistArtifacts: Boolean(sessionFile),
		artifactsDir,
		// Eval `agent()` subagents are short-lived programmatic helpers (data
		// collection, structured output, parallel() fan-out). LSP server
		// cold-start costs tens of seconds and is pure overhead here, so it is
		// forced off regardless of the `task.enableLsp` setting — that knob only
		// governs LSP-aware delegation through the `task` tool.
		enableLsp: false,
		signal: options.signal,
		eventBus: options.session.eventBus,
		onProgress: progress => emitProgressStatus(options.emitStatus, progress),
		authStorage: options.session.authStorage,
		modelRegistry: options.session.modelRegistry,
		settings: options.session.settings,
		// Eval `agent()` subagents are never wall-clock capped: the parent
		// cell's idle watchdog is suspended for the whole bridge call
		// (withBridgeTimeoutPause), so a long-running phase/recovery workflow
		// must not be killed by `task.maxRuntimeMs`. Force the limit off
		// regardless of the inherited session setting.
		maxRuntimeMs: 0,
		keepAlive: false,
		mcpManager,
		contextFiles,
		skills: availableSkills,
		autoloadSkills: resolvedAutoloadSkills,
		workspaceTree: options.session.workspaceTree,
		promptTemplates: options.session.promptTemplates,
		localProtocolOptions,
		parentArtifactManager,
		parentHindsightSessionState: options.session.getHindsightSessionState?.(),
		parentMnemopiSessionState: options.session.getMnemopiSessionState?.(),
		parentTelemetry: options.session.getTelemetry?.(),
		parentAgentId: options.session.getAgentId?.() ?? MAIN_AGENT_ID,
		// Live source of truth for `serviceTierSubagent: inherit` (null = explicit none).
		parentServiceTier: options.session.getServiceTier ? (options.session.getServiceTier() ?? null) : undefined,
		// Deliberately omit parentEvalSessionId: the parent's Python kernel is
		// blocked on this bridge call, so sharing the eval session would deadlock
		// (subagent queues behind the parent's in-flight execution, parent waits
		// for subagent → circular). Each bridge-spawned subagent gets its own
		// eval session with an independent kernel.
	};

	// Suspend eval timeout accounting through the WHOLE bridge call: the
	// subagent subprocess plus any isolation post-processing (merge,
	// nested-patch apply, cleanup). All of that is host-side work while the
	// runtime is parked waiting for the result, and the cell timeout must
	// not abort us mid-cherry-pick or mid-nested-commit. The clock restarts
	// only after we hand control back to the runtime.
	const { result, mergeSummary, changesApplied } = await withBridgeTimeoutPause(options.emitStatus, async () => {
		let isolationContext: IsolationContext | null = null;
		if (isIsolated) {
			try {
				isolationContext = await prepareIsolationContext(options.session.cwd);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new ToolError(`Isolated agent() execution requires a git repository. ${message}`);
			}
		}
		const preferredBackend = isIsolated ? parseIsolationMode(isolationMode) : undefined;

		const result = await (async () => {
			if (!isolationContext) {
				return taskExecutor.runSubprocess(baseRunOptions);
			}
			const taskStart = Date.now();
			return runIsolatedSubprocess({
				baseOptions: baseRunOptions,
				context: isolationContext,
				preferredBackend,
				agentId: id,
				mergeMode,
				artifactsDir,
				description: trimToUndefined(parsed.label),
				buildCommitMessage,
				buildFailureResult: err => {
					const message = err instanceof Error ? err.message : String(err);
					return {
						index: 0,
						id,
						agent: effectiveAgent.name,
						agentSource: effectiveAgent.source,
						task: renderSubagentPrompt(assignment),
						assignment,
						description: trimToUndefined(parsed.label),
						exitCode: 1,
						output: "",
						stderr: message,
						truncated: false,
						durationMs: Date.now() - taskStart,
						tokens: 0,
						requests: 0,
						modelOverride,
						error: message,
					};
				},
			});
		})();

		if (result.exitCode !== 0 || result.error || result.aborted) {
			throw new ToolError(buildSubagentFailureMessage(agentName, result));
		}

		let mergeSummary = "";
		let changesApplied: boolean | null = null;
		if (isIsolated && isolationContext) {
			if (applyChanges) {
				const outcome = await mergeIsolatedChanges({
					result,
					repoRoot: isolationContext.repoRoot,
					mergeMode,
				});
				mergeSummary = outcome.summary;
				changesApplied = outcome.changesApplied;
				if (outcome.changesApplied === false) {
					const summaryText = outcome.summary.trim();
					const recoveryParts: string[] = [];
					if (result.patchPath) recoveryParts.push(`Captured patch preserved at ${result.patchPath}.`);
					if (result.branchName) recoveryParts.push(`Captured branch preserved as ${result.branchName}.`);
					if (result.nestedPatches?.length) {
						const nestedPaths = await persistNestedPatches(artifactsDir, result.id, result.nestedPatches);
						recoveryParts.push(
							`Captured nested repository patches (${result.nestedPatches.length}) preserved at: ${nestedPaths.join(", ")}.`,
						);
					}
					const recoveryHint = recoveryParts.length > 0 ? ` ${recoveryParts.join(" ")}` : "";
					throw new ToolError(
						`agent() isolated apply failed for ${result.id}${summaryText ? `: ${summaryText}` : ""}${recoveryHint}`,
					);
				}

				const nestedSummary = await applyEligibleNestedPatches({
					result,
					repoRoot: isolationContext.repoRoot,
					mergeMode,
					changesApplied: outcome.changesApplied,
					mergedBranchForNestedPatches: outcome.mergedBranchForNestedPatches,
					commitMessage: buildCommitMessage(),
				});
				mergeSummary += nestedSummary;
				if (structured && nestedSummary.trim()) {
					const recoveryParts: string[] = [];
					if (result.nestedPatches?.length) {
						const nestedPaths = await persistNestedPatches(artifactsDir, result.id, result.nestedPatches);
						recoveryParts.push(
							`Captured nested repository patches (${result.nestedPatches.length}) preserved at: ${nestedPaths.join(", ")}.`,
						);
					}
					const recoveryHint = recoveryParts.length > 0 ? ` ${recoveryParts.join(" ")}` : "";
					throw new ToolError(
						`agent() isolated nested patch apply failed for ${result.id}: ${plainIsolationSummary(nestedSummary)}${recoveryHint}`,
					);
				}
			} else if (result.branchName) {
				mergeSummary = `\n\nIsolation: changes captured on branch \`${result.branchName}\` (apply=false). Not merged.`;
			} else if (result.patchPath) {
				mergeSummary = `\n\nIsolation: changes captured at \`${result.patchPath}\` (apply=false). Not applied.`;
			} else {
				const nestedPatches = result.nestedPatches ?? [];
				if (nestedPatches.length > 0) {
					mergeSummary = `\n\nIsolation: changes captured for ${nestedPatches.length} nested repositor${nestedPatches.length === 1 ? "y" : "ies"} (apply=false). Not applied.`;
				} else {
					mergeSummary = "\n\nIsolation: no changes captured.";
				}
			}
		}

		// Clean up the temp artifacts dir we created for this call only when the
		// caller will not need files from it later. Keep it when the runtime helper
		// will return an `agent://` handle (the `.md`/`.jsonl` backing files live
		// here) and on `apply=false` (`changesApplied === null`) where the caller
		// consumes `details.patchPath` / `details.branchName` /
		// `details.nestedPatches` out of band. Failed isolated applies throw
		// earlier with a recovery hint, so they never reach this gate.
		const shouldCleanupTempArtifacts = tempArtifactsDir && !parsed.handle && (!isIsolated || changesApplied === true);
		if (shouldCleanupTempArtifacts) {
			await fs.rm(artifactsDir, { recursive: true, force: true });
			unregisterArtifactsDir?.();
		}

		options.session.recordEvalSubagentUsage?.(result.usage?.output ?? 0);

		return { result, mergeSummary, changesApplied };
	});

	return {
		text: structured ? result.output : result.output + mergeSummary,
		details: {
			agent: result.agent,
			id: result.id,
			model: result.resolvedModel ?? modelOverride,
			structured,
			isolated: isIsolated || undefined,
			patchPath: result.patchPath,
			branchName: result.branchName,
			nestedPatches: result.nestedPatches?.length ? result.nestedPatches : undefined,
			changesApplied: isIsolated ? changesApplied : undefined,
			isolationSummary: mergeSummary ? mergeSummary.trim() : undefined,
		},
	};
}
