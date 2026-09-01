/** Runtime integration for task routing, context intelligence, and verification. */
import { ptree } from "@oh-my-pi/pi-utils";
import type { Effort } from "@oh-my-pi/pi-ai";
import { Agent } from "./agent";
import type { AgentMessage, AgentState } from "./types";
import { assembleContext, contextBudgetForComplexity, type ContextIntelligenceTelemetry } from "./context-intelligence";
import {
	buildRepairMessage,
	buildVerificationPlan,
	executeVerificationPlan,
	readWorkspacePackageScripts,
	VerificationRecoveryController,
	type VerificationFailure,
	type VerificationState,
	type VerificationTelemetry,
} from "./verification";
import { classifyTask, inferEscalationTrigger, isTaskFailureMessage, TaskRouteTracker, type TaskClassification, type TaskComplexity, type TaskRoutingTelemetry } from "./task-router";

const kPatched = Symbol.for("oh-my-pi-ultra.task-router.patched");
const kYieldPatched = Symbol.for("oh-my-pi-ultra.verification.yield-composer");
const byAgent = new WeakMap<Agent, RuntimeRoute>();
type YieldHook = () => Promise<void> | void;
const yieldHooks = new WeakMap<Agent, { primary?: YieldHook; extras: Set<YieldHook> }>();

interface RoutedState extends AgentState {
	taskRouting?: TaskRoutingTelemetry;
	initialTaskClassification?: TaskClassification;
	contextIntelligence?: ContextIntelligenceTelemetry;
	verification?: VerificationRuntimeTelemetry;
}
export interface VerificationRuntimeTelemetry extends VerificationTelemetry {
	lastFailure?: VerificationFailure;
	workspaceChanged: boolean;
}
interface VerificationRuntime {
	controller: VerificationRecoveryController;
	baselineWorkspace: string;
	pendingRecovery: boolean;
	previousAttempts: string[];
	lastPlanKey?: string;
	lastState?: VerificationState;
	telemetry: VerificationRuntimeTelemetry;
}
interface RuntimeRoute {
	tracker: TaskRouteTracker;
	previousThinking: Effort | undefined;
	autoThinking: boolean;
	unsubscribe: () => void;
	removeContextHook: () => void;
	removeVerificationHook: () => void;
	failures: number;
	verification?: VerificationRuntime;
}

function enabled(): boolean { return Bun.env.PI_TASK_ROUTER !== "0"; }
function contextEnabled(): boolean { return Bun.env.PI_CONTEXT_INTELLIGENCE !== "0"; }
function verificationEnabled(): boolean { return Bun.env.PI_VERIFICATION !== "0"; }
function parsePositiveInteger(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(item => item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "").join(" ");
}
function promptText(input: unknown): string | undefined {
	if (typeof input === "string") return input.trim() || undefined;
	if (Array.isArray(input)) return input.filter(x => x && typeof x === "object" && (x as { role?: string }).role === "user").map(x => textOf((x as { content?: unknown }).content)).join(" ").trim() || undefined;
	if (input && typeof input === "object" && (input as { role?: string }).role === "user") return textOf((input as { content?: unknown }).content).trim() || undefined;
	return undefined;
}
function effort(complexity: TaskComplexity): Effort {
	return complexity === "SIMPLE" ? "minimal" as Effort : complexity === "NORMAL" ? "low" as Effort : complexity === "COMPLEX" ? "high" as Effort : "max" as Effort;
}
function publish(agent: Agent, route: RuntimeRoute): void {
	const state = agent.state as RoutedState;
	state.initialTaskClassification = route.tracker.initial;
	state.taskRouting = route.tracker.telemetry;
	if (route.verification) state.verification = route.verification.telemetry;
}
function adaptThinking(agent: Agent, route: RuntimeRoute): void {
	if (agent.state.thinkingLevel !== undefined || route.autoThinking) return;
	route.autoThinking = true;
	agent.setThinkingLevel(effort(route.tracker.current.complexity));
}
function attachContextIntelligence(agent: Agent, route: RuntimeRoute, task: string): void {
	if (!contextEnabled()) return;
	route.removeContextHook = agent.addBeforeModelCall(async context => {
		if (context.messages.length === 0) return;
		const model = agent.state.model as typeof agent.state.model & { contextWindow?: number };
		const contextWindowTokens = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
		const explicitBudget = parsePositiveInteger(Bun.env.PI_CONTEXT_BUDGET);
		const assembled = assembleContext(task, context.messages, agent.tokenizer, {
			complexity: route.tracker.current.complexity,
			budgetTokens: explicitBudget ?? contextBudgetForComplexity(route.tracker.current.complexity, contextWindowTokens),
			recentMessageCount: parsePositiveInteger(Bun.env.PI_CONTEXT_RECENT_MESSAGES),
			contextWindowTokens,
		});
		context.messages = assembled.messages;
		(agent.state as RoutedState).contextIntelligence = assembled.telemetry;
		publish(agent, route);
	});
}

function patchYieldComposition(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown; setOnBeforeYield: (hook: YieldHook | undefined) => void };
	if (target[kYieldPatched]) return;
	target[kYieldPatched] = true;
	const original = target.setOnBeforeYield;
	target.setOnBeforeYield = function composedYieldHook(this: Agent, primary?: YieldHook): void {
		let record = yieldHooks.get(this);
		if (!record) { record = { extras: new Set() }; yieldHooks.set(this, record); }
		record.primary = primary;
		const extras = record.extras;
		const combined: YieldHook | undefined = record.primary || extras.size > 0
			? async () => {
				if (record?.primary) await record.primary();
				for (const hook of extras) await hook();
			}
			: undefined;
		original.call(this, combined);
	};
}
function addBeforeYieldHook(agent: Agent, hook: YieldHook): () => void {
	patchYieldComposition();
	let record = yieldHooks.get(agent);
	if (!record) { record = { extras: new Set() }; yieldHooks.set(agent, record); }
	record.extras.add(hook);
	// Re-install through the composed public setter so a host-owned primary hook remains active.
	agent.setOnBeforeYield(record.primary);
	return () => {
		const current = yieldHooks.get(agent);
		if (!current) return;
		current.extras.delete(hook);
		agent.setOnBeforeYield(current.primary);
		if (!current.primary && current.extras.size === 0) yieldHooks.delete(agent);
	};
}

async function workspaceSignature(cwd: string): Promise<string> {
	try {
		const result = await ptree.exec(["git", "status", "--porcelain", "--untracked-files=all"], { cwd, allowNonZero: true, allowAbort: true, stderr: "full" });
		const diff = await ptree.exec(["git", "diff", "HEAD", "--numstat"], { cwd, allowNonZero: true, allowAbort: true, stderr: "full" });
		return `${result.exitCode ?? 0}\n${result.stdout ?? ""}\n${diff.stdout ?? ""}`;
	} catch { return `cwd:${cwd}`; }
}
function changedFilesFromStatus(status: string): string[] {
	const files: string[] = [];
	for (const line of status.split(/\r?\n/).filter(Boolean)) {
		if (line.length < 4) continue;
		const payload = line.slice(3).trim();
		if (!payload) continue;
		const rename = payload.split(/\s+->\s+/);
		files.push((rename[rename.length - 1] ?? payload).replace(/^"|"$/g, ""));
	}
	return [...new Set(files)];
}
function blankTelemetry(): VerificationRuntimeTelemetry {
	return {
		plan: { risk: "low", scope: "single-file", checks: [], estimatedCost: "cheap", requiredEvidence: [], changedFiles: [], unexpectedFiles: [] },
		checksSelected: 0, checksExecuted: 0, checksSkipped: 0, checksPassed: 0, checksFailed: 0, checkDurationsMs: {},
		repairAttempts: 0, repairsModelCalls: 0, repairsToolCalls: 0, escalations: 0, finalState: "UNVERIFIED", workspaceChanged: false,
	};
}

async function attachVerification(agent: Agent, route: RuntimeRoute, task: string): Promise<void> {
	if (!verificationEnabled()) return;
	const cwd = process.cwd();
	const baseline = await workspaceSignature(cwd);
	const runtime: VerificationRuntime = {
		controller: new VerificationRecoveryController({ maxSameFailureRepairs: parsePositiveInteger(Bun.env.PI_VERIFICATION_MAX_SAME_FAILURE) ?? 2, maxTotalRepairs: parsePositiveInteger(Bun.env.PI_VERIFICATION_MAX_REPAIRS) ?? 4 }),
		baselineWorkspace: baseline,
		pendingRecovery: false,
		previousAttempts: [],
		telemetry: blankTelemetry(),
	};
	route.verification = runtime;
	route.removeVerificationHook = addBeforeYieldHook(agent, async () => {
		if (runtime.pendingRecovery) return;
		const current = await workspaceSignature(cwd);
		const changedFiles = changedFilesFromStatus(current);
		const changed = current !== runtime.baselineWorkspace;
		if (!changed || changedFiles.length === 0) {
			runtime.lastState = "UNVERIFIED";
			runtime.telemetry = { ...runtime.telemetry, finalState: "UNVERIFIED", workspaceChanged: changed };
			publish(agent, route);
			return;
		}
		const scripts = await readWorkspacePackageScripts(cwd);
		const plan = buildVerificationPlan({ task, complexity: route.tracker.current.complexity, changedFiles, availableScripts: scripts.rootScripts, packageScripts: scripts.packageScripts });
		const key = `${route.tracker.current.complexity}|${changedFiles.join("|")}|${plan.checks.map(check => check.name).join("|")}`;
		if (runtime.lastPlanKey === key && runtime.lastState === "VERIFIED_SUCCESS") return;
		runtime.lastPlanKey = key;
		const result = await executeVerificationPlan(plan, {
			execute: async (check, signal) => {
				const started = performance.now();
				const execution = await ptree.exec([check.command, ...check.args], { cwd, signal, timeout: parsePositiveInteger(Bun.env.PI_VERIFICATION_TIMEOUT_MS) ?? 120_000, allowNonZero: true, allowAbort: true, stderr: "full" });
				return { stdout: execution.stdout, stderr: execution.stderr, code: execution.exitCode ?? 0, killed: Boolean(execution.exitError?.aborted), durationMs: performance.now() - started };
			},
		});
		runtime.telemetry = {
			...runtime.telemetry,
			plan: result.plan,
			checksSelected: result.plan.checks.length,
			checksExecuted: result.checks.filter(item => item.status !== "skipped").length,
			checksSkipped: result.checks.filter(item => item.status === "skipped").length,
			checksPassed: result.checks.filter(item => item.status === "passed").length,
			checksFailed: result.checks.filter(item => item.status === "failed" || item.status === "blocked").length,
			checkDurationsMs: Object.fromEntries(result.checks.map(item => [item.check.name, item.durationMs])),
			failureCategory: result.failure?.category,
			finalState: result.state,
			workspaceChanged: true,
			lastFailure: result.failure,
			repairAttempts: runtime.controller.repairAttempts,
			escalations: route.tracker.telemetry.escalations.length,
		};
		runtime.lastState = result.state;
		if (result.state !== "FAILED" || !result.failure) { publish(agent, route); return; }
		const decision = runtime.controller.decide(result.failure, current, route.tracker);
		runtime.telemetry = { ...runtime.telemetry, repairAttempts: runtime.controller.repairAttempts, escalations: route.tracker.telemetry.escalations.length };
		if (decision.action === "stop") { publish(agent, route); return; }
		if (decision.escalated) adaptThinking(agent, route);
		runtime.pendingRecovery = true;
		const repairMessage = buildRepairMessage(task, result.failure, runtime.previousAttempts, result.plan.checks.find(item => item.status === "skipped")?.check, route.tracker.current.complexity);
		runtime.previousAttempts.push(`${result.failure.check}: ${result.failure.category}`);
		runtime.telemetry = { ...runtime.telemetry, repairsModelCalls: runtime.telemetry.repairsModelCalls + 1 };
		agent.followUp({ role: "user", content: repairMessage, timestamp: Date.now() } as AgentMessage);
		publish(agent, route);
	});
}

function inspectTurn(agent: Agent, route: RuntimeRoute, resultText: string, toolFailed: boolean): void {
	const text = resultText.slice(0, 12000);
	if (!toolFailed && !isTaskFailureMessage(text)) { route.failures = 0; return; }
	route.failures++;
	const escalation = route.tracker.observe(inferEscalationTrigger(text) ?? "repair_failure", `execution evidence: ${text.slice(0, 220)}`);
	if (escalation) adaptThinking(agent, route);
	publish(agent, route);
}

async function attach(agent: Agent, task: string): Promise<RuntimeRoute> {
	const previous = byAgent.get(agent);
	previous?.unsubscribe();
	previous?.removeContextHook();
	previous?.removeVerificationHook();
	const route: RuntimeRoute = { tracker: new TaskRouteTracker(classifyTask(task)), previousThinking: agent.state.thinkingLevel, autoThinking: false, unsubscribe: () => {}, removeContextHook: () => {}, removeVerificationHook: () => {}, failures: 0 };
	route.unsubscribe = agent.subscribe(event => {
		if (event.type === "turn_end") {
			const results = event.toolResults as Array<{ content: unknown; isError?: boolean }>;
			inspectTurn(agent, route, results.map(item => textOf(item.content)).join(" "), results.some(item => item.isError === true));
			if (route.verification?.pendingRecovery) {
				route.verification.pendingRecovery = false;
				route.verification.telemetry = { ...route.verification.telemetry, repairsToolCalls: route.verification.telemetry.repairsToolCalls + results.length };
			}
		}
		if (event.type === "agent_end") publish(agent, route);
	});
	byAgent.set(agent, route);
	publish(agent, route);
	adaptThinking(agent, route);
	attachContextIntelligence(agent, route, task);
	await attachVerification(agent, route, task);
	return route;
}

function patch(): void {
	const target = Agent.prototype as Agent & { [key: symbol]: unknown };
	if (target[kPatched]) return;
	target[kPatched] = true;
	patchYieldComposition();
	const original = Agent.prototype.prompt as (...args: unknown[]) => Promise<unknown>;
	(target as any).prompt = async function routedPrompt(this: Agent, ...args: unknown[]) {
		if (!enabled()) return original.apply(this, args);
		const task = promptText(args[0]);
		if (!task) return original.apply(this, args);
		const route = await attach(this, task);
		try { return await original.apply(this, args); }
		finally {
			publish(this, route);
			route.unsubscribe();
			route.removeContextHook();
			route.removeVerificationHook();
			if (route.previousThinking !== undefined) this.setThinkingLevel(route.previousThinking);
			else if (route.autoThinking) this.setThinkingLevel(undefined);
			byAgent.delete(this);
		}
	};
}
patch();
export function getTaskRouting(agent: Agent): TaskRoutingTelemetry | undefined { return (agent.state as RoutedState).taskRouting; }
export function getContextIntelligence(agent: Agent): ContextIntelligenceTelemetry | undefined { return (agent.state as RoutedState).contextIntelligence; }
export function getVerification(agent: Agent): VerificationRuntimeTelemetry | undefined { return (agent.state as RoutedState).verification; }
