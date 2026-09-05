import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TaskRouteTracker, type TaskComplexity } from "./task-router";

export type VerificationState = "VERIFIED_SUCCESS" | "PARTIAL_SUCCESS" | "FAILED" | "BLOCKED" | "UNVERIFIED";
export type VerificationFailureCategory = "COMPILE_ERROR" | "TYPE_ERROR" | "LINT_ERROR" | "TEST_FAILURE" | "BUILD_FAILURE" | "DEPENDENCY_FAILURE" | "ENVIRONMENT_FAILURE" | "NETWORK_FAILURE" | "TIMEOUT" | "TOOL_ERROR" | "UNKNOWN";
export type VerificationCheckKind = "typecheck" | "test" | "lint" | "build" | "compile" | "vet" | "custom";

export interface VerificationCheck {
	name: string;
	command: string;
	args: string[];
	reason: string;
	priority: number;
	cost: "cheap" | "moderate" | "expensive";
	dependencies: string[];
	kind: VerificationCheckKind;
	packagePath?: string;
	broad?: boolean;
}

export interface VerificationPlan {
	risk: "low" | "medium" | "high" | "critical";
	scope: "single-file" | "single-package" | "multi-package" | "repository";
	checks: VerificationCheck[];
	estimatedCost: "cheap" | "moderate" | "expensive";
	requiredEvidence: string[];
	changedFiles: string[];
	unexpectedFiles: string[];
}

export interface VerificationCommandResult { stdout: string; stderr: string; code: number; killed: boolean; durationMs: number; }
export interface VerificationExecutor { execute(check: VerificationCheck, signal?: AbortSignal): Promise<VerificationCommandResult>; }

export interface VerificationFailure {
	check: string;
	status: "failed";
	category: VerificationFailureCategory;
	summary: string;
	primaryError?: string;
	expectedActual?: string;
	relatedFiles: string[];
	affectedSymbols: string[];
	attempt: number;
	rawOutputAvailable: boolean;
	rawOutput: string;
}

export interface VerificationCheckResult { check: VerificationCheck; status: "passed" | "failed" | "blocked" | "skipped"; durationMs: number; failure?: VerificationFailure; }
export interface VerificationRunResult { state: VerificationState; plan: VerificationPlan; checks: VerificationCheckResult[]; failure?: VerificationFailure; message: string; }

export interface VerificationTelemetry {
	plan: VerificationPlan;
	checksSelected: number;
	checksExecuted: number;
	checksSkipped: number;
	checksPassed: number;
	checksFailed: number;
	checkDurationsMs: Record<string, number>;
	failureCategory?: VerificationFailureCategory;
	repairAttempts: number;
	repairsModelCalls: number;
	repairsToolCalls: number;
	escalations: number;
	finalState: VerificationState;
}

export interface VerificationPolicyInput {
	task: string;
	complexity: TaskComplexity;
	changedFiles: string[];
	availableScripts: Record<string, string>;
	packageScripts?: Record<string, Record<string, string>>;
	hasTests?: boolean;
	confidence?: number;
}
export interface RecoveryPolicyOptions { maxSameFailureRepairs?: number; maxTotalRepairs?: number; }

const TS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const CODE = new Set([...TS, ".rs", ".py", ".go", ".java", ".kt", ".rb", ".php"]);
const ext = (f: string) => path.extname(f).toLowerCase();
const isCode = (f: string) => CODE.has(ext(f));
const isTest = (f: string) => /(^|[._/\\-])(test|spec)(?:[._/\\-]|$)|(^|[._/\\-])tests?(?:[._/\\-]|$)/i.test(f);
const isConfig = (f: string) => /(^|[./_-])(package\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|tsconfig|vite|webpack|rollup|cargo|pyproject|requirements|go\.mod|go\.sum|gradle|pom|biome|eslint|prettier|\.env)([./_-]|$)/i.test(f);

function packageFor(file: string): string | undefined {
	const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
	const marker = "packages/";
	const index = normalized.indexOf(marker);
	if (index < 0) return undefined;
	const name = normalized.slice(index + marker.length).split("/")[0];
	return name ? `packages/${name}` : undefined;
}

function risk(input: VerificationPolicyInput): VerificationPlan["risk"] {
	const codeCount = input.changedFiles.filter(isCode).length;
	if (input.complexity === "VERY_COMPLEX" || input.changedFiles.some(isConfig) && input.changedFiles.length > 2) return "critical";
	if (input.complexity === "COMPLEX" || codeCount > 3 || input.changedFiles.length > 3) return "high";
	if (input.complexity === "NORMAL" || codeCount > 0) return "medium";
	return "low";
}

function scope(input: VerificationPolicyInput): VerificationPlan["scope"] {
	const packages = new Set(input.changedFiles.map(packageFor).filter(Boolean));
	if (packages.size > 1) return "multi-package";
	if (packages.size === 1) return "single-package";
	return input.changedFiles.length > 4 ? "repository" : "single-file";
}

function check(name: string, script: string | undefined, reason: string, priority: number, cost: VerificationCheck["cost"], kind: VerificationCheckKind, packagePath?: string, broad = false): VerificationCheck | undefined {
	if (!script) return undefined;
	return { name: packagePath ? `${packagePath}:${name}` : name, command: "bun", args: [...(packagePath ? ["--cwd", packagePath] : []), "run", name], reason, priority, cost, dependencies: [], kind, packagePath, broad };
}

function unexpectedFiles(task: string, changed: string[]): string[] {
	const mentions = (task.match(/(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[\w]+/g) ?? []).map(x => x.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase());
	if (!mentions.length) return [];
	return changed.filter(file => !mentions.some(m => file.toLowerCase() === m || file.toLowerCase().endsWith(`/${m}`)));
}

export function buildVerificationPlan(input: VerificationPolicyInput): VerificationPlan {
	const changed = [...new Set(input.changedFiles.map(x => x.replace(/\\/g, "/").replace(/^\.\//, "")))].sort();
	const packages = [...new Set(changed.map(packageFor).filter((x): x is string => Boolean(x)))];
	const codeChanged = changed.some(isCode);
	const testsChanged = changed.some(isTest);
	const configChanged = changed.some(isConfig);
	const checks: VerificationCheck[] = [];
	for (const packagePath of packages) {
		const scripts = input.packageScripts?.[packagePath] ?? {};
		if (codeChanged || testsChanged) {
			const typecheck = check("check:types", scripts["check:types"], "Affected package has code/test changes", 10, "cheap", "typecheck", packagePath);
			const tests = check("test", scripts.test, "Affected package has source or test changes", 20, "moderate", "test", packagePath);
			const lint = check("lint", scripts.lint, "Affected package exposes deterministic linting", 30, "moderate", "lint", packagePath);
			const build = (configChanged || input.complexity === "COMPLEX" || input.complexity === "VERY_COMPLEX") ? check("build", scripts.build, "Configuration/high-complexity change", 40, "expensive", "build", packagePath, true) : undefined;
			if (typecheck) checks.push(typecheck);
			if (tests) checks.push(tests);
			if (lint) checks.push(lint);
			if (build) checks.push(build);
		}
	}
	const root = input.availableScripts;
	if (!checks.length && codeChanged && TS.size > 0 && root["check:ts"]) checks.push({ name: "check:ts", command: "bun", args: ["run", "check:ts"], reason: "No affected package check discovered", priority: 10, cost: "cheap", dependencies: [], kind: "typecheck", broad: true });
	if (!checks.length && changed.some(x => ext(x) === ".rs") && root["check:rs"]) checks.push({ name: "check:rs", command: "bun", args: ["run", "check:rs"], reason: "Rust compiler validation", priority: 10, cost: "cheap", dependencies: [], kind: "compile", broad: true });
	if (!checks.length && changed.some(x => ext(x) === ".py")) for (const file of changed.filter(x => ext(x) === ".py")) checks.push({ name: `compile:${file}`, command: "python3", args: ["-m", "py_compile", file], reason: "Python source validation", priority: 10, cost: "cheap", dependencies: [], kind: "compile" });
	if (!checks.length && changed.some(x => ext(x) === ".go")) {
		checks.push({ name: "go-test", command: "go", args: ["test", "./..."], reason: "Go test validation", priority: 20, cost: "moderate", dependencies: [], kind: "test", broad: true });
		checks.push({ name: "go-vet", command: "go", args: ["vet", "./..."], reason: "Go static validation", priority: 30, cost: "moderate", dependencies: ["go-test"], kind: "vet", broad: true });
	}
	return { risk: risk({ ...input, changedFiles: changed }), scope: scope({ ...input, changedFiles: changed }), checks: checks.sort((a, b) => a.priority - b.priority), estimatedCost: checks.some(x => x.cost === "expensive") ? "expensive" : checks.some(x => x.cost === "moderate") ? "moderate" : "cheap", requiredEvidence: checks.length ? checks.map(x => `${x.name} passed`) : ["no deterministic application check was available"], changedFiles: changed, unexpectedFiles: unexpectedFiles(input.task, changed) };
}

function failureClass(checkDef: VerificationCheck, result: VerificationCommandResult, output: string): VerificationFailureCategory {
	if (result.killed) return /timeout/i.test(output) ? "TIMEOUT" : "ENVIRONMENT_FAILURE";
	if (/econnreset|enotfound|connection refused|network|fetch failed|socket/i.test(output)) return "NETWORK_FAILURE";
	if (/no such file|permission denied|command not found|working directory|executable/i.test(output)) return "ENVIRONMENT_FAILURE";
	if (/cannot find module|unable to resolve|could not resolve|package.*not found|lockfile/i.test(output)) return "DEPENDENCY_FAILURE";
	if (checkDef.kind === "typecheck" || /TS\d{3,5}|type .* is not assignable|property .* does not exist|typescript/i.test(output)) return "TYPE_ERROR";
	if (checkDef.kind === "compile" || /syntax error|parse error|compilation failed|cannot compile/i.test(output)) return "COMPILE_ERROR";
	if (checkDef.kind === "lint" || /biome|eslint|lint/i.test(output)) return "LINT_ERROR";
	if (checkDef.kind === "test" || /test suite|failed tests?|assertion|expected .*received/i.test(output)) return "TEST_FAILURE";
	if (checkDef.kind === "build" || /build failed|build error|vite .*error|webpack .*error/i.test(output)) return "BUILD_FAILURE";
	if (checkDef.kind === "vet") return "COMPILE_ERROR";
	if (/invalid argument|unsupported option|usage:/i.test(output)) return "TOOL_ERROR";
	return "UNKNOWN";
}

function filesFrom(output: string): string[] {
	return [...new Set((output.match(/(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s:'"]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|rb|php|json|yaml|yml|css|scss|md)(?=[:(\s]|$)/g) ?? []).map(x => x.replace(/[),.;]+$/, "")))].slice(0, 12);
}
function symbolsFrom(output: string): string[] { return [...new Set(output.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}(?=\(|\b)/g) ?? [])].slice(0, 12); }
function summaryFrom(output: string): string { const lines = output.split(/\r?\n/).map(x => x.trim()).filter(Boolean); return (lines.filter(x => /error|failed|failure|exception|assertion|expected|received/i.test(x)).slice(0, 6).concat(lines.slice(0, 2))).filter((x, i, a) => a.indexOf(x) === i).join(" | ").slice(0, 1200) || "Verification command failed without diagnostic text."; }

export function extractVerificationFailure(checkDef: VerificationCheck, result: VerificationCommandResult, attempt: number): VerificationFailure {
	const raw = `${result.stdout}\n${result.stderr}`.trim().slice(0, 64_000);
	return { check: checkDef.name, status: "failed", category: failureClass(checkDef, result, raw), summary: summaryFrom(raw), primaryError: raw.split(/\r?\n/).find(x => /error|failed|exception|assertion/i.test(x))?.trim().slice(0, 500), expectedActual: raw.match(/expected[^\n]{0,240}(?:received|actual)[^\n]{0,240}/i)?.[0]?.slice(0, 500), relatedFiles: filesFrom(raw), affectedSymbols: symbolsFrom(raw), attempt, rawOutputAvailable: raw.length > 0, rawOutput: raw };
}

function blocked(category: VerificationFailureCategory): boolean { return ["ENVIRONMENT_FAILURE", "NETWORK_FAILURE", "TIMEOUT", "DEPENDENCY_FAILURE"].includes(category); }
export function failureTrigger(category: VerificationFailureCategory): "unexpected_dependency" | "test_failure" | "verification_failure" | "repair_failure" { return category === "DEPENDENCY_FAILURE" ? "unexpected_dependency" : category === "TEST_FAILURE" ? "test_failure" : category === "UNKNOWN" || category === "TOOL_ERROR" ? "repair_failure" : "verification_failure"; }

export async function executeVerificationPlan(plan: VerificationPlan, executor: VerificationExecutor, signal?: AbortSignal): Promise<VerificationRunResult> {
	if (!plan.checks.length) return { state: "UNVERIFIED", plan, checks: [], message: "No meaningful deterministic verification was available for this change surface." };
	const results: VerificationCheckResult[] = [];
	for (const checkDef of plan.checks) {
		if (signal?.aborted) return { state: "BLOCKED", plan, checks: [...results, { check: checkDef, status: "blocked", durationMs: 0 }], message: "Verification was aborted." };
		if (checkDef.dependencies.some(dep => results.find(x => x.check.name === dep)?.status !== "passed")) { results.push({ check: checkDef, status: "skipped", durationMs: 0 }); continue; }
		const started = performance.now();
		let result: VerificationCommandResult;
		try { result = await executor.execute(checkDef, signal); } catch (error) {
			const failure: VerificationFailure = { check: checkDef.name, status: "failed", category: "TOOL_ERROR", summary: error instanceof Error ? error.message : String(error), relatedFiles: [], affectedSymbols: [], attempt: 1, rawOutputAvailable: false, rawOutput: "" };
			results.push({ check: checkDef, status: "failed", durationMs: performance.now() - started, failure });
			return { state: "FAILED", plan, checks: results, failure, message: failure.summary };
		}
		const durationMs = result.durationMs || performance.now() - started;
		if (result.code === 0 && !result.killed) { results.push({ check: checkDef, status: "passed", durationMs }); continue; }
		const failure = extractVerificationFailure(checkDef, result, 1);
		results.push({ check: checkDef, status: blocked(failure.category) ? "blocked" : "failed", durationMs, failure });
		return { state: blocked(failure.category) ? "BLOCKED" : "FAILED", plan, checks: results, failure, message: failure.summary };
	}
	const partial = results.some(x => x.status === "skipped");
	return { state: partial ? "PARTIAL_SUCCESS" : "VERIFIED_SUCCESS", plan, checks: results, message: partial ? "All runnable verification checks passed; dependent checks were skipped." : "All selected verification checks passed." };
}

export function buildRepairMessage(task: string, failure: VerificationFailure, attempts: readonly string[], nextCheck: VerificationCheck | undefined, complexity: TaskComplexity): string {
	return [
		"Verification failed. Perform a targeted repair; do not rewrite unrelated code.",
		`Task: ${task}`,
		`Failed check: ${failure.check}`,
		`Failure category: ${failure.category}`,
		`Summary: ${failure.summary}`,
		`Primary error: ${failure.primaryError ?? "not extracted"}`,
		`Expected/actual: ${failure.expectedActual ?? "not extracted"}`,
		`Related files: ${failure.relatedFiles.join(", ") || "none extracted"}`,
		`Affected symbols: ${failure.affectedSymbols.join(", ") || "none extracted"}`,
		`Previous repair attempts: ${attempts.join(" | ") || "none"}`,
		`Task Router complexity: ${complexity}`,
		`Rerun target: ${nextCheck?.name ?? failure.check}`,
		"Raw output remains available in verification telemetry.",
		"Inspect the affected symbol/dependency, make the smallest evidence-backed repair, then stop so deterministic verification can run again.",
	].join("\n");
}

export interface VerificationRecoveryDecision { action: "repair" | "escalate" | "stop"; reason: string; failureSignature: string; escalated: boolean; }
export class VerificationRecoveryController {
	readonly maxSameFailureRepairs: number;
	readonly maxTotalRepairs: number;
	private total = 0;
	private counts = new Map<string, number>();
	private lastWorkspace?: string;
	constructor(options: RecoveryPolicyOptions = {}) { this.maxSameFailureRepairs = options.maxSameFailureRepairs ?? 2; this.maxTotalRepairs = options.maxTotalRepairs ?? 4; }
	get repairAttempts() { return this.total; }
	decide(failure: VerificationFailure, workspaceSignature: string, tracker: TaskRouteTracker): VerificationRecoveryDecision {
		const signature = `${failure.category}|${failure.check}|${failure.primaryError ?? failure.summary.slice(0, 180)}`;
		const same = (this.counts.get(signature) ?? 0) + 1; this.counts.set(signature, same);
		const changedWorkspace = this.lastWorkspace !== undefined && this.lastWorkspace !== workspaceSignature; this.lastWorkspace = workspaceSignature;
		if (blocked(failure.category)) return { action: "stop", reason: "Verification is blocked by the environment/dependency/network condition.", failureSignature: signature, escalated: false };
		if (this.total >= this.maxTotalRepairs) return { action: "stop", reason: "Maximum autonomous repair budget reached.", failureSignature: signature, escalated: false };
		if (same > this.maxSameFailureRepairs) return { action: "stop", reason: "The same verification failure persisted beyond the bounded repair policy.", failureSignature: signature, escalated: false };
		if (failure.category === "UNKNOWN" && same > 1) return { action: "stop", reason: "Repeated unknown verification failures require human diagnosis.", failureSignature: signature, escalated: false };
		if (same > 1 && !changedWorkspace) return { action: "stop", reason: "The attempted repair did not change the workspace.", failureSignature: signature, escalated: false };
		const escalation = tracker.observe(failureTrigger(failure.category), `verification ${failure.check} failed: ${failure.summary.slice(0, 220)}`);
		this.total++;
		return escalation ? { action: "escalate", reason: `Escalated ${escalation.from} → ${escalation.to} after bounded verification evidence.`, failureSignature: signature, escalated: true } : { action: "repair", reason: "Targeted repair remains within the bounded recovery budget.", failureSignature: signature, escalated: false };
	}
}

export async function readWorkspacePackageScripts(cwd: string): Promise<{ rootScripts: Record<string, string>; packageScripts: Record<string, Record<string, string>> }> {
	let rootScripts: Record<string, string> = {};
	const packageScripts: Record<string, Record<string, string>> = {};
	try { const root = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }; rootScripts = Object.fromEntries(Object.entries(root.scripts ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>; } catch {}
	try {
		for (const entry of await fs.readdir(path.join(cwd, "packages"), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try { const pkg = JSON.parse(await fs.readFile(path.join(cwd, "packages", entry.name, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }; packageScripts[`packages/${entry.name}`] = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>; } catch {}
		}
	} catch {}
	return { rootScripts, packageScripts };
}
