/**
 * Workload execution: turn a validated {@link WorkloadSpec} into subagent
 * spawns and shell gates, wave by wave.
 *
 * The engine owns no agent machinery of its own. Steps that spawn go through
 * `runStructuredSubagent` — the same path the `task` tool and the eval
 * `agent()` bridge use — so per-step `model`/`effort`/`agent`/`isolated` are
 * resolved exactly as they are for a tool-driven spawn.
 * Fan-out reuses `mapWithConcurrencyLimitAllSettled`; the parent session is
 * bootstrapped the way `omp cleanse` does it.
 */
import * as path from "node:path";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { formatModelString, resolveModelFromSettings } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { mapWithConcurrencyLimitAllSettled } from "../task/parallel";
import { runStructuredSubagent, StructuredSubagentError } from "../task/structured-subagent";
import type { ToolSession } from "../tools";
import { EventBus } from "../utils/event-bus";
import type { WorkloadSpec, WorkloadStep } from "./spec";
import { interpolate, resolveReference, type TemplateScope, type WorkloadStepOutput } from "./template";

/** One attempt's observable outcome, before it becomes template scope. */
interface StepAttempt {
	ok: boolean;
	/** Yielded text, or parsed structured data when the step declared a schema. */
	output?: unknown;
	stdout?: string;
	exitCode?: number;
	error?: string;
	durationMs: number;
	/** Resolved `provider/model[:level]` actually used, for the ledger. */
	resolvedModel?: string;
	tokens?: number;
}

/** Terminal state of one step, as reported and persisted. */
export interface WorkloadStepReport {
	id: string;
	status: "ok" | "failed" | "skipped";
	/** `prompt` steps spawn; `run` steps execute argv. */
	kind: "agent" | "shell";
	attempts: number;
	durationMs: number;
	/** Number of fan-out items for a `for_each` step. */
	items?: number;
	resolvedModel?: string;
	tokens?: number;
	error?: string;
	/** Why the step never ran, when `status === "skipped"`. */
	skipReason?: string;
}

export interface WorkloadRunResult {
	name: string;
	runId: string;
	status: "ok" | "failed";
	steps: WorkloadStepReport[];
	durationMs: number;
	/** Absolute path of the persisted run ledger, when a session was created. */
	ledgerPath?: string;
	sessionFile?: string;
}

export interface WorkloadRunOptions {
	cwd?: string;
	/** Overrides every step's `concurrency`. */
	concurrency?: number;
	signal?: AbortSignal;
	/** Progress sink; the CLI renders these as they arrive. */
	onEvent?: (event: WorkloadRunEvent) => void;
}

export type WorkloadRunEvent =
	| { kind: "wave"; index: number; total: number; steps: string[] }
	| { kind: "step-start"; id: string; description?: string; items?: number; model?: string }
	| { kind: "step-end"; report: WorkloadStepReport };

/**
 * Create the parent session that owns every spawn of the run. Mirrors
 * `createCleanseAgentRuntime`: a persisted session so subagent transcripts,
 * artifacts, and `local://` handoffs land somewhere inspectable afterwards.
 */
async function createWorkloadSession(
	spec: WorkloadSpec,
	cwd: string,
): Promise<{ session: ToolSession; sessionFile: string; sessionManager: SessionManager }> {
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	// The parent never prompts a model itself, but it still needs a resolvable
	// active model: that is what a step inherits when it names neither a `model`
	// nor an agent whose definition does. `resolveModelFromSettings` walks the
	// configured roles exactly as an interactive session's startup does.
	const activeModel = resolveModelFromSettings({ settings, availableModels: modelRegistry.getAvailable() });
	if (!activeModel) {
		throw new Error(
			"No model with usable credentials. Run `omp models` to check discovery, or `omp login` to add a provider.",
		);
	}
	const modelSelector = formatModelString(activeModel);
	const sessionManager = SessionManager.create(cwd);
	await sessionManager.setSessionName(`Workload ${spec.name}`, "auto");
	sessionManager.appendCustomEntry("workload", { status: "running", name: spec.name, source: spec.sourcePath });
	await sessionManager.ensureOnDisk();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Workload session could not be persisted");
	const session: ToolSession = {
		cwd,
		hasUI: false,
		suppressSpawnAdvisory: true,
		enableLsp: true,
		enableIrc: true,
		enableMCP: false,
		eventBus: new EventBus(),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionManager.getSessionId(),
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getArtifactManager: () => sessionManager.getArtifactManager(),
		getAgentId: () => MAIN_AGENT_ID,
		getSessionSpawns: () => "*",
		getModelString: () => modelSelector,
		getActiveModelString: () => modelSelector,
		getActiveModel: () => activeModel,
		sessionManager,
		settings,
		authStorage,
		modelRegistry,
	};
	return { session, sessionFile, sessionManager };
}

/**
 * Run one shell gate step. Non-zero exit is a failure the policy then decides
 * on. `output` is the parsed value when stdout is a JSON document, so a shell
 * step can feed `for_each` (a script that lists targets) without a model in
 * the loop; `stdout` always stays the raw text.
 */
async function runShellStep(step: WorkloadStep, scope: TemplateScope, cwd: string): Promise<StepAttempt> {
	const argv = (step.run ?? []).map(argument => interpolate(argument, scope));
	const started = Bun.nanoseconds();
	const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
	let output: unknown = stdout;
	const trimmed = stdout.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			output = JSON.parse(trimmed);
		} catch {
			output = stdout;
		}
	}
	return {
		ok: exitCode === 0,
		output,
		stdout,
		exitCode,
		durationMs,
		...(exitCode === 0
			? {}
			: { error: `exit ${exitCode}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}` }),
	};
}

/** Spawn one subagent for a step (or for one `for_each` item). */
async function runAgentStep(
	step: WorkloadStep,
	scope: TemplateScope,
	session: ToolSession,
	index: number,
	label: string,
	signal?: AbortSignal,
): Promise<StepAttempt> {
	const started = Bun.nanoseconds();
	try {
		const execution = await runStructuredSubagent({
			session,
			invocationKind: "task",
			assignment: interpolate(step.prompt ?? "", scope),
			agent: step.agent,
			...(step.model !== undefined ? { model: step.model } : {}),
			...(step.effort !== undefined ? { effort: step.effort } : {}),
			...(step.outputSchema !== undefined ? { outputSchema: step.outputSchema } : {}),
			...(step.isolated ? { isolation: { requested: true } } : {}),
			identity: { label },
			index,
			keepAlive: false,
			...(signal !== undefined ? { signal } : {}),
		});
		const { result } = execution;
		const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
		const structured = result.structuredOutput;
		return {
			ok: result.exitCode === 0 && !result.aborted,
			output: structured?.data !== undefined ? structured.data : result.output,
			durationMs,
			...(result.resolvedModel !== undefined ? { resolvedModel: result.resolvedModel } : {}),
			...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
			...(result.exitCode === 0 && !result.aborted
				? {}
				: { error: result.error ?? result.abortReason ?? `subagent exited ${result.exitCode}` }),
		};
	} catch (err) {
		const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
		const message = err instanceof StructuredSubagentError || err instanceof Error ? err.message : String(err);
		return { ok: false, durationMs, error: message };
	}
}

/**
 * Execute one step, expanding `for_each` into a bounded fan-out and applying
 * `retries`. A fan-out step's `output` is the array of per-item outputs in item
 * order, so a downstream step can consume the whole set.
 */
async function executeStep(
	step: WorkloadStep,
	scope: TemplateScope,
	context: { session?: ToolSession; cwd: string; concurrency: number; signal?: AbortSignal; index: number },
): Promise<{ report: WorkloadStepReport; output: WorkloadStepOutput }> {
	const kind = step.run ? "shell" : "agent";
	const items: unknown[] | undefined = step.forEach ? toFanOutItems(step, scope) : undefined;
	const attemptOnce = async (itemScope: TemplateScope, label: string, index: number): Promise<StepAttempt> => {
		if (step.run) return runShellStep(step, itemScope, context.cwd);
		if (!context.session) throw new Error("Workload agent steps require a session");
		return runAgentStep(step, itemScope, context.session, index, label, context.signal);
	};
	const runWithRetries = async (itemScope: TemplateScope, label: string, index: number): Promise<StepAttempt[]> => {
		const attempts: StepAttempt[] = [];
		for (let attempt = 0; attempt <= step.retries; attempt++) {
			const outcome = await attemptOnce(itemScope, attempt === 0 ? label : `${label}-retry${attempt}`, index);
			attempts.push(outcome);
			if (outcome.ok) break;
		}
		return attempts;
	};

	const started = Bun.nanoseconds();
	if (items === undefined) {
		const attempts = await runWithRetries(scope, step.id, context.index);
		const last = attempts.at(-1);
		const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
		return {
			report: {
				id: step.id,
				status: last?.ok ? "ok" : "failed",
				kind,
				attempts: attempts.length,
				durationMs,
				...(last?.resolvedModel !== undefined ? { resolvedModel: last.resolvedModel } : {}),
				...(last?.tokens !== undefined ? { tokens: last.tokens } : {}),
				...(last?.ok ? {} : { error: last?.error ?? "step failed" }),
			},
			output: {
				...(last?.output !== undefined ? { output: last.output } : {}),
				...(last?.stdout !== undefined ? { stdout: last.stdout } : {}),
				...(last?.exitCode !== undefined ? { exitCode: last.exitCode } : {}),
			},
		};
	}

	const settled = await mapWithConcurrencyLimitAllSettled(
		items,
		context.concurrency,
		async (item, itemIndex) =>
			runWithRetries({ ...scope, item, itemIndex }, `${step.id}-${itemIndex + 1}`, context.index + itemIndex),
		context.signal,
	);
	const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
	const outputs: unknown[] = [];
	let failures = 0;
	let attemptCount = 0;
	let tokens = 0;
	let resolvedModel: string | undefined;
	let firstError: string | undefined;
	for (const entry of settled.results) {
		if (entry?.status !== "fulfilled") {
			failures++;
			firstError ??= entry?.status === "rejected" ? String(entry.reason) : "fan-out item never ran";
			outputs.push(undefined);
			continue;
		}
		const attempts = entry.value;
		attemptCount += attempts.length;
		const last = attempts.at(-1);
		outputs.push(last?.output);
		tokens += last?.tokens ?? 0;
		resolvedModel ??= last?.resolvedModel;
		if (!last?.ok) {
			failures++;
			firstError ??= last?.error ?? "fan-out item failed";
		}
	}
	return {
		report: {
			id: step.id,
			status: failures === 0 ? "ok" : "failed",
			kind,
			attempts: attemptCount,
			durationMs,
			items: items.length,
			...(resolvedModel !== undefined ? { resolvedModel } : {}),
			...(tokens > 0 ? { tokens } : {}),
			...(failures === 0 ? {} : { error: `${failures}/${items.length} items failed — ${firstError}` }),
		},
		output: { output: outputs },
	};
}

/** Resolve a `for_each` expression to the list it must fan out over. */
function toFanOutItems(step: WorkloadStep, scope: TemplateScope): unknown[] {
	const value = resolveReference(step.forEach ?? "", scope);
	if (!Array.isArray(value)) {
		throw new Error(
			`Step "${step.id}": \`for_each\` expression ${step.forEach} resolved to ${
				value === undefined ? "nothing" : typeof value
			}, but fan-out needs a list. Give the producing step an \`output_schema\` with an array property.`,
		);
	}
	return value;
}

/**
 * Execute a workload. Steps in one wave run concurrently; a failed step with
 * `on_failure: abort` stops the run and marks everything downstream skipped,
 * while `continue` lets independent branches finish. The ledger is written
 * whether the run passes or fails, so a failure is inspectable.
 */
export async function runWorkload(
	spec: WorkloadSpec,
	args: Record<string, string>,
	options: WorkloadRunOptions = {},
): Promise<WorkloadRunResult> {
	const cwd = options.cwd ?? getProjectDir();
	const runId = Bun.randomUUIDv7().slice(0, 8);
	const needsSession = spec.steps.some(step => step.prompt !== undefined);
	const started = Bun.nanoseconds();
	const bootstrap = needsSession ? await createWorkloadSession(spec, cwd) : undefined;
	const stepsById: Record<string, WorkloadStep> = {};
	for (const step of spec.steps) stepsById[step.id] = step;
	const scope: TemplateScope = { args, steps: {} };
	const reports: WorkloadStepReport[] = [];
	let aborted = false;
	let spawnIndex = 0;

	for (const [waveIndex, wave] of spec.waves.entries()) {
		if (aborted) {
			for (const id of wave) {
				reports.push({
					id,
					status: "skipped",
					kind: stepsById[id]?.run ? "shell" : "agent",
					attempts: 0,
					durationMs: 0,
					skipReason: "an earlier step failed with on_failure: abort",
				});
			}
			continue;
		}
		options.onEvent?.({ kind: "wave", index: waveIndex + 1, total: spec.waves.length, steps: wave });
		const runnable: WorkloadStep[] = [];
		for (const id of wave) {
			const step = stepsById[id];
			if (!step) continue;
			const failedNeed = step.needs.find(need => reports.find(report => report.id === need)?.status !== "ok");
			if (failedNeed) {
				reports.push({
					id,
					status: "skipped",
					kind: step.run ? "shell" : "agent",
					attempts: 0,
					durationMs: 0,
					skipReason: `needs "${failedNeed}", which did not succeed`,
				});
				continue;
			}
			runnable.push(step);
		}
		// Steps within a wave are independent by construction, so they run
		// together; each step's own `concurrency` still bounds its fan-out.
		const waveOutcomes = await mapWithConcurrencyLimitAllSettled(
			runnable,
			runnable.length,
			async step => {
				options.onEvent?.({
					kind: "step-start",
					id: step.id,
					...(step.description !== undefined ? { description: step.description } : {}),
					...(step.model !== undefined ? { model: step.model } : {}),
				});
				const index = spawnIndex;
				spawnIndex += 1024;
				return executeStep(step, scope, {
					...(bootstrap ? { session: bootstrap.session } : {}),
					cwd,
					concurrency: options.concurrency ?? step.concurrency,
					...(options.signal !== undefined ? { signal: options.signal } : {}),
					index,
				});
			},
			options.signal,
		);
		for (const [position, entry] of waveOutcomes.results.entries()) {
			const step = runnable[position];
			if (!step) continue;
			if (entry?.status !== "fulfilled") {
				const error = entry?.status === "rejected" ? String(entry.reason) : "step never ran";
				const report: WorkloadStepReport = {
					id: step.id,
					status: "failed",
					kind: step.run ? "shell" : "agent",
					attempts: 0,
					durationMs: 0,
					error,
				};
				reports.push(report);
				options.onEvent?.({ kind: "step-end", report });
				if (step.onFailure === "abort") aborted = true;
				continue;
			}
			scope.steps[step.id] = entry.value.output;
			reports.push(entry.value.report);
			options.onEvent?.({ kind: "step-end", report: entry.value.report });
			if (entry.value.report.status === "failed" && step.onFailure === "abort") aborted = true;
		}
	}

	const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
	const status = reports.every(report => report.status === "ok") ? "ok" : "failed";
	const result: WorkloadRunResult = {
		name: spec.name,
		runId,
		status,
		steps: reports,
		durationMs,
		...(bootstrap ? { sessionFile: bootstrap.sessionFile } : {}),
	};
	if (bootstrap) {
		const artifactsDir = bootstrap.session.getArtifactsDir?.();
		if (artifactsDir) {
			const ledgerPath = path.resolve(artifactsDir, `workload-${spec.name}-${runId}.json`);
			try {
				await Bun.write(
					ledgerPath,
					`${JSON.stringify({ ...result, source: spec.sourcePath, args, outputs: scope.steps }, null, "\t")}\n`,
				);
				result.ledgerPath = ledgerPath;
			} catch (err) {
				logger.warn("Failed to write workload ledger", { ledgerPath, err: String(err) });
			}
		}
		bootstrap.sessionManager.appendCustomEntry("workload", { status, name: spec.name, runId, durationMs });
		await bootstrap.sessionManager.ensureOnDisk();
	}
	return result;
}
